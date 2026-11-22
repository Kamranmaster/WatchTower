import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, aiAnalyzeJobSchema, eventMatchedSchema, type ContentProcessed } from '@monitorly/contracts';
import {
  CheckRun,
  Event,
  Monitor,
  OutboxMessage,
  User,
  connectDatabase,
  disconnectDatabase,
  mongoose,
  partitionFor,
  syncAllIndexes,
} from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { eventTarget, handleContentProcessed, type RulesDeps } from '../src/handler';

const TEST_DB_URI = process.env.TEST_RULES_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_rules_test?directConnection=true';
const logger = createSilentLogger();
const ctx = { messageId: 'm', attempt: 1, redelivered: false };

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

type Rules = { keywords?: string[]; locations?: string[]; excludeKeywords?: string[] };
let seq = 0;

async function setup(rules: Rules = {}, aiReview = true) {
  const user = await User.create({ name: 'R', email: `r-${Date.now()}-${seq++}@example.com`, passwordHash: 'x' });
  const _id = new mongoose.Types.ObjectId();
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    url: 'https://careers.example.com/jobs',
    instruction: 'frontend internships, remote or Mumbai, no senior roles',
    rules: { keywords: [], locations: [], excludeKeywords: [], ...rules },
    aiReview,
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
  });
  const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date(), status: 'succeeded' });

  async function event(title: string, location: string, extra: Record<string, unknown> = {}) {
    return Event.create({
      monitorId: monitor._id,
      userId: user._id,
      checkRunId: run._id,
      eventType: 'new_item',
      title,
      item: { title, fields: { location }, text: `${title} ${location}` },
      fingerprint: `fp-${seq++}`,
      detectedAt: new Date(),
      ...extra,
    });
  }

  function message(eventIds: string[]): ContentProcessed {
    return {
      ...createEnvelope(),
      checkRunId: run.id,
      monitorId: monitor.id,
      userId: user.id,
      snapshotId: new mongoose.Types.ObjectId().toString(),
      outcome: eventIds.length ? 'changed' : 'unchanged',
      eventIds,
      counts: { added: eventIds.length, updated: 0, removed: 0, pageChanged: false },
      truncated: false,
      itemCount: 5,
      processedAt: new Date().toISOString(),
    };
  }
  return { user, monitor, run, event, message };
}

const deps = (over: Partial<RulesDeps> = {}): RulesDeps => ({ logger, aiEnabled: true, aiBatchSize: 10, ...over });
const outbox = (routingKey: string) => OutboxMessage.find({ routingKey }).lean();

const RULES = { keywords: ['frontend', 'intern'], locations: ['Remote', 'Mumbai'], excludeKeywords: ['senior'] };

