import { createHash } from 'node:crypto';
import { ROUTES, type FetchJob, type FetchMode } from '@monitorly/contracts';
import {
  CheckRun,
  Monitor,
  Snapshot,
  TERMINAL_CHECK_RUN_STATUSES,
  isDuplicateKeyError,
  mongoose,
  type CheckRunDoc,
  type MonitorDoc,
} from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { enqueueOutbox } from '@monitorly/outbox';
import { putCompressedText, rawSnapshotKey, type ObjectStore } from '@monitorly/storage';
import type { FetchError } from './errors';

/**
 * The database/storage steps every fetch worker shares. Each step is idempotent: a message can
 * be delivered more than once (crash before ack, outbox re-publish), so repeating it is harmless.
 */

export interface PipelineDeps {
  store: ObjectStore;
  logger: Logger;
  /** Wake the worker's outbox relay so results are published immediately. */
  wakeOutbox?: () => void;
  /** Consecutive failed checks before a monitor is put in "error" (and no longer scheduled). */
  errorThreshold: number;
}

const NOT_FINISHED = { $nin: [...TERMINAL_CHECK_RUN_STATUSES] };

export type BeginResult =
  | { kind: 'proceed'; monitor: MonitorDoc; run: CheckRunDoc }
  | { kind: 'done'; reason: string };

/** Loads the run and its monitor, decides whether to work on it, and marks it running. */
export async function beginRun(job: FetchJob, attempt: number, options: { worker: FetchMode }): Promise<BeginResult> {
  const run = await CheckRun.findById(job.checkRunId);
  if (!run) return { kind: 'done', reason: 'run no longer exists (monitor deleted)' };
  if ((TERMINAL_CHECK_RUN_STATUSES as readonly string[]).includes(run.status)) {
    return { kind: 'done', reason: `run already ${run.status}` };
  }
  if (options.worker === 'http' && run.escalatedToBrowser) {
    return { kind: 'done', reason: 'run was already handed to the browser worker' };
  }

  const monitor = await Monitor.findById(job.monitorId);
  if (!monitor) return { kind: 'done', reason: 'monitor no longer exists' };
  if (monitor.url !== job.url) {
    // Fetching the old URL now would store a snapshot for the wrong page.
    await CheckRun.updateOne(
      { _id: run._id, status: NOT_FINISHED },
      { $set: { status: 'skipped', error: 'Skipped: the monitor’s URL changed before this check ran', completedAt: new Date() } },
    );
    return { kind: 'done', reason: 'monitor URL changed' };
  }

  const now = new Date();
  await CheckRun.updateOne(
    { _id: run._id, status: NOT_FINISHED },
    { $set: { status: 'running', attempts: attempt, ...(run.startedAt ? {} : { startedAt: now }) } },
  );
  if (!run.startedAt) run.startedAt = now;
  return { kind: 'proceed', monitor, run };
}

export interface FetchedContent {
  finalUrl: string;
  status: number;
  contentType?: string;
  body: string;
  bytes: number;
}

/**
 * Stores the page, then in one transaction: Snapshot + run succeeded + monitor updated +
 * fetch.completed message in the outbox. The HTML goes to object storage; only a reference
 * travels through RabbitMQ.
 */
