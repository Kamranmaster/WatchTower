import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CheckRun, Monitor } from '@monitorly/database';
import { buildApp, signedInAgent, useTestDatabase } from './helpers';
import { MemoryObjectStore, rawSnapshotKey } from '@monitorly/storage';

useTestDatabase();
const app = buildApp();

const validMonitor = {
  url: 'https://careers.example.com/jobs',
  instruction: 'Notify me when a new Software Engineer Intern role is posted in India.',
  rules: { keywords: ['software engineer', 'intern', 'Intern'], locations: ['India'], excludeKeywords: ['senior'] },
};

describe('creating monitors', () => {
  it('requires login', async () => {
    await request(app).post('/api/monitors').send(validMonitor).expect(401);
    await request(app).get('/api/monitors').expect(401);
  });

  it('creates an active monitor with defaults, due immediately', async () => {
    const { agent, user } = await signedInAgent(app);
    const res = await agent.post('/api/monitors').send(validMonitor);

    expect(res.status).toBe(201);
    const m = res.body.monitor;
    expect(m).toMatchObject({
      name: 'careers.example.com',
      status: 'active',
      monitorType: 'job_listing',
      checkIntervalMinutes: 30,
      fetchMode: 'auto',
      notifyInApp: true,
      notifyEmail: false,
      hasBaseline: false,
    });
    // duplicate "Intern" removed case-insensitively
    expect(m.rules.keywords).toEqual(['software engineer', 'intern']);
    expect(Date.parse(m.nextCheckAt)).toBeLessThanOrEqual(Date.now());
    // internal scheduling fields are not exposed
    expect(m).not.toHaveProperty('partitionId');
    expect(m).not.toHaveProperty('userId');

    const stored = await Monitor.findById(m.id);
    expect(stored?.userId.toString()).toBe(user.id);
    expect(stored?.partitionId).toBeGreaterThanOrEqual(0);
  });

  it('rejects a userId in the body — ownership comes from the session only', async () => {
    const { agent } = await signedInAgent(app);
    const res = await agent.post('/api/monitors').send({ ...validMonitor, userId: '507f1f77bcf86cd799439011' });
    expect(res.status).toBe(400);
  });

  it.each([
    ['http://localhost:3000/admin', /private or internal/],
    ['http://169.254.169.254/latest/meta-data', /private or internal/],
    ['https://sneaky.example.com', /private or internal/],
    ['ftp://careers.example.com', /http/],
    ['https://does-not-exist.example.com', /Could not find/],
  ])('rejects unsafe URL %s with 422', async (url, message) => {
    const { agent } = await signedInAgent(app);
    const res = await agent.post('/api/monitors').send({ ...validMonitor, url });
    expect(res.status).toBe(422);
    expect(res.body.details[0].path).toBe('url');
    expect(res.body.error).toMatch(message);
  });

  it('rejects intervals below 5 minutes', async () => {
    const { agent } = await signedInAgent(app);
    const res = await agent.post('/api/monitors').send({ ...validMonitor, checkIntervalMinutes: 1 });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('checkIntervalMinutes');
  });

  it('enforces the per-user monitor limit', async () => {
    const { agent } = await signedInAgent(app);
    for (let i = 0; i < 3; i++) await agent.post('/api/monitors').send(validMonitor).expect(201);
    const res = await agent.post('/api/monitors').send(validMonitor);
    expect(res.status).toBe(403);
  });
});

describe('ownership — users can only see and change their own monitors', () => {
  it('lists only the current user’s monitors', async () => {
    const alice = await signedInAgent(app, 'Alice');
    const bob = await signedInAgent(app, 'Bob');
    await alice.agent.post('/api/monitors').send(validMonitor).expect(201);
    await alice.agent.post('/api/monitors').send(validMonitor).expect(201);
    await bob.agent.post('/api/monitors').send({ ...validMonitor, url: 'https://shop.example.com' }).expect(201);

    const aliceList = await alice.agent.get('/api/monitors');
    const bobList = await bob.agent.get('/api/monitors');
    expect(aliceList.body.monitors).toHaveLength(2);
    expect(bobList.body.monitors).toHaveLength(1);
    expect(bobList.body.monitors[0].url).toBe('https://shop.example.com/');
  });

  it('returns 404 for every action on another user’s monitor and leaves it untouched', async () => {
    const alice = await signedInAgent(app, 'Alice');
    const bob = await signedInAgent(app, 'Bob');
    const { body } = await alice.agent.post('/api/monitors').send(validMonitor);
    const id = body.monitor.id;

    await bob.agent.get(`/api/monitors/${id}`).expect(404);
    await bob.agent.patch(`/api/monitors/${id}`).send({ name: 'hijacked' }).expect(404);
    await bob.agent.post(`/api/monitors/${id}/pause`).expect(404);
    await bob.agent.post(`/api/monitors/${id}/resume`).expect(404);
    await bob.agent.delete(`/api/monitors/${id}`).expect(404);

    const stillThere = await alice.agent.get(`/api/monitors/${id}`).expect(200);
    expect(stillThere.body.monitor).toMatchObject({ name: 'careers.example.com', status: 'active' });
  });

  it('returns 404 for malformed and unknown ids', async () => {
    const { agent } = await signedInAgent(app);
    await agent.get('/api/monitors/not-an-id').expect(404);
    await agent.get('/api/monitors/507f1f77bcf86cd799439011').expect(404);
  });
});

