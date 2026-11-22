import { Router } from 'express';
import { z } from 'zod';
import type { EventListResponse } from '@monitorly/contracts';
import { Event, Monitor } from '@monitorly/database';
import type { AppDeps } from '../app';
import { currentUserId, requireAuth } from '../middleware/auth';
import { cursorFilter, paginate } from '../pagination';
import { serializeEvent } from '../serializers';

/** `?only=matched`: just the changes the user was alerted about. */
export function onlyFilter(only: unknown): Record<string, unknown> {
  return only === 'matched' ? { alertedAt: { $exists: true } } : {};
}

/**
 * Recent changes across all of the current user's monitors (dashboard), newest first.
 * `?limit`, `?only=matched`, `?cursor` (from the previous page's nextCursor).
 */
export function eventsRouter({ env }: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(env));

  router.get('/', async (req, res) => {
    const userId = currentUserId(req);
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    const filter = { userId, ...onlyFilter(req.query.only), ...cursorFilter(req.query.cursor, 'detectedAt') };
    const rows = await Event.find(filter).sort({ detectedAt: -1, _id: -1 }).limit(limit + 1);
    const { page, nextCursor } = paginate(rows, limit, (e) => e.detectedAt);
    const monitorIds = [...new Set(page.map((e) => String(e.monitorId)))];
    const names = new Map(
      (await Monitor.find({ _id: { $in: monitorIds }, userId }, { name: 1, url: 1 }).lean()).map((m) => [
        String(m._id),
        m.name ?? new URL(m.url).hostname,
      ]),
    );
    const body: EventListResponse = { events: page.map((e) => serializeEvent(e, names.get(String(e.monitorId)))), nextCursor };
    res.json(body);
  });

  return router;
}
