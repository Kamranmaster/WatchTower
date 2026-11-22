import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RobotsChecker } from '../src';
import { startTestServer } from './server';

describe('RobotsChecker', () => {
  it('allows and disallows paths per robots.txt', async () => {
    const fetchRobots = vi.fn(async () => 'User-agent: *\nDisallow: /private\n\nUser-agent: MonitorlyBot\nDisallow: /no-bots\n');
    const robots = new RobotsChecker({ fetchRobots });
    expect(await robots.isAllowed('https://shop.example.com/jobs')).toBe(true);
    expect(await robots.isAllowed('https://shop.example.com/private/x')).toBe(true); // our group overrides "*"
    expect(await robots.isAllowed('https://shop.example.com/no-bots/1')).toBe(false);
  });

  it('caches robots.txt per origin', async () => {
    const fetchRobots = vi.fn(async () => '');
    const robots = new RobotsChecker({ fetchRobots });
    await Promise.all([robots.isAllowed('https://a.example.com/1'), robots.isAllowed('https://a.example.com/2')]);
    await robots.isAllowed('https://b.example.com/1');
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it('refreshes after the TTL', async () => {
    let now = 0;
    const fetchRobots = vi.fn(async () => '');
    const robots = new RobotsChecker({ fetchRobots, ttlMs: 1000, clock: () => now });
    await robots.isAllowed('https://a.example.com/');
    now = 2000;
    await robots.isAllowed('https://a.example.com/');
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it('allows the check when robots.txt cannot be fetched, and retries sooner', async () => {
    let now = 0;
    const fetchRobots = vi.fn(async () => {
      throw new Error('503');
    });
    const robots = new RobotsChecker({ fetchRobots, ttlMs: 60_000, errorTtlMs: 1000, clock: () => now });
    expect(await robots.isAllowed('https://a.example.com/')).toBe(true);
    now = 1500;
    await robots.isAllowed('https://a.example.com/');
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  describe('over real HTTP (SSRF-safe fetch)', () => {
    let server: Awaited<ReturnType<typeof startTestServer>>;
    beforeAll(async () => {
      server = await startTestServer();
    });
    afterAll(() => server.close());

    it('reads the site’s robots.txt', async () => {
      const robots = new RobotsChecker({ fetchOptions: { policy: server.policy } });
      expect(await robots.isAllowed(server.url('/page'))).toBe(true);
      expect(await robots.isAllowed(server.url('/private/page'))).toBe(false);
    });

    it('treats a missing robots.txt (404) as "allow everything"', async () => {
      const bare = await startTestServer({ '/robots.txt': (_q, res) => res.writeHead(404).end() });
      try {
        const robots = new RobotsChecker({ fetchOptions: { policy: bare.policy } });
        expect(await robots.isAllowed(bare.url('/private/page'))).toBe(true);
      } finally {
        await bare.close();
      }
    });
  });
});
