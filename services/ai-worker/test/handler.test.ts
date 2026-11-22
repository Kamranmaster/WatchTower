import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError, type ChangeReviewer, type ReviewInput, type ReviewVerdict } from '@monitorly/ai';
import { MAX_ATTEMPTS, ROUTES, eventMatchedSchema, type AiAnalyzeJob } from '@monitorly/contracts';
import {
  AiUsage,
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
import { createThrottle, reserveAiCall } from '../src/budget';
import { handleAiAnalyze, toReviewItem, type AiWorkerDeps } from '../src/handler';

const TEST_DB_URI = process.env.TEST_AI_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_ai_worker_test?directConnection=true';
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

let seq = 0;
async function setup() {
  const user = await User.create({ name: 'A', email: `a-${Date.now()}-${seq++}@example.com`, passwordHash: 'x' });
  const _id = new mongoose.Types.ObjectId();
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    url: 'https://careers.example.com/jobs?session=secret',
    instruction: 'frontend internships',
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
  });
  const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date(), status: 'succeeded' });
  async function pending(title: string) {
    return Event.create({
      monitorId: monitor._id,
      userId: user._id,
      checkRunId: run._id,
      eventType: 'new_item',
      title,
      item: { title, fields: { location: 'Remote' }, text: `${title} Remote` },
      match: { status: 'matched', reasons: [], matchedTerms: [] },
      ai: { status: 'pending' },
      fingerprint: `fp-${seq++}`,
      detectedAt: new Date(),
    });
  }
  const job = (eventIds: string[]): AiAnalyzeJob => ({
    ...createEnvelope(),
    monitorId: monitor.id,
    userId: user.id,
    checkRunId: run.id,
    eventIds,
  });
  return { user, monitor, pending, job };
}

/** A reviewer that answers from a title → verdict table. */
function fakeReviewer(answer: (title: string) => ReviewVerdict | undefined | Error) {
  const review = vi.fn(async (input: ReviewInput) => {
    const verdicts = new Map<string, ReviewVerdict>();
    for (const item of input.items) {
      const v = answer(item.title);
      if (v instanceof Error) throw v;
      if (v) verdicts.set(item.id, v);
    }
    return { verdicts, model: 'fake-model' };
  });
  return { reviewer: { provider: 'gemini', model: 'fake-model', review } as ChangeReviewer, review };
}

const yes = (summary = 'Fits'): ReviewVerdict => ({ relevant: true, score: 90, summary, reason: 'Matches the description' });
const no: ReviewVerdict = { relevant: false, score: 10, summary: 'Not it', reason: 'Not an internship' };
const limits = { perUserDaily: 100, globalDaily: 100 };
const deps = (reviewer: ChangeReviewer | null, over: Partial<AiWorkerDeps> = {}): AiWorkerDeps => ({ logger, reviewer, limits, ...over });
const alerts = async () => (await OutboxMessage.find({ routingKey: ROUTES.eventMatched.routingKey }).lean()).map((m) => eventMatchedSchema.parse(m.payload));
const ev = async (id: string) => (await Event.findById(id).lean())!;

