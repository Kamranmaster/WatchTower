import { findRoute, type Route } from '@monitorly/contracts';
import { OutboxMessage } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { ZodError } from 'zod';

export type Clock = () => Date;

/** Publishes one message and resolves once the broker confirms it (MessageBus.publish does this). */
export type PublishFn = (route: Route, payload: unknown) => Promise<unknown>;

export interface OutboxRelayOptions {
  /** Identifies this relay in lock fields (the scheduler instance id). */
  relayId: string;
  publish: PublishFn;
  logger: Logger;
  /** How long a claimed message stays locked; if we crash, another relay retries after this. */
  lockMs?: number;
  /** Max messages per drain() call. */
  batchSize?: number;
  /** Backoff cap for messages that keep failing to publish. */
  maxBackoffMs?: number;
  clock?: Clock;
}

class PermanentOutboxError extends Error {}

/**
 * Moves outbox messages to RabbitMQ: claim → publish (await confirm) → mark published.
 *
 * Several relays can run at once: claiming is an atomic findOneAndUpdate, so each message is
 * handled by one relay at a time. Delivery is at-least-once: if a relay crashes after the broker
 * confirmed but before marking the message published, it is published again once the lock
 * expires. Consumers are idempotent, so that is safe.
 */
export class OutboxRelay {
  private readonly clock: Clock;
  private readonly lockMs: number;
  private readonly batchSize: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: OutboxRelayOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.lockMs = options.lockMs ?? 30_000;
    this.batchSize = options.batchSize ?? 100;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  /** Publishes pending messages until none are left or batchSize is reached. Returns how many were handled. */
  async drain(): Promise<{ published: number; failed: number }> {
    const result = { published: 0, failed: 0 };
    for (let i = 0; i < this.batchSize; i++) {
      const message = await this.claimNext();
      if (!message) break;
      if (await this.publishOne(message)) result.published++;
      else result.failed++;
    }
    return result;
  }

  private async claimNext() {
    const now = this.clock();
    return OutboxMessage.findOneAndUpdate(
      // lockedUntil: null also matches documents where the field is missing.
      { status: 'pending', $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + this.lockMs), lockedBy: this.options.relayId }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
  }

  private async publishOne(message: NonNullable<Awaited<ReturnType<OutboxRelay['claimNext']>>>): Promise<boolean> {
    const { logger, relayId } = this.options;
    const log = logger.child({ outboxId: String(message._id), messageId: message.messageId, routingKey: message.routingKey });
    const mine = { _id: message._id, lockedBy: relayId };

    try {
      const route = findRoute(message.exchange, message.routingKey);
      if (!route) throw new PermanentOutboxError(`No route for ${message.exchange} / ${message.routingKey}`);
      try {
        await this.options.publish(route, message.payload);
      } catch (err) {
        // The payload no longer matches its schema: retrying can't help.
        if (err instanceof ZodError) throw new PermanentOutboxError(`Invalid payload: ${err.message}`);
        throw err;
      }
    } catch (err) {
      const errorText = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      if (err instanceof PermanentOutboxError) {
        log.error({ err }, 'Outbox message can never be published; marked failed');
        await OutboxMessage.updateOne(mine, { $set: { status: 'failed', lastError: errorText }, $unset: { lockedUntil: 1, lockedBy: 1 } });
      } else {
        const backoff = Math.min(this.maxBackoffMs, 1000 * 2 ** Math.min(message.attempts, 16));
        log.warn({ err, attempts: message.attempts, retryInMs: backoff }, 'Outbox publish failed; will retry');
        await OutboxMessage.updateOne(mine, {
          $set: { lockedUntil: new Date(this.clock().getTime() + backoff), lastError: errorText },
        });
      }
      return false;
    }

    // Broker confirmed. Only now is the message considered published.
    await OutboxMessage.updateOne(mine, {
      $set: { status: 'published', publishedAt: this.clock() },
      $unset: { lockedUntil: 1, lockedBy: 1, lastError: 1 },
    });
    return true;
  }
}
