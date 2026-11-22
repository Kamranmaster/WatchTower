import { z } from 'zod';

/** 24-char hex MongoDB ObjectId, carried as a string in messages. */
export const objectIdString = z.string().regex(/^[a-f\d]{24}$/i, 'must be a MongoDB ObjectId');

export const fetchModeSchema = z.enum(['http', 'browser']);
export type FetchMode = z.infer<typeof fetchModeSchema>;

/**
 * Every message carries a unique messageId (for idempotent consumers)
 * and the time it was produced.
 */
const envelope = {
  messageId: z.string().min(1),
  occurredAt: z.iso.datetime(),
};

/** Scheduler → fetch workers: "check this monitor now". IDs and small metadata only. */
export const fetchJobSchema = z.object({
  ...envelope,
  checkRunId: objectIdString,
  monitorId: objectIdString,
  userId: objectIdString,
  url: z.url({ protocol: /^https?$/ }),
  fetchMode: fetchModeSchema,
  scheduledAt: z.iso.datetime(),
});
export type FetchJob = z.infer<typeof fetchJobSchema>;

/** Fetch workers → processing worker: a reference to stored content, never the HTML itself. */
export const fetchCompletedSchema = z.object({
  ...envelope,
  checkRunId: objectIdString,
  monitorId: objectIdString,
  userId: objectIdString,
  snapshotId: objectIdString,
  fetchMode: fetchModeSchema,
  objectStorageKey: z.string().min(1),
  contentHash: z.string().min(1),
  httpStatus: z.number().int(),
  finalUrl: z.url(),
  fetchedAt: z.iso.datetime(),
});
export type FetchCompleted = z.infer<typeof fetchCompletedSchema>;

export const PROCESSING_OUTCOMES = ['baseline', 'unchanged', 'changed', 'incomplete', 'rebaselined'] as const;
export type ProcessingOutcome = (typeof PROCESSING_OUTCOMES)[number];

/**
 * Processing worker → rules engine (Phase 7): the result of comparing one check with the
 * baseline. Event details live in MongoDB; only their ids travel here.
 */
export const contentProcessedSchema = z.object({
  ...envelope,
  checkRunId: objectIdString,
  monitorId: objectIdString,
  userId: objectIdString,
  snapshotId: objectIdString,
  outcome: z.enum(PROCESSING_OUTCOMES),
  eventIds: z.array(objectIdString).max(200),
  counts: z.object({
    added: z.number().int().min(0),
    updated: z.number().int().min(0),
    removed: z.number().int().min(0),
    pageChanged: z.boolean(),
  }),
  /** More changes were found than events created (capped per check). */
  truncated: z.boolean(),
  itemCount: z.number().int().min(0),
  processedAt: z.iso.datetime(),
});
export type ContentProcessed = z.infer<typeof contentProcessedSchema>;

/** At most this many changes go to the AI in one request (one job). */
export const AI_BATCH_MAX = 20;

/** Rules engine → AI worker: review changes that passed the monitor's filters (one AI call per job). */
export const aiAnalyzeJobSchema = z.object({
  ...envelope,
  monitorId: objectIdString,
  userId: objectIdString,
  checkRunId: objectIdString,
  eventIds: z.array(objectIdString).min(1).max(AI_BATCH_MAX),
});
export type AiAnalyzeJob = z.infer<typeof aiAnalyzeJobSchema>;

/**
 * Rules engine / AI worker → notifications (Phase 8): this change should be delivered.
 * Sent at most once per event (Event.alertedAt is set in the same transaction).
 */
export const eventMatchedSchema = z.object({
  ...envelope,
  eventId: objectIdString,
  monitorId: objectIdString,
  userId: objectIdString,
  eventType: z.enum(['new_item', 'item_changed', 'item_removed', 'page_changed']),
  /** True when the AI reviewed the change and found it relevant; false when only the filters decided. */
  aiReviewed: z.boolean(),
});
export type EventMatched = z.infer<typeof eventMatchedSchema>;

/**
 * Notification worker → every API instance: a notification was created, push it to the user's
 * open browser tabs. A broadcast: not stored when no API is running (the list is loaded on connect).
 */
export const notificationCreatedSchema = z.object({
  ...envelope,
  notificationId: objectIdString,
  userId: objectIdString,
});
export type NotificationCreated = z.infer<typeof notificationCreatedSchema>;

/** Notification pipeline → email worker. */
export const emailJobSchema = z.object({
  ...envelope,
  notificationId: objectIdString,
  userId: objectIdString,
});
export type EmailJob = z.infer<typeof emailJobSchema>;
