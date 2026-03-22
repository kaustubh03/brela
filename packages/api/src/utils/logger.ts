// ── Logger configuration ─────────────────────────────────────────────────────
// Fastify ships with Pino natively. This module exports a factory for creating
// the logger options passed to the Fastify constructor.

import { config } from '../config.js';

export interface LoggerOptions {
  level: string;
  transport?: {
    target: string;
    options?: Record<string, unknown>;
  };
}

export function createLoggerOptions(): LoggerOptions {
  if (config.isDev) {
    return {
      level: 'debug',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    };
  }

  return {
    level: 'info',
  };
}
