'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOrder } = require('../server/core/module-loader');

const M = (name, dependsOn = []) => ({ name, dependsOn, register() {} });

test('modules: الترتيب يحترم الاعتماديات', () => {
  const o = resolveOrder([M('sales', ['inventory', 'system']), M('inventory', ['system']), M('system')]).map((m) => m.name);
  assert.deepEqual(o, ['system', 'inventory', 'sales']);
});
test('modules: اعتماد دائري يُرفض', () => {
  assert.throws(() => resolveOrder([M('a', ['b']), M('b', ['a'])]), /دائري/);
});
test('modules: اعتماد على وحدة غير موجودة / اسم مكرر / بلا اسم', () => {
  assert.throws(() => resolveOrder([M('a', ['ghost'])]), /غير موجودة/);
  assert.throws(() => resolveOrder([M('a'), M('a')]), /مكرر/);
  assert.throws(() => resolveOrder([{ register() {} }]), /بلا اسم/);
});
