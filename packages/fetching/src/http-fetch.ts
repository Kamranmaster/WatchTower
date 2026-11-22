import http from 'node:http';
import https from 'node:https';
import axios, { AxiosError, type AxiosResponse } from 'axios';
import { UNSAFE_ADDRESS_CODE, UnsafeUrlError, createSafeLookup, parsePublicUrl, type UrlPolicy } from '@monitorly/url-safety';
import { decodeBody, isSupportedContentType } from './decode';
import { FetchError, describeStatus, isRetryableStatus } from './errors';

/** Override with FETCH_USER_AGENT, e.g. to add a contact URL: "MonitorlyBot/1.0 (+https://your-site/bot)". */
export const USER_AGENT = 'MonitorlyBot/1.0';

export interface HttpFetchOptions {
  /** Deadline for the whole fetch, including redirects. */
  timeoutMs?: number;
  /** Max decoded response size (decompression counts, so gzip bombs are stopped too). */
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
  /** Tests only: lets a local test server through. Production uses the strict defaults. */
  policy?: UrlPolicy;
  signal?: AbortSignal;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  body: string;
  /** Decoded size in bytes. */
  bytes: number;
  redirects: string[];
}

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5';

/** Agents whose DNS lookup refuses private addresses at connect time (one pair per policy). */
const agentCache = new WeakMap<UrlPolicy, { httpAgent: http.Agent; httpsAgent: https.Agent }>();
const DEFAULT_POLICY: UrlPolicy = {};

function agentsFor(policy: UrlPolicy) {
  let agents = agentCache.get(policy);
  if (!agents) {
    const lookup = createSafeLookup(policy) as unknown as http.AgentOptions['lookup'];
    agents = {
      httpAgent: new http.Agent({ lookup, keepAlive: false }),
      httpsAgent: new https.Agent({ lookup, keepAlive: false }),
    };
    agentCache.set(policy, agents);
  }
  return agents;
}

/**
 * SSRF-safe GET.
 *  - Scheme, host and port rules on the URL and on every redirect target (redirects are followed
 *    here, one hop at a time, never automatically).
 *  - DNS checked at connect time by the agents' lookup, so rebinding can't sneak in.
 *  - No proxies from the environment, a total deadline, and a size cap.
 * Throws FetchError for every failure.
 */
export async function httpFetch(rawUrl: string, options: HttpFetchOptions = {}): Promise<FetchedPage> {
  const {
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 5,
    userAgent = USER_AGENT,
    accept = DEFAULT_ACCEPT,
    policy = DEFAULT_POLICY,
  } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const { httpAgent, httpsAgent } = agentsFor(policy);

  const redirects: string[] = [];
  let url = checkUrl(rawUrl, policy, false);

  for (;;) {
    let res: AxiosResponse<ArrayBuffer>;
    try {
      res = await axios.request<ArrayBuffer>({
        url: url.href,
        method: 'GET',
        responseType: 'arraybuffer',
        maxRedirects: 0, // we follow redirects ourselves, re-checking each target
        maxContentLength: maxBytes,
        decompress: true,
        proxy: false, // never route through an HTTP(S)_PROXY from the environment
        validateStatus: () => true,
        timeout: timeoutMs,
        signal,
        httpAgent,
        httpsAgent,
        headers: {
          'User-Agent': userAgent,
          Accept: accept,
          'Accept-Language': 'en-US,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        transitional: { clarifyTimeoutError: true },
      });
    } catch (err) {
      throw toFetchError(err, deadline, maxBytes, url);
    }

    const location = res.headers.location as string | undefined;
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects.length >= maxRedirects) {
        throw new FetchError('too_many_redirects', `The page redirected more than ${maxRedirects} times`);
      }
      redirects.push(url.href);
      url = checkUrl(new URL(location, url).href, policy, true);
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new FetchError('http_status', describeStatus(res.status), {
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }

    const contentType = res.headers['content-type'] as string | undefined;
    if (!isSupportedContentType(contentType)) {
      throw new FetchError('unsupported_content', `This URL returns ${contentType?.split(';')[0]}, not a web page`);
    }
    const buffer = Buffer.from(res.data);
    return {
      requestedUrl: rawUrl,
      finalUrl: url.href,
      status: res.status,
      contentType,
      body: decodeBody(buffer, contentType),
      bytes: buffer.length,
      redirects,
    };
  }
}

function checkUrl(raw: string, policy: UrlPolicy, isRedirect: boolean): URL {
  try {
    return parsePublicUrl(raw, policy);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new FetchError(
        'unsafe_url',
        isRedirect ? `The page redirected to a blocked address: ${err.message}` : err.message,
        { cause: err },
      );
    }
    throw err;
  }
}

const TLS_CODE = /^(CERT_|ERR_TLS|ERR_SSL|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY))/;

function toFetchError(err: unknown, deadline: AbortSignal, maxBytes: number, url: URL): FetchError {
  if (err instanceof FetchError) return err;
  const ax = err instanceof AxiosError ? err : undefined;
  const code = ax?.code ?? (err as NodeJS.ErrnoException | undefined)?.code;
  const causeCode = (ax?.cause as NodeJS.ErrnoException | undefined)?.code;

  if (code === UNSAFE_ADDRESS_CODE || causeCode === UNSAFE_ADDRESS_CODE || ax?.cause instanceof UnsafeUrlError) {
    return new FetchError('unsafe_url', `${url.hostname} resolves to a private or internal network address`, { cause: err });
  }
  if (ax?.message.includes('maxContentLength')) {
    return new FetchError('too_large', `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, { cause: err });
  }
  if (deadline.aborted || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return new FetchError('timeout', 'The site took too long to respond', { retryable: true, cause: err });
  }
  if (code === 'ERR_CANCELED') {
    return new FetchError('network', 'The fetch was cancelled', { retryable: true, cause: err });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || causeCode === 'ENOTFOUND') {
    return new FetchError('dns', `Could not find ${url.hostname}. Check the address.`, { retryable: true, cause: err });
  }
  if (code && TLS_CODE.test(code)) {
    return new FetchError('network', `The site's security certificate is not valid (${code})`, { cause: err });
  }
  return new FetchError('network', `Could not connect to ${url.hostname}${code ? ` (${code})` : ''}`, {
    retryable: true,
    cause: err,
  });
}
