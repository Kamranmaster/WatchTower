import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, fetchCompletedSchema, fetchJobSchema, type FetchJob } from '@monitorly/contracts';
import {
  CheckRun,
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
import { MemoryObjectStore, getCompressedText, rawSnapshotKey } from '@monitorly/storage';
import { FetchError, beginRun, escalateToBrowser, recordFailure, recordSuccess, type PipelineDeps } from '../src';

const TEST_DB_URI = process.env.TEST_FETCHING_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_fetching_test?directConnection=true';
const logger = createSilentLogger();

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

async function setup(monitorFields: Record<string, unknown> = {}) {
  const user = await User.create({ name: 'F', email: `f-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x' });
  const _id = new mongoose.Types.ObjectId();
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    url: 'https://careers.example.com/jobs',
    instruction: 'interns',
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
    ...monitorFields,
  });
  const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date() });
  const job: FetchJob = fetchJobSchema.parse({
    ...createEnvelope(),
    checkRunId: run.id,
    monitorId: monitor.id,
    userId: String(user._id),
    url: monitor.url,
    fetchMode: 'http',
    scheduledAt: new Date().toISOString(),
  });
  const store = new MemoryObjectStore();
  const deps: PipelineDeps = { store, logger, errorThreshold: 3 };
  return { monitor, run, job, store, deps };
}

const page = { finalUrl: 'https://careers.example.com/jobs', status: 200, contentType: 'text/html', body: '<p>jobs</p>', bytes: 11 };

async function begin(job: FetchJob, attempt = 1, worker: 'http' | 'browser' = 'http') {
  const result = await beginRun(job, attempt, { worker });
  if (result.kind !== 'proceed') throw new Error(`expected proceed, got ${result.reason}`);
  return result;
}

describe('beginRun', () => {
  it('marks the run running', async () => {
    const { job, run } = await setup();
    await begin(job, 2);
    expect(await CheckRun.findById(run._id).lean()).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('skips a run whose monitor URL changed since it was scheduled', async () => {
    const { job, run, monitor } = await setup();
    await Monitor.updateOne({ _id: monitor._id }, { $set: { url: 'https://careers.example.com/other' } });
    expect(await beginRun(job, 1, { worker: 'http' })).toMatchObject({ kind: 'done' });
    expect(await CheckRun.findById(run._id).lean()).toMatchObject({ status: 'skipped' });
  });

  it('does nothing for a deleted run, a finished run, or a run handed to the browser', async () => {
    const { job, run } = await setup();
    await CheckRun.updateOne({ _id: run._id }, { $set: { escalatedToBrowser: true } });
    expect(await beginRun(job, 1, { worker: 'http' })).toMatchObject({ kind: 'done' });
    expect(await beginRun(job, 1, { worker: 'browser' })).toMatchObject({ kind: 'proceed' });
    await CheckRun.updateOne({ _id: run._id }, { $set: { status: 'succeeded' } });
    expect(await beginRun(job, 1, { worker: 'browser' })).toMatchObject({ kind: 'done' });
    await CheckRun.deleteOne({ _id: run._id });
    expect(await beginRun(job, 1, { worker: 'http' })).toMatchObject({ kind: 'done' });
  });
});

describe('recordSuccess', () => {
  it('stores the page and publishes a reference to it, not the HTML (Milestone 5)', async () => {
    const { job, store, deps, monitor } = await setup({ fetchMode: 'auto', consecutiveFailures: 2, lastError: 'old' });
    const { run } = await begin(job);

    expect(await recordSuccess(deps, { job, monitor, run, page, fetchMode: 'http' })).toBe('recorded');

    const key = rawSnapshotKey(job.monitorId, job.checkRunId);
    expect(await getCompressedText(store, key)).toBe(page.body);

    const snapshot = await Snapshot.findOne({ checkRunId: run._id }).lean();
    expect(snapshot).toMatchObject({ rawObjectKey: key, fetchMode: 'http', httpStatus: 200, byteSize: 11 });

    const reloadedRun = await CheckRun.findById(run._id).lean();
    expect(reloadedRun).toMatchObject({ status: 'succeeded', fetchModeUsed: 'http', snapshotId: snapshot!._id });
    expect(reloadedRun!.durationMs).toBeGreaterThanOrEqual(0);

    const reloadedMonitor = await Monitor.findById(monitor._id).lean();
    expect(reloadedMonitor).toMatchObject({ consecutiveFailures: 0, resolvedFetchMode: 'http' });
    expect(reloadedMonitor!.lastError).toBeUndefined();
    expect(reloadedMonitor!.lastCheckedAt).toBeInstanceOf(Date);

    const [message] = await OutboxMessage.find().lean();
    expect(message!.routingKey).toBe(ROUTES.fetchCompleted.routingKey);
    const completed = fetchCompletedSchema.parse(message!.payload);
    expect(completed).toMatchObject({ objectStorageKey: key, snapshotId: String(snapshot!._id), contentHash: snapshot!.contentHash });
    expect(JSON.stringify(message!.payload)).not.toContain('<p>jobs</p>');
  });

  it('is idempotent: a repeated delivery records nothing twice', async () => {
    const { job, deps, monitor } = await setup();
    const { run } = await begin(job);
    await recordSuccess(deps, { job, monitor, run, page, fetchMode: 'http' });
    expect(await recordSuccess(deps, { job, monitor, run, page, fetchMode: 'http' })).toBe('duplicate');
    expect(await Snapshot.countDocuments()).toBe(1);
    expect(await OutboxMessage.countDocuments()).toBe(1);
  });

  it('does not change resolvedFetchMode for a monitor with a fixed fetch mode', async () => {
    const { job, deps, monitor } = await setup({ fetchMode: 'browser' });
    const { run } = await begin(job);
    await recordSuccess(deps, { job, monitor, run, page, fetchMode: 'browser' });
    expect((await Monitor.findById(monitor._id).lean())!.resolvedFetchMode).toBeUndefined();
  });
});

describe('recordFailure', () => {
  const error = new FetchError('http_status', 'The site had a server error (HTTP 503)', { status: 503, retryable: true });

  it('a non-final attempt keeps the run queued with a note', async () => {
    const { job, deps, monitor } = await setup();
    const { run } = await begin(job);
    await recordFailure(deps, { run, monitor, error, attempt: 1, final: false });
    const reloaded = await CheckRun.findById(run._id).lean();
    expect(reloaded!.status).toBe('queued');
    expect(reloaded!.error).toMatch(/Attempt 1 failed.*Retrying/);
    expect((await Monitor.findById(monitor._id).lean())!.consecutiveFailures).toBe(0);
  });

  it('the final attempt fails the run and counts against the monitor', async () => {
    const { job, deps, monitor } = await setup();
    const { run } = await begin(job);
    await recordFailure(deps, { run, monitor, error, attempt: 4, final: true });
    expect(await CheckRun.findById(run._id).lean()).toMatchObject({ status: 'failed', error: error.message });
    expect(await Monitor.findById(monitor._id).lean()).toMatchObject({ consecutiveFailures: 1, lastError: error.message, status: 'active' });
  });

  it('after too many failures in a row the monitor goes to "error"', async () => {
    const { job, deps, monitor } = await setup({ consecutiveFailures: 2 }); // threshold is 3
    const { run } = await begin(job);
    await recordFailure(deps, { run, monitor, error, attempt: 4, final: true });
    expect((await Monitor.findById(monitor._id).lean())!.status).toBe('error');
  });

  it('never un-pauses a paused monitor', async () => {
    const { job, deps, monitor } = await setup({ consecutiveFailures: 5, status: 'paused' });
    const { run } = await begin(job);
    await recordFailure(deps, { run, monitor, error, attempt: 4, final: true });
    expect((await Monitor.findById(monitor._id).lean())!.status).toBe('paused');
  });
});

describe('escalateToBrowser', () => {
  it('hands the same run to the browser queue, once', async () => {
    const { job, deps } = await setup({ fetchMode: 'auto' });
    const { run } = await begin(job);
    await escalateToBrowser(deps, { job, run, reason: 'no content' });
    await escalateToBrowser(deps, { job, run, reason: 'no content' }); // redelivery

    const messages = await OutboxMessage.find().lean();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.routingKey).toBe(ROUTES.fetchBrowser.routingKey);
    const browserJob = fetchJobSchema.parse(messages[0]!.payload);
    expect(browserJob).toMatchObject({ checkRunId: job.checkRunId, fetchMode: 'browser' });
    expect(browserJob.messageId).not.toBe(job.messageId);
    expect(await CheckRun.findById(run._id).lean()).toMatchObject({ status: 'queued', escalatedToBrowser: true });
  });
});
