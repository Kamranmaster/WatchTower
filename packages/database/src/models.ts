import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { FETCH_MODES, MONITOR_STATUSES, MONITOR_TYPES, PROCESSING_OUTCOMES } from '@monitorly/contracts';

export { FETCH_MODES, MONITOR_STATUSES, MONITOR_TYPES };

const { ObjectId, Mixed } = Schema.Types;

// ---------------------------------------------------------------- User
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    emailNotifications: { type: Boolean, default: true },
    defaultCheckIntervalMinutes: { type: Number, default: 30 },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------- Monitor
/** Structured rules produced from the user's instruction. Validated data only — never code. */
const rulesSchema = new Schema(
  {
    keywords: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    excludeKeywords: { type: [String], default: [] },
  },
  { _id: false },
);

const monitorSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    name: { type: String, trim: true, maxlength: 120 },
    url: { type: String, required: true, maxlength: 2048 },
    instruction: { type: String, required: true, maxlength: 2000 },
    monitorType: { type: String, enum: MONITOR_TYPES, default: 'job_listing' },
    rules: { type: rulesSchema, default: () => ({}) },

    checkIntervalMinutes: { type: Number, required: true, min: 5, max: 1440, default: 30 },
    status: { type: String, enum: MONITOR_STATUSES, default: 'active' },
    fetchMode: { type: String, enum: FETCH_MODES, default: 'auto' },
    /** The fetch method that last worked when fetchMode is "auto". */
    resolvedFetchMode: { type: String, enum: ['http', 'browser'] },

    notifyInApp: { type: Boolean, default: true },
    notifyEmail: { type: Boolean, default: false },
    /** AI reviews changes that pass the filters (Phase 7). */
    aiReview: { type: Boolean, default: true },

    partitionId: { type: Number, required: true },
    nextCheckAt: { type: Date, required: true },
    lastCheckedAt: Date,
    /** The baseline: the latest processed snapshot that new checks are compared with. */
    lastSnapshotId: { type: ObjectId, ref: 'Snapshot' },
    /** capturedAt of the baseline: results older than this are stale and never replace it. */
    baselineCapturedAt: Date,
    /** Set when the URL or page type changes: checks scheduled before this are stale. */
    baselineResetAt: Date,
    baselineItemCount: Number,
    /** Checks in a row whose extraction looked incomplete (after 3 the new layout is accepted). */
    incompleteStreak: { type: Number, default: 0 },
    lastChangeAt: Date,
    consecutiveFailures: { type: Number, default: 0 },
    lastError: String,
  },
  { timestamps: true },
);
// Scheduler: status = active AND partitionId IN (owned) AND nextCheckAt <= now.
// Equality/IN fields before the range field (ESR rule).
monitorSchema.index({ status: 1, partitionId: 1, nextCheckAt: 1 });
// Dashboard: a user's monitors, newest first.
monitorSchema.index({ userId: 1, createdAt: -1 });

// ---------------------------------------------------------------- CheckRun
/** skipped = not run because the monitor changed (e.g. new URL) after it was scheduled. */
export const CHECK_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'dead'] as const;
export const TERMINAL_CHECK_RUN_STATUSES = ['succeeded', 'failed', 'skipped', 'dead'] as const;

const checkRunSchema = new Schema(
  {
    monitorId: { type: ObjectId, ref: 'Monitor', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    /** The schedule slot this run belongs to. Unique per monitor → no duplicate scheduling. */
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: CHECK_RUN_STATUSES, default: 'queued' },
    attempts: { type: Number, default: 0 },
    fetchModeUsed: { type: String, enum: ['http', 'browser'] },
    /** Set when the HTTP worker handed this run to the browser worker ("auto" mode fallback). */
    escalatedToBrowser: { type: Boolean, default: false },
    snapshotId: { type: ObjectId, ref: 'Snapshot' },
    /** What processing concluded (Phase 6). */
    outcome: { type: String, enum: [...PROCESSING_OUTCOMES, 'stale'] },
    changeCount: Number,
    startedAt: Date,
    completedAt: Date,
    durationMs: Number,
    error: String,
  },
  { timestamps: true },
);
checkRunSchema.index({ monitorId: 1, scheduledFor: 1 }, { unique: true });
checkRunSchema.index({ status: 1, createdAt: 1 });

