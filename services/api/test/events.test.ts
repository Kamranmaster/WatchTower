import { describe, expect, it } from 'vitest';
import { CheckRun, Event, Monitor, mongoose } from '@monitorly/database';
import { buildApp, signedInAgent, useTestDatabase } from './helpers';

useTestDatabase();

async function setup() {
  const app = buildApp();
  const owner = await signedInAgent(app, 'Owner');
  const created = await owner.agent
    .post('/api/monitors')
    .send({ url: 'https://careers.example.com/jobs', instruction: 'new intern roles', name: 'Acme jobs' });
  const monitorId = created.body.monitor.id as string;
  const run = await CheckRun.create({ monitorId, userId: owner.user.id, scheduledFor: new Date() });
  const base = { monitorId, userId: owner.user.id, checkRunId: run._id };
  await Event.create([
    {
      ...base,
      eventType: 'new_item',
      title: 'Backend Engineer Intern',
      description: 'Bangalore, India',
      sourceUrl: 'https://careers.example.com/jobs/backend-intern',
      item: { title: 'Backend Engineer Intern', fields: { location: 'Bangalore, India' } },
      fingerprint: 'f1',
      detectedAt: new Date('2026-11-22T10:00:00Z'),
    },
    {
      ...base,
      eventType: 'item_changed',
      title: 'Data Analyst',
      description: 'Location: Remote → Mumbai, India',
      changedFields: ['location'],
      item: { title: 'Data Analyst', fields: { location: 'Mumbai, India' } },
      previous: { title: 'Data Analyst', fields: { location: 'Remote' } },
      fingerprint: 'f2',
      detectedAt: new Date('2026-11-22T11:00:00Z'),
    },
  ]);
  return { app, owner, monitorId };
}

describe('change events API', () => {
  it('lists a monitor’s changes, newest first, with what changed', async () => {
    const { owner, monitorId } = await setup();
    const res = await owner.agent.get(`/api/monitors/${monitorId}/events`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { title: string }) => e.title)).toEqual(['Data Analyst', 'Backend Engineer Intern']);
    expect(res.body.events[0]).toMatchObject({
      eventType: 'item_changed',
      changedFields: ['location'],
      previous: { title: 'Data Analyst', fields: { location: 'Remote' } },
      fields: { location: 'Mumbai, India' },
    });
    expect(res.body.events[1]).toMatchObject({ eventType: 'new_item', previous: null, sourceUrl: 'https://careers.example.com/jobs/backend-intern' });
  });

  it('lists recent changes across the user’s monitors, with monitor names', async () => {
    const { owner } = await setup();
    const res = await owner.agent.get('/api/events?limit=1');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ title: 'Data Analyst', monitorName: 'Acme jobs' });
  });

  it('never shows another user’s changes', async () => {
    const { app, monitorId } = await setup();
    const intruder = await signedInAgent(app, 'Intruder');
    expect((await intruder.agent.get(`/api/monitors/${monitorId}/events`)).status).toBe(404);
    expect((await intruder.agent.get('/api/events')).body.events).toEqual([]);
  });

  it('deleting a monitor deletes its events', async () => {
    const { owner, monitorId } = await setup();
    await owner.agent.delete(`/api/monitors/${monitorId}`).expect(204);
    expect(await Event.countDocuments({ monitorId })).toBe(0);
  });
});

describe('baseline reset', () => {
  async function withBaseline() {
    const { owner, monitorId } = await setup();
    await Monitor.updateOne(
      { _id: monitorId },
      { $set: { lastSnapshotId: new mongoose.Types.ObjectId(), baselineItemCount: 4, baselineCapturedAt: new Date() } },
    );
    return { owner, monitorId };
  }

  it('changing the page type starts a fresh baseline', async () => {
    const { owner, monitorId } = await withBaseline();
    const res = await owner.agent.patch(`/api/monitors/${monitorId}`).send({ monitorType: 'generic' });
    expect(res.body.monitor).toMatchObject({ hasBaseline: false, itemCount: null });
    expect((await Monitor.findById(monitorId).lean())!.baselineResetAt).toBeInstanceOf(Date);
  });

  it('editing only the filters keeps the baseline', async () => {
    const { owner, monitorId } = await withBaseline();
    const res = await owner.agent.patch(`/api/monitors/${monitorId}`).send({ rules: { keywords: ['intern'] } });
    expect(res.body.monitor).toMatchObject({ hasBaseline: true, itemCount: 4 });
  });

  it('saving the same page type again keeps the baseline', async () => {
    const { owner, monitorId } = await withBaseline();
    const res = await owner.agent.patch(`/api/monitors/${monitorId}`).send({ monitorType: 'job_listing' });
    expect(res.body.monitor.hasBaseline).toBe(true);
  });
});

