import { instructionInterpretationSchema, type InstructionInterpretation } from '@monitorly/contracts';
import type { AiConfig, AiProvider } from './config';
import { createChatClient, requestJson, type ChatClient } from './chat';
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

export type { ChatClient };

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

/** Works with any provider that speaks the OpenAI Chat Completions API (OpenAI, Gemini, Ollama). */
export function createAiInterpreter(config: AiConfig, options: { client?: ChatClient } = {}): InstructionInterpreter {
  const client = options.client ?? createChatClient(config);
  return {
    provider: config.provider,
    model: config.model,
    async interpret({ instruction, url }, { signal } = {}) {
      const res = await requestJson(
        client,
        config,
        {
          system: INTERPRET_SYSTEM_PROMPT,
          user: buildUserMessage(instruction, url),
          schemaName: 'monitor_rules',
          schema: INTERPRETATION_JSON_SCHEMA,
          maxCompletionTokens: 4000,
        },
        { signal },
      );
      return { interpretation: normalizeInterpretation(res.data), model: res.model, usage: res.usage };
    },
  };
}
