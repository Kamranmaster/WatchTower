import type { ApiErrorBody } from '@monitorly/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: ApiErrorBody,
  ) {
    super(message);
  }

  /** Field-level messages keyed by field path, for showing next to form inputs. */
  get fieldErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const detail of this.body?.details ?? []) {
      const key = detail.path.split('.')[0] ?? detail.path;
      errors[key] ??= detail.message;
    }
    return errors;
  }
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
    throw new ApiError(0, 'Cannot reach the server. Is the API running?');
  }
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody | undefined)?.error ?? res.statusText, body);
  }
  return body as T;
}
