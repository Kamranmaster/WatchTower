import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, fetchJobSchema, type FetchJob } from '@monitorly/contracts';
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
import { RobotsChecker } from '@monitorly/fetching';
import { createSilentLogger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { MemoryObjectStore } from '@monitorly/storage';
import { handleHttpFetchJob, type HttpHandlerDeps } from '../src/handler';
import { startTestServer } from '../../../packages/fetching/test/server';

const TEST_DB_URI = process.env.TEST_FETCH_WORKER_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_fetchworker_test?directConnection=true';
const logger = createSilentLogger();
let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  await connectDatabase(TEST_DB_URI, logger);
  await syncAllIndexes();
  server = await startTestServer();
});
beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});
afterAll(async () => {
  await server.close();
  await mongoose.connection.db?.dropDatabase();
  await disconnectDatabase();
});

async function setup(path: string, fetchMode: 'auto' | 'http' | 'browser' = 'auto') {
  const user = await User.create({ name: 'W', email: `w-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x' });
  const _id = new mongoose.Types.ObjectId();
  const url = server.url(path);
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    url,
    instruction: 'interns',
    fetchMode,
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
  });
  const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date() });
  const job: FetchJob = fetchJobSchema.parse({
    ...createEnvelope(),
    checkRunId: run.id,
    monitorId: monitor.id,
    userId: String(user._id),
    url,
    fetchMode: 'http',
    scheduledAt: new Date().toISOString(),
  });
  const deps: HttpHandlerDeps = {
    logger,
    fetchOptions: { policy: server.policy, timeoutMs: 2000 },
    robots: new RobotsChecker({ fetchOptions: { policy: server.policy } }),
    pipeline: { store: new MemoryObjectStore(), logger, errorThreshold: 5 },
  };
  return { job, run, monitor, deps };
}

const ctx = (attempt = 1) => ({ messageId: 'm', attempt, redelivered: false });
const runOf = (job: FetchJob) => CheckRun.findById(job.checkRunId).lean();

describe('handleHttpFetchJob', () => {
  it('fetches, stores and publishes fetch.completed (Milestone 5)', async () => {
    const { job, deps, monitor } = await setup('/page');
    await handleHttpFetchJob(deps, job, ctx());

    expect(await runOf(job)).toMatchObject({ status: 'succeeded', fetchModeUsed: 'http' });
    expect(await Snapshot.countDocuments()).toBe(1);
    const [message] = await OutboxMessage.find().lean();
    expect(message!.routingKey).toBe(ROUTES.fetchCompleted.routingKey);
    expect((await Monitor.findById(monitor._id).lean())!.resolvedFetchMode).toBe('http');
  });

  it('auto mode: a JavaScript-only page is handed to the browser worker', async () => {
    const { job, deps } = await setup('/spa', 'auto');
    await handleHttpFetchJob(deps, job, ctx());

    expect(await runOf(job)).toMatchObject({ status: 'queued', escalatedToBrowser: true });
    const [message] = await OutboxMessage.find().lean();
    expect(message!.routingKey).toBe(ROUTES.fetchBrowser.routingKey);
    expect(await Snapshot.countDocuments()).toBe(0);
  });

  it('http mode: a JavaScript-only page is stored as-is (the user chose simple fetching)', async () => {
    const { job, deps } = await setup('/spa', 'http');
    await handleHttpFetchJob(deps, job, ctx());
    expect((await runOf(job))!.status).toBe('succeeded');
  });

  it('auto mode: HTTP 403 (likely bot protection) is handed to the browser', async () => {
    const { job, deps } = await setup('/403', 'auto');
    await handleHttpFetchJob(deps, job, ctx());
    expect((await runOf(job))!.escalatedToBrowser).toBe(true);
  });

  it('a permanent error fails the run right away, without a retry', async () => {
    const { job, deps, monitor } = await setup('/404', 'http');
    await expect(handleHttpFetchJob(deps, job, ctx())).resolves.toBeUndefined();
    expect(await runOf(job)).toMatchObject({ status: 'failed' });
    expect((await runOf(job))!.error).toMatch(/not found/i);
    expect((await Monitor.findById(monitor._id).lean())!.consecutiveFailures).toBe(1);
  });

  it('a temporary error is retried (rethrown), then fails on the last attempt', async () => {
    const { job, deps } = await setup('/503', 'http');
    await expect(handleHttpFetchJob(deps, job, ctx(1))).rejects.toMatchObject({ kind: 'http_status', status: 503 });
    expect((await runOf(job))!.status).toBe('queued');

    await expect(handleHttpFetchJob(deps, job, ctx(4))).resolves.toBeUndefined();
    expect((await runOf(job))!.status).toBe('failed');
  });

  it('respects robots.txt', async () => {
    const { job, deps } = await setup('/private/page', 'http');
    await handleHttpFetchJob(deps, job, ctx());
    expect((await runOf(job))!.error).toMatch(/robots\.txt/);
  });

  it('a redirect to an internal address fails the run as blocked', async () => {
    const { job, deps } = await setup('/redirect-metadata', 'http');
    await handleHttpFetchJob(deps, job, ctx());
    const run = await runOf(job);
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/blocked address/);
  });

  it('a redelivered job that already succeeded does nothing', async () => {
    const { job, deps } = await setup('/page');
    await handleHttpFetchJob(deps, job, ctx());
    await handleHttpFetchJob(deps, job, { ...ctx(), redelivered: true });
    expect(await Snapshot.countDocuments()).toBe(1);
    expect(await OutboxMessage.countDocuments()).toBe(1);
  });
});
