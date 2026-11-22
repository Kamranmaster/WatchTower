import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, fetchJobSchema, type FetchJob } from '@monitorly/contracts';
import {
  CheckRun,
  Monitor,
  OutboxMessage,
  User,
  connectDatabase,
  disconnectDatabase,
  mongoose,
  partitionFor,
  syncAllIndexes,
} from '@monitorly/database';
import { FetchError } from '@monitorly/fetching';
import { createSilentLogger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { MemoryObjectStore } from '@monitorly/storage';
import { handleBrowserFetchJob, type BrowserHandlerDeps } from '../src/handler';

const TEST_DB_URI = process.env.TEST_BROWSER_WORKER_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_browserworker_test?directConnection=true';
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

async function setup(fetch: BrowserHandlerDeps['browser']['fetch']) {
  const user = await User.create({ name: 'B', email: `b-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x' });
  const _id = new mongoose.Types.ObjectId();
  const monitor = await Monitor.create({
    _id,
    userId: user._id,
    url: 'https://spa.example.com/jobs',
    instruction: 'interns',
    fetchMode: 'auto',
    partitionId: partitionFor(String(_id)),
    nextCheckAt: new Date(Date.now() + 60_000),
  });
  const run = await CheckRun.create({ monitorId: monitor._id, userId: user._id, scheduledFor: new Date(), escalatedToBrowser: true });
  const job: FetchJob = fetchJobSchema.parse({
    ...createEnvelope(),
    checkRunId: run.id,
    monitorId: monitor.id,
    userId: String(user._id),
    url: monitor.url,
    fetchMode: 'browser',
    scheduledAt: new Date().toISOString(),
  });
  const deps: BrowserHandlerDeps = { logger, browser: { fetch }, pipeline: { store: new MemoryObjectStore(), logger, errorThreshold: 5 } };
  return { job, monitor, deps };
}

const ctx = (attempt = 1) => ({ messageId: 'm', attempt, redelivered: false });

describe('handleBrowserFetchJob', () => {
  it('records a rendered page and remembers that "auto" needs the browser for this monitor', async () => {
    const { job, monitor, deps } = await setup(async () => ({
      finalUrl: 'https://spa.example.com/jobs',
      status: 200,
      contentType: 'text/html',
      body: '<div id="root">Rendered</div>',
      bytes: 29,
    }));
    await handleBrowserFetchJob(deps, job, ctx());

    expect(await CheckRun.findById(job.checkRunId).lean()).toMatchObject({ status: 'succeeded', fetchModeUsed: 'browser' });
    expect((await Monitor.findById(monitor._id).lean())!.resolvedFetchMode).toBe('browser');
    const [message] = await OutboxMessage.find().lean();
    expect(message!.routingKey).toBe(ROUTES.fetchCompleted.routingKey);
  });

  it('retries a browser timeout, then fails the run on the last attempt', async () => {
    const { job, deps } = await setup(async () => {
      throw new FetchError('timeout', 'The page took too long to load in the browser', { retryable: true });
    });
    await expect(handleBrowserFetchJob(deps, job, ctx(1))).rejects.toMatchObject({ kind: 'timeout' });
    await handleBrowserFetchJob(deps, job, ctx(4));
    expect(await CheckRun.findById(job.checkRunId).lean()).toMatchObject({ status: 'failed' });
  });
});
