// ── @brela/api — Server entrypoint ───────────────────────────────────────────

import { buildApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`🚀 Brela API running at http://${config.host}:${config.port}`);
    app.log.info(`   Environment: ${config.nodeEnv}`);
    app.log.info(`   Health check: http://${config.host}:${config.port}/health`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully…`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
