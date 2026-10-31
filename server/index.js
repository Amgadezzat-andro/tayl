'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./core/config');
const { createLogger } = require('./core/logger');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ dir: config.logDir, echo: process.env.TAYL_DEBUG === '1' });
  let app;
  try {
    app = await createApp({ config, logger });
    const addr = await app.listen();
    fs.writeFileSync(config.pidFile, String(process.pid));
    logger.info('TAYL started', { url: `http://${addr.address}:${addr.port}` });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') { logger.warn('port in use — another TAYL instance is probably running', { port: config.port }); process.exit(0); }
    logger.error('startup failed', { err: String(e && e.stack || e) });
    process.exit(1);
  }
  const stop = async (sig) => {
    logger.info('shutting down', { sig });
    await app.close();
    fs.rmSync(config.pidFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
main();
