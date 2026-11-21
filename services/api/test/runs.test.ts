import { describe, expect, it } from 'vitest';
import { CheckRun } from '@monitorly/database';
import { buildApp, signedInAgent, useTestDatabase } from './helpers';

useTestDatabase();

async function setup() {
  const app = buildApp();
  const owner = await signedInAgent(app, 'Owner');
  const created = await owner.agent
    .post('/api/monitors')
    .send({ url: 'https://careers.example.com/jobs', instruction: 'new intern roles' });
  const monitorId = created.body.monitor.id as string;
  const base = Date.parse('2026-11-22T10:00:00Z');
  await CheckRun.create(
    [0, 30, 60].map((min) => ({
      monitorId,
      userId: owner.user.id,
      scheduledFor: new Date(base + min * 60_000),
      status: min === 60 ? 'queued' : 'succeeded',
    })),
  );
  return { app, owner, monitorId };
}

describe('GET /api/monitors/:id/runs', () => {
  it('lists the monitor’s check runs, newest first', async () => {
    const { owner, monitorId } = await setup();
    const res = await owner.agent.get(`/api/monitors/${monitorId}/runs`);
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { scheduledFor: string }) => r.scheduledFor)).toEqual([
      '2026-11-22T11:00:00.000Z',
      '2026-11-22T10:30:00.000Z',
      '2026-11-22T10:00:00.000Z',
    ]);
    expect(res.body.runs[0]).toMatchObject({ status: 'queued', attempts: 0, error: null, fetchModeUsed: null });
  });

  it('respects ?limit and ignores a bad one', async () => {
    const { owner, monitorId } = await setup();
    expect((await owner.agent.get(`/api/monitors/${monitorId}/runs?limit=1`)).body.runs).toHaveLength(1);
    expect((await owner.agent.get(`/api/monitors/${monitorId}/runs?limit=abc`)).body.runs).toHaveLength(3);
  });

  it('another user gets 404, like a non-existent monitor', async () => {
    const { app, monitorId } = await setup();
    const intruder = await signedInAgent(app, 'Intruder');
    expect((await intruder.agent.get(`/api/monitors/${monitorId}/runs`)).status).toBe(404);
  });
});
