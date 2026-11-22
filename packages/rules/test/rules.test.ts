import { describe, expect, it } from 'vitest';
import { evaluateRules, fold, hasRules } from '../src/index';

const rules = (r: Partial<{ keywords: string[]; locations: string[]; excludeKeywords: string[] }>) => ({
  keywords: [],
  locations: [],
  excludeKeywords: [],
  ...r,
});

describe('evaluateRules', () => {
  it('matches everything when there are no rules', () => {
    expect(evaluateRules(rules({}), { title: 'Anything' })).toEqual({ matched: true, reasons: [], matchedTerms: [] });
    expect(hasRules(rules({}))).toBe(false);
  });

  it('requires ALL keywords, as substrings ("intern" matches "Internship")', () => {
    const r = rules({ keywords: ['intern', 'frontend'] });
    expect(evaluateRules(r, { title: 'Frontend Internship' }).matched).toBe(true);
    const miss = evaluateRules(r, { title: 'Backend Internship' });
    expect(miss.matched).toBe(false);
    expect(miss.reasons).toEqual(['Doesn’t mention “frontend”']);
    expect(miss.matchedTerms).toEqual(['intern']);
  });

  it('looks at title, text and fields', () => {
    const r = rules({ keywords: ['react'] });
    expect(evaluateRules(r, { title: 'Engineer', text: 'We use React and Node' }).matched).toBe(true);
    expect(evaluateRules(r, { title: 'Engineer', fields: { team: 'React platform' } }).matched).toBe(true);
  });

  it('is case-, accent- and spacing-insensitive', () => {
    expect(evaluateRules(rules({ keywords: ['sao paulo'] }), { title: 'Dev — São   Paulo' }).matched).toBe(true);
    expect(evaluateRules(rules({ keywords: ['MACHINE LEARNING'] }), { title: 'machine learning intern' }).matched).toBe(true);
    expect(fold('Ｆｕｌｌ‑time “Remote”')).toBe('full-time "remote"');
  });

  it('requires ANY location, preferring the location field when there is one', () => {
    const r = rules({ locations: ['Remote', 'Mumbai'] });
    expect(evaluateRules(r, { title: 'Dev', fields: { location: 'Mumbai, India' } }).matchedTerms).toEqual(['Mumbai']);
    // "remote" in the description does not make an office role match
    const office = evaluateRules(r, { title: 'Dev', text: 'Remote-friendly culture', fields: { location: 'Berlin' } });
    expect(office.matched).toBe(false);
    expect(office.reasons).toEqual(['Not in “Remote” or “Mumbai” (location: Berlin)']);
    // no location field: search everything
    expect(evaluateRules(r, { title: 'Dev (Remote)' }).matched).toBe(true);
  });

  it('drops items mentioning ANY excluded word', () => {
    const r = rules({ keywords: ['engineer'], excludeKeywords: ['senior', 'sr.'] });
    expect(evaluateRules(r, { title: 'Software Engineer' }).matched).toBe(true);
    const out = evaluateRules(r, { title: 'Sr. Software Engineer' });
    expect(out.matched).toBe(false);
    expect(out.reasons).toEqual(['Mentions excluded “sr.”']);
  });

  it('reports every reason at once', () => {
    const r = rules({ keywords: ['python'], locations: ['Remote'], excludeKeywords: ['senior'] });
    const out = evaluateRules(r, { title: 'Senior Java Developer', fields: { location: 'London' } });
    expect(out.reasons).toHaveLength(3);
  });

  it('ignores blank terms', () => {
    expect(evaluateRules(rules({ keywords: ['  '] }), { title: 'x' }).matched).toBe(false);
    expect(evaluateRules(rules({ excludeKeywords: [''] }), { title: 'x' }).matched).toBe(true);
  });
});
