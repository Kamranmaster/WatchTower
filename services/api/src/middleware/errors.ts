import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '@monitorly/logger';

/** Throw from a route to send a specific status and message to the client. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    /** Machine-readable reason, for clients that react to specific failures. */
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** MongoDB E11000: a unique index rejected the write. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route not found: ${req.method} ${req.path}`));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details, code: err.code });
      return;
    }
    // Malformed JSON body from express.json()
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body is not valid JSON' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large' });
      return;
    }
    logger.error({ err }, 'Unhandled request error');
    // Never leak internals to the client.
    res.status(500).json({ error: 'Internal server error' });
  };
}
