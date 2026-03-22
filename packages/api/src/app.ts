// ── Fastify app factory ──────────────────────────────────────────────────────
// Creates and configures the Fastify instance with all plugins and routes.
// Separated from index.ts so tests can import the app without starting the server.

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { createLoggerOptions } from './utils/logger.js';
import { config } from './config.js';

// Route modules
import { authRoutes } from './modules/auth/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { usageRoutes } from './modules/usage/routes.js';
import { emailRoutes } from './modules/emails/routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createLoggerOptions(),
    // Increase body size limit for batch ingest
    bodyLimit: 2 * 1024 * 1024, // 2 MB
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: config.isDev ? true : config.appUrl,
    credentials: true,
  });

  await app.register(sensible);

  await app.register(cookie);

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0-alpha.1',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // ── API routes (all prefixed under /api/v1) ────────────────────────────────
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(reportRoutes);
      await api.register(usageRoutes);
      await api.register(emailRoutes);
    },
    { prefix: '/api/v1' },
  );

  // ── Global error handler ───────────────────────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 ? 'Internal Server Error' : error.message;

    if (statusCode >= 500) {
      app.log.error(error);
    }

    reply.status(statusCode).send({
      statusCode,
      error: error.name ?? 'Error',
      message,
    });
  });

  return app;
}
