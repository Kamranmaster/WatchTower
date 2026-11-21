import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { runService } from '@monitorly/runtime';
import { PartitionLeaseManager } from './leases';
import { startLoop } from './loop';
import { OutboxRelay } from './outbox';
import { scheduleDueMonitors } from './schedule';

const env = loadEnv(
  baseEnvSchema.extend({
    /** How often to look for due monitors. */
    SCHEDULER_TICK_MS: z.coerce.number().int().min(250).default(2_000),
    /** Max monitors scheduled per tick (the next tick picks up the rest). */
    SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(200),
    /** A partition lease not renewed within this time is taken over by another instance. */
    SCHEDULER_LEASE_TTL_MS: z.coerce.number().int().min(3_000).default(15_000),
    SCHEDULER_LEASE_RENEW_MS: z.coerce.number().int().min(500).default(5_000),
    /** Fallback poll for the outbox; normally it is woken right after scheduling. */
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1_000),
    SCHEDULER_INSTANCE_ID: z.string().trim().min(1).optional(),
  }),
);

if (env.SCHEDULER_LEASE_RENEW_MS * 2 >= env.SCHEDULER_LEASE_TTL_MS) {
  console.error('SCHEDULER_LEASE_RENEW_MS must be less than half of SCHEDULER_LEASE_TTL_MS');
  process.exit(1);
}

const instanceId = env.SCHEDULER_INSTANCE_ID ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('scheduler').child({ instanceId });

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: `scheduler-${instanceId}`,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  const leases = new PartitionLeaseManager({ instanceId, ttlMs: env.SCHEDULER_LEASE_TTL_MS, logger });
  const relay = new OutboxRelay({ relayId: instanceId, publish: (route, payload) => bus.publish(route, payload), logger });

  await leases.refresh();

  const leaseLoop = startLoop('leases', env.SCHEDULER_LEASE_RENEW_MS, async () => void (await leases.refresh()), logger);

  const outboxLoop = startLoop(
    'outbox',
    env.OUTBOX_POLL_MS,
    async () => {
      const { published, failed } = await relay.drain();
      if (published + failed > 0) logger.debug({ published, failed }, 'Outbox drained');
      return published > 0 && failed === 0; // more may be waiting → go again immediately
    },
    logger,
  );

  const scheduleLoop = startLoop(
    'schedule',
    env.SCHEDULER_TICK_MS,
    async () => {
      const result = await scheduleDueMonitors({
        partitions: leases.ownedPartitions(),
        now: new Date(),
        batchSize: env.SCHEDULER_BATCH_SIZE,
        logger,
      });
      if (result.scheduled > 0) {
        logger.info(result, 'Scheduled checks');
        outboxLoop.wake();
      }
      return result.scheduled + result.duplicate >= env.SCHEDULER_BATCH_SIZE; // backlog → go again
    },
    logger,
  );

  logger.info({ partitions: leases.ownedPartitions().length }, 'Scheduler running');

  return {
    stop: async () => {
      await scheduleLoop.stop();
      await leaseLoop.stop();
      // Publish whatever was just scheduled before letting go of RabbitMQ.
      await outboxLoop.stop();
      await relay.drain().catch((err) => logger.warn({ err }, 'Final outbox drain failed'));
      await leases.releaseAll().catch((err) => logger.warn({ err }, 'Could not release leases'));
      await bus.close();
      await disconnectDatabase();
    },
  };
});
