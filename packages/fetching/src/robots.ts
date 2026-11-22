import robotsParser from 'robots-parser';
import { FetchError } from './errors';
import { httpFetch, type HttpFetchOptions } from './http-fetch';

type Robots = ReturnType<typeof robotsParser>;

export interface RobotsCheckerOptions {
  /** The product token matched against robots.txt "User-agent:" lines. */
  agentToken?: string;
  ttlMs?: number;
  /** When robots.txt can't be fetched (5xx, network), retry it sooner than ttlMs. */
  errorTtlMs?: number;
  fetchOptions?: HttpFetchOptions;
  /** Injectable for tests. */
  fetchRobots?: (url: string) => Promise<string | null>;
  clock?: () => number;
}

/**
 * Respects robots.txt: fetched once per origin and cached (in memory, per worker).
 * A missing robots.txt (4xx) allows everything. If it can't be fetched (5xx, network error) we
 * allow the check rather than fail every monitor on that site, and look again sooner.
 */
export class RobotsChecker {
  private readonly cache = new Map<string, { expires: number; robots: Promise<Robots | null> }>();
  private readonly agentToken: string;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly clock: () => number;
  private readonly fetchRobots: (url: string) => Promise<string | null>;

  constructor(options: RobotsCheckerOptions = {}) {
    this.agentToken = options.agentToken ?? 'MonitorlyBot';
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.errorTtlMs = options.errorTtlMs ?? 5 * 60 * 1000;
    this.clock = options.clock ?? Date.now;
    this.fetchRobots =
      options.fetchRobots ??
      (async (url) => {
        try {
          const page = await httpFetch(url, { timeoutMs: 5_000, maxBytes: 512 * 1024, accept: 'text/plain,*/*', ...options.fetchOptions });
          return page.body;
        } catch (err) {
          if (err instanceof FetchError && err.kind === 'http_status' && err.status! < 500) return ''; // none → allow all
          throw err;
        }
      });
  }

  async isAllowed(pageUrl: string): Promise<boolean> {
    const robotsUrl = new URL('/robots.txt', pageUrl).href;
    const origin = new URL(pageUrl).origin;
    const now = this.clock();
    let entry = this.cache.get(origin);
    if (!entry || entry.expires <= now) {
      const robots = this.fetchRobots(robotsUrl).then(
        (text) => (text === null ? null : robotsParser(robotsUrl, text)),
        () => {
          // Couldn't fetch: don't block, but re-check soon.
          const cached = this.cache.get(origin);
          if (cached) cached.expires = this.clock() + this.errorTtlMs;
          return null;
        },
      );
      entry = { expires: now + this.ttlMs, robots };
      this.cache.set(origin, entry);
    }
    const robots = await entry.robots;
    return robots?.isAllowed(pageUrl, this.agentToken) ?? true;
  }
}