describe('rules verdicts', () => {
  async function withVerdicts() {
    const { owner, monitorId } = await setup();
    await Event.updateOne(
      { fingerprint: 'f1' },
      { $set: { 'match.status': 'filtered_out', 'match.reasons': ['Doesn’t mention “frontend”'], 'match.matchedTerms': ['intern'] } },
    );
    await Event.updateOne(
      { fingerprint: 'f2' },
      {
        $set: {
          'match.status': 'matched',
          'match.reasons': [],
          'match.matchedTerms': ['mumbai'],
          'ai.status': 'done',
          'ai.relevant': true,
          'ai.summary': 'Data Analyst moved from Remote to Mumbai.',
          'ai.reason': 'Mumbai is a wanted location',
          alertedAt: new Date(),
        },
      },
    );
    return { owner, monitorId };
  }

  it('shows the verdict, the reasons and the AI review', async () => {
    const { owner, monitorId } = await withVerdicts();
    const [changed, filtered] = (await owner.agent.get(`/api/monitors/${monitorId}/events`)).body.events;
    expect(changed).toMatchObject({
      verdict: 'matched',
      matchedTerms: ['mumbai'],
      ai: { status: 'done', relevant: true, summary: 'Data Analyst moved from Remote to Mumbai.', reason: 'Mumbai is a wanted location' },
    });
    expect(filtered).toMatchObject({ verdict: 'filtered_out', matchReasons: ['Doesn’t mention “frontend”'], ai: null });
  });

  it('?only=matched lists just the changes the user is alerted about', async () => {
    const { owner, monitorId } = await withVerdicts();
    const mine = (await owner.agent.get(`/api/monitors/${monitorId}/events?only=matched`)).body.events;
    expect(mine.map((e: { title: string }) => e.title)).toEqual(['Data Analyst']);
    const all = (await owner.agent.get('/api/events?only=matched')).body.events;
    expect(all.map((e: { title: string }) => e.title)).toEqual(['Data Analyst']);
  });

  it('reports pending, AI-rejected and unreviewed matches', async () => {
    const { owner, monitorId } = await setup();
    await Event.updateOne({ fingerprint: 'f1' }, { $set: { 'match.status': 'matched', 'ai.status': 'pending' } });
    await Event.updateOne(
      { fingerprint: 'f2' },
      { $set: { 'match.status': 'matched', 'ai.status': 'done', 'ai.relevant': false, 'ai.reason': 'Not an internship' } },
    );
    const [rejected, pending] = (await owner.agent.get(`/api/monitors/${monitorId}/events`)).body.events;
    expect(pending.verdict).toBe('pending');
    expect(rejected).toMatchObject({ verdict: 'not_relevant', ai: { relevant: false, reason: 'Not an internship' } });

    await Event.updateOne(
      { fingerprint: 'f2' },
      { $set: { 'ai.status': 'skipped', 'ai.error': 'Daily AI review limit reached; the filters decided' }, $unset: { 'ai.relevant': 1, 'ai.reason': 1 } },
    );
    const [unreviewed] = (await owner.agent.get(`/api/monitors/${monitorId}/events`)).body.events;
    expect(unreviewed).toMatchObject({ verdict: 'matched', ai: { status: 'skipped', reason: 'Daily AI review limit reached; the filters decided' } });
  });

  it('events from before the rules engine show as pending', async () => {
    const { owner, monitorId } = await setup();
    const [first] = (await owner.agent.get(`/api/monitors/${monitorId}/events`)).body.events;
    expect(first).toMatchObject({ verdict: 'pending', matchReasons: [], ai: null });
  });

  it('AI review is on by default and can be turned off', async () => {
    const { owner, monitorId } = await setup();
    expect((await owner.agent.get(`/api/monitors/${monitorId}`)).body.monitor.aiReview).toBe(true);
    const res = await owner.agent.patch(`/api/monitors/${monitorId}`).send({ aiReview: false });
    expect(res.body.monitor.aiReview).toBe(false);
  });
});
