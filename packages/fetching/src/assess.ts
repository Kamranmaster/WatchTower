import * as cheerio from 'cheerio';
import { isHtml } from './decode';

export interface ContentAssessment {
  usable: boolean;
  /** Visible text length after removing scripts/styles. */
  textLength: number;
  /** Why the content isn't usable (shown in logs and on the check). */
  reason?: string;
}

/** Below this much visible text, an HTML page is almost certainly rendered by JavaScript. */
export const MIN_TEXT_LENGTH = 200;
const NEEDS_JS = /(enable|turn on|requires?|need)\s+(your\s+)?javascript|javascript (is )?(required|disabled)/i;

/**
 * Decides whether an HTTP response is good enough, or whether "auto" mode should retry the page
 * in a real browser. Deliberately simple: little visible text, or the page says it needs JavaScript.
 */
export function assessContent(body: string, contentType?: string): ContentAssessment {
  if (!isHtml(contentType)) {
    const textLength = body.trim().length;
    return textLength > 0 ? { usable: true, textLength } : { usable: false, textLength, reason: 'The response is empty' };
  }

  const $ = cheerio.load(body);
  const noscript = $('noscript').text();
  $('script, style, noscript, template, svg, iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const textLength = text.length;

  if (textLength < 1000 && (NEEDS_JS.test(text) || NEEDS_JS.test(noscript))) {
    return { usable: false, textLength, reason: 'The page says it needs JavaScript' };
  }
  if (textLength < MIN_TEXT_LENGTH) {
    return { usable: false, textLength, reason: 'The page has almost no content without JavaScript' };
  }
  return { usable: true, textLength };
}
