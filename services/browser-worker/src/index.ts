import { randomBytes } from 'node:crypto';
import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { QUEUES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { RobotsChecker, fetchEnvFields } from '@monitorly/fetching';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { OutboxRelay, startLoop } from '@monitorly/outbox';
import { runService } from '@monitorly/runtime';
import { S3ObjectStore, storageEnvFields } from '@monitorly/storage';
import { BrowserFetcher } from './browser';
import { handleBrowserFetchJob } from './handler';
import { startSafeProxy } from './proxy';

const env = loadEnv(
  baseEnvSchema.extend({
    ...storageEnvFields,
    ...fetchEnvFields,
    /** Pages rendered at once. Chromium is heavy: keep this low. */
    BROWSER_WORKER_PREFETCH: z.coerce.number().int().min(1).max(10).default(2),
    BROWSER_NAV_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
    BROWSER_SETTLE_MS: z.coerce.number().int().min(0).max(30_000).default(3_000),
  }),
);
const workerId = `browser-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('browser-worker');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const store = S3ObjectStore.fromEnv(env);
  await store.ping();

  const proxy = await startSafeProxy({ logger });
  const browser = new BrowserFetcher({
    proxy,
    logger,
    navigationTimeoutMs: env.BROWSER_NAV_TIMEOUT_MS,
    settleMs: env.BROWSER_SETTLE_MS,
    maxBytes: env.FETCH_MAX_BYTES,
  });
  await browser.start();

  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: workerId,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });
  const relay = new OutboxRelay({ relayId: workerId, publish: (route, payload) => bus.publish(route, payload), logger });
  const outboxLoop = startLoop('outbox', 1_000, async () => (await relay.drain()).published > 0, logger);

  const deps = {
    logger,
    browser,
    robots: env.RESPECT_ROBOTS_TXT ? new RobotsChecker({ fetchOptions: { userAgent: env.FETCH_USER_AGENT } }) : undefined,
    pipeline: { store, logger, errorThreshold: env.MONITOR_ERROR_THRESHOLD, wakeOutbox: () => outboxLoop.wake() },
  };

  await bus.consume(QUEUES.fetchBrowser, (job, ctx) => handleBrowserFetchJob(deps, job, ctx), {
    prefetch: env.BROWSER_WORKER_PREFETCH,
  });
  logger.info({ concurrency: env.BROWSER_WORKER_PREFETCH }, 'Browser worker ready');

  return {
    stop: async () => {
      await bus.close();
      await outboxLoop.stop();
      await browser.close();
      await proxy.close();
      await disconnectDatabase();
    },
  };
});
