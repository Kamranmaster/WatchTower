import { describe, expect, it } from 'vitest';
import { ROUTES, fetchJobSchema } from '@monitorly/contracts';
import { CheckRun, Monitor, OutboxMessage } from '@monitorly/database';
import { fetchModeFor, nextCheckAfter, scheduleDueMonitors, scheduleMonitor, slotFor } from '../src/schedule';
import { ALL_PARTITIONS, createMonitor, logger, useTestDatabase } from './helpers';

useTestDatabase();

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

describe('time helpers', () => {
  it('rounds the slot down to the minute', () => {
    expect(slotFor(at('2026-11-22T10:05:42.123Z'))).toEqual(at('2026-11-22T10:05:00.000Z'));
  });

  it('keeps the cadence for an on-time check', () => {
    expect(nextCheckAfter(at('2026-11-22T10:00:00Z'), 30, at('2026-11-22T10:00:01Z'))).toEqual(at('2026-11-22T10:30:00Z'));
  });

  it('keeps the cadence when a little late', () => {
    // 10 minutes late on a 30-minute interval: still 10:30.
    expect(nextCheckAfter(at('2026-11-22T10:00:00Z'), 30, at('2026-11-22T10:10:00Z'))).toEqual(at('2026-11-22T10:30:00Z'));
  });

  it('restarts the cadence from now when badly late, instead of catching up with a burst', () => {
    // Scheduler was down from 10:00 to 13:10 → next check 13:40, not 10:30, 11:00, 11:30…
    expect(nextCheckAfter(at('2026-11-22T10:00:00Z'), 30, at('2026-11-22T13:10:00Z'))).toEqual(at('2026-11-22T13:40:00Z'));
  });

  it('never schedules two checks less than half an interval apart', () => {
    // Found in a live run: due 19:54:58 on a 5-minute interval, picked up at 20:19:56.
    // Keeping the old cadence would have meant another check at 20:19:58 — two seconds later.
    const now = at('2026-11-22T20:19:56Z');
    const next = nextCheckAfter(at('2026-11-22T19:54:58Z'), 5, now);
    expect(next).toEqual(at('2026-11-22T20:24:56Z'));
    for (const lateBy of [0, 1, 60, 149, 150, 151, 299, 300, 301, 10_000].map((s) => s * 1000)) {
      const due = new Date(now.getTime() - lateBy);
      expect(nextCheckAfter(due, 5, now).getTime() - now.getTime()).toBeGreaterThanOrEqual(2.5 * 60_000);
    }
  });

  it('picks the fetch method', () => {
    expect(fetchModeFor({ fetchMode: 'auto' })).toBe('http');
    expect(fetchModeFor({ fetchMode: 'auto', resolvedFetchMode: 'browser' })).toBe('browser');
    expect(fetchModeFor({ fetchMode: 'browser', resolvedFetchMode: 'http' })).toBe('browser');
    expect(fetchModeFor({ fetchMode: 'http' })).toBe('http');
  });
});

