import { Router } from 'express';
import { z } from 'zod';
import { QUEUES, ROUTES, deadQueueName } from '@monitorly/contracts';
import { mongoose } from '@monitorly/database';
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

  return router;
}
