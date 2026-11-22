import { ROUTES, type FetchCompleted, type ProcessingOutcome } from '@monitorly/contracts';
import { CheckRun, Event, Monitor, Snapshot, isDuplicateKeyError, mongoose, type SnapshotDoc } from '@monitorly/database';
import { diffExtractions, extractItems, type Extraction } from '@monitorly/extraction';
import type { Logger } from '@monitorly/logger';
import { createEnvelope, type ConsumeContext } from '@monitorly/messaging';
import { enqueueOutbox } from '@monitorly/outbox';
import { getCompressedText, itemsSnapshotKey, putCompressedText, type ObjectStore } from '@monitorly/storage';
import { buildEvents, type EventDraft } from './events';

export interface ProcessingDeps {
  store: ObjectStore;
  logger: Logger;
  wakeOutbox?: () => void;
  /** Incomplete-looking extractions in a row before the new page layout is accepted as baseline. */
  rebaselineAfter?: number;
}

export type HandleResult =
  | 'ignored' // monitor/snapshot deleted
  | 'duplicate' // already processed (redelivery)
  | 'stale' // older than the baseline, or from before a URL/type change
  | ProcessingOutcome;

/** The baseline moved while we were comparing: start over against the new one. */
class BaselineMoved extends Error {}

const MAX_TRIES = 5;

/**
 * One fetch.completed message → extract items → compare with the baseline → events.
 *
 * Guarantees:
 *  - Deleted monitors/snapshots: ignored, never an error.
 *  - Duplicates: a processed snapshot is never processed again; event fingerprints are unique.
 *  - Order: only a snapshot newer than the baseline can replace it. The comparison, the events and
 *    the baseline update commit in one transaction that also checks the baseline is still the one
 *    compared against; if another check moved it meanwhile, we start over.
 */
