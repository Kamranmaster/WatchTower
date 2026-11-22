import { describe, expect, it } from 'vitest';
import { canonicalUrl, diffExtractions, extractItems, normalizeText, stableText } from '../src';
import { JOBS, articlePage, cardsPage, jsonLdJobsPage, listPage, productPage, tablePage } from './fixtures';

const BASE = 'https://careers.example.com/careers';
const jobs = (html: string) => extractItems(html, { baseUrl: BASE, monitorType: 'job_listing' });

describe('normalization', () => {
  it('normalizes whitespace, Unicode and typography consistently', () => {
    expect(normalizeText('  Ｓｏｆｔｗａｒｅ Engineer​ –  “Intern”\n\t')).toBe('Software Engineer - "Intern"');
  });

  it('removes volatile fragments for comparison', () => {
    expect(stableText('Posted 2 days ago')).toBe(stableText('Posted 5 days ago'));
    expect(stableText('Backend Intern · 1,204 applicants')).toBe(stableText('Backend Intern · 1,377 applicants'));
    expect(stableText('Updated at 10:42 AM')).toBe(stableText('Updated at 3:07 PM'));
    expect(stableText('Backend Intern')).not.toBe(stableText('Frontend Intern'));
  });

  it('canonicalizes links: absolute, no tracking, no fragment, sorted query, no trailing slash', () => {
    expect(canonicalUrl('/Jobs/42/?utm_source=x&b=2&a=1&gclid=z#apply', 'https://Careers.Example.com/x')).toBe(
      'https://careers.example.com/Jobs/42?a=1&b=2',
    );
    expect(canonicalUrl('javascript:void(0)', BASE)).toBeUndefined();
    expect(canonicalUrl('#top', BASE)).toBeUndefined();
    expect(canonicalUrl('mailto:jobs@example.com', BASE)).toBeUndefined();
  });
});

describe('extractItems', () => {
  it('extracts job cards with title, canonical link and location', () => {
    const result = jobs(cardsPage(JOBS));
    expect(result.strategy).toBe('repeated');
    expect(result.items.map((i) => i.title)).toEqual(['Software Engineer', 'Data Analyst', 'Product Designer']);
    expect(result.items[0]).toMatchObject({
      url: 'https://careers.example.com/jobs/software-engineer',
      key: 'url:https://careers.example.com/jobs/software-engineer',
      fields: { location: 'Bangalore, India' },
    });
  });

  it('ignores navigation, footer and cookie banners', () => {
    const titles = jobs(cardsPage(JOBS)).items.map((i) => i.title).join(' ');
    expect(titles).not.toMatch(/About us|Privacy|cookies/i);
  });

  it('extracts a plain list of links', () => {
    const result = jobs(listPage(['Backend Engineer Intern', 'Frontend Engineer Intern', 'QA Engineer Intern']));
    expect(result.items).toHaveLength(3);
    expect(result.items[2]!.url).toBe('https://careers.example.com/jobs?id=QA+Engineer+Intern');
  });

  it('extracts table rows, using titles as identity when there are no links', () => {
    const result = jobs(tablePage([['ML Intern', 'Pune'], ['Data Intern', 'Delhi'], ['Ops Intern', 'Mumbai']]));
    expect(result.items.map((i) => i.title)).toEqual(['ML Intern Pune', 'Data Intern Delhi', 'Ops Intern Mumbai']);
    expect(result.items[0]!.key).toBe('title:ml intern pune');
  });

  it('prefers schema.org JobPosting data when present (even on JavaScript-rendered pages)', () => {
    const result = jobs(jsonLdJobsPage([{ title: 'SWE Intern', id: 'R-1', city: 'Hyderabad' }, { title: 'PM Intern', id: 'R-2', city: 'Pune' }]));
    expect(result.strategy).toBe('json-ld');
    expect(result.items[0]).toMatchObject({
      key: 'id:R-1',
      title: 'SWE Intern',
      url: 'https://careers.example.com/jobs/R-1',
      fields: { location: 'Hyderabad, IN', employmentType: 'INTERN', company: 'Acme' },
    });
  });

  it('reads product price and availability from schema.org Product', () => {
    const result = extractItems(productPage('OutOfStock', '54990'), { baseUrl: 'https://shop.example.com/', monitorType: 'product_availability' });
    expect(result.items[0]).toMatchObject({ key: 'id:PS5-PRO-1TB', fields: { price: '54990 INR', availability: 'OutOfStock' } });
  });

  it('"any change" monitors compare page text blocks', () => {
    const result = extractItems(articlePage(['Version 2.1 adds dark mode to the dashboard.', 'Bug fixes for exports and imports.']), {
      baseUrl: BASE,
      monitorType: 'generic',
    });
    expect(result.strategy).toBe('blocks');
    expect(result.items.map((i) => i.title)).toContain('Version 2.1 adds dark mode to the dashboard.');
  });

  it('keeps duplicate titles apart with stable keys', () => {
    const result = jobs(tablePage([['Intern', 'Pune'], ['Intern', 'Pune'], ['Analyst', 'Delhi']]));
    expect(result.items.map((i) => i.key)).toEqual(['title:intern pune', 'title:intern pune#2', 'title:analyst delhi']);
  });

  it('does not use a link shared by every item as identity', () => {
    const html = `<main><ul>${['Alpha role here', 'Beta role here', 'Gamma role here'].map((t) => `<li>${t} <a href="/apply">Apply</a></li>`).join('')}</ul></main>`;
    expect(jobs(html).items.every((i) => i.key.startsWith('title:'))).toBe(true);
  });
});

