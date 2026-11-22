import { randomBytes } from 'node:crypto';
import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { QUEUES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { OutboxRelay, startLoop } from '@monitorly/outbox';
import { runService } from '@monitorly/runtime';
import { S3ObjectStore, storageEnvFields } from '@monitorly/storage';
import { handleFetchCompleted } from './handler';

const env = loadEnv(
  baseEnvSchema.extend({
    ...storageEnvFields,
    PROCESSING_WORKER_PREFETCH: z.coerce.number().int().min(1).max(50).default(4),
    /** Incomplete-looking extractions in a row before a new page layout is accepted. */
    REBASELINE_AFTER: z.coerce.number().int().min(1).default(3),
  }),
);
const workerId = `processing-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('processing-worker');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const store = S3ObjectStore.fromEnv(env);
  await store.ping();
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: workerId,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  const relay = new OutboxRelay({ relayId: workerId, publish: (route, payload) => bus.publish(route, payload), logger });
  const outboxLoop = startLoop('outbox', 1_000, async () => (await relay.drain()).published > 0, logger);
  const deps = { store, logger, wakeOutbox: () => outboxLoop.wake(), rebaselineAfter: env.REBASELINE_AFTER };

  await bus.consume(QUEUES.contentProcess, async (msg, ctx) => void (await handleFetchCompleted(deps, msg, ctx)), {
    prefetch: env.PROCESSING_WORKER_PREFETCH,
  });
  logger.info('Processing worker ready');

  return {
    stop: async () => {
      await bus.close();
      await outboxLoop.stop();
      await disconnectDatabase();
    },
  };
});
