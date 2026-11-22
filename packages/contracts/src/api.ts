import { z } from 'zod';

/**
 * HTTP API contracts shared by the Express API (runtime validation)
 * and the React app (types). Keep request schemas strict: unknown fields are rejected.
 */

import {
  FETCH_MODES,
  MAX_CHECK_INTERVAL_MINUTES,
  MIN_CHECK_INTERVAL_MINUTES,
  MONITOR_TYPES,
  type MonitorFetchMode,
  type MonitorStatus,
  type MonitorType,
} from './constants';

// ---------------------------------------------------------------- Auth
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'));

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: emailField,
  // bcrypt only uses the first 72 bytes, so longer passwords would silently be truncated.
  password: z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters'),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.strictObject({
  email: emailField,
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginInput = z.input<typeof loginSchema>;

// ---------------------------------------------------------------- Monitor rules
/** Trimmed, non-empty, de-duplicated (case-insensitive) list of short phrases. */
const phraseList = z
  .array(z.string().trim().min(1).max(100))
  .max(25, 'At most 25 entries')
  .transform((items) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/**
 * How the rules engine (Phase 7) applies these. Matching is case-insensitive substring
 * matching against an item's text, so "intern" also matches "internship".
 *  - keywords:        the item must mention ALL of them
 *  - locations:       the item must mention AT LEAST ONE of them (ignored when empty)
 *  - excludeKeywords: the item is dropped if it mentions ANY of them
 * Every list empty = every new item matches.
 */
export const monitorRulesSchema = z.strictObject({
  keywords: phraseList.default([]),
  locations: phraseList.default([]),
  excludeKeywords: phraseList.default([]),
});
export type MonitorRules = z.output<typeof monitorRulesSchema>;

// ---------------------------------------------------------------- Natural language → rules (AI)
export const interpretInstructionSchema = z.strictObject({
  instruction: z.string().trim().min(5, 'Describe what to monitor (at least 5 characters)').max(2000),
  /** Optional: helps the AI guess the page type. Only its host and path are sent to the AI. */
  url: z.string().trim().max(2048).optional(),
});
export type InterpretInstructionInput = z.input<typeof interpretInstructionSchema>;

/** What the AI proposes. Validated server-side before it reaches the user, who confirms it before saving. */
export const instructionInterpretationSchema = z.object({
  monitorType: z.enum(MONITOR_TYPES),
  rules: monitorRulesSchema,
  /** Parts of the instruction the filters can't express (e.g. "salary over 50k"). */
  notes: z.array(z.string().trim().min(1).max(300)).max(5),
});
export type InstructionInterpretation = z.output<typeof instructionInterpretationSchema>;

export interface InterpretInstructionResponse {
  interpretation: InstructionInterpretation;
  model: string;
}

// ---------------------------------------------------------------- Monitor input
// Fields are defined without defaults so the PATCH schema never fills in values the user didn't send.
const monitorFields = {
  name: z.string().trim().max(120),
  url: z.string().trim().min(1, 'Website URL is required').max(2048),
  instruction: z.string().trim().min(5, 'Describe what to monitor (at least 5 characters)').max(2000),
  monitorType: z.enum(MONITOR_TYPES),
  rules: monitorRulesSchema,
  checkIntervalMinutes: z
    .number()
    .int()
    .min(MIN_CHECK_INTERVAL_MINUTES, `Minimum interval is ${MIN_CHECK_INTERVAL_MINUTES} minutes`)
    .max(MAX_CHECK_INTERVAL_MINUTES, 'Maximum interval is 24 hours'),
  fetchMode: z.enum(FETCH_MODES),
  notifyInApp: z.boolean(),
  notifyEmail: z.boolean(),
  /** Let the AI review changes that pass the filters (relevance + a one-line summary). */
  aiReview: z.boolean(),
};

export const createMonitorSchema = z.strictObject({
  ...monitorFields,
  name: monitorFields.name.optional(),
  monitorType: monitorFields.monitorType.default('job_listing'),
  rules: monitorRulesSchema.default({ keywords: [], locations: [], excludeKeywords: [] }),
  checkIntervalMinutes: monitorFields.checkIntervalMinutes.default(30),
  fetchMode: monitorFields.fetchMode.default('auto'),
  notifyInApp: monitorFields.notifyInApp.default(true),
  notifyEmail: monitorFields.notifyEmail.default(false),
  aiReview: monitorFields.aiReview.default(true),
});
export type CreateMonitorInput = z.input<typeof createMonitorSchema>;

export const updateMonitorSchema = z
  .strictObject(monitorFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateMonitorInput = z.input<typeof updateMonitorSchema>;

// ---------------------------------------------------------------- Response DTOs
export interface UserDto {
  id: string;
  name: string;
  email: string;
  emailNotifications: boolean;
  defaultCheckIntervalMinutes: number;
  createdAt: string;
}

export interface MonitorDto {
  id: string;
  name: string;
  url: string;
  instruction: string;
  monitorType: MonitorType;
  rules: MonitorRules;
  checkIntervalMinutes: number;
  status: MonitorStatus;
  fetchMode: MonitorFetchMode;
  resolvedFetchMode: 'http' | 'browser' | null;
  notifyInApp: boolean;
  notifyEmail: boolean;
  aiReview: boolean;
  nextCheckAt: string;
  lastCheckedAt: string | null;
  hasBaseline: boolean;
  /** Items found on the page at the last processed check. */
  itemCount: number | null;
  lastChangeAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CheckRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'dead';

export interface CheckRunDto {
  id: string;
  scheduledFor: string;
  status: CheckRunStatus;
  attempts: number;
  fetchModeUsed: 'http' | 'browser' | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  /** What change detection concluded for this check, once processed. */
  outcome: 'baseline' | 'unchanged' | 'changed' | 'incomplete' | 'rebaselined' | 'stale' | null;
  changeCount: number | null;
  createdAt: string;
}

export type ChangeEventType = 'new_item' | 'item_changed' | 'item_removed' | 'page_changed';

/**
 * What the rules engine decided:
 *  pending      not evaluated yet, or the AI is still reviewing it
 *  matched      passed the filters (and the AI review, if any): the user is alerted
 *  filtered_out failed the filters (see matchReasons)
 *  not_relevant passed the filters but the AI judged it not what the user asked for
 */
export type ChangeVerdict = 'pending' | 'matched' | 'filtered_out' | 'not_relevant';

export interface ChangeAiDto {
  status: 'pending' | 'done' | 'skipped' | 'failed';
  relevant: boolean | null;
  summary: string | null;
  reason: string | null;
}

export interface ChangeEventDto {
  id: string;
  monitorId: string;
  monitorName?: string;
  eventType: ChangeEventType;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  changedFields: string[];
  /** For updates: the previous title/fields, to show "was …". */
  previous: { title: string; fields: Record<string, string> } | null;
  fields: Record<string, string>;
  verdict: ChangeVerdict;
  matchReasons: string[];
  matchedTerms: string[];
  /** Present once the change was sent for AI review. */
  ai: ChangeAiDto | null;
  detectedAt: string;
}

/** Dev-only scheduler overview (GET /api/dev/scheduler). */
export interface SchedulerStatusDto {
  instances: { id: string; partitions: number; lastSeenAt: string; startedAt: string }[];
  unownedPartitions: number;
  outbox: { pending: number; published: number; failed: number; oldestPendingAt: string | null };
  checkRuns: { queued: number; running: number; succeeded: number; failed: number; skipped: number; dead: number };
  dueMonitors: number;
}

/** Shape of every non-2xx JSON response. */
export interface ApiErrorBody {
  error: string;
  details?: { path: string; message: string }[];
  /** Machine-readable reason for some errors, e.g. "ai_not_configured". */
  code?: string;
}
