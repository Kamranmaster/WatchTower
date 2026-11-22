import type { MonitorRules } from '@monitorly/contracts';

/**
 * The rules engine. Pure functions over validated data: rules are never code.
 *
 * Semantics (shared with the AI prompt that writes the rules, packages/ai/src/prompt.ts):
 *  - matching is case-, accent- and spacing-insensitive SUBSTRING matching, so "intern" also
 *    matches "Internship";
 *  - keywords: the item must mention ALL of them;
 *  - locations: the item must mention AT LEAST ONE of them (ignored when empty). When the item
 *    has a location field, only that field counts, so "Remote" in a job's description doesn't make
 *    an office role match;
 *  - excludeKeywords: the item is dropped if it mentions ANY of them;
 *  - every list empty: everything matches.
 */

export interface RuleTarget {
  title: string;
  /** Everything else that describes the item (body text, change description…). */
  text?: string;
  fields?: Record<string, string>;
}

export interface RuleResult {
  matched: boolean;
  /** Why it was filtered out (empty when matched). Shown to the user. */
  reasons: string[];
  /** Keywords and locations that were found. */
  matchedTerms: string[];
}

/** Lowercase, accents removed, quotes/dashes unified, whitespace collapsed. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‘’‚′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const quote = (term: string) => `“${term}”`;

export function evaluateRules(rules: MonitorRules, target: RuleTarget): RuleResult {
  const fields = target.fields ?? {};
  const haystack = fold([target.title, target.text ?? '', ...Object.values(fields)].join(' \n '));
  const contains = (text: string, term: string) => {
    const needle = fold(term);
    return needle.length > 0 && text.includes(needle);
  };

  const reasons: string[] = [];
  const matchedTerms: string[] = [];

  for (const keyword of rules.keywords) {
    if (contains(haystack, keyword)) matchedTerms.push(keyword);
    else reasons.push(`Doesn’t mention ${quote(keyword)}`);
  }

  if (rules.locations.length > 0) {
    const locationText = fields.location ? fold(fields.location) : haystack;
    const found = rules.locations.filter((loc) => contains(locationText, loc));
    if (found.length > 0) matchedTerms.push(...found);
    else {
      const where = fields.location ? ` (location: ${fields.location})` : '';
      reasons.push(`Not in ${rules.locations.map(quote).join(' or ')}${where}`);
    }
  }

  const excluded = rules.excludeKeywords.filter((term) => contains(haystack, term));
  if (excluded.length > 0) reasons.push(`Mentions excluded ${excluded.map(quote).join(', ')}`);

  return { matched: reasons.length === 0, reasons, matchedTerms };
}

export function hasRules(rules: MonitorRules): boolean {
  return rules.keywords.length + rules.locations.length + rules.excludeKeywords.length > 0;
}