export async function recordSuccess(
  deps: PipelineDeps,
  args: { job: FetchJob; monitor: MonitorDoc; run: CheckRunDoc; page: FetchedContent; fetchMode: FetchMode },
): Promise<'recorded' | 'duplicate'> {
  const { job, monitor, run, page, fetchMode } = args;
  const contentHash = createHash('sha256').update(page.body).digest('hex');
  const key = rawSnapshotKey(job.monitorId, job.checkRunId);
  // Same key on every retry: a repeat just overwrites the object.
  await putCompressedText(deps.store, key, page.body, page.contentType ?? 'text/html; charset=utf-8');

  const now = new Date();
  try {
    await mongoose.connection.transaction(async (session) => {
      const [snapshot] = await Snapshot.create(
        [
          {
            monitorId: monitor._id,
            checkRunId: run._id,
            contentHash,
            rawObjectKey: key,
            fetchMode,
            contentType: page.contentType,
            httpStatus: page.status,
            finalUrl: page.finalUrl,
            byteSize: page.bytes,
            capturedAt: now,
          },
        ],
        { session },
      );
      await CheckRun.updateOne(
        { _id: run._id, status: NOT_FINISHED },
        {
          $set: {
            status: 'succeeded',
            fetchModeUsed: fetchMode,
            snapshotId: snapshot!._id,
            completedAt: now,
            durationMs: now.getTime() - (run.startedAt ?? now).getTime(),
          },
          $unset: { error: 1 },
        },
        { session },
      );
      await Monitor.updateOne(
        { _id: monitor._id },
        {
          $set: {
            lastCheckedAt: now,
            consecutiveFailures: 0,
            // "auto" remembers what worked, so the scheduler sends the next check straight there.
            ...(monitor.fetchMode === 'auto' ? { resolvedFetchMode: fetchMode } : {}),
          },
          $unset: { lastError: 1 },
        },
        { session },
      );
      await enqueueOutbox(
        ROUTES.fetchCompleted,
        {
          ...createEnvelope(),
          checkRunId: job.checkRunId,
          monitorId: job.monitorId,
          userId: job.userId,
          snapshotId: String(snapshot!._id),
          fetchMode,
          objectStorageKey: key,
          contentHash,
          httpStatus: page.status,
          finalUrl: page.finalUrl,
          fetchedAt: now.toISOString(),
        },
        session,
      );
    });
  } catch (err) {
    // Snapshot.checkRunId is unique: this run was already recorded by an earlier delivery.
    if (isDuplicateKeyError(err)) return 'duplicate';
    throw err;
  }
  deps.wakeOutbox?.();
  return 'recorded';
}

/**
 * Records a failed attempt. If it's the final one, the run fails and the monitor's failure count
 * goes up; after `errorThreshold` failures in a row the monitor is set to "error" (the user can
 * fix and resume it) so we stop hammering a broken page.
 */
export async function recordFailure(
  deps: PipelineDeps,
  args: { run: CheckRunDoc; monitor: MonitorDoc; error: FetchError; attempt: number; final: boolean },
): Promise<void> {
  const { run, monitor, error, attempt, final } = args;
  if (!final) {
    await CheckRun.updateOne(
      { _id: run._id, status: NOT_FINISHED },
      { $set: { status: 'queued', error: `Attempt ${attempt} failed: ${error.message}. Retrying…` } },
    );
    return;
  }

  const now = new Date();
  await mongoose.connection.transaction(async (session) => {
    await CheckRun.updateOne(
      { _id: run._id, status: NOT_FINISHED },
      {
        $set: {
          status: 'failed',
          error: error.message,
          completedAt: now,
          durationMs: now.getTime() - (run.startedAt ?? now).getTime(),
        },
      },
      { session },
    );
    const updated = await Monitor.findOneAndUpdate(
      { _id: monitor._id },
      { $inc: { consecutiveFailures: 1 }, $set: { lastError: error.message, lastCheckedAt: now } },
      { session, new: true },
    );
    if (updated && updated.status === 'active' && updated.consecutiveFailures >= deps.errorThreshold) {
      await Monitor.updateOne({ _id: monitor._id, status: 'active' }, { $set: { status: 'error' } }, { session });
      deps.logger.warn(
        { monitorId: String(monitor._id), failures: updated.consecutiveFailures },
        'Monitor failed too many times in a row; set to error',
      );
    }
  });
}

/** "auto" mode: the HTTP result wasn't usable, so hand the same run to the browser worker. */
export async function escalateToBrowser(
  deps: PipelineDeps,
  args: { job: FetchJob; run: CheckRunDoc; reason: string },
): Promise<void> {
  const { job, run, reason } = args;
  await mongoose.connection.transaction(async (session) => {
    const res = await CheckRun.updateOne(
      { _id: run._id, status: NOT_FINISHED, escalatedToBrowser: { $ne: true } },
      { $set: { status: 'queued', escalatedToBrowser: true, error: `Simple fetch not enough (${reason}); using a browser` } },
      { session },
    );
    if (res.modifiedCount !== 1) return; // already escalated by an earlier delivery
    await enqueueOutbox(ROUTES.fetchBrowser, { ...job, ...createEnvelope(), fetchMode: 'browser' }, session);
  });
  deps.wakeOutbox?.();
}
