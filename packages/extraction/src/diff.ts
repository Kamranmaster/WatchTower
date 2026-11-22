import type { Extraction, ExtractedItem } from './extract';
import { stableText } from './normalize';

export interface ItemChange {
  before: ExtractedItem;
  after: ExtractedItem;
  /** Which parts differ: "title", "text", or a field name such as "location". */
  changed: string[];
}

export type DiffResult =
  | { kind: 'unchanged' }
  /**
   * The new extraction lost most items at once. That is far more often a broken page load,
   * an A/B test or a redesign than a mass removal, so nothing is reported and the old
   * baseline is kept.
   */
  | { kind: 'incomplete'; reason: string }
  | { kind: 'changed'; added: ExtractedItem[]; removed: ExtractedItem[]; updated: ItemChange[]; pageChanged: boolean };

export interface DiffOptions {
  /** A drop to below this share of the previous item count is treated as incomplete… */
  minRetainedShare?: number;
  /** …but only when the previous page had at least this many items. */
  minItemsForGuard?: number;
}

export function diffExtractions(before: Extraction, after: Extraction, options: DiffOptions = {}): DiffResult {
  const { minRetainedShare = 0.5, minItemsForGuard = 5 } = options;
  if (before.contentHash === after.contentHash) return { kind: 'unchanged' };

  const pageLevel = (e: Extraction) => e.strategy === 'blocks' || e.strategy === 'none';
  // Page-level content (no records found): a single "page changed" result.
  if (pageLevel(before) && pageLevel(after)) {
    if (stableText(after.pageText).length === 0 && stableText(before.pageText).length > 0) {
      return { kind: 'incomplete', reason: 'The page came back empty' };
    }
    const beforeKeys = new Set(before.items.map((i) => i.key));
    const afterKeys = new Set(after.items.map((i) => i.key));
    return {
      kind: 'changed',
      added: after.items.filter((i) => !beforeKeys.has(i.key)),
      removed: before.items.filter((i) => !afterKeys.has(i.key)),
      updated: [],
      pageChanged: true,
    };
  }

  // Records on one side, page text on the other (e.g. the last job was taken down and the page now
  // says "No open positions"): compare records only, so page text never shows up as "new items".
  const beforeItems = pageLevel(before) ? [] : before.items;
  const afterItems = pageLevel(after) ? [] : after.items;

  if (beforeItems.length >= minItemsForGuard && afterItems.length < beforeItems.length * minRetainedShare) {
    return {
      kind: 'incomplete',
      reason: `Found ${afterItems.length} items where there were ${beforeItems.length}; the page may not have loaded fully`,
    };
  }

  const previous = new Map(beforeItems.map((i) => [i.key, i]));
  const current = new Map(afterItems.map((i) => [i.key, i]));
  let added: ExtractedItem[] = [];
  const updated: ItemChange[] = [];
  for (const item of afterItems) {
    const old = previous.get(item.key);
    if (!old) added.push(item);
    else if (old.hash !== item.hash) updated.push({ before: old, after: item, changed: changedParts(old, item) });
  }
  let removed = beforeItems.filter((i) => !current.has(i.key));

  // Second chance for links whose query string changes on every load (session tokens, cache
  // busters): same title and same path is the same item. Only unambiguous pairs are matched.
  if (added.length > 0 && removed.length > 0) {
    const loose = (i: ExtractedItem) => `${stableText(i.title)}|${i.url ? pathOf(i.url) : ''}`;
    const unique = (items: ExtractedItem[]) => {
      const counts = new Map<string, number>();
      for (const i of items) counts.set(loose(i), (counts.get(loose(i)) ?? 0) + 1);
      return new Map(items.filter((i) => counts.get(loose(i)) === 1).map((i) => [loose(i), i]));
    };
    const removedByLoose = unique(removed);
    const addedByLoose = unique(added);
    const matched = new Set<ExtractedItem>();
    for (const [key, item] of addedByLoose) {
      const old = removedByLoose.get(key);
      if (!old) continue;
      matched.add(item).add(old);
      if (old.hash !== item.hash) updated.push({ before: old, after: item, changed: changedParts(old, item) });
    }
    added = added.filter((i) => !matched.has(i));
    removed = removed.filter((i) => !matched.has(i));
  }

  if (added.length + removed.length + updated.length === 0) return { kind: 'unchanged' };
  return { kind: 'changed', added, removed, updated, pageChanged: false };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function changedParts(a: ExtractedItem, b: ExtractedItem): string[] {
  const parts: string[] = [];
  if (stableText(a.title) !== stableText(b.title)) parts.push('title');
  for (const key of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
    if (stableText(a.fields[key] ?? '') !== stableText(b.fields[key] ?? '')) parts.push(key);
  }
  if (parts.length === 0) parts.push('text');
  return parts;
}
