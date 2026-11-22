/** Query parameters that only track where a click came from; they never change what the link points to. */
const TRACKING_PARAM = /^(utm_\w+|gclid|gbraid|wbraid|fbclid|msclkid|dclid|yclid|mc_[ce]id|_hs\w+|hsCtaTracking|igshid|ref|ref_src|referrer|source|trk|trackingId|tracking_id|refId|cmpid|_ga|_gl)$/i;

/**
 * A stable form of a link, used as the item's identity: absolute, lower-case host, no fragment,
 * no tracking parameters, sorted query, no trailing slash. Returns undefined for non-web links.
 */
export function canonicalUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel|data|blob):/i.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}
