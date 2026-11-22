import { describe, expect, it, vi } from 'vitest';
import { buildReviewMessage, createChangeReviewer, parseReview, type AiConfig, type ChatClient, type ReviewItem } from '../src';

const config: AiConfig = { provider: 'gemini', apiKey: 'unused', model: 'test-model', reasoningEffort: 'low', timeoutMs: 5000 };

function fakeClient(content: string) {
  const create = vi.fn(async () => ({
    model: 'model-from-provider',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
    usage: { prompt_tokens: 300, completion_tokens: 60 },
  }));
  return { client: { chat: { completions: { create } } } as unknown as ChatClient, create };
}

const items: ReviewItem[] = [
  { id: 'evt-a', changeType: 'new_item', title: 'Frontend Intern', details: 'Remote · Internship' },
  { id: 'evt-b', changeType: 'new_item', title: 'Senior Staff Engineer', details: 'Berlin' },
];

describe('buildReviewMessage', () => {
  it('numbers the changes and never sends the caller ids or query strings', () => {
    const msg = buildReviewMessage({ instruction: 'frontend internships', url: 'https://jobs.example.com/x?session=abc', items });
    expect(msg).toContain('#1 [new_item] Frontend Intern');
    expect(msg).toContain('#2 [new_item] Senior Staff Engineer');
    expect(msg).not.toContain('evt-a');
    expect(msg).not.toContain('session=abc');
    expect(msg).toContain('<<<\nfrontend internships\n>>>');
  });

  it('caps long page text', () => {
    const long: ReviewItem = { id: 'x', changeType: 'new_item', title: 'T'.repeat(1000), details: 'D'.repeat(5000) };
    expect(buildReviewMessage({ instruction: 'x', items: [long] }).length).toBeLessThan(1500);
  });
});

describe('parseReview', () => {
  it('maps change numbers back to ids, clamps scores and clips text', () => {
    const verdicts = parseReview(
      {
        results: [
          { change: 1, relevant: true, score: 140, summary: 'New Frontend Intern role (Remote).', reason: 'x'.repeat(500) },
          { change: 2, relevant: false, score: -5, summary: 'Senior role', reason: 'Not an internship' },
        ],
      },
      items,
    );
    expect(verdicts.get('evt-a')).toMatchObject({ relevant: true, score: 100, summary: 'New Frontend Intern role (Remote).' });
    expect(verdicts.get('evt-a')!.reason).toHaveLength(200);
    expect(verdicts.get('evt-b')).toMatchObject({ relevant: false, score: 0 });
  });

  it('ignores unknown numbers, duplicates and malformed entries', () => {
    const verdicts = parseReview(
      {
        results: [
          { change: 9, relevant: true, score: 1, summary: '', reason: '' },
          { change: 1, relevant: 'yes', score: 1, summary: '', reason: '' },
          { change: 1, relevant: false, score: 10, summary: 'first', reason: '' },
          { change: 1, relevant: true, score: 90, summary: 'second', reason: '' },
          null,
        ],
      },
      items,
    );
    expect([...verdicts.keys()]).toEqual(['evt-a']);
    expect(verdicts.get('evt-a')!.summary).toBe('first');
  });

  it('fails when nothing usable came back', () => {
    expect(() => parseReview({ results: [] }, items)).toThrow(expect.objectContaining({ code: 'bad_output' }));
    expect(() => parseReview({ nope: 1 }, items)).toThrow(expect.objectContaining({ code: 'bad_output' }));
  });
});

describe('createChangeReviewer', () => {
  it('calls the model with a strict schema and returns verdicts by id', async () => {
    const { client, create } = fakeClient(
      JSON.stringify({ results: [{ change: 1, relevant: true, score: 90, summary: 'New intern role', reason: 'fits' }] }),
    );
    const result = await createChangeReviewer(config, { client }).review({ instruction: 'internships', items });
    expect(result.verdicts.get('evt-a')?.relevant).toBe(true);
    expect(result.verdicts.has('evt-b')).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 60 });
    const [params] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(params.response_format).toMatchObject({ json_schema: { name: 'change_review', strict: true } });
    expect(params.messages[0].content).toContain('untrusted');
  });

  it('makes no call for an empty batch', async () => {
    const { client, create } = fakeClient('{}');
    await createChangeReviewer(config, { client }).review({ instruction: 'x', items: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('surfaces bad output as an AiError', async () => {
    const { client } = fakeClient('not json');
    await expect(createChangeReviewer(config, { client }).review({ instruction: 'x', items })).rejects.toMatchObject({
      code: 'bad_output',
    });
  });
});
