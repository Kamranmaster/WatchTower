export type FetchErrorKind =
  | 'unsafe_url' // private/internal address, bad scheme or port (also on a redirect)
  | 'robots' // robots.txt disallows us
  | 'dns' // hostname didn't resolve
  | 'network' // connection refused/reset, TLS failure…
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects'
  | 'http_status' // the site answered with an error status
  | 'unsupported_content' // PDF, image, download…
  | 'browser'; // the headless browser itself failed

/**
 * A failed fetch, with a message safe to show the user (stored as the check's error).
 * `retryable` = worth trying again with backoff (timeouts, 5xx, 429…).
 */
export class FetchError extends Error {
  override name = 'FetchError';
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

/** HTTP statuses worth retrying: timeouts, rate limiting and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return `The site refused access (HTTP ${status})`;
  if (status === 404 || status === 410) return `The page was not found (HTTP ${status}). Check the URL.`;
  if (status === 429) return 'The site is rate-limiting us (HTTP 429); will try again later';
  if (status >= 500) return `The site had a server error (HTTP ${status})`;
  return `The site answered with HTTP ${status}`;
}
