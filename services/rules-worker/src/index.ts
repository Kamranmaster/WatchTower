import { randomBytes } from 'node:crypto';
import { aiEnvFields, resolveAiConfig } from '@monitorly/ai';
import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { AI_BATCH_MAX, QUEUES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { OutboxRelay, startLoop } from '@monitorly/outbox';
import { runService } from '@monitorly/runtime';
import { handleContentProcessed } from './handler';

const env = loadEnv(
  baseEnvSchema.extend({
    ...aiEnvFields,
    RULES_WORKER_PREFETCH: z.coerce.number().int().min(1).max(50).default(8),
    /** Changes reviewed per AI request (fewer requests, same quota per change). */
    AI_BATCH_SIZE: z.coerce.number().int().min(1).max(AI_BATCH_MAX).default(10),
  }),
);
const workerId = `rules-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('rules-worker');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: workerId,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  const ai = resolveAiConfig(env);
  if (!ai) logger.warn(`AI_API_KEY not set (AI_PROVIDER=${env.AI_PROVIDER}): matches are decided by the filters alone`);

  const relay = new OutboxRelay({ relayId: workerId, publish: (route, payload) => bus.publish(route, payload), logger });
  const outboxLoop = startLoop('outbox', 1_000, async () => (await relay.drain()).published > 0, logger);
  const deps = { logger, aiEnabled: ai !== null, aiBatchSize: env.AI_BATCH_SIZE, wakeOutbox: () => outboxLoop.wake() };

  await bus.consume(QUEUES.rulesEvaluate, async (msg, ctx) => void (await handleContentProcessed(deps, msg, ctx)), {
    prefetch: env.RULES_WORKER_PREFETCH,
  });
  logger.info({ ai: ai ? `${ai.provider}/${ai.model}` : 'off' }, 'Rules worker ready');

  return {
    stop: async () => {
      await bus.close();
      await outboxLoop.stop();
      await disconnectDatabase();
    },
  };
});
