import { AI_BATCH_MAX, ROUTES, type ContentProcessed, type MonitorRules } from '@monitorly/contracts';
import { Event, Monitor, mongoose, type EventDoc } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { createEnvelope, type ConsumeContext } from '@monitorly/messaging';
import { enqueueOutbox } from '@monitorly/outbox';
import { evaluateRules, type RuleTarget } from '@monitorly/rules';

export interface RulesDeps {
  logger: Logger;
  /** An AI provider is configured: matched changes of monitors with AI review on go to the AI worker. */
  aiEnabled: boolean;
  /** Changes per AI request. */
  aiBatchSize?: number;
  wakeOutbox?: () => void;
}

export type RulesResult = 'ignored' | 'nothing' | 'duplicate' | 'evaluated';

export interface RulesSummary {
  matched: number;
  filteredOut: number;
  /** Sent straight to notifications. */
  alerted: number;
  /** Sent to the AI worker for review. */
  toAi: number;
}

type StoredItem = { title?: string; text?: string; fields?: Record<string, string> } | null | undefined;
type EventLike = Pick<EventDoc, 'eventType' | 'title' | 'description' | 'item' | 'previous'>;

/** What the rules look at: the item as it is now (for a removal, as it was). */
export function eventTarget(event: EventLike): RuleTarget {
  if (event.eventType === 'page_changed') {
    // Match against the passages that appeared, not the ones that disappeared.
    const lines = (event.description ?? '').split('\n');
    const added = lines.filter((l) => l.startsWith('+ ')).map((l) => l.slice(2));
    return { title: '', text: (added.length > 0 ? added : lines).join('\n') };
  }
  const item = (event.eventType === 'item_removed' ? event.previous : event.item) as StoredItem;
  return { title: item?.title ?? event.title, text: item?.text, fields: item?.fields ?? {} };
}

/**
 * One content.processed message → apply the monitor's filters to each new event.
 *
 *  - Deleted monitors are ignored (their events are gone too).
 *  - Each event is evaluated once: the update only applies while match.status is still pending,
 *    inside the transaction that also writes the follow-up messages, so redeliveries and parallel
 *    copies can't alert twice.
 *  - Matched + AI review on → ai.analyze (batched). Matched otherwise → event.matched for
 *    notifications. Removals skip the AI: there's nothing new to judge.
 */
export async function handleContentProcessed(deps: RulesDeps, msg: ContentProcessed, ctx: ConsumeContext): Promise<RulesResult> {
  const log = deps.logger.child({ monitorId: msg.monitorId, checkRunId: msg.checkRunId, attempt: ctx.attempt });
  if (msg.eventIds.length === 0) {
    log.debug({ outcome: msg.outcome }, 'No changes to evaluate');
    return 'nothing';
  }

  const monitor = await Monitor.findById(msg.monitorId, { rules: 1, aiReview: 1 }).lean();
  if (!monitor) {
    log.info('Monitor no longer exists; ignoring');
    return 'ignored';
  }
  const rules: MonitorRules = {
    keywords: monitor.rules?.keywords ?? [],
    locations: monitor.rules?.locations ?? [],
    excludeKeywords: monitor.rules?.excludeKeywords ?? [],
  };
  const useAi = deps.aiEnabled && monitor.aiReview !== false;
  const batchSize = Math.max(1, Math.min(deps.aiBatchSize ?? 10, AI_BATCH_MAX));

  const summary = await mongoose.connection.transaction(async (session) => {
    const s: RulesSummary = { matched: 0, filteredOut: 0, alerted: 0, toAi: 0 };
    // null: events created before the rules engine existed have no match field yet.
    const pending = { 'match.status': { $in: ['pending', null] } };
    const events = await Event.find({ _id: { $in: msg.eventIds }, monitorId: msg.monitorId, ...pending })
      .session(session)
      .lean();
    const now = new Date();
    const forAi: string[] = [];

    for (const event of events) {
      const result = evaluateRules(rules, eventTarget(event));
      const review = result.matched && useAi && event.eventType !== 'item_removed';
      const set: Record<string, unknown> = {
        'match.status': result.matched ? 'matched' : 'filtered_out',
        'match.reasons': result.reasons,
        'match.matchedTerms': result.matchedTerms,
        'match.evaluatedAt': now,
      };
      if (review) set['ai.status'] = 'pending';
      if (result.matched && !review) set.alertedAt = now;

      const updated = await Event.updateOne({ _id: event._id, ...pending }, { $set: set }, { session });
      if (updated.modifiedCount !== 1) continue;

      if (!result.matched) {
        s.filteredOut++;
        continue;
      }
      s.matched++;
      if (review) {
        forAi.push(String(event._id));
      } else {
        s.alerted++;
        await enqueueOutbox(
          ROUTES.eventMatched,
          {
            ...createEnvelope(),
            eventId: String(event._id),
            monitorId: msg.monitorId,
            userId: msg.userId,
            eventType: event.eventType,
            aiReviewed: false,
          },
          session,
        );
      }
    }

    for (let i = 0; i < forAi.length; i += batchSize) {
      await enqueueOutbox(
        ROUTES.aiAnalyze,
        {
          ...createEnvelope(),
          monitorId: msg.monitorId,
          userId: msg.userId,
          checkRunId: msg.checkRunId,
          eventIds: forAi.slice(i, i + batchSize),
        },
        session,
      );
    }
    s.toAi = forAi.length;
    return { s, found: events.length };
  });

  if (summary.found === 0) {
    log.info('Events already evaluated (or deleted); nothing to do');
    return 'duplicate';
  }
  deps.wakeOutbox?.();
  log.info(summary.s, 'Rules evaluated');
  return 'evaluated';
}