// ---------------------------------------------------------------- Snapshot
const snapshotSchema = new Schema(
  {
    monitorId: { type: ObjectId, ref: 'Monitor', required: true },
    checkRunId: { type: ObjectId, ref: 'CheckRun', required: true },
    contentHash: { type: String, required: true },
    /** Raw HTML in object storage. */
    rawObjectKey: { type: String, required: true },
    /** Extracted/normalised items (JSON) in object storage. */
    extractedObjectKey: String,
    itemCount: { type: Number, default: 0 },
    fetchMode: { type: String, enum: ['http', 'browser'], required: true },
    contentType: String,
    httpStatus: Number,
    /** Where the page ended up after redirects. */
    finalUrl: String,
    /** Size of the decoded page in bytes (before compression). */
    byteSize: Number,
    capturedAt: { type: Date, required: true },
    /** Set by the processing worker; present ⇒ already processed (idempotency). */
    processedAt: Date,
    processingStatus: { type: String, enum: [...PROCESSING_OUTCOMES, 'stale'] },
    /** Hash of the extracted, normalized content (unlike contentHash, stable across loads). */
    normalizedHash: String,
    extractionStrategy: String,
  },
  { timestamps: false },
);
snapshotSchema.index({ monitorId: 1, capturedAt: -1 });
snapshotSchema.index({ checkRunId: 1 }, { unique: true });

// ---------------------------------------------------------------- Event
export const EVENT_TYPES = ['new_item', 'item_changed', 'item_removed', 'page_changed'] as const;
export const MATCH_STATUSES = ['pending', 'matched', 'filtered_out'] as const;
export const AI_REVIEW_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const;
export const EMAIL_STATUSES = ['not_requested', 'pending', 'sending', 'sent', 'skipped', 'failed'] as const;

const eventSchema = new Schema(
  {
    monitorId: { type: ObjectId, ref: 'Monitor', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    checkRunId: { type: ObjectId, ref: 'CheckRun', required: true },
    snapshotId: { type: ObjectId, ref: 'Snapshot' },
    eventType: { type: String, enum: EVENT_TYPES, required: true },
    title: { type: String, required: true, maxlength: 500 },
    description: { type: String, maxlength: 5000 },
    sourceUrl: String,
    /** The item's identity on the page (canonical link or title). */
    itemKey: String,
    item: Mixed,
    /** For updates and removals: the version before. */
    previous: Mixed,
    /** For updates: which parts changed ("title", "location", "price"…). */
    changedFields: [String],
    /** Rules engine verdict (Phase 7). pending ⇒ not evaluated yet. */
    match: {
      status: { type: String, enum: MATCH_STATUSES, default: 'pending' },
      /** Why it was filtered out, in words the user sees. */
      reasons: { type: [String], default: undefined },
      matchedTerms: { type: [String], default: undefined },
      evaluatedAt: Date,
    },
    /**
     * AI review of a matched change. skipped = never sent (AI off for the monitor, or a removal).
     * pending = queued for review; done = reviewed; failed = the AI couldn't, the filters decided.
     */
    ai: {
      status: { type: String, enum: AI_REVIEW_STATUSES, default: 'skipped' },
      relevant: Boolean,
      relevanceScore: Number,
      summary: String,
      reason: String,
      classification: String,
      model: String,
      /** Why the AI didn't decide (limit reached, provider error…). */
      error: String,
      analyzedAt: Date,
    },
    /** When it was handed to notifications (event.matched). Set once, in the same transaction. */
    alertedAt: Date,
    /** Stable hash of the item identity. Unique per monitor → re-processing never duplicates alerts. */
    fingerprint: { type: String, required: true },
    detectedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
eventSchema.index({ monitorId: 1, fingerprint: 1 }, { unique: true });
eventSchema.index({ userId: 1, detectedAt: -1 });
eventSchema.index({ monitorId: 1, detectedAt: -1 });

// ---------------------------------------------------------------- AiUsage
/**
 * Daily AI call counters for budgets: _id is "<scope>:<YYYY-MM-DD>" (scope "global" or "user:<id>").
 * Old days expire on their own.
 */
const aiUsageSchema = new Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
aiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ---------------------------------------------------------------- Notification
const notificationSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    eventId: { type: ObjectId, ref: 'Event', required: true },
    monitorId: { type: ObjectId, ref: 'Monitor', required: true },
    eventType: { type: String, enum: EVENT_TYPES },
    title: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 2000 },
    sourceUrl: String,
    /** Shown in the app (bell + live pop-up). False when the monitor only emails. */
    inApp: { type: Boolean, default: true },
    isRead: { type: Boolean, default: false },
    readAt: Date,
    email: {
      /**
       * not_requested: email off · pending: queued · sending: being sent (claimed) · sent
       * skipped: not sent on purpose (turned off meanwhile, hourly limit) · failed: gave up
       */
      status: { type: String, enum: EMAIL_STATUSES, default: 'not_requested' },
      /** When the current send started: a crashed send can be taken over after a while. */
      sendingAt: Date,
      sentAt: Date,
      providerMessageId: String,
      error: String,
    },
  },
  { timestamps: true },
);
notificationSchema.index({ userId: 1, inApp: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, inApp: 1, isRead: 1 });
/** Hourly email cap per user. */
notificationSchema.index({ userId: 1, 'email.sentAt': -1 });
// One notification per event, however many times the pipeline runs.
notificationSchema.index({ eventId: 1 }, { unique: true });

