import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, assessContent, decodeBody, httpFetch, isSupportedContentType } from '../src';
import { HTML, PAGE_TEXT, SPA_HTML, startTestServer } from './server';

let server: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
});

async function fetchError(path: string, options: Parameters<typeof httpFetch>[1] = {}) {
  const err = await httpFetch(server.url(path), { policy: server.policy, ...options }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(FetchError);
  return err as FetchError;
}

describe('httpFetch — normal pages', () => {
  it('fetches a page', async () => {
    const page = await httpFetch(server.url('/page'), { policy: server.policy });
    expect(page).toMatchObject({ status: 200, body: HTML, finalUrl: server.url('/page'), redirects: [] });
    expect(page.contentType).toContain('text/html');
  });

  it('follows a safe redirect and reports where it ended up', async () => {
    const page = await httpFetch(server.url('/redirect'), { policy: server.policy });
    expect(page.finalUrl).toBe(server.url('/page'));
    expect(page.redirects).toEqual([server.url('/redirect')]);
  });

  it('decodes the charset from the header and from a <meta> tag', async () => {
    expect((await httpFetch(server.url('/latin1'), { policy: server.policy })).body).toBe('<p>Café</p>');
    expect((await httpFetch(server.url('/meta-charset'), { policy: server.policy })).body).toContain('“quoted”');
  });

  it('ignores HTTP_PROXY from the environment', async () => {
    const before = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'; // nothing listens there
    try {
      expect((await httpFetch(server.url('/page'), { policy: server.policy })).status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = before;
    }
  });
});

describe('httpFetch — SSRF protection', () => {
  it('with the real policy, refuses the local test server itself', async () => {
    const err = await httpFetch(`http://127.0.0.1:${server.port}/page`).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unsafe_url', retryable: false });
  });

  it('checks the address at connect time: a public-looking name that resolves to loopback is refused', async () => {
    // Same DNS as the test server, but with the default (public-only) address rule.
    const policy = { ...server.policy, isAllowedAddress: undefined };
    const err = await httpFetch(server.url('/page'), { policy }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'unsafe_url', retryable: false });
  });

  it('refuses a redirect to the cloud metadata address', async () => {
    const err = await fetchError('/redirect-metadata');
    expect(err.kind).toBe('unsafe_url');
    expect(err.message).toMatch(/redirected to a blocked address/);
  });

  it('refuses a redirect to a name that resolves to a private address', async () => {
    expect((await fetchError('/redirect-private-dns')).kind).toBe('unsafe_url');
  });

  it('refuses a redirect to another scheme', async () => {
    expect((await fetchError('/redirect-ftp')).kind).toBe('unsafe_url');
  });
});

describe('httpFetch — limits', () => {
  it('stops redirect loops', async () => {
    expect((await fetchError('/loop')).kind).toBe('too_many_redirects');
  });

  it('caps the response size', async () => {
    expect((await fetchError('/big', { maxBytes: 1024 * 1024 })).kind).toBe('too_large');
  });

  it('caps the decompressed size (gzip bomb)', async () => {
    expect((await fetchError('/bomb', { maxBytes: 5 * 1024 * 1024 })).kind).toBe('too_large');
  });

  it('gives up on a server that stalls', async () => {
    const started = Date.now();
    const err = await fetchError('/slow', { timeoutMs: 700 });
    expect(err).toMatchObject({ kind: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('rejects non-page content', async () => {
    expect((await fetchError('/pdf')).kind).toBe('unsupported_content');
  });
});

describe('httpFetch — status codes', () => {
  it.each([
    ['/404', 404, false],
    ['/403', 403, false],
    ['/429', 429, true],
    ['/503', 503, true],
  ] as const)('%s → http_status %i (retryable: %s)', async (path, status, retryable) => {
    expect(await fetchError(path)).toMatchObject({ kind: 'http_status', status, retryable });
  });

  it('DNS failures are reported clearly', async () => {
    const err = await httpFetch(`http://nowhere.example.test:${server.port}/`, { policy: server.policy }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'dns' });
  });
});

describe('assessContent', () => {
  it('accepts a page with real content', () => {
    expect(assessContent(HTML, 'text/html')).toMatchObject({ usable: true });
    expect(assessContent(HTML, 'text/html').textLength).toBeGreaterThanOrEqual(PAGE_TEXT.trim().length);
  });

  it('flags a JavaScript-only page', () => {
    expect(assessContent(SPA_HTML, 'text/html')).toMatchObject({ usable: false, reason: 'The page says it needs JavaScript' });
  });

  it('flags a page with almost no text', () => {
    expect(assessContent('<html><body><div id="app"></div></body></html>')).toMatchObject({ usable: false });
  });

  it('does not count script contents as text', () => {
    const html = `<html><body><script>${'var x = 1;'.repeat(500)}</script><p>hi</p></body></html>`;
    expect(assessContent(html).usable).toBe(false);
  });

  it('treats non-empty JSON as usable', () => {
    expect(assessContent('{"jobs":[]}', 'application/json').usable).toBe(true);
  });
});

describe('content helpers', () => {
  it('knows which content types are pages', () => {
    expect(isSupportedContentType('text/html; charset=utf-8')).toBe(true);
    expect(isSupportedContentType('application/json')).toBe(true);
    expect(isSupportedContentType('application/rss+xml')).toBe(true);
    expect(isSupportedContentType(undefined)).toBe(true);
    expect(isSupportedContentType('application/pdf')).toBe(false);
    expect(isSupportedContentType('image/png')).toBe(false);
  });

  it('falls back to UTF-8 for an unknown charset', () => {
    expect(decodeBody(Buffer.from('héllo'), 'text/html; charset=made-up')).toBe('héllo');
  });
});