describe('stable fingerprints', () => {
  it('the same content gives the same ids, hashes and page hash on every load', () => {
    const a = jobs(cardsPage(JOBS)); // the inline script has a random nonce each time
    const b = jobs(cardsPage(JOBS));
    expect(b.items.map((i) => [i.id, i.hash])).toEqual(a.items.map((i) => [i.id, i.hash]));
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('ignores tracking parameters, volatile dates and whitespace', () => {
    const a = jobs(cardsPage(JOBS));
    const b = jobs(cardsPage(JOBS.map((j) => ({ ...j, posted: '9 days ago' })), '?utm_campaign=spring').replace(/>\s+</g, '>\n\n   <'));
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('page text that only differs in a timestamp is unchanged', () => {
    const p = ['Version 2.1 adds dark mode to the dashboard.'];
    const a = extractItems(articlePage(p, '10:42 AM'), { baseUrl: BASE, monitorType: 'generic' });
    const b = extractItems(articlePage(p, '4:15 PM'), { baseUrl: BASE, monitorType: 'generic' });
    expect(b.contentHash).toBe(a.contentHash);
  });
});

describe('diffExtractions', () => {
  const NEW_JOB = { title: 'Backend Engineer Intern', slug: 'backend-intern', location: 'Bangalore, India' };

  it('an unchanged page produces no changes', () => {
    expect(diffExtractions(jobs(cardsPage(JOBS)), jobs(cardsPage(JOBS)))).toEqual({ kind: 'unchanged' });
  });

  it('detects a new item (the roadmap example)', () => {
    const result = diffExtractions(jobs(cardsPage(JOBS)), jobs(cardsPage([...JOBS, NEW_JOB])));
    expect(result.kind).toBe('changed');
    if (result.kind !== 'changed') return;
    expect(result.added.map((i) => i.title)).toEqual(['Backend Engineer Intern']);
    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('detects an updated item (same link, new location) and says what changed', () => {
    const moved = JOBS.map((j) => (j.slug === 'data-analyst' ? { ...j, location: 'Mumbai, India' } : j));
    const result = diffExtractions(jobs(cardsPage(JOBS)), jobs(cardsPage(moved)));
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.added).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toMatchObject({ changed: ['location'], before: { fields: { location: 'Remote' } }, after: { fields: { location: 'Mumbai, India' } } });
  });

  it('a renamed item with the same link is an update, not remove + add', () => {
    const renamed = JOBS.map((j) => (j.slug === 'software-engineer' ? { ...j, title: 'Senior Software Engineer' } : j));
    const result = diffExtractions(jobs(cardsPage(JOBS)), jobs(cardsPage(renamed)));
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.updated[0]!.changed).toEqual(['title']);
    expect(result.added).toEqual([]);
  });

  /** The second check reuses the template learned on the first, as the processing worker does. */
  const next = (before: ReturnType<typeof jobs>, html: string) =>
    extractItems(html, { baseUrl: BASE, monitorType: 'job_listing', template: before.template });

  it('detects a removed item', () => {
    const before = jobs(cardsPage(JOBS));
    const result = diffExtractions(before, next(before, cardsPage(JOBS.slice(0, 2))));
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.removed.map((i) => i.title)).toEqual(['Product Designer']);
    expect(result.added).toEqual([]);
  });

  it('the learned template still finds records when only one is left', () => {
    const before = jobs(cardsPage(JOBS));
    expect(before.template).toEqual({ container: 'div.jobs', item: 'div.job-card' });
    const after = next(before, cardsPage(JOBS.slice(0, 1)));
    expect(after.items.map((i) => i.title)).toEqual(['Software Engineer']);
  });

  it('when the last records disappear, they are reported as removed (not page text as new items)', () => {
    const before = jobs(cardsPage(JOBS.slice(0, 2)));
    const emptyHtml = cardsPage([]).replace(
      '<h1>Open positions</h1>',
      '<h1>Open positions</h1><p>There are no open positions right now, check back soon.</p>',
    );
    const result = diffExtractions(before, next(before, emptyHtml));
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.removed).toHaveLength(2);
    expect(result.added).toEqual([]);
  });

  it('a list of two linked items is detected even without a template', () => {
    expect(jobs(cardsPage(JOBS.slice(0, 2))).items).toHaveLength(2);
  });

  it('does not report mass removals when most items vanish at once (likely a broken load)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `Role number ${i}`, slug: `role-${i}`, location: 'Remote' }));
    const result = diffExtractions(jobs(cardsPage(many)), jobs(cardsPage(many.slice(0, 2))));
    expect(result.kind).toBe('incomplete');
  });

  it('links whose token changes on every load are still the same items (found live on a sign-in page)', () => {
    const page = (token: string) =>
      `<main><ul>${['Forgot your email address?', 'Create a new account', 'Learn more about privacy'].map((t, i) => `<li><a href="/help/${i}?continue=x&token=${token}${i}">${t}</a></li>`).join('')}</ul></main>`;
    expect(diffExtractions(jobs(page('a8f3k2')), jobs(page('zz91qq')))).toEqual({ kind: 'unchanged' });
  });

  it('…but a genuinely new link with a token is still reported as new', () => {
    const page = (titles: string[], token: string) =>
      `<main><ul>${titles.map((t, i) => `<li><a href="/jobs/${i}?session=${token}">${t}</a></li>`).join('')}</ul></main>`;
    const result = diffExtractions(
      jobs(page(['Backend developer role', 'Frontend developer role'], 'one')),
      jobs(page(['Backend developer role', 'Frontend developer role', 'Mobile developer role'], 'two')),
    );
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.added.map((i) => i.title)).toEqual(['Mobile developer role']);
    expect(result.removed).toEqual([]);
  });

  it('"any change" pages report a single page change', () => {
    const a = extractItems(articlePage(['Version 2.1 adds dark mode to the dashboard.']), { baseUrl: BASE, monitorType: 'generic' });
    const b = extractItems(articlePage(['Version 2.1 adds dark mode to the dashboard.', 'Version 2.2 adds CSV export for all reports.']), {
      baseUrl: BASE,
      monitorType: 'generic',
    });
    const result = diffExtractions(a, b);
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.pageChanged).toBe(true);
    expect(result.added.map((i) => i.title)).toEqual(['Version 2.2 adds CSV export for all reports.']);
  });

  it('product availability changes are detected as an update', () => {
    const opts = { baseUrl: 'https://shop.example.com/', monitorType: 'product_availability' as const };
    const result = diffExtractions(extractItems(productPage('OutOfStock', '54990'), opts), extractItems(productPage('InStock', '54990'), opts));
    if (result.kind !== 'changed') throw new Error(result.kind);
    expect(result.updated[0]!.changed).toEqual(['availability']);
  });
});
