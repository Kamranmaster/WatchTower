import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError } from '@monitorly/fetching';
import { createSilentLogger } from '@monitorly/logger';
import { BrowserFetcher } from '../src/browser';
import { startSafeProxy, type ProxyJob, type SafeProxy } from '../src/proxy';
import { startTestServer } from '../../../packages/fetching/test/server';

const logger = createSilentLogger();
const SECRET = 'TOP-SECRET-INTERNAL-DATA';

let site: Awaited<ReturnType<typeof startTestServer>>;
let internal: http.Server;
let internalPort: number;
let proxy: SafeProxy;
let fetcher: BrowserFetcher;
const jobs: ProxyJob[] = [];

beforeAll(async () => {
  // Stands in for an internal service (database admin, metadata endpoint…): must never be reachable.
  internal = http.createServer((_req, res) => res.writeHead(200, { 'access-control-allow-origin': '*' }).end(SECRET));
  await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve));
  internalPort = (internal.address() as AddressInfo).port;

  site = await startTestServer({
    '/api': (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"jobs":["Rendered Intern Role"]}'),
    // A JavaScript-only page that also tries to read internal addresses.
    '/js-page': (_q, res, port) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>
        <div id="root"></div><div id="leak1"></div><div id="leak2"></div>
        <script>
          document.getElementById('root').textContent = 'Rendered by JavaScript';
          fetch('/api').then(r => r.json()).then(d => { document.getElementById('root').textContent += ' | ' + d.jobs[0]; });
          fetch('http://127.0.0.1:${internalPort}/').then(r => r.text()).then(t => { document.getElementById('leak1').textContent = t; }).catch(() => {});
          fetch('http://evil.example.test:${port}/page').then(r => r.text()).then(t => { document.getElementById('leak2').textContent = t; }).catch(() => {});
        </script></body></html>`),
    '/js-redirect-internal': (_q, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<script>location.href='http://127.0.0.1:${internalPort}/'</script>`),
  });

  proxy = await startSafeProxy({ logger, policy: site.policy });
  const startJob = proxy.startJob.bind(proxy);
  proxy.startJob = () => {
    const job = startJob();
    jobs.push(job);
    return job;
  };
  fetcher = new BrowserFetcher({ proxy, logger, policy: site.policy, settleMs: 1500, navigationTimeoutMs: 10_000 });
  await fetcher.start();
}, 60_000);

afterAll(async () => {
  await fetcher?.close();
  await proxy?.close();
  await site?.close();
  await new Promise<void>((resolve) => internal.close(() => resolve()));
});

async function browserError(url: string) {
  const err = await fetcher.fetch(url).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(FetchError);
  return err as FetchError;
}

describe('BrowserFetcher', () => {
  it('renders a JavaScript page', async () => {
    const page = await fetcher.fetch(site.url('/js-page'));
    expect(page.status).toBe(200);
    expect(page.body).toContain('Rendered by JavaScript | Rendered Intern Role');
    expect(page.finalUrl).toBe(site.url('/js-page'));
  });

  it('the page’s own requests to internal addresses are refused by the proxy', async () => {
    const before = jobs.length;
    const page = await fetcher.fetch(site.url('/js-page'));
    expect(page.body).not.toContain(SECRET);
    expect(page.body).not.toContain('Software Engineer Intern'); // evil.example.test → 10.0.0.5
    // Proof the requests went through the proxy and were refused there (not just failed some other way).
    const blocked = jobs.slice(before).flatMap((j) => j.blocked());
    expect(blocked.some((t) => t.includes(`127.0.0.1:${internalPort}`))).toBe(true);
    expect(blocked.some((t) => t.includes('evil.example.test'))).toBe(true);
  });

  it('refuses to open an internal address directly', async () => {
    expect((await browserError(`http://127.0.0.1:${internalPort}/`)).kind).toBe('unsafe_url');
  });

  it('a server redirect to the metadata address is blocked', async () => {
    const before = jobs.length;
    const err = await browserError(site.url('/redirect-metadata'));
    expect(err.kind).toBe('unsafe_url');
    expect(jobs.slice(before).flatMap((j) => j.blocked()).some((t) => t.includes('169.254.169.254'))).toBe(true);
  });

  it('a JavaScript redirect to an internal address never returns its content', async () => {
    const result = await fetcher.fetch(site.url('/js-redirect-internal')).catch((e: unknown) => e);
    if (result instanceof FetchError) {
      expect(['unsafe_url', 'browser', 'http_status']).toContain(result.kind);
    } else {
      expect((result as { body: string }).body).not.toContain(SECRET);
    }
  });

  it('reports HTTP errors', async () => {
    expect(await browserError(site.url('/404'))).toMatchObject({ kind: 'http_status', status: 404 });
  });

  it('rejects downloads and non-page content', async () => {
    expect((await browserError(site.url('/pdf'))).kind).toBe('unsupported_content');
  });
});

describe('safety proxy', () => {
  const viaProxy = (target: string, auth?: string) =>
    new Promise<number>((resolve, reject) => {
      const proxyUrl = new URL(proxy.url);
      const req = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port,
        path: target,
        headers: auth ? { 'proxy-authorization': `Basic ${Buffer.from(auth).toString('base64')}` } : {},
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  it('refuses anyone without the per-process secret (not an open relay)', async () => {
    expect(await viaProxy(site.url('/page'))).toBe(407);
    const job = proxy.startJob();
    expect(await viaProxy(site.url('/page'), `${job.token}:wrong-secret`)).toBe(407);
    expect(await viaProxy(site.url('/page'), `not-a-job:${proxy.secret}`)).toBe(407);
    job.end();
  });

  it('forwards allowed requests and refuses internal ones', async () => {
    const job = proxy.startJob();
    const auth = `${job.token}:${proxy.secret}`;
    expect(await viaProxy(site.url('/page'), auth)).toBe(200);
    expect(await viaProxy(`http://127.0.0.1:${internalPort}/`, auth)).toBe(403);
    expect(await viaProxy(`http://evil.example.test:${site.port}/`, auth)).toBe(403);
    expect(job.blocked()).toHaveLength(2);
    job.end();
  });
});
