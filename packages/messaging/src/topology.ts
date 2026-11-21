import type { Channel } from 'amqplib';
import { EXCHANGES, QUEUES, RETRY_DELAYS_MS, deadQueueName, retryQueueName } from '@monitorly/contracts';

/**
 * Declares every exchange and queue. Idempotent — safe for every service to call on startup.
 *
 * Note: RabbitMQ refuses to redeclare an existing queue with different arguments
 * (PRECONDITION_FAILED). If you change queue arguments here, delete the old queue
 * in the management UI or run `npm run infra:reset` locally.
 */
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGES.monitor, 'topic', { durable: true });
  await channel.assertExchange(EXCHANGES.notification, 'topic', { durable: true });
  await channel.assertExchange(EXCHANGES.deadLetter, 'direct', { durable: true });

  for (const q of Object.values(QUEUES)) {
    // Work queue: rejected messages (nack, requeue=false) go to the dead-letter exchange.
    await channel.assertQueue(q.name, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.deadLetter,
        'x-dead-letter-routing-key': q.name,
      },
    });
    await channel.bindQueue(q.name, q.route.exchange, q.route.routingKey);

    // Retry tiers: messages sit here for <delay> ms, then dead-letter straight back into the work queue.
    for (const delay of RETRY_DELAYS_MS) {
      await channel.assertQueue(retryQueueName(q.name, delay), {
        durable: true,
        arguments: {
          'x-message-ttl': delay,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': q.name,
        },
      });
    }

    // Dead-letter queue: inspect/replay manually from the management UI.
    await channel.assertQueue(deadQueueName(q.name), { durable: true });
    await channel.bindQueue(deadQueueName(q.name), EXCHANGES.deadLetter, q.name);
  }
}
