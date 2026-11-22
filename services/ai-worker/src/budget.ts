import { AiUsage, isDuplicateKeyError } from '@monitorly/database';

export interface AiLimits {
  /** AI calls per user per UTC day. */
  perUserDaily: number;
  /** AI calls for the whole installation per UTC day (protects the provider quota). */
  globalDaily: number;
}

const DAY_MS = 86_400_000;
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Atomically takes one unit if the counter is under the limit. */
async function take(key: string, limit: number, now: Date): Promise<boolean> {
  // At the limit the filter doesn't match, so the upsert tries to insert the same _id and fails.
  // A duplicate key can also mean another call created today's counter at the same moment: the
  // second try then finds the counter and increments it (or hits the real limit).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await AiUsage.updateOne(
        { _id: key, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + 2 * DAY_MS) } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
  return false;
}

async function giveBack(key: string): Promise<void> {
  await AiUsage.updateOne({ _id: key, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

/** Reserves one AI call for this user today. False = a daily limit is reached. */
export async function reserveAiCall(userId: string, limits: AiLimits, now = new Date()): Promise<boolean> {
  if (limits.perUserDaily <= 0 || limits.globalDaily <= 0) return false;
  const day = dayOf(now);
  const userKey = `user:${userId}:${day}`;
  if (!(await take(userKey, limits.perUserDaily, now))) return false;
  if (!(await take(`global:${day}`, limits.globalDaily, now))) {
    await giveBack(userKey);
    return false;
  }
  return true;
}

/** Returns a reservation when the provider was never reached (e.g. it said "rate limited"). */
export async function releaseAiCall(userId: string, now = new Date()): Promise<void> {
  const day = dayOf(now);
  await Promise.all([giveBack(`user:${userId}:${day}`), giveBack(`global:${day}`)]);
}

/** Spaces out calls (free tiers allow only a few requests per minute). One per process. */
export function createThrottle(minIntervalMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}
