import { chromium, errors, type Browser } from 'playwright';
import { FetchError, describeStatus, isRetryableStatus, isSupportedContentType, type FetchedContent } from '@monitorly/fetching';
import type { Logger } from '@monitorly/logger';
import { UnsafeUrlError, assertSafeUrl, type UrlPolicy } from '@monitorly/url-safety';
import type { SafeProxy } from './proxy';

export interface BrowserFetcherOptions {
  proxy: SafeProxy;
  logger: Logger;
  navigationTimeoutMs?: number;
  /** After the DOM is ready, wait up to this long for the network to go quiet (lets SPAs render). */
  settleMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Tests only. */
  policy?: UrlPolicy;
}

/** Not needed to read a page, and the heaviest things to download. */
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);

/**
 * Renders pages in headless Chromium. One browser process is shared; every job gets a fresh,
 * isolated context (no cookies, storage or credentials carried over) whose traffic all goes
 * through the safety proxy.
 */
export class BrowserFetcher {
  private browser?: Promise<Browser>;
  private readonly navigationTimeoutMs: number;
  private readonly settleMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: BrowserFetcherOptions) {
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.settleMs = options.settleMs ?? 3_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  }

  private async getBrowser(): Promise<Browser> {
    const current = this.browser ? await this.browser.catch(() => undefined) : undefined;
    if (current?.isConnected()) return current;
    this.browser = chromium.launch({
      headless: true,
      // Launch-level proxy too, so nothing can ever go direct; per-job credentials are set per context.
      proxy: { server: this.options.proxy.url, username: 'launch', password: 'unused' },
    });
    const browser = await this.browser;
    browser.on('disconnected', () => this.options.logger.warn('Chromium disconnected; will relaunch on the next job'));
    this.options.logger.info({ version: browser.version() }, 'Chromium launched');
    return browser;
  }

  async start(): Promise<void> {
    await this.getBrowser();
  }

  async fetch(url: string): Promise<FetchedContent> {
    // Friendly, early error for the page itself (the proxy enforces it for everything else).
    try {
      await assertSafeUrl(url, { policy: this.options.policy });
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new FetchError('unsafe_url', err.message, { cause: err });
      throw err;
    }

    const browser = await this.getBrowser();
    const job = this.options.proxy.startJob();
    const context = await browser.newContext({
      proxy: { server: this.options.proxy.url, username: job.token, password: this.options.proxy.secret },
      userAgent: this.options.userAgent,
      serviceWorkers: 'block',
      acceptDownloads: false,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });

    try {
      await context.route('**/*', (route) =>
        SKIPPED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
      );
      const page = await context.newPage();

      let response;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs });
      } catch (err) {
        throw this.toFetchError(err, job.blocked());
      }
      if (!response) throw new FetchError('browser', 'The browser did not get a response for the page', { retryable: true });

      const status = response.status();
      if (status >= 400) {
        if (status === 403 && job.blocked().length > 0) {
          throw new FetchError('unsafe_url', 'The page redirected to a private or internal address');
        }
        throw new FetchError('http_status', describeStatus(status), { status, retryable: isRetryableStatus(status) });
      }
      const contentType = response.headers()['content-type'];
      if (!isSupportedContentType(contentType)) {
        throw new FetchError('unsupported_content', `This URL returns ${contentType?.split(';')[0]}, not a web page`);
      }

      await page.waitForLoadState('networkidle', { timeout: this.settleMs }).catch(() => undefined);
      const body = await page.content();
      const bytes = Buffer.byteLength(body);
      if (bytes > this.maxBytes) {
        throw new FetchError('too_large', `The page is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
      }
      const blocked = job.blocked();
      if (blocked.length > 0) this.options.logger.info({ blocked }, 'Page tried to reach blocked addresses (those requests were refused)');

      return { finalUrl: page.url(), status, contentType, body, bytes };
    } finally {
      await context.close().catch(() => undefined);
      job.end();
    }
  }

  private toFetchError(err: unknown, blocked: string[]): FetchError {
    const message = err instanceof Error ? err.message : String(err);
    if (blocked.length > 0 && /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_ACCESS_DENIED/.test(message)) {
      return new FetchError('unsafe_url', 'The page redirected to a private or internal address', { cause: err });
    }
    if (err instanceof errors.TimeoutError) {
      return new FetchError('timeout', 'The page took too long to load in the browser', { retryable: true, cause: err });
    }
    if (/Download is starting/i.test(message)) {
      return new FetchError('unsupported_content', 'This URL starts a file download, not a web page', { cause: err });
    }
    if (/ERR_NAME_NOT_RESOLVED/.test(message)) {
      return new FetchError('dns', 'Could not find the website. Check the address.', { retryable: true, cause: err });
    }
    if (/ERR_CERT_|ERR_SSL/.test(message)) {
      return new FetchError('network', 'The site’s security certificate is not valid', { cause: err });
    }
    return new FetchError('browser', `The browser could not load the page (${message.split('\n')[0]})`, {
      retryable: true,
      cause: err,
    });
  }

  async close(): Promise<void> {
    const browser = this.browser ? await this.browser.catch(() => undefined) : undefined;
    await browser?.close().catch(() => undefined);
  }
}
