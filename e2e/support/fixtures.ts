import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { MonitorDto, UserDto } from '@monitorly/contracts';
import { E2E } from './env';

export const PASSWORD = 'correct-horse-battery';

export interface TestUser extends UserDto {
  password: string;
}

/** Seed-server calls (see seed-server.ts). */
async function seedCall<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${E2E.seedUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`seed ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const seed = {
  events: (monitorId: string, events: { title: string; verdict?: string; description?: string; reasons?: string[]; minutesAgo?: number }[]) =>
    seedCall<{ ids: string[] }>('/events', { monitorId, events }),
  runs: (monitorId: string, count: number) => seedCall('/runs', { monitorId, count }),
  fail: (monitorId: string, error?: string) => seedCall('/fail', { monitorId, error }),
  notify: (monitorId: string, options: { title?: string; count?: number; live?: boolean; read?: boolean } = {}) =>
    seedCall<{ notifications: { id: string; eventId: string }[] }>('/notify', { monitorId, ...options }),
};

/** Creates a monitor through the real API as the logged-in user (same cookies as the page). */
export async function createMonitor(request: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<MonitorDto> {
  const res = await request.post('/api/monitors', {
    data: {
      url: 'https://example.com/careers',
      instruction: 'New software engineering intern roles',
      name: `Acme careers ${randomUUID().slice(0, 4)}`,
      rules: { keywords: ['intern'], locations: [], excludeKeywords: ['senior'] },
      ...overrides,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { monitor: MonitorDto }).monitor;
}

/** Registers a brand-new account through the API; the page's context is then logged in. */
export async function registerUser(request: APIRequestContext, name = 'Riya Sharma'): Promise<TestUser> {
  const email = `e2e-${randomUUID()}@example.com`;
  const res = await request.post('/api/auth/register', { data: { name, email, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return { ...((await res.json()) as { user: UserDto }).user, password: PASSWORD };
}

/** A toast message ("Changes saved.", error messages, live alerts). */
export const toast = (page: Page, text: string | RegExp) => page.getByRole('region', { name: 'Messages' }).getByText(text);

/** Accessibility scan (axe, WCAG 2.2 A/AA). Fails on serious and critical issues. */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = blocking.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`).join('\n');
  expect(blocking, `${label}:\n${report}`).toEqual([]);
}

/** The page must not scroll sideways (nothing wider than the screen). */
export async function expectNoHorizontalScroll(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label} scrolls sideways`).toBeLessThanOrEqual(clientWidth);
}

/** `user`: a fresh account per test, already logged in. Tests never share data. */
export const test = base.extend<{ user: TestUser }>({
  user: async ({ page }, use) => {
    await use(await registerUser(page.request));
  },
});

export { expect };
