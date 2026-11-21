import { Router } from 'express';
import { z } from 'zod';
import { QUEUES, ROUTES, deadQueueName, type SchedulerStatusDto } from '@monitorly/contracts';
import {
  CheckRun,
  Monitor,
  OutboxMessage,
  SchedulerInstance,
  SchedulerLease,
  TOTAL_PARTITIONS,
  mongoose,
} from '@monitorly/database';
import { createEnvelope } from '@monitorly/messaging';
import type { AppDeps } from '../app';

const testJobBody = z.object({
  url: z.url({ protocol: /^https?$/ }).default('https://example.com'),
});

/**
 * Development-only endpoints for exercising the pipeline (never mounted in production).
 */
export function devRouter({ bus }: AppDeps): Router {
  const router = Router();

  /** Publishes a synthetic fetch job so you can watch the fetch worker pick it up. */
  router.post('/test-fetch-job', async (req, res) => {
    const { url } = testJobBody.parse(req.body ?? {});
    const id = () => new mongoose.Types.ObjectId().toString();
    const now = new Date().toISOString();

    const message = await bus.publish(ROUTES.fetchHttp, {
      ...createEnvelope(),
      checkRunId: id(),
      monitorId: id(),
      userId: id(),
      url,
      fetchMode: 'http',
      scheduledAt: now,
    });

    res.status(202).json({ published: true, routingKey: ROUTES.fetchHttp.routingKey, message });
  });

  /** Depth and consumer count of every work queue and its DLQ. */
  router.get('/queues', async (_req, res) => {
    const queues = await Promise.all(
      Object.values(QUEUES).map(async (q) => ({
        queue: q.name,
        ...(await bus.queueStats(q.name)),
        deadLettered: (await bus.queueStats(deadQueueName(q.name))).messageCount,
      })),
    );
    res.json({ queues });
  });

  /** Scheduler instances and their partitions, outbox backlog and check run counts. */
  router.get('/scheduler', async (_req, res) => {
    const now = new Date();
    const [instances, leases, outbox, oldestPending, runs, dueMonitors] = await Promise.all([
      SchedulerInstance.find().sort({ startedAt: 1 }).lean(),
      SchedulerLease.find({ ownerId: { $ne: null }, expiresAt: { $gt: now } }, { ownerId: 1 }).lean(),
      OutboxMessage.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      OutboxMessage.findOne({ status: 'pending' }, { createdAt: 1 }).sort({ createdAt: 1 }).lean(),
      CheckRun.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      Monitor.countDocuments({ status: 'active', nextCheckAt: { $lte: now } }),
    ]);
    const count = (rows: { _id: string; n: number }[], key: string) => rows.find((r) => r._id === key)?.n ?? 0;
    const perOwner = new Map<string, number>();
    for (const lease of leases) perOwner.set(lease.ownerId!, (perOwner.get(lease.ownerId!) ?? 0) + 1);

    const body: SchedulerStatusDto = {
      instances: instances.map((i) => ({
        id: i._id,
        partitions: perOwner.get(i._id) ?? 0,
        lastSeenAt: i.lastSeenAt.toISOString(),
        startedAt: i.startedAt.toISOString(),
      })),
      unownedPartitions: TOTAL_PARTITIONS - leases.length,
      outbox: {
        pending: count(outbox, 'pending'),
        published: count(outbox, 'published'),
        failed: count(outbox, 'failed'),
        oldestPendingAt: oldestPending?.createdAt.toISOString() ?? null,
      },
      checkRuns: {
        queued: count(runs, 'queued'),
        running: count(runs, 'running'),
        succeeded: count(runs, 'succeeded'),
        failed: count(runs, 'failed'),
        dead: count(runs, 'dead'),
      },
      dueMonitors,
    };
    res.json(body);
  });

  return router;
}
