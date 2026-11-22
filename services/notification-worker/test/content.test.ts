import { describe, expect, it, vi } from 'vitest';
import { emailContent, notificationText, safeHttpUrl } from '../src/content';
import { MailError, createResendMailer } from '../src/mailer';

const links = { monitorUrl: 'https://app.test/monitors/1', settingsUrl: 'https://app.test/monitors/1/edit' };

describe('notification text', () => {
  it('labels the change and prefers the AI summary', () => {
    expect(notificationText({ eventType: 'new_item', title: 'Dev', aiSummary: 'New Dev role', description: 'Remote', monitorName: 'M' })).toEqual({
      title: 'New: Dev',
      message: 'New Dev role',
    });
    expect(notificationText({ eventType: 'item_removed', title: 'Dev', description: 'Remote', monitorName: 'M' })).toEqual({
      title: 'Removed: Dev',
      message: 'Remote',
    });
    expect(notificationText({ eventType: 'page_changed', title: 'The page changed', monitorName: 'Docs' }).title).toBe('Docs: the page changed');
  });

  it('keeps titles on one line and within limits', () => {
    const n = notificationText({ eventType: 'new_item', title: `A\r\nB ${'x'.repeat(400)}`, monitorName: 'M' });
    expect(n.title).not.toMatch(/[\r\n]/);
    expect(n.title.length).toBeLessThanOrEqual(200);
  });
});

describe('email content', () => {
  const hostile = {
    eventType: 'new_item' as const,
    title: '<script>alert(1)</script>',
    sourceUrl: 'javascript:alert(1)',
    monitorName: 'Jobs" onmouseover="x',
  };

  it('escapes page text and never links to non-http URLs', () => {
    const n = notificationText(hostile);
    const email = emailContent(hostile, n, links);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('javascript:');
    expect(email.html).not.toContain('" onmouseover="');
    expect(email.text).not.toContain('javascript:');
  });

  it('has a header-safe subject and an opt-out link', () => {
    const src = { eventType: 'new_item' as const, title: 'Dev\r\nBcc: victim@example.com', sourceUrl: 'https://x.test/1', monitorName: 'M' };
    const email = emailContent(src, notificationText(src), links);
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).toContain('href="https://app.test/monitors/1/edit"');
    expect(email.text).toContain('View it: https://x.test/1');
  });

  it('safeHttpUrl', () => {
    expect(safeHttpUrl('https://a.test/x?y=1')).toBe('https://a.test/x?y=1');
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});

describe('Resend mailer', () => {
  const email = { to: 'u@example.com', subject: 's', text: 't', html: '<p>h</p>', idempotencyKey: 'notification-1' };

  it('posts with the idempotency key and returns the id', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    const result = await createResendMailer('re_key', 'Monitorly <a@b.test>', fetchFn as unknown as typeof fetch).send(email);
    expect(result.id).toBe('abc');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('notification-1');
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ['u@example.com'], from: 'Monitorly <a@b.test>' });
  });

  it.each([
    [422, true],
    [401, true],
    [429, false],
    [500, false],
  ])('HTTP %i → permanent: %s', async (status, permanent) => {
    const fetchFn = async () => new Response(JSON.stringify({ name: 'error', message: 'nope' }), { status });
    const err = await createResendMailer('k', 'f', fetchFn as unknown as typeof fetch).send(email).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.permanent).toBe(permanent);
  });
});