export async function handleFetchCompleted(deps: ProcessingDeps, msg: FetchCompleted, ctx: ConsumeContext): Promise<HandleResult> {
  const log = deps.logger.child({ monitorId: msg.monitorId, checkRunId: msg.checkRunId, attempt: ctx.attempt });
  const rebaselineAfter = deps.rebaselineAfter ?? 3;

  const snapshot = await Snapshot.findById(msg.snapshotId);
  if (!snapshot) return done(log, 'ignored', 'snapshot no longer exists (monitor deleted)');
  if (snapshot.processedAt) return done(log, 'duplicate', 'snapshot already processed');
  const run = await CheckRun.findById(snapshot.checkRunId, { createdAt: 1 }).lean();
  if (!run) return done(log, 'ignored', 'check run no longer exists (monitor deleted)');

  let html: string | undefined;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const monitor = await Monitor.findById(msg.monitorId).lean();
    if (!monitor) return done(log, 'ignored', 'monitor no longer exists');

    // Scheduled before the URL or page type changed: it describes a different page.
    if (monitor.baselineResetAt && run.createdAt < monitor.baselineResetAt) {
      if (!(await markStale(snapshot, 'scheduled before the monitor’s URL or page type changed'))) {
        return done(log, 'duplicate', 'already processed');
      }
      return done(log, 'stale', 'check predates a URL/type change');
    }

    const baselineId = monitor.lastSnapshotId ?? null;
    // A copy of this message already made this snapshot the baseline (parallel duplicate delivery).
    if (baselineId && String(baselineId) === String(snapshot._id)) return done(log, 'duplicate', 'snapshot is already the baseline');
    const baseline = baselineId ? await Snapshot.findById(baselineId).lean() : null;
    if (baseline && baseline.capturedAt >= snapshot.capturedAt) {
      if (!(await markStale(snapshot, 'older than the current baseline'))) return done(log, 'duplicate', 'already processed');
      return done(log, 'stale', 'result arrived after a newer one was already processed');
    }

    let before: Extraction | null = null;
    if (baseline?.extractedObjectKey) {
      try {
        before = JSON.parse(await getCompressedText(deps.store, baseline.extractedObjectKey)) as Extraction;
      } catch (err) {
        log.warn({ err }, 'Baseline items unreadable; treating this check as a new baseline');
      }
    }

    try {
      html ??= await getCompressedText(deps.store, snapshot.rawObjectKey);
    } catch (err) {
      // The monitor may have been deleted while we worked (its objects go with it).
      if (!(await Monitor.exists({ _id: msg.monitorId }))) return done(log, 'ignored', 'monitor deleted during processing');
      throw err; // storage hiccup: retry with backoff
    }

    const after = extractItems(html, {
      baseUrl: snapshot.finalUrl ?? monitor.url,
      monitorType: monitor.monitorType,
      template: before?.template,
    });
    const itemsKey = itemsSnapshotKey(msg.monitorId, msg.checkRunId);
    await putCompressedText(deps.store, itemsKey, JSON.stringify(after), 'application/json');

    // ---- Decide
    let outcome: ProcessingOutcome;
    let advanceBaseline = true;
    let drafts: EventDraft[] = [];
    let counts = { added: 0, updated: 0, removed: 0, pageChanged: false };
    let truncated = false;
    let note: string | undefined;
    let incompleteStreak = 0;

    if (!before) {
      outcome = 'baseline'; // first check: nothing to compare with, so no alerts
    } else {
      const diff = diffExtractions(before, after);
      if (diff.kind === 'unchanged') outcome = 'unchanged';
      else if (diff.kind === 'incomplete') {
        incompleteStreak = (monitor.incompleteStreak ?? 0) + 1;
        if (incompleteStreak >= rebaselineAfter) {
          outcome = 'rebaselined'; // consistently different: a real redesign, accept it quietly
          incompleteStreak = 0;
        } else {
          outcome = 'incomplete';
          advanceBaseline = false;
        }
        note = diff.reason;
      } else {
        outcome = 'changed';
        ({ drafts, counts, truncated } = buildEvents(diff, after, snapshot.finalUrl ?? monitor.url));
      }
    }

    // ---- Commit atomically
    try {
      const committed = await mongoose.connection.transaction(async (session) => {
        const current = await Monitor.findById(msg.monitorId, { lastSnapshotId: 1 }).session(session).lean();
        if (!current) return { result: 'ignored' as const, eventIds: [] as string[] };
        if (String(current.lastSnapshotId ?? '') !== String(baselineId ?? '')) throw new BaselineMoved();

        const now = new Date();
        const marked = await Snapshot.updateOne(
          { _id: snapshot._id, processedAt: { $exists: false } },
          {
            $set: {
              processedAt: now,
              processingStatus: outcome,
              extractedObjectKey: itemsKey,
              itemCount: after.items.length,
              normalizedHash: after.contentHash,
              extractionStrategy: after.strategy,
            },
          },
          { session },
        );
        if (marked.modifiedCount !== 1) return { result: 'duplicate' as const, eventIds: [] as string[] };

        // Fingerprints already seen (an earlier check reported the same change) are skipped.
        let eventIds: string[] = [];
        if (drafts.length > 0) {
          const existing = new Set(
            (await Event.find({ monitorId: msg.monitorId, fingerprint: { $in: drafts.map((d) => d.fingerprint) } }, { fingerprint: 1 })
              .session(session)
              .lean()).map((e) => e.fingerprint),
          );
          const fresh = drafts.filter((d) => !existing.has(d.fingerprint));
          if (fresh.length > 0) {
            const inserted = await Event.insertMany(
              fresh.map((d) => ({
                ...d,
                monitorId: msg.monitorId,
                userId: msg.userId,
                checkRunId: msg.checkRunId,
                snapshotId: snapshot._id,
                detectedAt: now,
              })),
              { session },
            );
            eventIds = inserted.map((e) => String(e._id));
          }
        }

        await Monitor.updateOne(
          { _id: msg.monitorId, lastSnapshotId: baselineId },
          advanceBaseline
            ? {
                $set: {
                  lastSnapshotId: snapshot._id,
                  baselineCapturedAt: snapshot.capturedAt,
                  baselineItemCount: after.items.length,
                  incompleteStreak: 0,
                  ...(eventIds.length > 0 ? { lastChangeAt: now } : {}),
                },
              }
            : { $set: { incompleteStreak } },
          { session },
        );

        await CheckRun.updateOne(
          { _id: snapshot.checkRunId },
          { $set: { outcome, changeCount: eventIds.length, ...(note ? { error: note } : {}) } },
          { session },
        );

        await enqueueOutbox(
          ROUTES.contentProcessed,
          {
            ...createEnvelope(),
            checkRunId: msg.checkRunId,
            monitorId: msg.monitorId,
            userId: msg.userId,
            snapshotId: String(snapshot._id),
            outcome,
            eventIds,
            counts,
            truncated,
            itemCount: after.items.length,
            processedAt: now.toISOString(),
          },
          session,
        );
        return { result: outcome, eventIds };
      });

      deps.wakeOutbox?.();
      log.info(
        { outcome: committed.result, events: committed.eventIds.length, items: after.items.length, strategy: after.strategy, ...counts },
        'Processed',
      );
      return committed.result;
    } catch (err) {
      // Another check moved the baseline, or inserted the same event first: redo against the new state.
      if (err instanceof BaselineMoved || isDuplicateKeyError(err)) {
        log.debug({ attempt }, 'Baseline changed during processing; retrying');
        continue;
      }
      throw err;
    }
  }
  throw new Error('The baseline kept changing while processing; will retry');
}

/** Marks the snapshot stale unless something already processed it. Returns false if it was already processed. */
async function markStale(snapshot: SnapshotDoc, reason: string): Promise<boolean> {
  const marked = await Snapshot.updateOne(
    { _id: snapshot._id, processedAt: { $exists: false } },
    { $set: { processedAt: new Date(), processingStatus: 'stale' } },
  );
  // Never overwrite the outcome recorded by the delivery that did process it.
  if (marked.modifiedCount !== 1) return false;
  await CheckRun.updateOne({ _id: snapshot.checkRunId }, { $set: { outcome: 'stale', changeCount: 0, error: `Not compared: ${reason}` } });
  return true;
}

function done(log: Logger, result: HandleResult, reason: string): HandleResult {
  log.info({ result, reason }, 'Nothing to process');
  return result;
}
