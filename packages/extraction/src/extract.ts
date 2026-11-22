import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { normalizeText, sha256, shortHash, stableText, truncate } from './normalize';
import { canonicalUrl } from './url';

export type MonitorKind = 'job_listing' | 'product_availability' | 'generic';
export type ExtractionStrategy = 'json-ld' | 'repeated' | 'links' | 'blocks' | 'none';

export interface ExtractedItem {
  /** Stable identity within the page: canonical link if it has one, else its title. */
  key: string;
  /** Hash of the key: the item's fingerprint. */
  id: string;
  title: string;
  url?: string;
  /** Normalized visible text of the item (capped). */
  text: string;
  /** Structured details when known: location, price, availability… */
  fields: Record<string, string>;
  /** Hash of the item's stable content: changes when the item is edited. */
  hash: string;
}

/**
 * Where the records were found: the container's and items' tag+class signatures. Saved with the
 * baseline and passed to the next extraction, so the same records are found again even when the
 * list shrinks to one or two entries (too few to detect from scratch).
 */
export interface ExtractionTemplate {
  container: string;
  item: string;
}

export interface Extraction {
  strategy: ExtractionStrategy;
  template?: ExtractionTemplate;
  items: ExtractedItem[];
  /** Hash of everything meaningful on the page: equal hashes ⇒ no change. */
  contentHash: string;
  /** Normalized main text (capped), for page-level comparison and summaries. */
  pageText: string;
}

const MAX_ITEMS = 500;
const MAX_ITEM_TEXT = 1000;
const MAX_PAGE_TEXT = 100_000;

/** Everything that is never content. */
const NOISE = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'link', 'meta', 'object', 'embed',
  'nav', 'header', 'footer', 'aside', 'form[role="search"]', 'dialog',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]', '[role="dialog"]', '[role="alertdialog"]',
  '[aria-hidden="true"]', '[hidden]',
].join(',');
const NOISE_NAME = /(^|[\s_-])(cookie|consent|gdpr|onetrust|newsletter|subscribe|breadcrumbs?|pagination|pager|skip-link|sr-only|visually-hidden)([\s_-]|$)/i;
/** Classes that mark state rather than kind; ignored when grouping similar elements. */
const STATE_CLASS = /^(active|selected|current|open|closed|odd|even|first|last|hidden|visible|show|is-.+|has-.+|js-.+|ng-.+|css-[a-z0-9]+|sc-[a-zA-Z0-9]+|[a-z]+-[a-f0-9]{5,})$/;

export function extractItems(
  html: string,
  options: { baseUrl: string; monitorType: MonitorKind; template?: ExtractionTemplate },
): Extraction {
  const $ = cheerio.load(html);
  const { baseUrl, monitorType } = options;

  // Structured data first (before scripts are removed): the most reliable source when present.
  const fromJsonLd = monitorType === 'generic' ? [] : extractJsonLd($, baseUrl, monitorType);

  $(NOISE).remove();
  $('[id],[class]').each((_, el) => {
    const $el = $(el);
    if (NOISE_NAME.test(`${$el.attr('id') ?? ''} ${$el.attr('class') ?? ''}`)) $el.remove();
  });

  const root = pickRoot($);
  const pageText = truncate(normalizeText(blockText($, root)), MAX_PAGE_TEXT);

  let strategy: ExtractionStrategy = 'none';
  let template: ExtractionTemplate | undefined;
  let raw: RawItem[] = [];
  if (fromJsonLd.length > 0) {
    strategy = 'json-ld';
    raw = fromJsonLd;
  } else if (monitorType !== 'generic') {
    const repeated =
      (options.template && extractWithTemplate($, root, baseUrl, options.template)) ?? extractRepeated($, root, baseUrl);
    if (repeated) {
      strategy = 'repeated';
      raw = repeated.items;
      template = repeated.template;
    } else {
      raw = extractLinks($, root, baseUrl);
      if (raw.length > 0) strategy = 'links';
    }
  }
  if (raw.length === 0) {
    raw = extractBlocks($, root);
    if (raw.length > 0) strategy = 'blocks';
  }

  const items = finalize(raw.slice(0, MAX_ITEMS));
  const contentHash =
    strategy === 'blocks' || strategy === 'none'
      ? sha256(`page:${stableText(pageText)}`)
      : sha256(
          items
            .map((i) => `${i.id}:${i.hash}`)
            .sort()
            .join('\n'),
        );
  return { strategy, template, items, contentHash, pageText };
}

// ---------------------------------------------------------------- Shared
interface RawItem {
  title: string;
  url?: string;
  text: string;
  fields: Record<string, string>;
  /** Identifier from structured data, if any. */
  identifier?: string;
}

function pickRoot($: cheerio.CheerioAPI) {
  for (const selector of ['main', '[role="main"]', '#main', '#content', '.main-content', 'article']) {
    const candidate = $(selector).first();
    if (candidate.length && normalizeText(candidate.text()).length > 50) return candidate;
  }
  return $('body').length ? $('body') : $.root();
}

