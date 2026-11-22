import { randomBytes } from 'node:crypto';
import { baseEnvSchema, loadEnv, z } from '@monitorly/config';
import { QUEUES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { OutboxRelay, startLoop } from '@monitorly/outbox';
import { runService } from '@monitorly/runtime';
import { handleEmailJob, handleEventMatched } from './handler';
import { createResendMailer, createSmtpMailer } from './mailer';

const env = loadEnv(
  baseEnvSchema.extend({
    WEB_ORIGIN: z.url().default('http://localhost:5173'),
    EMAIL_FROM: z.string().min(3).default('Monitorly <onboarding@resend.dev>'),
    /** Set to send real email through Resend; otherwise SMTP (Mailpit locally). */
    RESEND_API_KEY: z.string().default(''),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_USER: z.string().default(''),
    SMTP_PASS: z.string().default(''),
    /** Emails per user per hour; more alerts are still shown in the app. */
    EMAIL_MAX_PER_HOUR: z.coerce.number().int().min(0).default(20),
    NOTIFICATION_WORKER_PREFETCH: z.coerce.number().int().min(1).max(50).default(10),
    EMAIL_WORKER_PREFETCH: z.coerce.number().int().min(1).max(20).default(4),
  }),
);
const workerId = `notification-${process.pid}-${randomBytes(3).toString('hex')}`;
const logger = createLogger('notification-worker');
const webOrigin = env.WEB_ORIGIN.replace(/\/+$/, '');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: workerId,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  const mailer = env.RESEND_API_KEY
    ? createResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM)
    : createSmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER || undefined, pass: env.SMTP_PASS, from: env.EMAIL_FROM });

  const relay = new OutboxRelay({ relayId: workerId, publish: (route, payload) => bus.publish(route, payload), logger });
  const outboxLoop = startLoop('outbox', 1_000, async () => (await relay.drain()).published > 0, logger);
  const wakeOutbox = () => outboxLoop.wake();

  await bus.consume(QUEUES.notifyDispatch, async (msg, ctx) => void (await handleEventMatched({ logger, webOrigin, wakeOutbox }, msg, ctx)), {
    prefetch: env.NOTIFICATION_WORKER_PREFETCH,
  });
  await bus.consume(
    QUEUES.notifyEmail,
    async (msg, ctx) => void (await handleEmailJob({ logger, mailer, webOrigin, maxPerHour: env.EMAIL_MAX_PER_HOUR }, msg, ctx)),
    { prefetch: env.EMAIL_WORKER_PREFETCH },
  );
  logger.info({ mailer: mailer.name }, 'Notification worker ready');

  return {
    stop: async () => {
      await bus.close();
      await outboxLoop.stop();
      await disconnectDatabase();
    },
  };
});
