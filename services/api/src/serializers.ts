import type { ChangeAiDto, ChangeEventDto, ChangeVerdict, CheckRunDto, NotificationDto, MonitorDto, UserDto } from '@monitorly/contracts';
import type { CheckRunDoc, EventDoc, MonitorDoc, NotificationDoc, UserDoc } from '@monitorly/database';

/**
 * Explicit DB → API mapping. Only listed fields ever leave the server,
 * so adding a sensitive field to a model can't leak it by accident.
 */

export function serializeUser(user: UserDoc): UserDto {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    emailNotifications: user.emailNotifications,
    defaultCheckIntervalMinutes: user.defaultCheckIntervalMinutes,
    createdAt: user.createdAt.toISOString(),
  };
}

export function serializeMonitor(monitor: MonitorDoc): MonitorDto {
  return {
    id: monitor._id.toString(),
    name: monitor.name ?? new URL(monitor.url).hostname,
    url: monitor.url,
    instruction: monitor.instruction,
    monitorType: monitor.monitorType,
    rules: {
      keywords: monitor.rules?.keywords ?? [],
      locations: monitor.rules?.locations ?? [],
      excludeKeywords: monitor.rules?.excludeKeywords ?? [],
    },
    checkIntervalMinutes: monitor.checkIntervalMinutes,
    status: monitor.status,
    fetchMode: monitor.fetchMode,
    resolvedFetchMode: monitor.resolvedFetchMode ?? null,
    notifyInApp: monitor.notifyInApp,
    notifyEmail: monitor.notifyEmail,
    aiReview: monitor.aiReview !== false,
    nextCheckAt: monitor.nextCheckAt.toISOString(),
    lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
    hasBaseline: Boolean(monitor.lastSnapshotId),
    itemCount: monitor.baselineItemCount ?? null,
    lastChangeAt: monitor.lastChangeAt?.toISOString() ?? null,
    consecutiveFailures: monitor.consecutiveFailures,
    lastError: monitor.lastError ?? null,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

export function serializeCheckRun(run: CheckRunDoc): CheckRunDto {
  return {
    id: run._id.toString(),
    scheduledFor: run.scheduledFor.toISOString(),
    status: run.status,
    attempts: run.attempts,
    fetchModeUsed: run.fetchModeUsed ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs: run.durationMs ?? null,
    error: run.error ?? null,
    outcome: run.outcome ?? null,
    changeCount: run.changeCount ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

type StoredItem = { title?: string; fields?: Record<string, string> } | undefined;

export function serializeEvent(event: EventDoc, monitorName?: string): ChangeEventDto {
  const item = event.item as StoredItem;
  const previous = event.previous as StoredItem;
  return {
    id: event._id.toString(),
    monitorId: event.monitorId.toString(),
    ...(monitorName ? { monitorName } : {}),
    eventType: event.eventType,
    title: event.title,
    description: event.description ?? null,
    sourceUrl: event.sourceUrl ?? null,
    changedFields: event.changedFields ?? [],
    previous: event.eventType === 'item_changed' && previous ? { title: previous.title ?? '', fields: previous.fields ?? {} } : null,
    fields: (item ?? previous)?.fields ?? {},
    verdict: verdictOf(event),
    matchReasons: event.match?.reasons ?? [],
    matchedTerms: event.match?.matchedTerms ?? [],
    ai: aiOf(event),
    detectedAt: event.detectedAt.toISOString(),
  };
}

function verdictOf(event: EventDoc): ChangeVerdict {
  const match = event.match?.status ?? 'pending';
  if (match === 'filtered_out') return 'filtered_out';
  if (match !== 'matched' || event.ai?.status === 'pending') return 'pending';
  if (event.ai?.status === 'done' && event.ai.relevant === false) return 'not_relevant';
  return 'matched';
}

function aiOf(event: EventDoc): ChangeAiDto | null {
  const ai = event.ai;
  if (!ai || (ai.status === 'skipped' && !ai.error)) return null;
  return {
    status: ai.status,
    relevant: ai.relevant ?? null,
    summary: ai.summary ?? null,
    // When the AI couldn't decide, say why (limit reached, provider down…).
    reason: ai.reason ?? ai.error ?? null,
  };
}

type NotificationLike = Pick<
  NotificationDoc,
  '_id' | 'monitorId' | 'eventId' | 'eventType' | 'title' | 'message' | 'sourceUrl' | 'isRead' | 'createdAt'
>;

export function serializeNotification(n: NotificationLike, monitorName: string | null): NotificationDto {
  return {
    id: String(n._id),
    monitorId: String(n.monitorId),
    monitorName,
    eventId: String(n.eventId),
    eventType: n.eventType ?? null,
    title: n.title,
    message: n.message,
    sourceUrl: n.sourceUrl ?? null,
    isRead: n.isRead,
    createdAt: n.createdAt.toISOString(),
  };
}
