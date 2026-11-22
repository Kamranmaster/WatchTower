import OpenAI from 'openai';
import type { AiConfig } from './config';
import { AiError } from './errors';

export type ChatClient = Pick<OpenAI, 'chat'>;

export interface JsonRequest {
  system: string;
  user: string;
  schemaName: string;
  /** Strict JSON Schema: every property required, no extras (accepted by OpenAI, Gemini, Ollama). */
  schema: Record<string, unknown>;
  /** OpenAI completion cap; leaves room for reasoning tokens plus the answer. */
  maxCompletionTokens?: number;
}

export interface JsonResponse {
  data: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export function createChatClient(config: AiConfig): ChatClient {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 1 });
}

/** One structured-output call through the OpenAI Chat Completions API (OpenAI, Gemini, Ollama). */
export async function requestJson(
  client: ChatClient,
  config: AiConfig,
  request: JsonRequest,
  { signal }: { signal?: AbortSignal } = {},
): Promise<JsonResponse> {
  const { provider, model, reasoningEffort, timeoutMs } = config;
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, strict: true, schema: request.schema },
        },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        // OpenAI-only parameters (compatible endpoints may reject unknown ones).
        ...(provider === 'openai' ? { max_completion_tokens: request.maxCompletionTokens ?? 4000, store: false } : {}),
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
      data: parseJson(choice.message.content),
      model: completion.model || model,
      usage: completion.usage ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens } : undefined,
    };
  } catch (err) {
    throw toAiError(err);
  }
}

/** Parses the JSON answer, tolerating a markdown code fence that some models add anyway. */
export function parseJson(text: string): unknown {
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

export function toAiError(err: unknown): AiError {
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
