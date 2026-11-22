import type { ChangeEventDto, CheckRunDto, MonitorDto, UserDto } from '@monitorly/contracts';
import type { CheckRunDoc, EventDoc, MonitorDoc, UserDoc } from '@monitorly/database';

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
    detectedAt: event.detectedAt.toISOString(),
  };
}
