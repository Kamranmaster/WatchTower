import OpenAI from 'openai';
import { instructionInterpretationSchema, type InstructionInterpretation } from '@monitorly/contracts';
import type { AiConfig, AiProvider } from './config';
import { AiError } from './errors';
import { INTERPRETATION_JSON_SCHEMA, INTERPRET_SYSTEM_PROMPT, buildUserMessage } from './prompt';

export interface InterpretInput {
  instruction: string;
  url?: string;
}

export interface InterpretResult {
  interpretation: InstructionInterpretation;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** The seam the API depends on, so tests can swap in a fake. */
export interface InstructionInterpreter {
  readonly provider: AiProvider;
  readonly model: string;
  interpret(input: InterpretInput, options?: { signal?: AbortSignal }): Promise<InterpretResult>;
}

export type ChatClient = Pick<OpenAI, 'chat'>;

const MAX_LIST = 25;
const MAX_PHRASE = 100;

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const clipList = (list: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(list) ? list : [])
    .map((s) => clip(s, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

/**
 * Turns the model's raw JSON into a validated interpretation.
 * Clips oversized output instead of failing, removes contradictions, then validates with the
 * shared Zod schema — nothing reaches the user unless it passes.
 */
export function normalizeInterpretation(raw: unknown): InstructionInterpretation {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keywords = clipList(r.keywords, MAX_LIST, MAX_PHRASE);
  const included = new Set(keywords.map((k) => k.toLowerCase()));
  // An exclude that is also a required keyword would make every item fail to match.
  const excludeKeywords = clipList(r.excludeKeywords, MAX_LIST, MAX_PHRASE).filter((k) => !included.has(k.toLowerCase()));

  const parsed = instructionInterpretationSchema.safeParse({
    monitorType: r.monitorType,
    rules: { keywords, locations: clipList(r.locations, MAX_LIST, MAX_PHRASE), excludeKeywords },
    notes: clipList(r.notes, 5, 300),
  });
  if (!parsed.success) {
    throw new AiError('bad_output', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/** Parses the JSON answer, tolerating a markdown code fence that some models add anyway. */
function parseJson(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^`{3}(?:json)?\s*/i, '')
    .replace(/\s*`{3}$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new AiError('bad_output', 'response was not JSON');
  }
}

function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new AiError('timeout', undefined, { cause: err });
  if (err instanceof OpenAI.APIUserAbortError) return new AiError('timeout', 'aborted', { cause: err });
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new AiError('auth', err.message, { cause: err });
  }
  // Gemini answers an invalid key with 400 "API key not valid".
  if (err instanceof OpenAI.BadRequestError && /api key/i.test(err.message)) {
    return new AiError('auth', err.message, { cause: err });
  }
  if (err instanceof OpenAI.RateLimitError) {
    // OpenAI with no credits: type "insufficient_quota" (older responses put it in `code`).
    const quota = err.type === 'insufficient_quota' || err.code === 'insufficient_quota';
    return new AiError(quota ? 'quota_exhausted' : 'rate_limited', err.message, { cause: err });
  }
  // Gemini: 503 "model is currently experiencing high demand".
  if (err instanceof OpenAI.APIError && err.status === 503) return new AiError('rate_limited', err.message, { cause: err });
  if (err instanceof OpenAI.APIError) return new AiError('upstream', `${err.status ?? 'network'}: ${err.message}`, { cause: err });
  return new AiError('upstream', err instanceof Error ? err.message : String(err), { cause: err });
}

/** Works with any provider that speaks the OpenAI Chat Completions API (OpenAI, Gemini, Ollama). */
export function createAiInterpreter(config: AiConfig, options: { client?: ChatClient } = {}): InstructionInterpreter {
  const { provider, model, reasoningEffort, timeoutMs } = config;
  const client =
    options.client ?? new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: timeoutMs, maxRetries: 1 });

  return {
    provider,
    model,
    async interpret({ instruction, url }, { signal } = {}) {
      try {
        const completion = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: INTERPRET_SYSTEM_PROMPT },
              { role: 'user', content: buildUserMessage(instruction, url) },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'monitor_rules', strict: true, schema: INTERPRETATION_JSON_SCHEMA },
            },
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            // OpenAI-only parameters (compatible endpoints may reject unknown ones).
            // The cap leaves room for reasoning tokens plus the small JSON answer.
            ...(provider === 'openai' ? { max_completion_tokens: 4000, store: false } : {}),
          },
          { signal, timeout: timeoutMs },
        );

        const choice = completion.choices[0];
        if (!choice) throw new AiError('bad_output', 'no choices returned');
        if (choice.message.refusal) throw new AiError('refused', choice.message.refusal);
        if (choice.finish_reason === 'content_filter') throw new AiError('refused', 'content filter');
        if (choice.finish_reason === 'length') throw new AiError('bad_output', 'answer was cut off (length)');
        if (!choice.message.content) throw new AiError('bad_output', 'empty answer');

        return {
          interpretation: normalizeInterpretation(parseJson(choice.message.content)),
          model: completion.model || model,
          usage: completion.usage
            ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens }
            : undefined,
        };
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}
