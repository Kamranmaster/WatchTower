import type http from 'node:http';
import { Server } from 'socket.io';
import type { NotificationCreated } from '@monitorly/contracts';
import { Notification } from '@monitorly/database';
import type { Logger } from '@monitorly/logger';
import { AUTH_COOKIE, verifyToken } from './auth/tokens';
import type { Env } from './env';
import { monitorNames } from './routes/notifications';
import { serializeNotification } from './serializers';

const room = (userId: string) => `user:${userId}`;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface Realtime {
  io: Server;
  /** Pushes a stored notification to its owner's open tabs (on this API instance). */
  pushNotification(msg: NotificationCreated): Promise<void>;
  close(): Promise<void>;
}

/**
 * Socket.IO for live updates. Each API instance receives every notification.created broadcast
 * and emits to the sockets connected to it, so it scales out without a shared adapter.
 *
 * Security: the session cookie is checked on connect (same JWT as the REST API), and only the
 * web app's origin may connect — browsers send cookies on cross-site WebSocket handshakes, so
 * without the origin check any site could open a socket as the user. Each socket only joins its
 * own user's room; clients can't subscribe to anything else.
 */
export function attachRealtime(server: http.Server, { env, logger }: { env: Env; logger: Logger }): Realtime {
  const io = new Server(server, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    allowRequest: (req, callback) => callback(null, req.headers.origin === env.WEB_ORIGIN),
  });

  io.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, AUTH_COOKIE);
    const userId = token ? verifyToken(token, env) : null;
    if (!userId) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.userId = userId;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    void socket.join(room(userId));
    logger.debug({ userId, socketId: socket.id }, 'Live updates connected');
  });

  return {
    io,
    async pushNotification(msg) {
      if (io.sockets.adapter.rooms.get(room(msg.userId)) === undefined) return; // not connected here
      const n = await Notification.findById(msg.notificationId).lean();
      if (!n || String(n.userId) !== msg.userId || n.inApp === false) return;
      const names = await monitorNames(msg.userId, [String(n.monitorId)]);
      io.to(room(msg.userId)).emit('notification', serializeNotification(n, names.get(String(n.monitorId)) ?? null));
    },
    close: () => new Promise<void>((resolve) => void io.close(() => resolve())),
  };
}