// ---------------------------------------------------------------- Outbox
/**
 * Transactional outbox: written in the same transaction as the state change,
 * then published to RabbitMQ by a relay. Prevents "DB updated but message lost".
 */
export const OUTBOX_STATUSES = ['pending', 'published', 'failed'] as const;

const outboxSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true },
    exchange: { type: String, required: true },
    routingKey: { type: String, required: true },
    payload: { type: Mixed, required: true },
    /** failed = can never be published (unknown route / invalid payload); kept for inspection. */
    status: { type: String, enum: OUTBOX_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    /** A relay claims a message until this time; also used as the retry backoff. */
    lockedUntil: Date,
    lockedBy: String,
    lastError: String,
    publishedAt: Date,
  },
  { timestamps: true },
);
outboxSchema.index({ status: 1, createdAt: 1 });
// Clean up published entries after 7 days.
outboxSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

// ---------------------------------------------------------------- Scheduler coordination
/**
 * One document per partition (0..TOTAL_PARTITIONS-1). A scheduler instance may only schedule
 * monitors in partitions whose lease it holds; an unrenewed lease expires and can be taken over.
 */
const schedulerLeaseSchema = new Schema(
  {
    _id: { type: Number, required: true },
    ownerId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    /** Incremented on every change of owner (fencing token, useful for debugging handovers). */
    token: { type: Number, default: 0 },
  },
  { timestamps: false, versionKey: false },
);

/** Heartbeat of each running scheduler instance, used to compute each one's fair share of partitions. */
const schedulerInstanceSchema = new Schema(
  {
    _id: { type: String, required: true },
    hostname: String,
    pid: Number,
    startedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
// Dead instances disappear on their own (TTL runs about once a minute; queries also filter by lastSeenAt).
schedulerInstanceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 10 * 60 });

// ---------------------------------------------------------------- Exports
export const User = mongoose.model('User', userSchema);
export const Monitor = mongoose.model('Monitor', monitorSchema);
export const CheckRun = mongoose.model('CheckRun', checkRunSchema);
export const Snapshot = mongoose.model('Snapshot', snapshotSchema);
export const Event = mongoose.model('Event', eventSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const AiUsage = mongoose.model('AiUsage', aiUsageSchema);
export const OutboxMessage = mongoose.model('OutboxMessage', outboxSchema);
export const SchedulerLease = mongoose.model('SchedulerLease', schedulerLeaseSchema);
export const SchedulerInstance = mongoose.model('SchedulerInstance', schedulerInstanceSchema);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export type MonitorDoc = HydratedDocument<InferSchemaType<typeof monitorSchema>>;
export type CheckRunDoc = HydratedDocument<InferSchemaType<typeof checkRunSchema>>;
export type SnapshotDoc = HydratedDocument<InferSchemaType<typeof snapshotSchema>>;
export type EventDoc = HydratedDocument<InferSchemaType<typeof eventSchema>>;
export type NotificationDoc = HydratedDocument<InferSchemaType<typeof notificationSchema>>;
export type OutboxMessageDoc = HydratedDocument<InferSchemaType<typeof outboxSchema>>;
