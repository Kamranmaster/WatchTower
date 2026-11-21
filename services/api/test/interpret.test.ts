import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AiError, type InstructionInterpreter } from '@monitorly/ai';
import type { InstructionInterpretation } from '@monitorly/contracts';
import { buildApp, signedInAgent, useTestDatabase } from './helpers';

useTestDatabase();

const proposal: InstructionInterpretation = {
  monitorType: 'job_listing',
  rules: { keywords: ['software engineer', 'intern'], locations: ['India'], excludeKeywords: ['senior'] },
  notes: [],
};

function fakeInterpreter(impl?: InstructionInterpreter['interpret']) {
  const interpret = vi.fn<InstructionInterpreter['interpret']>(
    impl ?? (async () => ({ interpretation: proposal, model: 'fake-model' })),
  );
  return { interpreter: { provider: 'gemini', model: 'fake-model', interpret } satisfies InstructionInterpreter, interpret };
}

const INSTRUCTION = 'Notify me when a new software engineer internship in India is posted. Ignore senior positions.';

describe('POST /api/monitors/interpret', () => {
  it('requires login', async () => {
    const { interpreter } = fakeInterpreter();
    const res = await request(buildApp({ interpreter })).post('/api/monitors/interpret').send({ instruction: INSTRUCTION });
    expect(res.status).toBe(401);
  });

  it('returns the proposed filters without saving anything', async () => {
    const { interpreter, interpret } = fakeInterpreter();
    const app = buildApp({ interpreter });
    const { agent } = await signedInAgent(app);

    const res = await agent
      .post('/api/monitors/interpret')
      .send({ instruction: INSTRUCTION, url: 'https://careers.example.com/jobs' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interpretation: proposal, model: 'fake-model' });
    expect(interpret).toHaveBeenCalledWith(
      { instruction: INSTRUCTION, url: 'https://careers.example.com/jobs' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const list = await agent.get('/api/monitors');
    expect(list.body.monitors).toHaveLength(0);
  });

  it('the confirmed proposal can be saved as the monitor configuration (Milestone 3)', async () => {
    const { interpreter } = fakeInterpreter();
    const app = buildApp({ interpreter });
    const { agent } = await signedInAgent(app);

    const { body } = await agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION });
    const created = await agent.post('/api/monitors').send({
      url: 'https://careers.example.com/jobs',
      instruction: INSTRUCTION,
      monitorType: body.interpretation.monitorType,
      rules: body.interpretation.rules,
    });

    expect(created.status).toBe(201);
    expect(created.body.monitor).toMatchObject({ instruction: INSTRUCTION, monitorType: 'job_listing', rules: proposal.rules });
    const reloaded = await agent.get(`/api/monitors/${created.body.monitor.id}`);
    expect(reloaded.body.monitor.rules).toEqual(proposal.rules);
  });

  it.each([
    ['too short', { instruction: 'hi' }],
    ['missing', {}],
    ['unknown fields', { instruction: INSTRUCTION, userId: 'someone-else' }],
  ])('rejects input that is %s, without calling the AI', async (_label, body) => {
    const { interpreter, interpret } = fakeInterpreter();
    const { agent } = await signedInAgent(buildApp({ interpreter }));
    const res = await agent.post('/api/monitors/interpret').send(body);
    expect(res.status).toBe(400);
    expect(interpret).not.toHaveBeenCalled();
  });

  it('returns 503 with a clear code when no OpenAI key is configured', async () => {
    const { agent } = await signedInAgent(buildApp()); // no interpreter
    const res = await agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_not_configured');
    expect(res.body.error).toMatch(/fill in the filters yourself/i);
  });

  it.each([
    ['quota_exhausted', 503],
    ['timeout', 504],
    ['bad_output', 502],
    ['refused', 422],
  ] as const)('maps AI failure "%s" to HTTP %i without leaking provider details', async (code, status) => {
    const { interpreter } = fakeInterpreter(async () => {
      throw new AiError(code, 'sk-secret provider detail');
    });
    const { agent } = await signedInAgent(buildApp({ interpreter }));
    const res = await agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(`ai_${code}`);
    expect(JSON.stringify(res.body)).not.toContain('provider detail');
  });

  it('turns unexpected errors into a generic 500', async () => {
    const { interpreter } = fakeInterpreter(async () => {
      throw new Error('kaboom');
    });
    const { agent } = await signedInAgent(buildApp({ interpreter }));
    const res = await agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });

  it('limits AI calls per user, not per IP', async () => {
    const { interpreter } = fakeInterpreter();
    const app = buildApp({ interpreter }); // AI_RATE_LIMIT=5 in tests
    const alice = await signedInAgent(app, 'Alice');
    const bob = await signedInAgent(app, 'Bob');

    for (let i = 0; i < 5; i++) {
      expect((await alice.agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION })).status).toBe(200);
    }
    const blocked = await alice.agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('ai_rate_limited');

    // Same IP, different user: unaffected.
    expect((await bob.agent.post('/api/monitors/interpret').send({ instruction: INSTRUCTION })).status).toBe(200);
  });
});