/** Text with block boundaries kept as spaces (cheerio's .text() glues "<li>a</li><li>b</li>" into "ab"). */
function blockText($: cheerio.CheerioAPI, node: cheerio.Cheerio<AnyNode>): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === 'text') parts.push((n as unknown as { data: string }).data);
    else if ('children' in n && n.children) {
      const el = n as Element;
      const block = /^(p|div|li|ul|ol|tr|td|th|h[1-6]|br|section|article|dt|dd|table|tbody|header|footer|span)$/i.test(el.name ?? '');
      if (block) parts.push(' ');
      for (const child of el.children) walk(child);
      if (block) parts.push(' ');
    }
  };
  node.each((_, el) => walk(el));
  return parts.join('');
}

/** Gives each item a stable key and its content hash. Duplicate keys get an occurrence suffix. */
function finalize(raw: RawItem[]): ExtractedItem[] {
  const urlCounts = new Map<string, number>();
  for (const item of raw) if (item.url) urlCounts.set(item.url, (urlCounts.get(item.url) ?? 0) + 1);

  const seen = new Map<string, number>();
  return raw.map((item) => {
    const title = truncate(normalizeText(item.title), 300);
    const text = truncate(normalizeText(item.text), MAX_ITEM_TEXT);
    let base: string;
    if (item.identifier) base = `id:${item.identifier}`;
    // A link is the best identity, unless several items share it (e.g. all link to "/apply").
    else if (item.url && urlCounts.get(item.url) === 1) base = `url:${item.url}`;
    else base = `title:${stableText(title) || stableText(text).slice(0, 200)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;

    const fieldText = Object.keys(item.fields)
      .sort()
      .map((k) => `${k}=${stableText(item.fields[k]!)}`)
      .join(';');
    return {
      key,
      id: shortHash(key),
      title,
      url: item.url,
      text,
      fields: item.fields,
      hash: shortHash(`${stableText(title)}|${stableText(text)}|${fieldText}`),
    };
  });
}

// ---------------------------------------------------------------- JSON-LD (schema.org)
function extractJsonLd($: cheerio.CheerioAPI, baseUrl: string, monitorType: MonitorKind): RawItem[] {
  const wanted = monitorType === 'job_listing' ? 'JobPosting' : 'Product';
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['@graph']) visit(obj['@graph']);
      if (obj.itemListElement) visit(obj.itemListElement);
      if (obj.item) visit(obj.item);
      const type = obj['@type'];
      if (type === wanted || (Array.isArray(type) && type.includes(wanted))) nodes.push(obj);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {
      // Broken JSON-LD is common; ignore it.
    }
  });

  return nodes.flatMap((node): RawItem[] => {
    const title = str(node.title) ?? str(node.name);
    if (!title) return [];
    const fields: Record<string, string> = {};
    if (wanted === 'JobPosting') {
      const location = jobLocation(node);
      if (location) fields.location = location;
      const type = list(node.employmentType).join(', ');
      if (type) fields.employmentType = type;
      const org = str((node.hiringOrganization as Record<string, unknown> | undefined)?.name);
      if (org) fields.company = org;
    } else {
      const offer = list(node.offers)[0] as Record<string, unknown> | undefined;
      const price = str(offer?.price) ?? str((offer?.priceSpecification as Record<string, unknown> | undefined)?.price);
      if (price) fields.price = `${price}${offer?.priceCurrency ? ` ${str(offer.priceCurrency)}` : ''}`;
      const availability = str(offer?.availability)?.replace(/^https?:\/\/schema\.org\//i, '');
      if (availability) fields.availability = availability;
    }
    const identifier = str((node.identifier as Record<string, unknown> | undefined)?.value) ?? str(node.identifier) ?? str(node.sku);
    const description = str(node.description) ?? '';
    return [
      {
        title,
        url: canonicalUrl(str(node.url) ?? str((list(node.offers)[0] as Record<string, unknown> | undefined)?.url), baseUrl),
        // Descriptions can be long HTML; keep a short, tag-free version.
        text: [title, ...Object.values(fields), cheerio.load(description).text().slice(0, 300)].join(' · '),
        fields,
        identifier: identifier ? normalizeText(identifier) : undefined,
      },
    ];
  });
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function list(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function jobLocation(node: Record<string, unknown>): string | undefined {
  if (list(node.jobLocationType).some((t) => /TELECOMMUTE/i.test(String(t)))) return 'Remote';
  const places = list(node.jobLocation).map((loc) => {
    const address = (loc as Record<string, unknown>)?.address as Record<string, unknown> | string | undefined;
    if (typeof address === 'string') return address;
    return [address?.addressLocality, address?.addressRegion, address?.addressCountry]
      .map((v) => (typeof v === 'object' ? str((v as Record<string, unknown>)?.name) : str(v)))
      .filter(Boolean)
      .join(', ');
  });
  return places.filter(Boolean).join(' / ') || undefined;
}

// ---------------------------------------------------------------- Repeated structure (lists, cards, table rows)
function signature(el: Element): string {
  const classes = (el.attribs?.class ?? '')
    .split(/\s+/)
    .filter((c) => c && !STATE_CLASS.test(c))
    .sort()
    .join('.');
  return `${el.name}.${classes}`;
}

/**
 * Finds the container whose children look most like a list of records: many siblings with the
 * same tag and classes, with a reasonable amount of text, ideally each with a link.
 */
function extractRepeated(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  baseUrl: string,
): { items: RawItem[]; template: ExtractionTemplate } | undefined {
  let best: { score: number; elements: Element[]; container: Element } | undefined;

  root.find('*').addBack().each((_, container) => {
    const children = (container as Element).children?.filter((c): c is Element => c.type === 'tag') ?? [];
    if (children.length < 2) return;
    const groups = new Map<string, Element[]>();
    for (const child of children) {
      const sig = signature(child);
      groups.set(sig, [...(groups.get(sig) ?? []), child]);
    }
    for (const elements of groups.values()) {
      if (elements.length < 2) continue;
      const texts = elements.map((e) => normalizeText(blockText($, $(e))));
      const nonEmpty = texts.filter((t) => t.length >= 3);
      const withLinks = elements.filter((e) => $(e).find('a[href]').length > 0 || e.name === 'a').length / elements.length;
      // Two similar entries are a list only if each has its own link; otherwise ask for three.
      if (nonEmpty.length < (withLinks === 1 ? 2 : 3)) continue;
      const avgLen = nonEmpty.reduce((s, t) => s + t.length, 0) / nonEmpty.length;
      if (avgLen < 8 || avgLen > 3000) continue; // icon rows / whole sections
      const score = elements.length * Math.min(avgLen, 200) * (0.4 + withLinks);
      if (!best || score > best.score) best = { score, elements, container: container as Element };
    }
  });

  if (!best) return undefined;
  return {
    items: toRawItems($, best.elements, baseUrl),
    template: { container: signature(best.container), item: signature(best.elements[0]!) },
  };
}

/** Finds records with the template learned from the baseline: any number, even one. */
function extractWithTemplate(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  baseUrl: string,
  template: ExtractionTemplate,
): { items: RawItem[]; template: ExtractionTemplate } | undefined {
  const elements: Element[] = [];
  root.find('*').addBack().each((_, container) => {
    if (container.type !== 'tag' || signature(container as Element) !== template.container) return;
    for (const child of (container as Element).children ?? []) {
      if (child.type === 'tag' && signature(child as Element) === template.item) elements.push(child as Element);
    }
  });
  if (elements.length === 0) return undefined;
  const items = toRawItems($, elements, baseUrl);
  return items.length > 0 ? { items, template } : undefined;
}

function toRawItems($: cheerio.CheerioAPI, elements: Element[], baseUrl: string): RawItem[] {
  return elements.flatMap((el): RawItem[] => {
    const $el = $(el);
    const text = blockText($, $el);
    if (normalizeText(text).length < 3) return [];
    const heading = $el.find('h1,h2,h3,h4,h5,h6,[class*="title" i],[itemprop="title"],[itemprop="name"]').first();
    const anchor = el.name === 'a' ? $el : $el.find('a[href]').first();
    const title = normalizeText(heading.text()) || normalizeText(anchor.text()) || normalizeText(text).slice(0, 120);
    const fields: Record<string, string> = {};
    for (const [name, selector] of [
      ['location', '[class*="location" i],[itemprop="jobLocation"],[data-testid*="location" i]'],
      ['price', '[class*="price" i],[itemprop="price"]'],
      ['availability', '[class*="stock" i],[class*="availability" i],[itemprop="availability"]'],
    ] as const) {
      const value = normalizeText($el.find(selector).first().text());
      if (value) fields[name] = truncate(value, 200);
    }
    return [{ title, url: canonicalUrl(anchor.attr('href'), baseUrl), text, fields }];
  });
}

// ---------------------------------------------------------------- Fallbacks
/** Content links with meaningful text (when there's no repeated structure). */
function extractLinks($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, baseUrl: string): RawItem[] {
  const seen = new Set<string>();
  const items: RawItem[] = [];
  root.find('a[href]').each((_, a) => {
    const text = normalizeText($(a).text());
    const url = canonicalUrl($(a).attr('href'), baseUrl);
    if (!url || text.length < 10 || text.split(' ').length < 2 || seen.has(url)) return;
    seen.add(url);
    items.push({ title: text, url, text, fields: {} });
  });
  return items.length >= 3 ? items : [];
}

/** Headings, paragraphs and list entries: used for "any change" monitors and pages without records. */
function extractBlocks($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): RawItem[] {
  const items: RawItem[] = [];
  root.find('h1,h2,h3,h4,h5,h6,p,li,td,dd,blockquote').each((_, el) => {
    // Skip containers whose text is already covered by a nested block.
    if ($(el).find('p,li,td,dd').length > 0) return;
    const text = normalizeText(blockText($, $(el)));
    if (text.length >= 20) items.push({ title: truncate(text, 160), text, fields: {} });
  });
  return items;
}
