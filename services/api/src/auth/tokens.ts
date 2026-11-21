import type { CookieOptions, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Env } from '../env';

export const AUTH_COOKIE = 'monitorly_session';
const ISSUER = 'monitorly-api';
const AUDIENCE = 'monitorly-web';

export function signToken(userId: string, env: Env): string {
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: `${env.JWT_EXPIRES_IN_DAYS}d`,
  });
}

/** Returns the user id, or null if the token is missing, expired, tampered with or malformed. */
export function verifyToken(token: string, env: Env): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'], // never accept "none" or a different algorithm
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * httpOnly: JavaScript (and therefore XSS) can't read the token.
 * sameSite=lax: the browser won't attach it to cross-site POSTs (CSRF protection).
 * secure: HTTPS-only in production.
 */
function cookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  };
}

export function setAuthCookie(res: Response, token: string, env: Env): void {
  res.cookie(AUTH_COOKIE, token, { ...cookieOptions(env), maxAge: env.JWT_EXPIRES_IN_DAYS * 24 * 3600 * 1000 });
}

export function clearAuthCookie(res: Response, env: Env): void {
  res.clearCookie(AUTH_COOKIE, cookieOptions(env));
}
