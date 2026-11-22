import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationDto } from '@monitorly/contracts';
import { CheckRun, Event, Notification, mongoose } from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';
import { createEnvelope } from '@monitorly/messaging';
import { AUTH_COOKIE, signToken } from '../src/auth/tokens';
import { attachRealtime, type Realtime } from '../src/realtime';
import { buildApp, signedInAgent, testEnv, useTestDatabase } from './helpers';

useTestDatabase();

async function setup() {
  const app = buildApp();
  const owner = await signedInAgent(app, 'Owner');
  const created = await owner.agent
    .post('/api/monitors')
    .send({ url: 'https://careers.example.com/jobs', instruction: 'new intern roles', name: 'Acme jobs' });
  const monitorId = created.body.monitor.id as string;
  const run = await CheckRun.create({ monitorId, userId: owner.user.id, scheduledFor: new Date() });

  let n = 0;
  async function notification(extra: Record<string, unknown> = {}) {
    n++;
    const event = await Event.create({
      monitorId,
      userId: owner.user.id,
      checkRunId: run._id,
      eventType: 'new_item',
      title: `Job ${n}`,
      fingerprint: `fp-${n}-${Date.now()}`,
      detectedAt: new Date(),
    });
    return Notification.create({
      userId: owner.user.id,
      monitorId,
      eventId: event._id,
      eventType: 'new_item',
      title: `New: Job ${n}`,
      message: `Job ${n} (Remote)`,
      sourceUrl: `https://careers.example.com/jobs/${n}`,
      createdAt: new Date(Date.now() + n * 1000),
      ...extra,
    });
  }
  return { app, owner, monitorId, notification };
}

describe('notifications API', () => {
  it('lists my in-app notifications, newest first, with the unread count', async () => {
    const { owner, notification } = await setup();
    await notification();
    await notification({ isRead: true });
    await notification({ inApp: false }); // email-only: not in the bell
    const res = await owner.agent.get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.notifications.map((x: NotificationDto) => x.title)).toEqual(['New: Job 2', 'New: Job 1']);
    expect(res.body.notifications[1]).toMatchObject({ monitorName: 'Acme jobs', eventType: 'new_item', isRead: false, message: 'Job 1 (Remote)' });

    const unread = await owner.agent.get('/api/notifications?unread=true');
    expect(unread.body.notifications.map((x: NotificationDto) => x.title)).toEqual(['New: Job 1']);
  });

  it('marks one or all as read', async () => {
    const { owner, notification } = await setup();
    const a = await notification();
    await notification();
    const one = await owner.agent.post(`/api/notifications/${a.id}/read`);
    expect(one.body.notification.isRead).toBe(true);
    expect((await owner.agent.get('/api/notifications')).body.unreadCount).toBe(1);
    expect((await owner.agent.post('/api/notifications/read-all')).body.updated).toBe(1);
    expect((await owner.agent.get('/api/notifications')).body.unreadCount).toBe(0);
  });

  it('keeps notifications private', async () => {
    const { app, notification } = await setup();
    const mine = await notification();
    const intruder = await signedInAgent(app, 'Intruder');
    expect((await intruder.agent.get('/api/notifications')).body).toEqual({ notifications: [], unreadCount: 0 });
    expect((await intruder.agent.post(`/api/notifications/${mine.id}/read`)).status).toBe(404);
    expect((await intruder.agent.post('/api/notifications/not-an-id/read')).status).toBe(404);
    await intruder.agent.post('/api/notifications/read-all');
    expect((await Notification.findById(mine.id).lean())!.isRead).toBe(false);
  });

  it('requires login', async () => {
    const { app } = await setup();
    const { default: request } = await import('supertest');
    expect((await request(app).get('/api/notifications')).status).toBe(401);
  });
});

describe('live updates (Socket.IO)', () => {
  let server: http.Server | undefined;
  let realtime: Realtime | undefined;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.close());
    await realtime?.close();
    server = undefined;
    realtime = undefined;
  });

  async function start() {
    const app = buildApp();
    server = http.createServer(app);
    realtime = attachRealtime(server, { env: testEnv, logger: createSilentLogger() });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://localhost:${(server.address() as AddressInfo).port}`;
  }

  function open(url: string, headers: Record<string, string>): Promise<Socket> {
    const socket = connect(url, { transports: ['websocket'], extraHeaders: headers, reconnection: false });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err) => reject(err));
    });
  }

  it('pushes a new notification to its owner only', async () => {
    const { owner, notification } = await setup();
    const url = await start();
    const otherUser = new mongoose.Types.ObjectId().toString();
    const origin = testEnv.WEB_ORIGIN;
    const mine = await open(url, { origin, cookie: `${AUTH_COOKIE}=${signToken(owner.user.id, testEnv)}` });
    const theirs = await open(url, { origin, cookie: `${AUTH_COOKIE}=${signToken(otherUser, testEnv)}` });
    const theirMessages: unknown[] = [];
    theirs.on('notification', (m) => theirMessages.push(m));

    const received = new Promise<NotificationDto>((resolve) => mine.on('notification', resolve));
    const n = await notification();
    await realtime!.pushNotification({ ...createEnvelope(), notificationId: n.id, userId: owner.user.id });
    expect(await received).toMatchObject({ id: n.id, title: 'New: Job 1', monitorName: 'Acme jobs' });

    // A message naming the wrong owner is never delivered to anyone.
    await realtime!.pushNotification({ ...createEnvelope(), notificationId: n.id, userId: otherUser });
    await new Promise((r) => setTimeout(r, 200));
    expect(theirMessages).toEqual([]);
  });

  it('rejects connections without a valid session', async () => {
    const url = await start();
    await expect(open(url, { origin: testEnv.WEB_ORIGIN })).rejects.toThrow('unauthorized');
    await expect(open(url, { origin: testEnv.WEB_ORIGIN, cookie: `${AUTH_COOKIE}=forged.token.here` })).rejects.toThrow('unauthorized');
  });

  it('rejects connections from other sites, even with the cookie', async () => {
    const { owner } = await setup();
    const url = await start();
    const cookie = `${AUTH_COOKIE}=${signToken(owner.user.id, testEnv)}`;
    await expect(open(url, { origin: 'https://evil.example', cookie })).rejects.toThrow();
    await expect(open(url, { cookie })).rejects.toThrow(); // no Origin header at all
  });
});
