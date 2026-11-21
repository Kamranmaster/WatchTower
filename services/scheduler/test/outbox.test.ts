import { describe, expect, it, vi } from 'vitest';
import { ROUTES, fetchJobSchema, type Route } from '@monitorly/contracts';
import { OutboxMessage, mongoose } from '@monitorly/database';
import { createEnvelope } from '@monitorly/messaging';
import { OutboxRelay, type PublishFn } from '../src/outbox';
import { fakeClock, logger, useTestDatabase } from './helpers';

useTestDatabase();

const id = () => new mongoose.Types.ObjectId().toString();

async function addMessage(overrides: Record<string, unknown> = {}) {
  const payload = {
    ...createEnvelope(),
    checkRunId: id(),
    monitorId: id(),
    userId: id(),
    url: 'https://careers.example.com/jobs',
    fetchMode: 'http',
    scheduledAt: new Date().toISOString(),
  };
  return OutboxMessage.create({
    messageId: payload.messageId,
    exchange: ROUTES.fetchHttp.exchange,
    routingKey: ROUTES.fetchHttp.routingKey,
    payload,
    ...overrides,
  });
}

/** Behaves like MessageBus.publish: validates against the route schema, then "confirms". */
function fakeBus() {
  const published: { route: Route; payload: unknown }[] = [];
  const publish = vi.fn<PublishFn>(async (route, payload) => {
    route.schema.parse(payload);
    published.push({ route, payload });
  });
  return { publish, published };
}

describe('OutboxRelay', () => {
  it('publishes pending messages and marks them published only after the broker confirms', async () => {
    await addMessage();
    await addMessage();
    const bus = fakeBus();
    const relay = new OutboxRelay({ relayId: 'r1', publish: bus.publish, logger });

    expect(await relay.drain()).toEqual({ published: 2, failed: 0 });
    expect(bus.published).toHaveLength(2);
    expect(fetchJobSchema.parse(bus.published[0]!.payload).url).toBe('https://careers.example.com/jobs');

    const docs = await OutboxMessage.find().lean();
    expect(docs.every((d) => d.status === 'published' && d.publishedAt && !d.lockedBy)).toBe(true);
    // Nothing left to do.
    expect(await relay.drain()).toEqual({ published: 0, failed: 0 });
  });

  it('keeps a message pending with backoff when RabbitMQ is unavailable, then succeeds later', async () => {
    await addMessage();
    const { clock, advance } = fakeClock();
    const publish = vi.fn<PublishFn>().mockRejectedValueOnce(new Error('channel closed')).mockResolvedValue(undefined);
    const relay = new OutboxRelay({ relayId: 'r1', publish, logger, clock });

    expect(await relay.drain()).toEqual({ published: 0, failed: 1 });
    let doc = await OutboxMessage.findOne().lean();
    expect(doc).toMatchObject({ status: 'pending', attempts: 1, lastError: 'channel closed' });

    // Still backing off: not retried yet.
    expect(await relay.drain()).toEqual({ published: 0, failed: 0 });

    advance(5_000);
    expect(await relay.drain()).toEqual({ published: 1, failed: 0 });
    doc = await OutboxMessage.findOne().lean();
    expect(doc).toMatchObject({ status: 'published', attempts: 2 });
    expect(doc!.lastError).toBeUndefined();
  });

  it('marks messages that can never be published as failed instead of retrying forever', async () => {
    await addMessage({ routingKey: 'no.such.route' });
    await addMessage({ payload: { messageId: 'x', nonsense: true } });
    const bus = fakeBus();
    const relay = new OutboxRelay({ relayId: 'r1', publish: bus.publish, logger });

    expect(await relay.drain()).toEqual({ published: 0, failed: 2 });
    expect(await OutboxMessage.countDocuments({ status: 'failed' })).toBe(2);
    expect(bus.published).toHaveLength(0);
  });

  it('a message locked by a crashed relay is retried after the lock expires (at-least-once)', async () => {
    await addMessage();
    const { clock, advance } = fakeClock();
    // Relay r1 claims the message and then "crashes" (publish never returns).
    const hang = new OutboxRelay({ relayId: 'r1', publish: () => new Promise(() => {}), logger, clock, lockMs: 30_000 });
    void hang.drain();
    await vi.waitFor(async () => expect(await OutboxMessage.exists({ lockedBy: 'r1' })).toBeTruthy());

    const bus = fakeBus();
    const r2 = new OutboxRelay({ relayId: 'r2', publish: bus.publish, logger, clock });
    expect(await r2.drain()).toEqual({ published: 0, failed: 0 }); // still locked by r1

    advance(31_000);
    expect(await r2.drain()).toEqual({ published: 1, failed: 0 });
  });

  it('two relays draining together publish each message once', async () => {
    await Promise.all(Array.from({ length: 20 }, () => addMessage()));
    const bus = fakeBus();
    const relays = ['r1', 'r2', 'r3'].map((relayId) => new OutboxRelay({ relayId, publish: bus.publish, logger }));

    const results = await Promise.all(relays.map((r) => r.drain()));
    expect(results.reduce((n, r) => n + r.published, 0)).toBe(20);
    const ids = bus.published.map((p) => (p.payload as { messageId: string }).messageId);
    expect(new Set(ids).size).toBe(20);
  });
});
