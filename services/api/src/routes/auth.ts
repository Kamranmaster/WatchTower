import { Router } from 'express';
import { loginSchema, registerSchema, updateProfileSchema } from '@monitorly/contracts';
import { User } from '@monitorly/database';
import type { AppDeps } from '../app';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/passwords';
import { clearAuthCookie, setAuthCookie, signToken } from '../auth/tokens';
import { currentUserId, requireAuth } from '../middleware/auth';
import { HttpError, isDuplicateKeyError } from '../middleware/errors';
import { authRateLimit } from '../middleware/security';
import { serializeUser } from '../serializers';

export function authRouter({ env, logger }: AppDeps): Router {
  const router = Router();
  const limiter = authRateLimit(env.AUTH_RATE_LIMIT);

  router.post('/register', limiter, async (req, res) => {
    const input = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password, env.BCRYPT_ROUNDS);

    let user;
    try {
      user = await User.create({ name: input.name, email: input.email, passwordHash });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new HttpError(409, 'An account with this email already exists', [
          { path: 'email', message: 'An account with this email already exists' },
        ]);
      }
      throw err;
    }

    logger.info({ userId: user.id }, 'User registered');
    setAuthCookie(res, signToken(user.id, env), env);
    res.status(201).json({ user: serializeUser(user) });
  });

  router.post('/login', limiter, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await User.findOne({ email: input.email }).select('+passwordHash');

    // Always run bcrypt, even for unknown emails, so response time doesn't reveal which emails exist.
    const hash = user?.passwordHash ?? (await getDummyHash(env.BCRYPT_ROUNDS));
    const valid = await verifyPassword(input.password, hash);
    if (!user || !valid) {
      throw new HttpError(401, 'Incorrect email or password');
    }

    setAuthCookie(res, signToken(user.id, env), env);
    res.json({ user: serializeUser(user) });
  });

  router.post('/logout', (_req, res) => {
    clearAuthCookie(res, env);
    res.status(204).end();
  });

  router.get('/me', requireAuth(env), async (req, res) => {
    const user = await User.findById(currentUserId(req));
    if (!user) {
      // Valid token but the account is gone.
      clearAuthCookie(res, env);
      throw new HttpError(401, 'Please log in to continue');
    }
    res.json({ user: serializeUser(user) });
  });

  /** Account settings: display name, the account-wide email switch, the default check interval. */
  router.patch('/me', requireAuth(env), async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    const user = await User.findByIdAndUpdate(currentUserId(req), { $set: input }, { new: true, runValidators: true });
    if (!user) {
      clearAuthCookie(res, env);
      throw new HttpError(401, 'Please log in to continue');
    }
    logger.info({ userId: user.id, fields: Object.keys(input) }, 'Account settings updated');
    res.json({ user: serializeUser(user) });
  });

  return router;
}
