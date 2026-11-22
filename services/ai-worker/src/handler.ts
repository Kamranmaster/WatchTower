import { AiError, type ChangeReviewer, type ReviewItem, type ReviewVerdict } from '@monitorly/ai';
import { MAX_ATTEMPTS, ROUTES, type AiAnalyzeJob } from '@monitorly/contracts';
import { Event, Monitor, mongoose, type EventDoc } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { createEnvelope, type ConsumeContext } from '@monitorly/messaging';
import { enqueueOutbox } from '@monitorly/outbox';
import { releaseAiCall, reserveAiCall, type AiLimits } from './budget';

export interface AiWorkerDeps {
  logger: Logger;
  /** Null when no AI provider is configured: matches are passed on as the filters decided. */
  reviewer: ChangeReviewer | null;
  limits: AiLimits;
  /** Waits for the next allowed call slot. */
  throttle?: () => Promise<void>;
  wakeOutbox?: () => void;
}

export type AiResult = 'ignored' | 'duplicate' | 'reviewed' | 'fallback';

type StoredItem = { title?: string; text?: string; fields?: Record<string, string> } | null | undefined;
type LeanEvent = Pick<EventDoc, '_id' | 'eventType' | 'title' | 'description' | 'item' | 'previous'>;

/** What the AI sees of one change: title plus the details that matter for relevance. */
export function toReviewItem(event: LeanEvent): ReviewItem {
  const item = (event.eventType === 'item_removed' ? event.previous : event.item) as StoredItem;
  const fields = Object.entries(item?.fields ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  const details =
    event.eventType === 'page_changed'
      ? event.description
      : event.eventType === 'item_changed'
        ? [event.description, fields].filter(Boolean).join(' | ')
        : [fields, item?.text].filter(Boolean).join(' | ');
  return { id: String(event._id), changeType: event.eventType, title: item?.title ?? event.title, details: details || undefined };
}

/** Provider problems a retry can fix. Anything else won't get better by waiting. */
const TRANSIENT = new Set(['rate_limited', 'timeout', 'upstream']);
/** Errors where the request never did any work, so the budget unit is returned. */
const NOT_SPENT = new Set(['rate_limited', 'quota_exhausted', 'auth', 'not_configured']);

const FALLBACK_TEXT: Record<string, string> = {
  not_configured: 'AI review is not set up; the filters decided',
  budget: 'Daily AI review limit reached; the filters decided',
  quota_exhausted: 'The AI provider’s quota is used up; the filters decided',
  auth: 'The AI provider rejected the API key; the filters decided',
  rate_limited: 'The AI provider was busy; the filters decided',
  timeout: 'The AI review timed out; the filters decided',
  upstream: 'The AI provider had an error; the filters decided',
  refused: 'The AI declined to review this; the filters decided',
  bad_output: 'The AI gave an unusable answer; the filters decided',
  missing: 'The AI gave no answer for this change; the filters decided',
};

/**
 * One ai.analyze job (a batch of matched changes from one check) → one AI call → verdicts.
 *
 * Relevant changes go on to notifications; changes the AI judges irrelevant stop here (shown as
 * "Not relevant" with the AI's reason). If the AI can't decide (not configured, daily limit,
 * provider down after all retries, bad answer) the filters' decision stands and the change is
 * delivered: a missed alert is worse than an unreviewed one.
 *
 * Only events still in ai.status "pending" are touched, in one transaction with the follow-up
 * messages, so redeliveries can't alert twice.
 */
export async function handleAiAnalyze(deps: AiWorkerDeps, msg: AiAnalyzeJob, ctx: ConsumeContext): Promise<AiResult> {
  const log = deps.logger.child({ monitorId: msg.monitorId, checkRunId: msg.checkRunId, attempt: ctx.attempt });

  const monitor = await Monitor.findById(msg.monitorId, { instruction: 1, url: 1 }).lean();
  if (!monitor) {
    log.info('Monitor no longer exists; ignoring');
    return 'ignored';
  }
  const events = await Event.find({ _id: { $in: msg.eventIds }, monitorId: msg.monitorId, 'ai.status': 'pending' }).lean();
  if (events.length === 0) {
    log.info('Changes already reviewed (or deleted)');
    return 'duplicate';
  }

  if (!deps.reviewer) return fallback(deps, msg, events, 'skipped', 'not_configured', log);
  if (!(await reserveAiCall(msg.userId, deps.limits))) return fallback(deps, msg, events, 'skipped', 'budget', log);

  let verdicts: Map<string, ReviewVerdict>;
  let model: string;
  try {
    await deps.throttle?.();
    const result = await deps.reviewer.review({ instruction: monitor.instruction, url: monitor.url, items: events.map(toReviewItem) });
    verdicts = result.verdicts;
    model = result.model;
    log.info({ model, items: events.length, verdicts: verdicts.size, usage: result.usage }, 'AI review done');
  } catch (err) {
    const code = err instanceof AiError ? err.code : 'upstream';
    if (NOT_SPENT.has(code)) await releaseAiCall(msg.userId);
    if (TRANSIENT.has(code) && ctx.attempt < MAX_ATTEMPTS) {
      log.warn({ err, code }, 'AI review failed; will retry');
      throw err;
    }
    log.warn({ err, code }, 'AI review failed; passing the matches on as the filters decided');
    const status = code === 'quota_exhausted' || code === 'auth' ? 'skipped' : 'failed';
    return fallback(deps, msg, events, status, code, log);
  }

  const now = new Date();
  const counts = await mongoose.connection.transaction(async (session) => {
    const c = { relevant: 0, notRelevant: 0, unanswered: 0 };
    for (const event of events) {
      const v = verdicts.get(String(event._id));
      const alert = !v || v.relevant;
      const set: Record<string, unknown> = v
        ? {
            'ai.status': 'done',
            'ai.relevant': v.relevant,
            'ai.relevanceScore': v.score,
            'ai.summary': v.summary || undefined,
            'ai.reason': v.reason || undefined,
            'ai.model': model,
            'ai.analyzedAt': now,
          }
        : { 'ai.status': 'failed', 'ai.error': FALLBACK_TEXT.missing, 'ai.analyzedAt': now };
      if (alert) set.alertedAt = now;
      const updated = await Event.updateOne({ _id: event._id, 'ai.status': 'pending' }, { $set: set }, { session });
      if (updated.modifiedCount !== 1) continue;
      if (!v) c.unanswered++;
      else if (v.relevant) c.relevant++;
      else c.notRelevant++;
      if (alert) await announce(msg, event, Boolean(v), session);
    }
    return c;
  });
  deps.wakeOutbox?.();
  log.info(counts, 'AI verdicts saved');
  return 'reviewed';
}

async function announce(msg: AiAnalyzeJob, event: LeanEvent, aiReviewed: boolean, session: mongoose.ClientSession) {
  await enqueueOutbox(
    ROUTES.eventMatched,
    { ...createEnvelope(), eventId: String(event._id), monitorId: msg.monitorId, userId: msg.userId, eventType: event.eventType, aiReviewed },
    session,
  );
}

/** The AI couldn't decide: keep the filters' verdict and deliver. */
async function fallback(
  deps: AiWorkerDeps,
  msg: AiAnalyzeJob,
  events: LeanEvent[],
  status: 'skipped' | 'failed',
  why: string,
  log: Logger,
): Promise<AiResult> {
  const now = new Date();
  const error = FALLBACK_TEXT[why] ?? FALLBACK_TEXT.upstream;
  await mongoose.connection.transaction(async (session) => {
    for (const event of events) {
      const updated = await Event.updateOne(
        { _id: event._id, 'ai.status': 'pending' },
        { $set: { 'ai.status': status, 'ai.error': error, 'ai.analyzedAt': now, alertedAt: now } },
        { session },
      );
      if (updated.modifiedCount === 1) await announce(msg, event, false, session);
    }
  });
  deps.wakeOutbox?.();
  log.info({ items: events.length, why }, 'Passed on without AI review');
  return 'fallback';
}