describe('updating monitors', () => {
  it('updates only the fields sent', async () => {
    const { agent } = await signedInAgent(app);
    const { body } = await agent.post('/api/monitors').send({ ...validMonitor, notifyEmail: true });
    const res = await agent.patch(`/api/monitors/${body.monitor.id}`).send({ name: 'Acme internships' });

    expect(res.status).toBe(200);
    expect(res.body.monitor).toMatchObject({ name: 'Acme internships', notifyEmail: true, checkIntervalMinutes: 30 });
    expect(res.body.monitor.rules.keywords).toEqual(['software engineer', 'intern']);
  });

  it('rejects an empty update and unknown fields', async () => {
    const { agent } = await signedInAgent(app);
    const { body } = await agent.post('/api/monitors').send(validMonitor);
    await agent.patch(`/api/monitors/${body.monitor.id}`).send({}).expect(400);
    await agent.patch(`/api/monitors/${body.monitor.id}`).send({ status: 'active' }).expect(400);
    await agent.patch(`/api/monitors/${body.monitor.id}`).send({ partitionId: 1 }).expect(400);
  });

  it('re-checks URL safety on update', async () => {
    const { agent } = await signedInAgent(app);
    const { body } = await agent.post('/api/monitors').send(validMonitor);
    const res = await agent.patch(`/api/monitors/${body.monitor.id}`).send({ url: 'http://10.0.0.1/' });
    expect(res.status).toBe(422);
  });

  it('changing the URL resets the baseline and schedules a check now', async () => {
    const { agent } = await signedInAgent(app);
    const { body } = await agent.post('/api/monitors').send(validMonitor);
    await Monitor.updateOne(
      { _id: body.monitor.id },
      { lastSnapshotId: '507f1f77bcf86cd799439011', nextCheckAt: new Date(Date.now() + 3600_000) },
    );

    const res = await agent.patch(`/api/monitors/${body.monitor.id}`).send({ url: 'https://shop.example.com/stock' });
    expect(res.body.monitor.hasBaseline).toBe(false);
    expect(Date.parse(res.body.monitor.nextCheckAt)).toBeLessThanOrEqual(Date.now());
  });
});

describe('pause, resume and delete', () => {
  it('pauses and resumes; resume clears errors and checks right away', async () => {
    const { agent } = await signedInAgent(app);
    const { body } = await agent.post('/api/monitors').send(validMonitor);
    const id = body.monitor.id;

    const paused = await agent.post(`/api/monitors/${id}/pause`).expect(200);
    expect(paused.body.monitor.status).toBe('paused');

    await Monitor.updateOne({ _id: id }, { lastError: 'HTTP 500', consecutiveFailures: 4 });
    const resumed = await agent.post(`/api/monitors/${id}/resume`).expect(200);
    expect(resumed.body.monitor).toMatchObject({ status: 'active', lastError: null, consecutiveFailures: 0 });
    expect(Date.parse(resumed.body.monitor.nextCheckAt)).toBeLessThanOrEqual(Date.now());
  });

  it('delete removes the monitor, its history and its stored snapshots', async () => {
    const store = new MemoryObjectStore();
    const appWithStore = buildApp({ store });
    const { agent, user } = await signedInAgent(appWithStore);
    const { body } = await agent.post('/api/monitors').send(validMonitor);
    const id = body.monitor.id;
    await CheckRun.create({ monitorId: id, userId: user.id, scheduledFor: new Date() });
    await store.put(rawSnapshotKey(id, 'run1'), Buffer.from('<html>'));
    await store.put(rawSnapshotKey('someone-else', 'run1'), Buffer.from('<html>'));

    await agent.delete(`/api/monitors/${id}`).expect(204);
    await agent.get(`/api/monitors/${id}`).expect(404);
    expect(await CheckRun.countDocuments({ monitorId: id })).toBe(0);
    expect([...store.objects.keys()]).toEqual([rawSnapshotKey('someone-else', 'run1')]);
  });
});
