import { hostname } from 'node:os';
import { SchedulerInstance, SchedulerLease, TOTAL_PARTITIONS, isDuplicateKeyError } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';

export type Clock = () => Date;

export interface LeaseOptions {
  instanceId: string;
  /** A lease not renewed within this time can be taken over by another instance. */
  ttlMs: number;
  logger: Logger;
  clock?: Clock;
  totalPartitions?: number;
}

/**
 * Splits the partitions fairly between live scheduler instances using leases in MongoDB.
 *
 * Each refresh(): heartbeat → renew own leases → hand back any above the fair share
 * (ceil(partitions / live instances)) → claim free or expired leases up to the fair share.
 * A crashed instance stops renewing, so its leases expire and the others take them over.
 *
 * Leases decide who *should* schedule a partition. Correctness does not depend on them alone:
 * the unique CheckRun index and the conditional monitor update still prevent duplicate runs
 * if two instances briefly overlap (clock skew, a long GC pause).
 */
export class PartitionLeaseManager {
  private owned: number[] = [];
  /** Local deadline: if renewals keep failing, stop scheduling once the leases would have expired. */
  private validUntil = 0;
  private readonly clock: Clock;
  private readonly total: number;

  constructor(private readonly options: LeaseOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.total = options.totalPartitions ?? TOTAL_PARTITIONS;
  }

  get instanceId(): string {
    return this.options.instanceId;
  }

  /** Partitions this instance may schedule right now (empty if its leases may have lapsed). */
  ownedPartitions(): number[] {
    return this.clock().getTime() < this.validUntil ? [...this.owned] : [];
  }

  async refresh(): Promise<number[]> {
    const { instanceId: me, ttlMs, logger } = this.options;
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const before = this.owned.join(',');

    // 1. Heartbeat, and count live instances to know our fair share.
    await SchedulerInstance.updateOne(
      { _id: me },
      { $set: { lastSeenAt: now, hostname: hostname(), pid: process.pid }, $setOnInsert: { startedAt: now } },
      { upsert: true },
    );
    const live = await SchedulerInstance.countDocuments({ lastSeenAt: { $gt: new Date(now.getTime() - ttlMs) } });
    const target = Math.ceil(this.total / Math.max(1, live));

    // 2. Renew leases we still hold (an expired one may already belong to someone else).
    await SchedulerLease.updateMany({ ownerId: me, expiresAt: { $gt: now } }, { $set: { expiresAt } });
    let owned = (await SchedulerLease.find({ ownerId: me, expiresAt: { $gt: now } }, { _id: 1 }).lean())
      .map((l) => l._id as number)
      .sort((a, b) => a - b);

    // 3. Hand back partitions above our fair share so a newly started instance can take them.
    if (owned.length > target) {
      const extra = owned.slice(target);
      await SchedulerLease.updateMany({ _id: { $in: extra }, ownerId: me }, { $set: { ownerId: null, expiresAt: now } });
      owned = owned.slice(0, target);
    }

    // 4. Claim free or expired partitions up to our fair share.
    if (owned.length < target) {
      const heldByOthers = new Set(
        (await SchedulerLease.find({ ownerId: { $nin: [null, me] }, expiresAt: { $gt: now } }, { _id: 1 }).lean()).map(
          (l) => l._id as number,
        ),
      );
      const mine = new Set(owned);
      // Random order so instances starting together don't all fight over partition 0, 1, 2…
      const candidates = shuffle(
        Array.from({ length: this.total }, (_, p) => p).filter((p) => !heldByOthers.has(p) && !mine.has(p)),
      );
      for (const partition of candidates) {
        if (owned.length >= target) break;
        if (await this.tryClaim(partition, now, expiresAt)) owned.push(partition);
      }
      owned.sort((a, b) => a - b);
    }

    this.owned = owned;
    this.validUntil = expiresAt.getTime();
    if (owned.join(',') !== before) {
      logger.info({ partitions: owned.length, liveInstances: live, fairShare: target }, 'Partition ownership changed');
    }
    return [...owned];
  }

  /** Atomically takes a partition if it is free or its lease has expired. */
  private async tryClaim(partition: number, now: Date, expiresAt: Date): Promise<boolean> {
    try {
      const lease = await SchedulerLease.findOneAndUpdate(
        { _id: partition, $or: [{ ownerId: null }, { expiresAt: { $lte: now } }] },
        { $set: { ownerId: this.options.instanceId, expiresAt }, $inc: { token: 1 } },
        // If the lease is held by someone else the filter doesn't match, the upsert tries to insert
        // the same _id and fails with a duplicate key: that means "taken".
        { upsert: true, new: true },
      ).lean();
      return lease?.ownerId === this.options.instanceId;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  /** On graceful shutdown: give everything back immediately instead of waiting for expiry. */
  async releaseAll(): Promise<void> {
    const now = this.clock();
    await SchedulerLease.updateMany({ ownerId: this.options.instanceId }, { $set: { ownerId: null, expiresAt: now } });
    await SchedulerInstance.deleteOne({ _id: this.options.instanceId });
    this.owned = [];
    this.validUntil = 0;
  }
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
