import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, retryQueueName, type QueueDef, type Route } from '@monitorly/contracts';
import type { Logger } from '@monitorly/logger';
import type { z } from 'zod';
import { assertTopology } from './topology';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;

/** Throw this from a handler when retrying can never succeed (e.g. the monitor was deleted). */
export class NonRetryableError extends Error {
  override name = 'NonRetryableError';
}

export interface ConsumeContext {
  messageId: string;
  /** 1 on first delivery, incremented each time the message goes through a retry queue. */
  attempt: number;
  /** True if the broker redelivered after a consumer died without acking. */
  redelivered: boolean;
}

export interface ConsumeOptions {
  /** Max unacknowledged messages this consumer holds at once. Keep low for heavy work (Playwright). */
  prefetch?: number;
  maxAttempts?: number;
}

export interface ConnectOptions {
  logger: Logger;
  /** Shows up in the RabbitMQ management UI. */
  connectionName: string;
  /** Called if the broker connection drops. Services should exit and let the supervisor restart them. */
  onUnexpectedClose?: (err?: Error) => void;
}

/** Creates the standard envelope fields every message needs. */
export function createEnvelope(): { messageId: string; occurredAt: string } {
  return { messageId: randomUUID(), occurredAt: new Date().toISOString() };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class MessageBus {
  private closing = false;
  private connected = true;
  private readonly consumers: { channel: Channel; consumerTag: string }[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  private constructor(
    private readonly connection: Connection,
    private readonly publisher: ConfirmChannel,
    private readonly logger: Logger,
  ) {}

  static async connect(url: string, options: ConnectOptions): Promise<MessageBus> {
    const { logger } = options;
    const connection = await amqp.connect(url, {
      clientProperties: { connection_name: options.connectionName },
    });
    // Confirm channel: the broker acks every publish, so we know it was accepted.
    const publisher = await connection.createConfirmChannel();
    await assertTopology(publisher);

    const bus = new MessageBus(connection, publisher, logger);

    connection.on('error', (err: Error) => logger.error({ err }, 'RabbitMQ connection error'));
    connection.on('close', (err?: Error) => {
      bus.connected = false;
      if (!bus.closing) {
        logger.error({ err }, 'RabbitMQ connection closed unexpectedly');
        options.onUnexpectedClose?.(err);
      }
    });
    publisher.on('error', (err: Error) => logger.error({ err }, 'RabbitMQ publisher channel error'));
    publisher.on('return', (msg: ConsumeMessage) =>
      logger.error(
        { exchange: msg.fields.exchange, routingKey: msg.fields.routingKey },
        'Message was unroutable (no queue bound) and returned by the broker',
      ),
    );

    logger.info('Connected to RabbitMQ');
    return bus;
  }

  get isHealthy(): boolean {
    return this.connected && !this.closing;
  }

  /**
   * Validates the message against the route's schema, publishes it persistently,
   * and resolves only once the broker confirms it.
   */
  async publish<S extends z.ZodType>(route: Route<S>, message: z.input<S>): Promise<z.output<S>> {
    const parsed = route.schema.parse(message);
    const messageId = (parsed as { messageId?: string }).messageId ?? randomUUID();
    await this.publishRaw(route.exchange, route.routingKey, Buffer.from(JSON.stringify(parsed)), {
      messageId,
      // Broadcasts may have no listener at all (no API running): that's not an error.
      ...(route.broadcast ? { mandatory: false, persistent: false } : {}),
    });
    return parsed;
  }

  private publishRaw(exchange: string, routingKey: string, content: Buffer, options: Options.Publish): Promise<void> {
    return new Promise((resolve, reject) => {
      this.publisher.publish(
        exchange,
        routingKey,
        content,
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          timestamp: Math.floor(Date.now() / 1000),
          ...options,
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * Consumes a queue with manual acknowledgements.
   *   success              → ack
   *   invalid message      → dead-letter immediately
   *   handler throws       → retry with backoff via TTL queues, up to maxAttempts
   *   NonRetryableError    → dead-letter immediately
   *   process crashes      → message is unacked, broker redelivers it
   *
   * Handlers must be idempotent: the same message can arrive more than once.
   */
  async consume<S extends z.ZodType>(
    queue: QueueDef<S>,
    handler: (message: z.output<S>, ctx: ConsumeContext) => Promise<void>,
    options: ConsumeOptions = {},
  ): Promise<void> {
    const { prefetch = 10, maxAttempts = MAX_ATTEMPTS } = options;
    const log = this.logger.child({ queue: queue.name });
    const channel = await this.connection.createChannel();
    channel.on('error', (err: Error) => log.error({ err }, 'Consumer channel error'));
    await channel.prefetch(prefetch);

    const handle = async (msg: ConsumeMessage): Promise<void> => {
      const headers = msg.properties.headers ?? {};
      const attempt = Number(headers['x-attempt'] ?? 1);
      const messageId = String(msg.properties.messageId ?? 'unknown');
      const mlog = log.child({ messageId, attempt });

      let payload: z.output<S>;
      try {
        payload = queue.route.schema.parse(JSON.parse(msg.content.toString('utf8')));
      } catch (err) {
        mlog.error({ err }, 'Invalid message; sending to dead-letter queue');
        channel.nack(msg, false, false);
        return;
      }

      try {
        await handler(payload, { messageId, attempt, redelivered: msg.fields.redelivered });
        channel.ack(msg);
      } catch (err) {
        if (err instanceof NonRetryableError || attempt >= maxAttempts) {
          mlog.error({ err }, 'Handler failed permanently; sending to dead-letter queue');
          channel.nack(msg, false, false);
          return;
        }
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
        try {
          // Publish to the retry tier first, then ack the original: at-least-once, never lost.
          await this.publishRaw('', retryQueueName(queue.name, delay), msg.content, {
            messageId,
            contentType: msg.properties.contentType,
            headers: { ...headers, 'x-attempt': attempt + 1, 'x-last-error': errorMessage(err).slice(0, 500) },
          });
          channel.ack(msg);
          mlog.warn({ err, retryInMs: delay }, 'Handler failed; retry scheduled');
        } catch (publishErr) {
          mlog.error({ err: publishErr }, 'Could not schedule retry; requeueing');
          channel.nack(msg, false, true);
        }
      }
    };

    const { consumerTag } = await channel.consume(
      queue.name,
      (msg) => {
        if (!msg) {
          log.warn('Consumer was cancelled by the broker');
          return;
        }
        const task = handle(msg).catch((err) => log.error({ err }, 'Unexpected consumer failure'));
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task));
      },
      { noAck: false },
    );

    this.consumers.push({ channel, consumerTag });
    log.info({ prefetch }, 'Consuming');
  }

  /**
   * Listens to a broadcast route with a private, temporary queue (deleted when this process
   * disconnects). Every subscribed process gets every message. Best effort: no retries, and
   * messages sent while nobody listens are dropped, so use it only for live updates whose
   * source of truth is stored elsewhere.
   */
  async subscribe<S extends z.ZodType>(route: Route<S>, handler: (message: z.output<S>) => Promise<void>): Promise<void> {
    const log = this.logger.child({ route: route.routingKey });
    const channel = await this.connection.createChannel();
    channel.on('error', (err: Error) => log.error({ err }, 'Subscriber channel error'));
    const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false });
    await channel.bindQueue(queue, route.exchange, route.routingKey);
    const { consumerTag } = await channel.consume(
      queue,
      (msg) => {
        if (!msg) return;
        const task = (async () => {
          const payload = route.schema.parse(JSON.parse(msg.content.toString('utf8')));
          await handler(payload);
        })().catch((err) => log.warn({ err }, 'Broadcast handler failed'));
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task));
      },
      { noAck: true },
    );
    this.consumers.push({ channel, consumerTag });
    log.info('Subscribed');
  }

  /** Message/consumer counts for a queue — used by health checks and dev tooling. */
  async queueStats(queueName: string): Promise<{ messageCount: number; consumerCount: number }> {
    const { messageCount, consumerCount } = await this.publisher.checkQueue(queueName);
    return { messageCount, consumerCount };
  }

  /** Graceful shutdown: stop taking new messages, finish in-flight ones, then disconnect. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const { channel, consumerTag } of this.consumers) {
      await channel.cancel(consumerTag).catch(() => undefined);
    }
    await Promise.allSettled([...this.inFlight]);
    for (const { channel } of this.consumers) {
      await channel.close().catch(() => undefined);
    }
    await this.publisher.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
    this.logger.info('RabbitMQ connection closed');
  }
}
