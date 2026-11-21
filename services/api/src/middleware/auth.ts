import type { Request, RequestHandler } from 'express';
import { AUTH_COOKIE, verifyToken } from '../auth/tokens';
import type { Env } from '../env';
import { HttpError } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: { userId: string };
  }
}

/**
 * Rejects the request with 401 unless it carries a valid session.
 * Accepts the httpOnly cookie (browser) or `Authorization: Bearer <token>` (scripts/tests).
 */
export function requireAuth(env: Env): RequestHandler {
  return (req, _res, next) => {
    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = (req.cookies as Record<string, string> | undefined)?.[AUTH_COOKIE] ?? bearer;
    const userId = token ? verifyToken(token, env) : null;
    if (!userId) {
      next(new HttpError(401, 'Please log in to continue'));
      return;
    }
    req.auth = { userId };
    next();
  };
}

/** The authenticated user id. Ownership always comes from here — never from the request body. */
export function currentUserId(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'Please log in to continue');
  return req.auth.userId;
}
