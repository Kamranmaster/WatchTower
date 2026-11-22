import type { ApiErrorBody } from '@monitorly/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: ApiErrorBody,
  ) {
    super(message);
  }

  /** Field-level messages keyed by field path (see errorsByPath), for showing next to form inputs. */
  get fieldErrors(): Record<string, string> {
    return errorsByPath(this.body?.details ?? []);
  }

  /** Short, human message for toasts and error states. */
  get friendlyMessage(): string {
    if (this.status === 0) return 'Can’t reach Monitorly. Check your connection and try again.';
    if (this.status === 429) return this.message || 'Too many requests. Wait a moment and try again.';
    if (this.status >= 500 && this.message === 'Internal server error') return 'Something went wrong on our side. Try again in a moment.';
    return this.message;
  }
}

/**
 * Validation messages keyed by every prefix of their path, first message wins:
 * "rules.keywords.0" is available as "rules.keywords.0", "rules.keywords" and "rules".
 */
export function errorsByPath(issues: { path: string; message: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const { path, message } of issues) {
    const parts = path.split('.');
    for (let i = 1; i <= parts.length; i++) errors[parts.slice(0, i).join('.')] ??= message;
  }
  return errors;
}

/** The message to show for any error (API or not). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.friendlyMessage;
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Fetch wrapper: JSON in/out, sends the session cookie, throws ApiError on non-2xx. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      credentials: 'include',
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, 'Can’t reach Monitorly. Check your connection and try again.');
  }
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody | undefined)?.error ?? res.statusText, body);
  }
  return body as T;
}
