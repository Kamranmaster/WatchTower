import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, contentProcessedSchema, type FetchCompleted } from '@monitorly/contracts';
import {
  CheckRun,
  Event,
  Monitor,
  OutboxMessage,
  Snapshot,
  User,
  connectDatabase,
  disconnectDatabase,
  mongoose,
  partitionFor,
  syncAllIndexes,
} from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { MemoryObjectStore, getCompressedText, putCompressedText, rawSnapshotKey } from '@monitorly/storage';
import { handleFetchCompleted, type ProcessingDeps } from '../src/handler';
import { JOBS, articlePage, cardsPage, type Job } from '../../../packages/extraction/test/fixtures';

const TEST_DB_URI = process.env.TEST_PROCESSING_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_processing_test?directConnection=true';
const logger = createSilentLogger();
const ctx = { messageId: 'm', attempt: 1, redelivered: false };
const PAGE = 'https://careers.example.com/careers';

beforeAll(async () => {
  await connectDatabase(TEST_DB_URI, logger);
  await syncAllIndexes();
});
beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});
afterAll(async () => {
  await mongoose.connection.db?.dropDatabase();
  await disconnectDatabase();
});

async function setup(monitorType: 'job_listing' | 'generic' = 'job_listing') {
  const user = await User.create({ name: 'P', email: `p-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x' });
  const _id = new mongoose.Types.ObjectId();
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    url: PAGE,
    instruction: 'new roles',
    monitorType,
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
  });
  const store = new MemoryObjectStore();
  const deps: ProcessingDeps = { store, logger };
  let clock = Date.parse('2026-11-22T10:00:00Z');

  /** What the fetch workers produce for one check: run + stored page + snapshot + message. */
  async function fetched(html: string, at = (clock += 30 * 60_000)): Promise<FetchCompleted> {
    const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date(at), status: 'succeeded' });
    const key = rawSnapshotKey(monitor.id, run.id);
    await putCompressedText(store, key, html);
    const snapshot = await Snapshot.create({
      monitorId: monitor._id,
      checkRunId: run._id,
      contentHash: 'raw',
      rawObjectKey: key,
      fetchMode: 'http',
      finalUrl: PAGE,
      capturedAt: new Date(at),
    });
    return {
      ...createEnvelope(),
      checkRunId: run.id,
      monitorId: monitor.id,
      userId: String(user._id),
      snapshotId: snapshot.id,
      fetchMode: 'http',
      objectStorageKey: key,
      contentHash: 'raw',
      httpStatus: 200,
      finalUrl: PAGE,
      fetchedAt: new Date(at).toISOString(),
    };
  }

  const process = (msg: FetchCompleted) => handleFetchCompleted(deps, msg, ctx);
  const events = () => Event.find({ monitorId: monitor._id }).sort({ _id: 1 }).lean();
  const reload = () => Monitor.findById(monitor._id).lean();
  return { monitor, store, deps, fetched, process, events, reload };
}

const NEW_JOB: Job = { title: 'Backend Engineer Intern', slug: 'backend-intern', location: 'Bangalore, India', posted: 'just now' };

describe('first check', () => {
  it('saves a baseline and creates no events', async () => {
    const t = await setup();
    const msg = await t.fetched(cardsPage(JOBS));
    expect(await t.process(msg)).toBe('baseline');
    expect(await t.events()).toEqual([]);
    const monitor = await t.reload();
    expect(String(monitor!.lastSnapshotId)).toBe(msg.snapshotId);
    expect(monitor!.baselineItemCount).toBe(3);
    expect(await CheckRun.findById(msg.checkRunId).lean()).toMatchObject({ outcome: 'baseline', changeCount: 0 });
  });
});

describe('change detection', () => {
  it('an unchanged page generates no events (even with new nonces and "posted X ago")', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    const again = await t.fetched(cardsPage(JOBS.map((j) => ({ ...j, posted: '3 weeks ago' }))));
    expect(await t.process(again)).toBe('unchanged');
    expect(await t.events()).toEqual([]);
    expect(String((await t.reload())!.lastSnapshotId)).toBe(again.snapshotId); // baseline moves to the latest
  });

  it('detects a new item and records the details', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    const msg = await t.fetched(cardsPage([...JOBS, NEW_JOB]));
    expect(await t.process(msg)).toBe('changed');

    const [event] = await t.events();
    expect(event).toMatchObject({
      eventType: 'new_item',
      title: 'Backend Engineer Intern',
      description: 'Bangalore, India',
      sourceUrl: 'https://careers.example.com/jobs/backend-intern',
      itemKey: 'url:https://careers.example.com/jobs/backend-intern',
    });
    expect(await CheckRun.findById(msg.checkRunId).lean()).toMatchObject({ outcome: 'changed', changeCount: 1 });
    expect((await t.reload())!.lastChangeAt).toBeInstanceOf(Date);
  });

  it('detects an updated item and says what changed', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    await t.process(await t.fetched(cardsPage(JOBS.map((j) => (j.slug === 'data-analyst' ? { ...j, location: 'Mumbai, India' } : j)))));
    const [event] = await t.events();
    expect(event).toMatchObject({
      eventType: 'item_changed',
      title: 'Data Analyst',
      changedFields: ['location'],
      description: 'Location: Remote → Mumbai, India',
    });
    expect((event!.previous as { fields: Record<string, string> }).fields.location).toBe('Remote');
  });

  it('detects a removed item', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    await t.process(await t.fetched(cardsPage(JOBS.slice(0, 2))));
    const [event] = await t.events();
    expect(event).toMatchObject({ eventType: 'item_removed', title: 'Product Designer' });
  });

  it('"any change" monitors get one page-changed event', async () => {
    const t = await setup('generic');
    await t.process(await t.fetched(articlePage(['Version 2.1 adds dark mode to the dashboard.'])));
    await t.process(await t.fetched(articlePage(['Version 2.1 adds dark mode to the dashboard.', 'Version 2.2 adds CSV export for all reports.'])));
    const events = await t.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'page_changed' });
    expect(events[0]!.description).toContain('Version 2.2 adds CSV export');
  });

  it('does not report removals when most items vanish at once, and keeps the baseline', async () => {
    const t = await setup();
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `Role number ${i}`, slug: `role-${i}`, location: 'Remote' }));
    const first = await t.fetched(cardsPage(many));
    await t.process(first);
    expect(await t.process(await t.fetched(cardsPage(many.slice(0, 2))))).toBe('incomplete');
    expect(await t.events()).toEqual([]);
    expect(String((await t.reload())!.lastSnapshotId)).toBe(first.snapshotId);
  });

  it('accepts the new layout after it is seen 3 times in a row, still without events', async () => {
    const t = await setup();
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `Role number ${i}`, slug: `role-${i}`, location: 'Remote' }));
    await t.process(await t.fetched(cardsPage(many)));
    const shrunk = cardsPage(many.slice(0, 2));
    expect(await t.process(await t.fetched(shrunk))).toBe('incomplete');
    expect(await t.process(await t.fetched(shrunk))).toBe('incomplete');
    const third = await t.fetched(shrunk);
    expect(await t.process(third)).toBe('rebaselined');
    expect(await t.events()).toEqual([]);
    expect(String((await t.reload())!.lastSnapshotId)).toBe(third.snapshotId);
  });
});

describe('robustness', () => {
  it('a duplicate message produces no duplicate events', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    const msg = await t.fetched(cardsPage([...JOBS, NEW_JOB]));
    expect(await t.process(msg)).toBe('changed');
    expect(await t.process(msg)).toBe('duplicate');
    expect(await t.process({ ...msg, messageId: 'redelivered-copy' })).toBe('duplicate');
    expect(await t.events()).toHaveLength(1);
    expect(await OutboxMessage.countDocuments({ routingKey: 'content.processed' })).toBe(2); // baseline + change
  });

  it('two copies of the same message processed at the same time: one result, outcome kept (found live)', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    const msg = await t.fetched(cardsPage([...JOBS, NEW_JOB]));
    const results = await Promise.all([t.process(msg), t.process({ ...msg, messageId: 'copy' }), t.process({ ...msg, messageId: 'copy2' })]);

    expect(results.filter((r) => r === 'changed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(2);
    expect(await t.events()).toHaveLength(1);
    expect(await CheckRun.findById(msg.checkRunId).lean()).toMatchObject({ outcome: 'changed', changeCount: 1 });
  });

  it('the same change seen again by a later check is not reported twice', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    await t.process(await t.fetched(cardsPage([...JOBS, NEW_JOB]))); // added
    await t.process(await t.fetched(cardsPage(JOBS))); // removed again
    await t.process(await t.fetched(cardsPage([...JOBS, NEW_JOB]))); // identical repost
    const types = (await t.events()).map((e) => e.eventType);
    expect(types).toEqual(['new_item', 'item_removed']);
  });

  it('an older result arriving late cannot replace a newer baseline', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS), Date.parse('2026-11-22T10:00:00Z')));
    const older = await t.fetched(cardsPage(JOBS.slice(0, 2)), Date.parse('2026-11-22T10:30:00Z'));
    const newer = await t.fetched(cardsPage([...JOBS, NEW_JOB]), Date.parse('2026-11-22T11:00:00Z'));

    expect(await t.process(newer)).toBe('changed');
    expect(await t.process(older)).toBe('stale');

    expect(String((await t.reload())!.lastSnapshotId)).toBe(newer.snapshotId);
    expect((await t.events()).map((e) => e.eventType)).toEqual(['new_item']); // no bogus "removed"
    expect(await CheckRun.findById(older.checkRunId).lean()).toMatchObject({ outcome: 'stale' });
  });

  it('two results processed at the same time end with the newest as baseline, and no duplicate events', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    const a = await t.fetched(cardsPage([...JOBS, NEW_JOB]));
    const b = await t.fetched(cardsPage([...JOBS, NEW_JOB]));
    const results = await Promise.all([t.process(a), t.process(b)]);

    expect(results.sort()).toEqual(expect.arrayContaining(['changed']));
    expect(String((await t.reload())!.lastSnapshotId)).toBe(b.snapshotId);
    expect((await t.events()).filter((e) => e.eventType === 'new_item')).toHaveLength(1);
  });

  it('a check scheduled before the URL changed is not compared with the new page', async () => {
    const t = await setup();
    const msg = await t.fetched(cardsPage(JOBS));
    await Monitor.updateOne({ _id: t.monitor._id }, { $set: { baselineResetAt: new Date(Date.now() + 1000) } });
    expect(await t.process(msg)).toBe('stale');
    expect((await t.reload())!.lastSnapshotId).toBeUndefined();
  });

  it('deleted monitors are ignored safely', async () => {
    const t = await setup();
    const msg = await t.fetched(cardsPage(JOBS));
    await Monitor.deleteOne({ _id: t.monitor._id });
    expect(await t.process(msg)).toBe('ignored');

    const gone = await t.fetched(cardsPage(JOBS));
    await Snapshot.deleteOne({ _id: gone.snapshotId });
    expect(await t.process(gone)).toBe('ignored');
    expect(await Event.countDocuments()).toBe(0);
  });
});

describe('persistence and publishing', () => {
  it('keeps every snapshot and its extracted items; the baseline points at the latest', async () => {
    const t = await setup();
    const msgs = [];
    for (const page of [cardsPage(JOBS), cardsPage([...JOBS, NEW_JOB]), cardsPage([...JOBS, NEW_JOB])]) {
      const msg = await t.fetched(page);
      msgs.push(msg);
      await t.process(msg);
    }
    const snapshots = await Snapshot.find({ monitorId: t.monitor._id }).sort({ capturedAt: 1 }).lean();
    expect(snapshots.map((s) => s.processingStatus)).toEqual(['baseline', 'changed', 'unchanged']);
    for (const s of snapshots) {
      const items = JSON.parse(await getCompressedText(t.store, s.extractedObjectKey!));
      expect(items.items.length).toBe(s.itemCount);
    }
    expect(String((await t.reload())!.lastSnapshotId)).toBe(msgs[2]!.snapshotId);
  });

  it('publishes the processing result for Phase 7 with the new event ids', async () => {
    const t = await setup();
    await t.process(await t.fetched(cardsPage(JOBS)));
    const msg = await t.fetched(cardsPage([...JOBS, NEW_JOB]));
    await t.process(msg);

    const outbox = await OutboxMessage.find({ routingKey: ROUTES.contentProcessed.routingKey }).sort({ createdAt: 1 }).lean();
    const result = contentProcessedSchema.parse(outbox.at(-1)!.payload);
    const [event] = await t.events();
    expect(result).toMatchObject({
      checkRunId: msg.checkRunId,
      outcome: 'changed',
      eventIds: [String(event!._id)],
      counts: { added: 1, updated: 0, removed: 0, pageChanged: false },
      itemCount: 4,
    });
  });
});
