'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../server/core/config');
const { createLogger } = require('../server/core/logger');
const { createApp } = require('../server/app');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tayl-test-'));
const silent = createLogger({});

async function startApp(extra = {}) {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir, port: 0, ...extra.config });
  const app = await createApp({ config, logger: silent, modules: extra.modules });
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, dir, base, config, stop: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { tmpDir, silent, startApp };
