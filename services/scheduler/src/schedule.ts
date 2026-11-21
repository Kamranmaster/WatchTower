import { ROUTES, fetchJobSchema, type FetchMode } from '@monitorly/contracts';
import { CheckRun, Monitor, OutboxMessage, isDuplicateKeyError, mongoose } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';

const MINUTE = 60_000;

export type ScheduleOutcome = 'scheduled' | 'skipped' | 'duplicate';

export interface ScheduleResult {
  scheduled: number;
  skipped: number;
  duplicate: number;
}

/**
 * The schedule slot a check belongs to: its due time rounded down to the minute.
 * The unique index on (monitorId, scheduledFor) allows one CheckRun per slot, so the same
 * check can never be scheduled twice — not by two schedulers, not by a retry.
 * (Intervals are at least 5 minutes, so two legitimate checks never share a minute.)
 */
export function slotFor(dueAt: Date): Date {
  return new Date(Math.floor(dueAt.getTime() / MINUTE) * MINUTE);
}

/**
 * Next due time.
 *  - On time (or a little late): keep the cadence, dueAt + interval.
 *  - Badly late (scheduler was down, backlog): start the cadence again from now. This skips
 *    missed slots instead of firing a burst of catch-up checks, and guarantees two checks are
 *    never less than half an interval apart.
 */
export function nextCheckAfter(dueAt: Date, intervalMinutes: number, now: Date): Date {
  const step = intervalMinutes * MINUTE;
  const onCadence = dueAt.getTime() + step;
  if (onCadence - now.getTime() >= step / 2) return new Date(onCadence);
  return new Date(now.getTime() + step);
}

/** "auto" uses whatever worked last time, defaulting to the cheap HTTP fetch. */
export function fetchModeFor(monitor: { fetchMode?: string | null; resolvedFetchMode?: string | null }): FetchMode {
  if (monitor.fetchMode === 'http' || monitor.fetchMode === 'browser') return monitor.fetchMode;
  return monitor.resolvedFetchMode === 'browser' ? 'browser' : 'http';
}

/**
 * Atomically, in one MongoDB transaction:
 *   1. claim the monitor (advance nextCheckAt, only if it is still the value we saw as due)
 *   2. create the CheckRun for this slot
 *   3. write the fetch job to the outbox
 * Either all three happen or none do, so a crash can't leave a run without a message
 * (or a message without a run). The outbox relay publishes the message afterwards.
 */
export async function scheduleMonitor(monitorId: string, dueAt: Date, now: Date): Promise<ScheduleOutcome> {
  try {
    return await mongoose.connection.transaction(async (session) => {
      // Snapshot read inside the transaction. If anything else modifies this monitor before we
      // commit (another scheduler, the API), our write conflicts and the transaction retries.
      const monitor = await Monitor.findOne({ _id: monitorId, status: 'active', nextCheckAt: dueAt }).session(session).lean();
      if (!monitor) return 'skipped'; // paused, deleted, rescheduled, or already claimed

      const next = nextCheckAfter(dueAt, monitor.checkIntervalMinutes, now);
      const claimed = await Monitor.updateOne(
        { _id: monitorId, status: 'active', nextCheckAt: dueAt },
        { $set: { nextCheckAt: next } },
        { session },
      );
      if (claimed.modifiedCount !== 1) return 'skipped';

      const scheduledFor = slotFor(dueAt);
      const [run] = await CheckRun.create(
        [{ monitorId: monitor._id, userId: monitor.userId, scheduledFor, status: 'queued' }],
        { session },
      );

      const fetchMode = fetchModeFor(monitor);
      const route = fetchMode === 'browser' ? ROUTES.fetchBrowser : ROUTES.fetchHttp;
      // Validate now: a bad message must fail the transaction, not sit in the outbox.
      const payload = fetchJobSchema.parse({
        ...createEnvelope(),
        checkRunId: run!.id,
        monitorId: String(monitor._id),
        userId: String(monitor.userId),
        url: monitor.url,
        fetchMode,
        scheduledAt: scheduledFor.toISOString(),
      });
      await OutboxMessage.create(
        [{ messageId: payload.messageId, exchange: route.exchange, routingKey: route.routingKey, payload }],
        { session },
      );
      return 'scheduled';
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // A CheckRun for this slot already exists (e.g. the monitor was resumed twice within a minute).
    // The transaction rolled back, so still move nextCheckAt on — otherwise it stays due forever.
    const monitor = await Monitor.findOne({ _id: monitorId, nextCheckAt: dueAt }, { checkIntervalMinutes: 1 }).lean();
    if (monitor) {
      await Monitor.updateOne(
        { _id: monitorId, nextCheckAt: dueAt },
        { $set: { nextCheckAt: nextCheckAfter(dueAt, monitor.checkIntervalMinutes, now) } },
      );
    }
    return 'duplicate';
  }
}

export interface ScheduleDueOptions {
  partitions: number[];
  now: Date;
  batchSize: number;
  concurrency?: number;
  logger: Logger;
}

/** Schedules up to batchSize due monitors from the given partitions, most overdue first. */
export async function scheduleDueMonitors(options: ScheduleDueOptions): Promise<ScheduleResult> {
  const { partitions, now, batchSize, concurrency = 8, logger } = options;
  const result: ScheduleResult = { scheduled: 0, skipped: 0, duplicate: 0 };
  if (partitions.length === 0) return result;

  // Uses the { status, partitionId, nextCheckAt } index.
  const due = await Monitor.find(
    { status: 'active', partitionId: { $in: partitions }, nextCheckAt: { $lte: now } },
    { _id: 1, nextCheckAt: 1 },
  )
    .sort({ nextCheckAt: 1 })
    .limit(batchSize)
    .lean();

  let index = 0;
  const worker = async () => {
    while (index < due.length) {
      const monitor = due[index++]!;
      try {
        result[await scheduleMonitor(String(monitor._id), monitor.nextCheckAt, now)]++;
      } catch (err) {
        // One bad monitor must not block the rest; it stays due and is retried next tick.
        logger.error({ err, monitorId: String(monitor._id) }, 'Failed to schedule monitor');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return result;
}
