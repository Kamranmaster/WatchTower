import { sha256, truncate, type DiffResult, type ExtractedItem, type Extraction } from '@monitorly/extraction';

/** Cap per check: a redesign that "changes" thousands of items must not flood the user. */
export const MAX_EVENTS_PER_CHECK = 100;

export interface EventDraft {
  eventType: 'new_item' | 'item_changed' | 'item_removed' | 'page_changed';
  title: string;
  description?: string;
  sourceUrl?: string;
  itemKey?: string;
  item?: unknown;
  previous?: unknown;
  changedFields?: string[];
  /**
   * Unique per monitor (database index). Derived only from what changed, never from when, so
   * re-processing the same check — or a later check seeing the same change — can't create a
   * second event.
   */
  fingerprint: string;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  location: 'Location',
  price: 'Price',
  availability: 'Availability',
  employmentType: 'Type',
  company: 'Company',
  text: 'Details',
};

function summary(item: ExtractedItem): string | undefined {
  const fields = Object.values(item.fields).filter(Boolean);
  if (fields.length > 0) return truncate(fields.join(' · '), 500);
  const extra = item.text.startsWith(item.title) ? item.text.slice(item.title.length).trim() : item.text;
  return extra ? truncate(extra, 500) : undefined;
}

function compact(item: ExtractedItem) {
  return { key: item.key, title: item.title, url: item.url, fields: item.fields, text: truncate(item.text, 1000), hash: item.hash };
}

export interface BuiltEvents {
  drafts: EventDraft[];
  counts: { added: number; updated: number; removed: number; pageChanged: boolean };
  truncated: boolean;
}

export function buildEvents(diff: DiffResult, after: Extraction, pageUrl: string): BuiltEvents {
  if (diff.kind !== 'changed') return { drafts: [], counts: { added: 0, updated: 0, removed: 0, pageChanged: false }, truncated: false };
  const counts = { added: diff.added.length, updated: diff.updated.length, removed: diff.removed.length, pageChanged: diff.pageChanged };

  if (diff.pageChanged) {
    const lines = diff.added.slice(0, 3).map((i) => `+ ${truncate(i.text, 200)}`);
    const removedLines = diff.removed.slice(0, 2).map((i) => `− ${truncate(i.text, 200)}`);
    const parts = [
      diff.added.length ? `${diff.added.length} new` : '',
      diff.removed.length ? `${diff.removed.length} removed` : '',
    ].filter(Boolean);
    return {
      drafts: [
        {
          eventType: 'page_changed',
          title: parts.length ? `The page changed (${parts.join(', ')} passages)` : 'The page changed',
          description: [...lines, ...removedLines].join('\n') || undefined,
          sourceUrl: pageUrl,
          fingerprint: sha256(`page:${after.contentHash}`),
        },
      ],
      counts,
      truncated: false,
    };
  }

  const drafts: EventDraft[] = [
    ...diff.added.map(
      (item): EventDraft => ({
        eventType: 'new_item',
        title: item.title,
        description: summary(item),
        sourceUrl: item.url ?? pageUrl,
        itemKey: item.key,
        item: compact(item),
        fingerprint: sha256(`new:${item.key}:${item.hash}`),
      }),
    ),
    ...diff.updated.map(
      ({ before, after: item, changed }): EventDraft => ({
        eventType: 'item_changed',
        title: item.title,
        description: truncate(
          changed
            .map((field) =>
              field === 'title'
                ? `Title: “${before.title}” → “${item.title}”`
                : field === 'text'
                  ? 'Details changed'
                  : `${FIELD_LABELS[field] ?? field}: ${before.fields[field] ?? '—'} → ${item.fields[field] ?? '—'}`,
            )
            .join('\n'),
          1000,
        ),
        sourceUrl: item.url ?? pageUrl,
        itemKey: item.key,
        item: compact(item),
        previous: compact(before),
        changedFields: changed,
        fingerprint: sha256(`changed:${item.key}:${item.hash}`),
      }),
    ),
    ...diff.removed.map(
      (item): EventDraft => ({
        eventType: 'item_removed',
        title: item.title,
        description: summary(item),
        sourceUrl: item.url ?? pageUrl,
        itemKey: item.key,
        previous: compact(item),
        fingerprint: sha256(`removed:${item.key}:${item.hash}`),
      }),
    ),
  ];
  return { drafts: drafts.slice(0, MAX_EVENTS_PER_CHECK), counts, truncated: drafts.length > MAX_EVENTS_PER_CHECK };
}
