import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defence in depth against CSRF on top of SameSite cookies: browsers always send
 * an Origin header on cross-site POST/PATCH/DELETE, so reject any that isn't our web app.
 * Requests without Origin (curl, server-to-server) don't carry the browser's cookies anyway.
 */
export function sameOriginOnly(allowedOrigin: string): RequestHandler {
  const allowed = new URL(allowedOrigin).origin;
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (SAFE_METHODS.has(req.method) || !origin || origin === allowed) {
      next();
      return;
    }
    next(new HttpError(403, 'Cross-origin request blocked'));
  };
}

/** Caps AI calls per user (cost control). Must run after requireAuth. */
export function aiRateLimit(limitPerHour: number): RequestHandler {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: limitPerHour,
    keyGenerator: (req) => req.auth?.userId ?? 'anonymous',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: "You've used AI setup a lot in the last hour. Fill in the filters yourself, or try again later.", code: 'ai_rate_limited' },
  });
}

/** Slows down password guessing. In-memory per process; moves to Redis when the API scales out. */
export function authRateLimit(limit: number): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  });
}