describe('scheduleDueMonitors', () => {
  it('gives a due monitor a CheckRun and an outbox message, and advances nextCheckAt (Milestone 4)', async () => {
    const dueAt = new Date(Date.now() - 2 * MIN);
    const monitor = await createMonitor({ nextCheckAt: dueAt });
    const now = new Date();

    const result = await scheduleDueMonitors({ partitions: ALL_PARTITIONS, now, batchSize: 50, logger });
    expect(result).toEqual({ scheduled: 1, skipped: 0, duplicate: 0 });

    const runs = await CheckRun.find({ monitorId: monitor._id }).lean();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', scheduledFor: slotFor(dueAt), userId: monitor.userId });

    const outbox = await OutboxMessage.find().lean();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', exchange: ROUTES.fetchHttp.exchange, routingKey: ROUTES.fetchHttp.routingKey });
    const job = fetchJobSchema.parse(outbox[0]!.payload);
    expect(job).toMatchObject({
      checkRunId: String(runs[0]!._id),
      monitorId: monitor.id,
      url: 'https://careers.example.com/jobs',
      fetchMode: 'http',
      scheduledAt: slotFor(dueAt).toISOString(),
    });
    expect(outbox[0]!.messageId).toBe(job.messageId);

    const reloaded = await Monitor.findById(monitor._id).lean();
    expect(reloaded!.nextCheckAt).toEqual(nextCheckAfter(dueAt, 30, now));
  });

  it('routes browser monitors to the browser queue', async () => {
    await createMonitor({ fetchMode: 'browser' });
    await scheduleDueMonitors({ partitions: ALL_PARTITIONS, now: new Date(), batchSize: 50, logger });
    const [message] = await OutboxMessage.find().lean();
    expect(message!.routingKey).toBe(ROUTES.fetchBrowser.routingKey);
  });

  it('ignores monitors that are paused, not yet due, or in partitions this instance does not own', async () => {
    await createMonitor({ status: 'paused' });
    await createMonitor({ nextCheckAt: new Date(Date.now() + 10 * MIN) });
    const other = await createMonitor();
    const notOwned = ALL_PARTITIONS.filter((p) => p !== other.partitionId);
    // Make sure no due monitor sits in the owned partitions except possibly the paused/future ones.
    const result = await scheduleDueMonitors({ partitions: notOwned, now: new Date(), batchSize: 50, logger });

    expect(result.scheduled).toBe(0);
    expect(await CheckRun.countDocuments()).toBe(0);
    expect(await OutboxMessage.countDocuments()).toBe(0);
  });

  it('does nothing without partitions', async () => {
    await createMonitor();
    expect(await scheduleDueMonitors({ partitions: [], now: new Date(), batchSize: 50, logger })).toEqual({
      scheduled: 0,
      skipped: 0,
      duplicate: 0,
    });
  });

  it('two schedulers running at the same time never create duplicate runs (Milestone 4)', async () => {
    const monitors = await Promise.all(Array.from({ length: 30 }, () => createMonitor()));
    const now = new Date();

    // Both "instances" think they own every partition (worst case: a lease handover overlap).
    const results = await Promise.all(
      Array.from({ length: 4 }, () => scheduleDueMonitors({ partitions: ALL_PARTITIONS, now, batchSize: 100, concurrency: 8, logger })),
    );

    const scheduled = results.reduce((sum, r) => sum + r.scheduled, 0);
    expect(scheduled).toBe(monitors.length);
    expect(await CheckRun.countDocuments()).toBe(monitors.length);
    expect(await OutboxMessage.countDocuments()).toBe(monitors.length);
    const perMonitor = await CheckRun.aggregate([{ $group: { _id: '$monitorId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
    expect(perMonitor).toEqual([]);
  });

  it('an existing run for the same slot is not duplicated, and the monitor still moves on', async () => {
    const dueAt = new Date(Date.now() - 30_000);
    const monitor = await createMonitor({ nextCheckAt: dueAt });
    // e.g. the monitor was resumed twice within a minute: a run for this slot already exists.
    await CheckRun.create({ monitorId: monitor._id, userId: monitor.userId, scheduledFor: slotFor(dueAt) });
    const now = new Date();

    expect(await scheduleMonitor(monitor.id, dueAt, now)).toBe('duplicate');
    expect(await CheckRun.countDocuments()).toBe(1);
    expect(await OutboxMessage.countDocuments()).toBe(0); // rolled back with the transaction
    expect((await Monitor.findById(monitor._id).lean())!.nextCheckAt).toEqual(nextCheckAfter(dueAt, 30, now));
  });

  it('skips a monitor that changed after it was found due (e.g. paused by the user)', async () => {
    const dueAt = new Date(Date.now() - 30_000);
    const monitor = await createMonitor({ nextCheckAt: dueAt });
    await Monitor.updateOne({ _id: monitor._id }, { $set: { status: 'paused' } });

    expect(await scheduleMonitor(monitor.id, dueAt, new Date())).toBe('skipped');
    expect(await CheckRun.countDocuments()).toBe(0);
  });

  it('processes at most batchSize monitors per tick, most overdue first', async () => {
    const oldest = await createMonitor({ nextCheckAt: new Date(Date.now() - 60 * MIN) });
    await Promise.all(Array.from({ length: 4 }, () => createMonitor({ nextCheckAt: new Date(Date.now() - MIN) })));

    const result = await scheduleDueMonitors({ partitions: ALL_PARTITIONS, now: new Date(), batchSize: 2, logger });
    expect(result.scheduled).toBe(2);
    expect(await CheckRun.exists({ monitorId: oldest._id })).toBeTruthy();
  });
});
