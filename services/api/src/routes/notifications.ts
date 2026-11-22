import { Router } from 'express';
import { z } from 'zod';
import type { NotificationListResponse } from '@monitorly/contracts';
import { Monitor, Notification, mongoose } from '@monitorly/database';
import type { AppDeps } from '../app';
import { currentUserId, requireAuth } from '../middleware/auth';
import { HttpError } from '../middleware/errors';
import { cursorFilter, paginate } from '../pagination';
import { serializeNotification } from '../serializers';

/** Monitor display names for a set of notifications (one query). */
export async function monitorNames(userId: string, monitorIds: string[]): Promise<Map<string, string>> {
  const monitors = await Monitor.find({ _id: { $in: [...new Set(monitorIds)] }, userId }, { name: 1, url: 1 }).lean();
  return new Map(monitors.map((m) => [String(m._id), m.name || new URL(m.url).hostname]));
}

/**
 * The in-app notification list (the bell and the notifications page). Only the owner's
 * notifications, only in-app ones. `?limit`, `?unread=true`, `?cursor` (next page).
 */
export function notificationsRouter({ env }: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(env));

  router.get('/', async (req, res) => {
    const userId = currentUserId(req);
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    const mine = { userId, inApp: { $ne: false } };
    const filter = {
      ...mine,
      ...(req.query.unread === 'true' ? { isRead: false } : {}),
      ...cursorFilter(req.query.cursor, 'createdAt'),
    };
    const [rows, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean(),
      Notification.countDocuments({ ...mine, isRead: false }),
    ]);
    const { page, nextCursor } = paginate(rows, limit, (n) => n.createdAt);
    const names = await monitorNames(userId, page.map((n) => String(n.monitorId)));
    const body: NotificationListResponse = {
      notifications: page.map((n) => serializeNotification(n, names.get(String(n.monitorId)) ?? null)),
      unreadCount,
      nextCursor,
    };
    res.json(body);
  });

  router.post('/read-all', async (req, res) => {
    const userId = currentUserId(req);
    const result = await Notification.updateMany({ userId, isRead: false }, { $set: { isRead: true, readAt: new Date() } });
    res.json({ updated: result.modifiedCount });
  });

  router.post('/:id/read', async (req, res) => {
    const userId = currentUserId(req);
    const id = req.params.id;
    // Someone else's id behaves exactly like a missing one.
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Notification not found');
    const n = await Notification.findOneAndUpdate(
      { _id: id, userId },
      [{ $set: { isRead: true, readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
      { new: true },
    ).lean();
    if (!n) throw new HttpError(404, 'Notification not found');
    const names = await monitorNames(userId, [String(n.monitorId)]);
    res.json({ notification: serializeNotification(n, names.get(String(n.monitorId)) ?? null) });
  });

  return router;
}
