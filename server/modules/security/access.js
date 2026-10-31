'use strict';
const { HttpError } = require('../../core/errors');

/**
 * صلاحيات المستخدم الفعلية ونطاق فروعه — تُحمَّل من القاعدة في كل طلب
 * (فأي تعديل على الأدوار أو الفروع أو تعطيل المستخدم يسري فورًا دون انتظار انتهاء الجلسة).
 */
function createAccessLoader({ db, permissions }) {
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?');
  const permsOf = db.prepare('SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?');
  const branchesOf = db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?');
  const activeBranches = db.prepare('SELECT id FROM branches WHERE is_active = 1 ORDER BY is_main DESC, code');

  /** يبني ctx.user و ctx.access لمستخدم. يعيد null إن كان غير موجود أو معطّلًا. */
  function load(userId) {
    const u = userRow.get(userId);
    if (!u || u.is_active !== 1) return null;
    const isSuperAdmin = u.is_super_admin === 1;
    const allBranches = isSuperAdmin || u.all_branches === 1;
    // صلاحيات لم تعد في الكتالوج (وحدة أُزيلت مثلًا) تُتجاهل.
    const perms = new Set(isSuperAdmin ? permissions.keys() : permsOf.all(userId).map((r) => r.permission).filter((p) => permissions.has(p)));
    const explicit = new Set(branchesOf.all(userId).map((r) => r.branch_id));

    const user = {
      id: u.id, username: u.username, displayName: u.display_name, isSuperAdmin, allBranches,
      mustChangePassword: u.must_change_password === 1, defaultBranchId: u.default_branch_id,
      permissions: perms,
    };

    const branchAllowed = (id) => allBranches || explicit.has(id);
    const access = {
      allBranches,
      can: (p) => isSuperAdmin || perms.has(p),
      /** معرّفات الفروع المصرح بها صراحة (للمستخدم المحدود النطاق). */
      branchIds: () => [...explicit],
      branchAllowed,
      assertBranch(id) {
        if (!branchAllowed(id)) throw new HttpError(403, 'BRANCH_FORBIDDEN', 'لا تملك صلاحية الوصول لهذا الفرع');
      },
      /** فروع نشطة مصرح بها — تُستخدم لاختيار الفرع الحالي وللمستندات الجديدة. */
      operationalBranchIds: () => activeBranches.all().map((r) => r.id).filter(branchAllowed),
      /**
       * نطاق التقارير: 'all' (أو بلا قيمة) = كل الفروع المصرح بها، أو معرّف فرع واحد بعد التحقق منه.
       * يعيد { all: true } لمن يملك جميع الفروع، أو { all: false, ids: [...] }.
       */
      scope(requested) {
        if (requested === undefined || requested === null || requested === '' || requested === 'all') {
          return allBranches ? { all: true, ids: null } : { all: false, ids: [...explicit] };
        }
        const id = typeof requested === 'number' ? requested : (/^[1-9]\d{0,15}$/.test(String(requested)) ? Number(requested) : NaN);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'BAD_BRANCH', 'معرّف فرع غير صالح');
        access.assertBranch(id);
        return { all: false, ids: [id] };
      },
      /** شرط SQL جاهز لتقييد أي استعلام بنطاق الفروع (عمود الفرع يجب أن يكون اسمًا آمنًا). */
      sqlFilter(column, requested) {
        if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) throw new Error('اسم عمود غير آمن');
        const s = access.scope(requested);
        if (s.all) return { sql: '1 = 1', params: [] };
        if (!s.ids.length) return { sql: '0 = 1', params: [] };
        return { sql: `${column} IN (${s.ids.map(() => '?').join(', ')})`, params: s.ids };
      },
    };
    return { user, access };
  }

  return { load };
}

/**
 * حماية من تصعيد الصلاحيات: من ليس مديرًا عامًا لا يستطيع منح أكثر مما يملك
 * (صلاحيات أو فروع)، ولا إدارة مستخدم أقوى منه أو خارج نطاق فروعه.
 */
function createGrantGuard({ db }) {
  const rolePerms = (roleIds) => (roleIds.length
    ? db.prepare(`SELECT DISTINCT permission FROM role_permissions WHERE role_id IN (${roleIds.map(() => '?').join(',')})`).all(...roleIds).map((r) => r.permission)
    : []);
  const userRoleIds = (userId) => db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(userId).map((r) => r.role_id);
  const userBranchIds = (userId) => db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(userId).map((r) => r.branch_id);

  function assertPermissionsSubset(ctx, perms) {
    if (ctx.user.isSuperAdmin) return;
    const extra = perms.filter((p) => !ctx.user.permissions.has(p));
    if (extra.length) throw new HttpError(403, 'PERMISSION_ESCALATION', 'لا يمكنك منح صلاحيات لا تملكها', { permissions: extra });
  }

  return {
    rolePerms,
    assertPermissionsSubset,
    /** ما سيُمنح لمستخدم: أدوار + نطاق فروع + صفة المدير العام. */
    assertCanGrant(ctx, { roleIds = [], branchIds = [], allBranches = false, isSuperAdmin = false }) {
      if (ctx.user.isSuperAdmin) return;
      if (isSuperAdmin) throw new HttpError(403, 'SUPER_ADMIN_ONLY', 'هذا الإجراء للمدير العام فقط');
      if (allBranches && !ctx.access.allBranches) throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'لا يمكنك منح نطاق فروع أوسع من نطاقك');
      if (!branchIds.every((b) => ctx.access.branchAllowed(b))) throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'لا يمكنك منح نطاق فروع أوسع من نطاقك');
      assertPermissionsSubset(ctx, rolePerms(roleIds));
    },
    /** هل يحق للمستخدم الحالي إدارة هذا المستخدم أصلًا؟ */
    assertCanManage(ctx, target) {
      if (ctx.user.isSuperAdmin) return;
      if (target.is_super_admin === 1) throw new HttpError(403, 'SUPER_ADMIN_ONLY', 'إدارة المدير العام للمدير العام فقط');
      if (!ctx.access.allBranches && (target.all_branches === 1 || !userBranchIds(target.id).every((b) => ctx.access.branchAllowed(b)))) {
        throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'المستخدم خارج نطاق فروعك');
      }
      assertPermissionsSubset(ctx, rolePerms(userRoleIds(target.id)));
    },
  };
}

module.exports = { createAccessLoader, createGrantGuard };
