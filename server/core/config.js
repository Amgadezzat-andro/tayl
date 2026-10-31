'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  host: '127.0.0.1',          // محلي فقط. للشبكة الداخلية لاحقًا: '0.0.0.0' + إعداد صريح
  port: 3737,
  dataDir: path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, 'public'),
  backupRetention: 30,
  maxBodyBytes: 1024 * 1024,
  allowedHosts: null,         // null = يُشتق تلقائيًا من host/port
};

/** الأولوية: متغيرات البيئة > data/config.json > القيم الافتراضية */
function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir || process.env.TAYL_DATA_DIR || DEFAULTS.dataDir;
  let fileCfg = {};
  const cfgPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { throw new Error(`config.json غير صالح: ${e.message}`); }
  }
  const env = {};
  if (process.env.TAYL_HOST) env.host = process.env.TAYL_HOST;
  if (process.env.TAYL_PORT) env.port = Number(process.env.TAYL_PORT);

  const cfg = { ...DEFAULTS, ...fileCfg, ...env, ...overrides, dataDir };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error('رقم المنفذ غير صالح');
  cfg.dbFile = cfg.dbFile || path.join(dataDir, 'tayl.db');
  cfg.backupDir = cfg.backupDir || path.join(dataDir, 'backups');
  cfg.logDir = cfg.logDir || path.join(dataDir, 'logs');
  cfg.pidFile = cfg.pidFile || path.join(dataDir, 'tayl.pid');
  return Object.freeze(cfg);
}

module.exports = { loadConfig, ROOT };