describe('rules worker', () => {
  it('applies the filters and records why items were filtered out', async () => {
    const t = await setup(RULES, false);
    const hit = await t.event('Frontend Intern', 'Remote');
    const wrongPlace = await t.event('Frontend Intern', 'Berlin');
    const senior = await t.event('Senior Frontend Intern Mentor', 'Mumbai');
    const backend = await t.event('Backend Intern', 'Mumbai');

    const res = await handleContentProcessed(deps(), t.message([hit.id, wrongPlace.id, senior.id, backend.id]), ctx);
    expect(res).toBe('evaluated');

    const byId = async (id: string) => (await Event.findById(id).lean())!;
    expect((await byId(hit.id)).match).toMatchObject({ status: 'matched', reasons: [], matchedTerms: ['frontend', 'intern', 'Remote'] });
    expect((await byId(wrongPlace.id)).match).toMatchObject({ status: 'filtered_out', reasons: ['Not in “Remote” or “Mumbai” (location: Berlin)'] });
    expect((await byId(senior.id)).match!.reasons).toEqual(['Mentions excluded “senior”']);
    expect((await byId(backend.id)).match!.reasons).toEqual(['Doesn’t mention “frontend”']);
    expect((await byId(wrongPlace.id)).alertedAt).toBeUndefined();
  });

  it('without AI review: matches go straight to notifications, once', async () => {
    const t = await setup(RULES, false);
    const hit = await t.event('Frontend Intern', 'Remote');
    const miss = await t.event('Backend Intern', 'Remote');
    await handleContentProcessed(deps(), t.message([hit.id, miss.id]), ctx);

    const matched = await outbox(ROUTES.eventMatched.routingKey);
    expect(matched).toHaveLength(1);
    const payload = eventMatchedSchema.parse(matched[0]!.payload);
    expect(payload).toMatchObject({ eventId: hit.id, monitorId: t.monitor.id, userId: t.user.id, eventType: 'new_item', aiReviewed: false });
    expect((await Event.findById(hit.id).lean())!.alertedAt).toBeInstanceOf(Date);
    expect(await outbox(ROUTES.aiAnalyze.routingKey)).toHaveLength(0);
  });

  it('with AI review: matches are sent for review in batches, nothing is alerted yet', async () => {
    const t = await setup({}, true);
    const events = await Promise.all(Array.from({ length: 5 }, (_, i) => t.event(`Role ${i}`, 'Remote')));
    await handleContentProcessed(deps({ aiBatchSize: 2 }), t.message(events.map((e) => e.id)), ctx);

    const jobs = (await outbox(ROUTES.aiAnalyze.routingKey)).map((m) => aiAnalyzeJobSchema.parse(m.payload));
    expect(jobs.map((j) => j.eventIds.length)).toEqual([2, 2, 1]);
    expect(jobs.flatMap((j) => j.eventIds).sort()).toEqual(events.map((e) => e.id).sort());
    expect(jobs[0]).toMatchObject({ monitorId: t.monitor.id, userId: t.user.id, checkRunId: t.run.id });
    expect(await outbox(ROUTES.eventMatched.routingKey)).toHaveLength(0);
    expect((await Event.findById(events[0]!.id).lean())!.ai!.status).toBe('pending');
  });

  it('AI on but not configured: decided by the filters alone', async () => {
    const t = await setup({}, true);
    const e = await t.event('Anything', 'Remote');
    await handleContentProcessed(deps({ aiEnabled: false }), t.message([e.id]), ctx);
    expect(await outbox(ROUTES.eventMatched.routingKey)).toHaveLength(1);
    expect((await Event.findById(e.id).lean())!.ai!.status).toBe('skipped');
  });

  it('removals skip the AI and are judged on the item that was removed', async () => {
    const t = await setup({ keywords: ['intern'] }, true);
    const removed = await t.event('Frontend Intern', 'Remote', {
      eventType: 'item_removed',
      item: undefined,
      previous: { title: 'Frontend Intern', fields: { location: 'Remote' } },
    });
    await handleContentProcessed(deps(), t.message([removed.id]), ctx);
    expect((await Event.findById(removed.id).lean())!.match!.status).toBe('matched');
    expect(await outbox(ROUTES.eventMatched.routingKey)).toHaveLength(1);
    expect(await outbox(ROUTES.aiAnalyze.routingKey)).toHaveLength(0);
  });

  it('duplicate deliveries evaluate and alert only once', async () => {
    const t = await setup({}, false);
    const e = await t.event('Role', 'Remote');
    const msg = t.message([e.id]);
    expect(await handleContentProcessed(deps(), msg, ctx)).toBe('evaluated');
    expect(await handleContentProcessed(deps(), msg, { ...ctx, redelivered: true })).toBe('duplicate');
    expect(await outbox(ROUTES.eventMatched.routingKey)).toHaveLength(1);
  });

  it('parallel duplicate deliveries alert only once', async () => {
    const t = await setup({}, false);
    const events = await Promise.all([t.event('A', 'Remote'), t.event('B', 'Remote'), t.event('C', 'Remote')]);
    const msg = t.message(events.map((e) => e.id));
    const results = await Promise.all([1, 2, 3].map(() => handleContentProcessed(deps(), msg, ctx)));
    expect(results.filter((r) => r === 'evaluated')).toHaveLength(1);
    expect(await outbox(ROUTES.eventMatched.routingKey)).toHaveLength(3);
  });

  it('ignores deleted monitors and checks without changes', async () => {
    const t = await setup();
    const e = await t.event('Role', 'Remote');
    expect(await handleContentProcessed(deps(), t.message([]), ctx)).toBe('nothing');
    await Monitor.deleteOne({ _id: t.monitor._id });
    expect(await handleContentProcessed(deps(), t.message([e.id]), ctx)).toBe('ignored');
    expect(await OutboxMessage.countDocuments()).toBe(0);
  });

  it('never evaluates another monitor’s events', async () => {
    const a = await setup({}, false);
    const b = await setup({}, false);
    const foreign = await b.event('Role', 'Remote');
    expect(await handleContentProcessed(deps(), a.message([foreign.id]), ctx)).toBe('duplicate');
    expect((await Event.findById(foreign.id).lean())!.match!.status).toBe('pending');
  });

  it('evaluates events that existed before the rules engine (no match field)', async () => {
    const t = await setup({}, false);
    const e = await t.event('Old', 'Remote');
    await Event.collection.updateOne({ _id: e._id }, { $unset: { match: 1 } });
    expect(await handleContentProcessed(deps(), t.message([e.id]), ctx)).toBe('evaluated');
    expect((await Event.findById(e.id).lean())!.match!.status).toBe('matched');
  });
});

describe('eventTarget', () => {
  const base = { title: 'T', description: undefined, item: undefined, previous: undefined };
  it('uses the new version of an update, not the old one', () => {
    const target = eventTarget({
      ...base,
      eventType: 'item_changed',
      description: 'Location: Remote → Berlin',
      item: { title: 'Dev', fields: { location: 'Berlin' } },
      previous: { title: 'Dev', fields: { location: 'Remote' } },
    });
    expect(target).toEqual({ title: 'Dev', text: undefined, fields: { location: 'Berlin' } });
  });

  it('matches page changes on the passages that appeared', () => {
    const target = eventTarget({ ...base, eventType: 'page_changed', description: '+ New pricing plans\n− Old banner' });
    expect(target.text).toBe('New pricing plans');
  });
});
