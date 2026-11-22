/**
 * Turns response bytes into text using, in order: a UTF-8 byte-order mark, the Content-Type
 * charset, a <meta charset> / http-equiv tag near the top, then UTF-8.
 */
export function decodeBody(body: Buffer, contentType?: string): string {
  let charset: string | undefined;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) charset = 'utf-8';
  charset ??= /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    const head = body.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  if (charset && LATIN1_LABELS.has(charset.toLowerCase())) return decodeWindows1252(body);
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    // Unknown label: fall back rather than fail the check.
    return new TextDecoder('utf-8').decode(body);
  }
}

/**
 * Per the WHATWG Encoding standard (what browsers do), all of these mean windows-1252.
 * Node's TextDecoder decodes them as strict ISO-8859-1 instead, turning “smart quotes” and €
 * into invisible control characters, so we decode them ourselves.
 */
const LATIN1_LABELS = new Set(['windows-1252', 'cp1252', 'x-cp1252', 'iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'us-ascii', 'ascii']);
// Bytes 0x80–0x9F in windows-1252 (undefined positions stay as-is).
const CP1252_HIGH = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8DŽ\x8F\x90‘’“”•–—˜™š›œ\x9DžŸ';

function decodeWindows1252(body: Buffer): string {
  let out = '';
  for (const byte of body) {
    out += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte);
  }
  return out;
}

/** Media types we monitor. Anything else (PDF, images, archives…) is rejected. */
const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml)\b)/i;

export function isSupportedContentType(contentType: string | undefined): boolean {
  if (!contentType) return true; // many servers omit it for HTML
  return TEXTUAL.test(contentType.trim());
}

export function isHtml(contentType: string | undefined): boolean {
  return !contentType || /html/i.test(contentType);
}
