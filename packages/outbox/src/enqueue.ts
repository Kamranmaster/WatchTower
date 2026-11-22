import type { ClientSession } from 'mongoose';
import type { Route } from '@monitorly/contracts';
import { OutboxMessage } from '@monitorly/database';
import type { z } from 'zod';

/**
 * Writes a message to the outbox — pass the session to make it part of the same transaction as
 * the state change it announces. Validated now, so a bad message fails the transaction instead of
 * sitting in the outbox. A relay publishes it afterwards.
 */
export async function enqueueOutbox<S extends z.ZodType>(
  route: Route<S>,
  message: z.input<S>,
  session?: ClientSession,
): Promise<z.output<S>> {
  const payload = route.schema.parse(message);
  const messageId = (payload as { messageId?: unknown }).messageId;
  if (typeof messageId !== 'string' || !messageId) throw new Error('Outbox messages need a messageId');
  await OutboxMessage.create(
    [{ messageId, exchange: route.exchange, routingKey: route.routingKey, payload }],
    session ? { session } : {},
  );
  return payload;
}
