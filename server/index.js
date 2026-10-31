'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./core/config');
const { createLogger } = require('./core/logger');
const { createApp } = require('./app');

/** العنوان الذي يفتحه المستخدم في المتصفح (0.0.0.0 أو :: ليسا عنوانًا يُفتح). */
function browserUrl(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ dir: config.logDir, echo: process.env.TAYL_DEBUG === '1' });
  let app;
  try {
    app = await createApp({ config, logger });
    const addr = await app.listen();
    fs.writeFileSync(config.pidFile, String(process.pid));
    const url = browserUrl(config.host, addr.port);
    logger.info('TAYL started', { url });
    // يظهر في الطرفية عند npm start (والتشغيل المخفي على ويندوز لا يتأثر).
    process.stdout.write(`\nTAYL is running — open: ${url}\nPress Ctrl+C to stop.\n\n`);
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      logger.warn('port in use — another TAYL instance is probably running', { port: config.port });
      process.stdout.write(`\nTAYL is already running — open: ${browserUrl(config.host, config.port)}\n\n`);
      process.exit(0);
    }
    logger.error('startup failed', { err: String(e && e.stack || e) });
    process.stderr.write(`\nTAYL failed to start. Details in: ${config.logDir}\n\n`);
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
