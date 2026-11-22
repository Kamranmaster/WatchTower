import { Router } from 'express';
import { z } from 'zod';
import { Event, Monitor } from '@monitorly/database';
import type { AppDeps } from '../app';
import { currentUserId, requireAuth } from '../middleware/auth';
import { serializeEvent } from '../serializers';

/** Recent changes across all of the current user's monitors (dashboard). `?only=matched`: just the alerts. */
export function eventsRouter({ env }: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(env));

  router.get('/', async (req, res) => {
    const userId = currentUserId(req);
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    const filter = req.query.only === 'matched' ? { userId, alertedAt: { $exists: true } } : { userId };
    const events = await Event.find(filter).sort({ detectedAt: -1, _id: -1 }).limit(limit);
    const monitorIds = [...new Set(events.map((e) => String(e.monitorId)))];
    const names = new Map(
      (await Monitor.find({ _id: { $in: monitorIds }, userId }, { name: 1, url: 1 }).lean()).map((m) => [
        String(m._id),
        m.name ?? new URL(m.url).hostname,
      ]),
    );
    res.json({ events: events.map((e) => serializeEvent(e, names.get(String(e.monitorId)))) });
  });

  return router;
}
