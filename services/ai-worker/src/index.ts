import { randomBytes } from 'node:crypto';
import { aiEnvFields, createChangeReviewer, resolveAiConfig } from '@monitorly/ai';
import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { QUEUES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { OutboxRelay, startLoop } from '@monitorly/outbox';
import { runService } from '@monitorly/runtime';
import { createThrottle } from './budget';
import { handleAiAnalyze } from './handler';

const env = loadEnv(
  baseEnvSchema.extend({
    ...aiEnvFields,
    AI_WORKER_PREFETCH: z.coerce.number().int().min(1).max(10).default(1),
    /** AI review calls per user per day (each call reviews up to AI_BATCH_SIZE changes). */
    AI_REVIEW_DAILY_LIMIT: z.coerce.number().int().min(0).default(100),
    /** AI review calls per day for the whole installation. */
    AI_REVIEW_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(0).default(500),
    /** Minimum gap between AI calls from this worker (free tiers allow ~15 requests/minute). */
    AI_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(4_000),
  }),
);
const workerId = `ai-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('ai-worker');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: workerId,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  const ai = resolveAiConfig(env);
  if (!ai) logger.warn(`AI_API_KEY not set (AI_PROVIDER=${env.AI_PROVIDER}): changes are passed on without AI review`);

  const relay = new OutboxRelay({ relayId: workerId, publish: (route, payload) => bus.publish(route, payload), logger });
  const outboxLoop = startLoop('outbox', 1_000, async () => (await relay.drain()).published > 0, logger);
  const deps = {
    logger,
    reviewer: ai ? createChangeReviewer(ai) : null,
    limits: { perUserDaily: env.AI_REVIEW_DAILY_LIMIT, globalDaily: env.AI_REVIEW_GLOBAL_DAILY_LIMIT },
    throttle: createThrottle(env.AI_MIN_INTERVAL_MS),
    wakeOutbox: () => outboxLoop.wake(),
  };

  await bus.consume(QUEUES.aiAnalyze, async (msg, ctx) => void (await handleAiAnalyze(deps, msg, ctx)), {
    prefetch: env.AI_WORKER_PREFETCH,
  });
  logger.info({ ai: ai ? `${ai.provider}/${ai.model}` : 'off' }, 'AI worker ready');

  return {
    stop: async () => {
      await bus.close();
      await outboxLoop.stop();
      await disconnectDatabase();
    },
  };
});
