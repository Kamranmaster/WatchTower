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
  fetchMode: fetchModeSchema,
  objectStorageKey: z.string().min(1),
  contentHash: z.string().min(1),
  httpStatus: z.number().int(),
  finalUrl: z.url(),
  fetchedAt: z.iso.datetime(),
});
export type FetchCompleted = z.infer<typeof fetchCompletedSchema>;

/** Processing worker → AI worker: enrich matched events. */
export const aiAnalyzeJobSchema = z.object({
  ...envelope,
  eventId: objectIdString,
  monitorId: objectIdString,
  userId: objectIdString,
});
export type AiAnalyzeJob = z.infer<typeof aiAnalyzeJobSchema>;

/** Notification pipeline → email worker. */
export const emailJobSchema = z.object({
  ...envelope,
  notificationId: objectIdString,
  userId: objectIdString,
});
export type EmailJob = z.infer<typeof emailJobSchema>;
