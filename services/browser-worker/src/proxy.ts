import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Logger } from '@monitorly/logger';
import { UNSAFE_ADDRESS_CODE, UnsafeUrlError, createSafeLookup, parsePublicUrl, type UrlPolicy } from '@monitorly/url-safety';

/**
 * A tiny forward proxy that every byte the headless browser sends must go through.
 *
 * Checking only the URL we navigate to is not enough: the page can redirect, load scripts,
 * call fetch(), open iframes or WebSockets — to any address. Chromium sends all of that to this
 * proxy (Playwright also routes loopback through it), and the proxy resolves DNS itself with the
 * safe lookup and connects only to allowed public addresses on allowed ports. This also defeats
 * DNS rebinding, since the browser never resolves hostnames.
 *
 * It requires a per-process secret, so nothing else on the machine can use it as an open relay,
 * and the username identifies the job, so a blocked request can be reported for the right check.
 */
export interface SafeProxy {
  url: string;
  secret: string;
  /** Start tracking a job; its token is the proxy username for that browser context. */
  startJob(): ProxyJob;
  close(): Promise<void>;
}

export interface ProxyJob {
  token: string;
  /** Targets the proxy refused for this job. Still readable after end(). */
  blocked(): string[];
  end(): void;
}

const MAX_BLOCKED_PER_JOB = 20;
const HOP_BY_HOP = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

export async function startSafeProxy(options: { policy?: UrlPolicy; logger: Logger }): Promise<SafeProxy> {
  const { logger } = options;
  const policy = options.policy ?? {};
  const lookup = createSafeLookup(policy) as unknown as net.LookupFunction;
  const secret = randomBytes(24).toString('hex');
  const secretBuf = Buffer.from(secret);
  const jobs = new Map<string, string[]>();
  const sockets = new Set<net.Socket>();

  /** Returns the job token if the Proxy-Authorization header carries our secret. */
  function authenticate(req: http.IncomingMessage): string | null {
    const header = req.headers['proxy-authorization'];
    if (!header?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    const token = decoded.slice(0, sep);
    const password = Buffer.from(decoded.slice(sep + 1));
    if (password.length !== secretBuf.length || !timingSafeEqual(password, secretBuf)) return null;
    return jobs.has(token) ? token : null;
  }

  function block(token: string, target: string, reason: string) {
    const list = jobs.get(token);
    if (list && list.length < MAX_BLOCKED_PER_JOB) list.push(target);
    logger.warn({ target, reason }, 'Browser request blocked by safety proxy');
  }

  const server = http.createServer((req, res) => {
    // Plain-HTTP requests arrive with an absolute URL: "GET http://host/path".
    const token = authenticate(req);
    if (!token) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="monitorly"' }).end();
      return;
    }
    let url: URL;
    try {
      url = parsePublicUrl(req.url ?? '', policy);
      if (url.protocol !== 'http:') throw new UnsafeUrlError('Only http:// over a plain proxy request');
    } catch (err) {
      block(token, req.url ?? '?', (err as Error).message);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by Monitorly: private or internal address');
      return;
    }

    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const upstream = http.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        lookup,
        agent: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === UNSAFE_ADDRESS_CODE) block(token, url.host, err.message);
      if (!res.headersSent) res.writeHead(err.code === UNSAFE_ADDRESS_CODE ? 403 : 502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSockets: "CONNECT host:port" then a raw tunnel.
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const token = authenticate(req);
    if (!token) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="monitorly"\r\n\r\n');
      return;
    }
    let target: URL;
    try {
      target = parsePublicUrl(`https://${req.url ?? ''}/`, policy);
    } catch (err) {
      block(token, req.url ?? '?', (err as Error).message);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const upstream = net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443), lookup });
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === UNSAFE_ADDRESS_CODE) {
        block(token, req.url ?? '?', err.message);
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      } else if (!client.destroyed) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });
    client.on('close', () => upstream.destroy());
  });

  // Plain ws:// upgrades through the proxy aren't needed for monitoring: refuse them.
  server.on('upgrade', (_req, socket: net.Socket) => socket.destroy());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    startJob() {
      const token = randomBytes(8).toString('hex');
      const blocked: string[] = [];
      jobs.set(token, blocked);
      // The list stays readable after end(); end() only stops the token being accepted.
      return { token, blocked: () => [...blocked], end: () => void jobs.delete(token) };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