describe('AI worker', () => {
  it('saves verdicts; relevant changes are alerted, irrelevant ones stop here', async () => {
    const t = await setup();
    const good = await t.pending('Frontend Intern');
    const bad = await t.pending('Office Manager');
    const { reviewer, review } = fakeReviewer((title) => (title.startsWith('Frontend') ? yes('New Frontend Intern role (Remote)') : no));

    expect(await handleAiAnalyze(deps(reviewer), t.job([good.id, bad.id]), ctx)).toBe('reviewed');
    expect(review).toHaveBeenCalledTimes(1); // one call for the whole batch
    const input = review.mock.calls[0]![0];
    expect(input.instruction).toBe('frontend internships');
    expect(input.items.map((i) => i.title)).toEqual(['Frontend Intern', 'Office Manager']);

    expect((await ev(good.id)).ai).toMatchObject({ status: 'done', relevant: true, relevanceScore: 90, summary: 'New Frontend Intern role (Remote)', model: 'fake-model' });
    expect((await ev(bad.id)).ai).toMatchObject({ status: 'done', relevant: false, reason: 'Not an internship' });
    expect((await ev(bad.id)).alertedAt).toBeUndefined();
    expect(await alerts()).toEqual([expect.objectContaining({ eventId: good.id, aiReviewed: true })]);
  });

  it('a change the AI skipped is still delivered', async () => {
    const t = await setup();
    const a = await t.pending('A');
    const b = await t.pending('B');
    const { reviewer } = fakeReviewer((title) => (title === 'A' ? yes() : undefined));
    await handleAiAnalyze(deps(reviewer), t.job([a.id, b.id]), ctx);
    expect((await ev(b.id)).ai).toMatchObject({ status: 'failed', error: expect.stringContaining('no answer') });
    expect((await alerts()).map((x) => [x.eventId, x.aiReviewed])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
  });

  it('duplicates never review or alert twice', async () => {
    const t = await setup();
    const e = await t.pending('Frontend Intern');
    const { reviewer, review } = fakeReviewer(() => yes());
    const job = t.job([e.id]);
    await handleAiAnalyze(deps(reviewer), job, ctx);
    expect(await handleAiAnalyze(deps(reviewer), job, { ...ctx, redelivered: true })).toBe('duplicate');
    expect(review).toHaveBeenCalledTimes(1);
    expect(await alerts()).toHaveLength(1);
  });

  it('no AI configured: delivered as the filters decided', async () => {
    const t = await setup();
    const e = await t.pending('X');
    expect(await handleAiAnalyze(deps(null), t.job([e.id]), ctx)).toBe('fallback');
    expect((await ev(e.id)).ai).toMatchObject({ status: 'skipped', error: expect.stringContaining('not set up') });
    expect(await alerts()).toEqual([expect.objectContaining({ eventId: e.id, aiReviewed: false })]);
  });

  it('daily limit reached: no AI call, delivered as the filters decided', async () => {
    const t = await setup();
    const e1 = await t.pending('One');
    const e2 = await t.pending('Two');
    const { reviewer, review } = fakeReviewer(() => yes());
    const tight = { perUserDaily: 1, globalDaily: 100 };
    await handleAiAnalyze(deps(reviewer, { limits: tight }), t.job([e1.id]), ctx);
    expect(await handleAiAnalyze(deps(reviewer, { limits: tight }), t.job([e2.id]), ctx)).toBe('fallback');
    expect(review).toHaveBeenCalledTimes(1);
    expect((await ev(e2.id)).ai).toMatchObject({ status: 'skipped', error: expect.stringContaining('limit') });
    expect(await alerts()).toHaveLength(2);
  });

  it('temporary provider errors retry (and give the budget back when unspent)', async () => {
    const t = await setup();
    const e = await t.pending('X');
    const { reviewer } = fakeReviewer(() => new AiError('rate_limited', '429'));
    await expect(handleAiAnalyze(deps(reviewer), t.job([e.id]), ctx)).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await ev(e.id)).ai!.status).toBe('pending');
    expect(await alerts()).toHaveLength(0);
    const usage = await AiUsage.findOne({ _id: { $regex: `^user:${t.user.id}:` } }).lean();
    expect(usage!.count).toBe(0);
  });

  it('after the last retry the filters decide', async () => {
    const t = await setup();
    const e = await t.pending('X');
    const { reviewer } = fakeReviewer(() => new AiError('timeout'));
    expect(await handleAiAnalyze(deps(reviewer), t.job([e.id]), { ...ctx, attempt: MAX_ATTEMPTS })).toBe('fallback');
    expect((await ev(e.id)).ai).toMatchObject({ status: 'failed', error: expect.stringContaining('timed out') });
    expect(await alerts()).toHaveLength(1);
  });

  it.each([
    ['quota_exhausted', 'skipped'],
    ['auth', 'skipped'],
    ['bad_output', 'failed'],
    ['refused', 'failed'],
  ] as const)('%s: no retry, delivered as the filters decided', async (code, status) => {
    const t = await setup();
    const e = await t.pending('X');
    const { reviewer } = fakeReviewer(() => new AiError(code));
    expect(await handleAiAnalyze(deps(reviewer), t.job([e.id]), ctx)).toBe('fallback');
    expect((await ev(e.id)).ai!.status).toBe(status);
    expect(await alerts()).toHaveLength(1);
  });

  it('ignores deleted monitors', async () => {
    const t = await setup();
    const e = await t.pending('X');
    await Monitor.deleteOne({ _id: t.monitor._id });
    const { reviewer, review } = fakeReviewer(() => yes());
    expect(await handleAiAnalyze(deps(reviewer), t.job([e.id]), ctx)).toBe('ignored');
    expect(review).not.toHaveBeenCalled();
  });
});

describe('toReviewItem', () => {
  it('describes updates by what changed', () => {
    const item = toReviewItem({
      _id: new mongoose.Types.ObjectId(),
      eventType: 'item_changed',
      title: 'Dev',
      description: 'Location: Remote → Mumbai',
      item: { title: 'Dev', fields: { location: 'Mumbai' } },
      previous: undefined,
    });
    expect(item.details).toBe('Location: Remote → Mumbai | location: Mumbai');
  });
});

describe('budget', () => {
  it('counts per user and globally, atomically', async () => {
    const u1 = new mongoose.Types.ObjectId().toString();
    const u2 = new mongoose.Types.ObjectId().toString();
    const l = { perUserDaily: 3, globalDaily: 4 };
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveAiCall(u1, l)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await reserveAiCall(u2, l)).toBe(true);
    expect(await reserveAiCall(u2, l)).toBe(false); // global limit (4) reached
    const u2Usage = await AiUsage.findOne({ _id: { $regex: `^user:${u2}:` } }).lean();
    expect(u2Usage!.count).toBe(1); // the refused call was given back
  });

  it('simultaneous first calls of the day all count (no false "limit reached")', async () => {
    for (let round = 0; round < 5; round++) {
      const u = new mongoose.Types.ObjectId().toString();
      const results = await Promise.all(Array.from({ length: 8 }, () => reserveAiCall(u, { perUserDaily: 8, globalDaily: 1000 })));
      expect(results.every(Boolean)).toBe(true);
    }
  });

  it('a new day starts a new count', async () => {
    const u = new mongoose.Types.ObjectId().toString();
    const l = { perUserDaily: 1, globalDaily: 10 };
    expect(await reserveAiCall(u, l, new Date('2026-11-22T23:59:00Z'))).toBe(true);
    expect(await reserveAiCall(u, l, new Date('2026-11-22T23:59:30Z'))).toBe(false);
    expect(await reserveAiCall(u, l, new Date('2026-11-23T00:00:10Z'))).toBe(true);
  });

  it('throttle spaces calls out', async () => {
    const throttle = createThrottle(50);
    const start = Date.now();
    await throttle();
    await throttle();
    await throttle();
    expect(Date.now() - start).toBeGreaterThanOrEqual(95);
  });
});
