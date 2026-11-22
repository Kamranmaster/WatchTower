import type { z } from 'zod';
import { errorsByPath } from './api';

/**
 * Runs one of the API's own request schemas (from @monitorly/contracts) in the browser, so
 * the form shows exactly the messages the server would, before anything is sent.
 * Returns {} when valid, else messages keyed by field path (see errorsByPath).
 */
export function validate(schema: z.ZodType, values: unknown): Record<string, string> {
  const result = schema.safeParse(values);
  if (result.success) return {};
  return errorsByPath(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
}

/** Same rule the API applies before its safety checks: a full http(s) URL. */
export function urlError(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return 'Website URL is required';
  if (!/^https?:\/\//i.test(value)) return 'Enter a full URL, including https://';
  try {
    const url = new URL(value);
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return 'Enter a full URL, e.g. https://careers.example.com/jobs';
  } catch {
    return 'That doesn’t look like a valid URL';
  }
  return undefined;
}

/** Moves focus to the first field marked invalid inside a form (after React has rendered the errors). */
export function focusFirstInvalid(form: HTMLFormElement | null): void {
  requestAnimationFrame(() => {
    const field = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
    field?.focus();
  });
}
