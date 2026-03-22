// ── Standardised API error responses ──────────────────────────────────────────

import type { FastifyReply } from 'fastify';

interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly error: string = 'Error',
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON(): ApiErrorBody {
    return {
      statusCode: this.statusCode,
      error: this.error,
      message: this.message,
    };
  }
}

// ── Convenience factories ────────────────────────────────────────────────────

export function badRequest(message = 'Bad Request'): ApiError {
  return new ApiError(400, message, 'Bad Request');
}

export function unauthorized(message = 'Unauthorized'): ApiError {
  return new ApiError(401, message, 'Unauthorized');
}

export function forbidden(message = 'Forbidden'): ApiError {
  return new ApiError(403, message, 'Forbidden');
}

export function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message, 'Not Found');
}

export function conflict(message = 'Conflict'): ApiError {
  return new ApiError(409, message, 'Conflict');
}

export function internal(message = 'Internal Server Error'): ApiError {
  return new ApiError(500, message, 'Internal Server Error');
}

// ── Fastify error handler ────────────────────────────────────────────────────

export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof ApiError) {
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  reply.status(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message,
  });
}
