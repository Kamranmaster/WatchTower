const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "in 5 minutes", "3 hours ago", "now". */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never';
  const diff = Date.parse(iso) - now;
  if (Math.abs(diff) < 60_000) return diff >= 0 ? 'Due now' : 'Just now';
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 60_000), 'minute');
}

export function formatInterval(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes === 60) return 'Every hour';
  if (minutes < 1440) return `Every ${minutes / 60} hours`;
  return 'Once a day';
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** "software engineer, intern" → ["software engineer", "intern"] */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const MONITOR_TYPE_LABELS = {
  job_listing: 'Job listings',
  product_availability: 'Product availability',
  generic: 'Any page change',
} as const;

export const FETCH_MODE_LABELS = {
  auto: 'Automatic (recommended)',
  http: 'Simple (fast, no JavaScript)',
  browser: 'Full browser (JavaScript sites)',
} as const;

const ITEM_NOUNS = {
  job_listing: 'new job listings',
  product_availability: 'new or restocked products',
  generic: 'new content on the page',
} as const;

const andList = new Intl.ListFormat('en', { type: 'conjunction' });
const orList = new Intl.ListFormat('en', { type: 'disjunction' });
const quote = (s: string) => `“${s}”`;

/**
 * Plain-English description of exactly what the filters do (built from the rules, not from
 * the AI, so it always matches what the rules engine will apply).
 */
export function describeRules(
  monitorType: keyof typeof ITEM_NOUNS,
  rules: { keywords: string[]; locations: string[]; excludeKeywords: string[] },
): string {
  const { keywords, locations, excludeKeywords } = rules;
  let text = `You’ll be alerted about ${keywords.length + locations.length + excludeKeywords.length === 0 ? 'all ' : ''}${ITEM_NOUNS[monitorType]}`;
  if (keywords.length) text += ` that mention ${andList.format(keywords.map(quote))}`;
  if (locations.length) text += `${keywords.length ? ',' : ''} in ${orList.format(locations)}`;
  if (excludeKeywords.length) text += `, unless they mention ${orList.format(excludeKeywords.map(quote))}`;
  return `${text}.`;
}
