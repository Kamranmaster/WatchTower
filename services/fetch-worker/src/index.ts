import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { QUEUES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { runService } from '@monitorly/runtime';

const env = loadEnv(
  baseEnvSchema.extend({
    FETCH_WORKER_PREFETCH: z.coerce.number().int().min(1).max(100).default(5),
  }),
);
const logger = createLogger('fetch-worker');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: `fetch-worker-${process.pid}`,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  await bus.consume(
    QUEUES.fetchHttp,
    async (job, ctx) => {
      // Phase 1: prove delivery end-to-end. Phase 5 replaces this with the SSRF-safe HTTP fetch.
      logger.info(
        { checkRunId: job.checkRunId, monitorId: job.monitorId, url: job.url, attempt: ctx.attempt },
        'Received fetch job',
      );
    },
    { prefetch: env.FETCH_WORKER_PREFETCH },
  );

  return {
    stop: async () => {
      await bus.close();
      await disconnectDatabase();
    },
  };
});
