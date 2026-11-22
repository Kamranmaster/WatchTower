import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { UrlPolicy } from '@monitorly/url-safety';

export const PAGE_TEXT = 'Software Engineer Intern — Bangalore. '.repeat(20);
export const HTML = `<!doctype html><html><head><title>Jobs</title></head><body><ul><li>${PAGE_TEXT}</li></ul></body></html>`;
export const SPA_HTML = `<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;

export type Routes = Record<string, (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void>;

/** A local HTTP server plus a URL policy that lets *only* it through (the safety checks stay on). */
export async function startTestServer(extra: Routes = {}) {
  const routes: Routes = {
    '/page': (_q, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML),
    '/spa': (_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(SPA_HTML),
    '/latin1': (_q, res) =>
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }).end(Buffer.from('<p>Caf\xe9</p>', 'latin1')),
    '/meta-charset': (_q, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end(Buffer.from('<meta charset="windows-1252"><p>\x93quoted\x94</p>', 'latin1')),
    '/redirect': (_q, res) => res.writeHead(302, { location: '/page' }).end(),
    '/redirect-metadata': (_q, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    '/redirect-private-dns': (_q, res, port) => res.writeHead(301, { location: `http://evil.example.test:${port}/page` }).end(),
    '/redirect-ftp': (_q, res) => res.writeHead(302, { location: 'ftp://files.example.com/x' }).end(),
    '/loop': (_q, res) => res.writeHead(302, { location: '/loop' }).end(),
    '/big': (_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('x'.repeat(6 * 1024 * 1024)),
    // ~50 KB on the wire, 64 MB once decompressed.
    '/bomb': (_q, res) =>
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(64 * 1024 * 1024))),
    '/slow': (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<p>starting');
      // …and never finishes.
    },
    '/pdf': (_q, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4'),
    '/404': (_q, res) => res.writeHead(404).end('nope'),
    '/403': (_q, res) => res.writeHead(403).end('go away'),
    '/429': (_q, res) => res.writeHead(429).end('slow down'),
    '/503': (_q, res) => res.writeHead(503).end('down'),
    '/robots.txt': (_q, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private\n'),
    ...extra,
  };

  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const route = routes[path];
    if (!route) return void res.writeHead(404).end();
    route(req, res, port);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const dns: Record<string, string[]> = { 'site.example.test': ['127.0.0.1'], 'evil.example.test': ['10.0.0.5'] };
  const policy: UrlPolicy = {
    allowedPorts: new Set([String(port)]),
    isAllowedAddress: (ip) => ip === '127.0.0.1',
    lookup: async (host) => {
      const addresses = dns[host];
      if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return addresses;
    },
  };

  return {
    port,
    policy,
    url: (path: string) => `http://site.example.test:${port}${path}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
