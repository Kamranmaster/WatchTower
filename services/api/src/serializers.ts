import type { MonitorDto, UserDto } from '@monitorly/contracts';
import type { MonitorDoc, UserDoc } from '@monitorly/database';

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
    consecutiveFailures: monitor.consecutiveFailures,
    lastError: monitor.lastError ?? null,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}
