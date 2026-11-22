import { createHash } from 'node:crypto';

/** Zero-width and other invisible characters that differ between renders. */
const INVISIBLE = /[​-‍⁠﻿­]/g;

/**
 * Display normalization: Unicode NFKC (full-width → ASCII, ligatures…), invisible characters
 * removed, typographic quotes/dashes unified, whitespace collapsed.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text that changes on every visit without the content changing. Removed before hashing so
 * "Posted 2 days ago" → "Posted 3 days ago" is not reported as an update.
 */
const VOLATILE: RegExp[] = [
  /\b(about\s+)?(\d+|an?|one|a few)\s*\+?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?)\s+ago\b/gi,
  /\b(just now|moments? ago|today|yesterday|this (morning|afternoon|evening))\b/gi,
  /\b(posted|updated|published|reposted|active|refreshed)\s*:?\s*(on\s+)?$/gi,
  /\b\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?\b/gi,
  /\b[\d,.]+\s*\+?\s*(views?|applicants?|applications?|clicks?|reviews?|ratings?|comments?|likes?|watchers?|people (are )?(viewing|looking))\b/gi,
  /\b(new|hot|trending|featured|promoted|sponsored)!?$/gi,
];

/** Normalized and lower-cased with volatile fragments removed: what hashes and comparisons use. */
export function stableText(text: string): string {
  let out = normalizeText(text).toLowerCase();
  for (const pattern of VOLATILE) out = out.replace(pattern, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Short hash for identities (collision-safe enough per monitor, compact in the database). */
export function shortHash(value: string): string {
  return sha256(value).slice(0, 32);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
