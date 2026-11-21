import { z } from 'zod';

export const AI_PROVIDERS = ['openai', 'gemini', 'ollama'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/**
 * Every provider is called through the OpenAI SDK's Chat Completions API, which OpenAI,
 * Gemini (OpenAI-compatible endpoint) and Ollama all support. A preset supplies the defaults.
 */
const PRESETS: Record<AiProvider, { baseURL?: string; model: string; reasoningEffort?: ReasoningEffort; needsKey: boolean }> = {
  openai: { model: 'gpt-5.4-mini', reasoningEffort: 'low', needsKey: true },
  // Free tier available: create a key at https://aistudio.google.com/apikey
  // Lite: ~1s answers and the most free-tier headroom; full Flash was overloaded/slow on the free tier (2026-11).
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-flash-lite-latest', reasoningEffort: 'low', needsKey: true },
  // Runs locally and free: https://ollama.com, then `ollama pull <model>`
  ollama: { baseURL: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
};

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

/** Env fields for services that use AI. Spread into a service's env schema. */
export const aiEnvFields = {
  AI_PROVIDER: z.enum(AI_PROVIDERS).default('openai'),
  /** Key for the chosen provider. Optional: without it, AI features report "not configured". */
  AI_API_KEY: optionalString,
  /** Optional overrides of the provider preset. */
  AI_MODEL: optionalString,
  AI_BASE_URL: optionalString.pipe(z.url().optional()),
  /** "off" = don't send a reasoning setting (for models that reject it). */
  AI_REASONING_EFFORT: z.enum(['off', 'none', 'minimal', 'low', 'medium', 'high']).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  /** Older names, still honoured when AI_PROVIDER=openai. */
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
};

type AiEnv = z.output<z.ZodObject<typeof aiEnvFields>>;

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  timeoutMs: number;
}

/** Combines env + provider preset. Returns null when the provider needs a key and none is set. */
export function resolveAiConfig(env: AiEnv): AiConfig | null {
  const provider = env.AI_PROVIDER;
  const preset = PRESETS[provider];
  const legacy = provider === 'openai';

  const apiKey = env.AI_API_KEY ?? (legacy ? env.OPENAI_API_KEY : undefined);
  if (preset.needsKey && !apiKey) return null;

  const effort = env.AI_REASONING_EFFORT;
  return {
    provider,
    apiKey: apiKey ?? 'not-needed', // the SDK insists on a value; Ollama ignores it
    baseURL: env.AI_BASE_URL ?? preset.baseURL,
    model: env.AI_MODEL ?? (legacy ? env.OPENAI_MODEL : undefined) ?? preset.model,
    reasoningEffort: effort === 'off' ? undefined : (effort ?? preset.reasoningEffort),
    timeoutMs: env.AI_TIMEOUT_MS,
  };
}
