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
import { handleHttpFetchJob } from './handler';

const env = loadEnv(
  baseEnvSchema.extend({
    ...storageEnvFields,
    ...fetchEnvFields,
    FETCH_WORKER_PREFETCH: z.coerce.number().int().min(1).max(100).default(5),
  }),
);
const workerId = `fetch-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('fetch-worker');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const store = S3ObjectStore.fromEnv(env);
  await store.ping();
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: workerId,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  // Results go through this worker's own outbox relay, woken right after each commit.
  const relay = new OutboxRelay({ relayId: workerId, publish: (route, payload) => bus.publish(route, payload), logger });
  const outboxLoop = startLoop('outbox', 1_000, async () => (await relay.drain()).published > 0, logger);

  const fetchOptions = { timeoutMs: env.FETCH_TIMEOUT_MS, maxBytes: env.FETCH_MAX_BYTES, userAgent: env.FETCH_USER_AGENT };
  const deps = {
    logger,
    fetchOptions,
    robots: env.RESPECT_ROBOTS_TXT ? new RobotsChecker({ fetchOptions: { userAgent: env.FETCH_USER_AGENT } }) : undefined,
    pipeline: { store, logger, errorThreshold: env.MONITOR_ERROR_THRESHOLD, wakeOutbox: () => outboxLoop.wake() },
  };

  await bus.consume(QUEUES.fetchHttp, (job, ctx) => handleHttpFetchJob(deps, job, ctx), {
    prefetch: env.FETCH_WORKER_PREFETCH,
  });
  logger.info({ robots: env.RESPECT_ROBOTS_TXT }, 'HTTP fetch worker ready');

  return {
    stop: async () => {
      await bus.close(); // finishes in-flight jobs first
      await outboxLoop.stop();
      await disconnectDatabase();
    },
  };
});
