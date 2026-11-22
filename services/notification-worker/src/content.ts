/**
 * What a notification says, in the app and by email. Titles, descriptions and URLs come from
 * third-party pages: everything is escaped for HTML, header-safe in the subject, and only
 * http(s) links are ever rendered.
 */

export type ChangeType = 'new_item' | 'item_changed' | 'item_removed' | 'page_changed';

export interface NotificationSource {
  eventType: ChangeType;
  title: string;
  description?: string | null;
  sourceUrl?: string | null;
  aiSummary?: string | null;
  monitorName: string;
}

const LABEL: Record<ChangeType, string> = {
  new_item: 'New',
  item_changed: 'Updated',
  item_removed: 'Removed',
  page_changed: 'Page changed',
};

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function notificationText(src: NotificationSource): { title: string; message: string } {
  const title = cut(oneLine(src.eventType === 'page_changed' ? `${src.monitorName}: the page changed` : `${LABEL[src.eventType]}: ${src.title}`), 200);
  // The AI's one-liner reads best; otherwise the change description (e.g. "Location: A → B").
  const message = cut((src.aiSummary || src.description || src.title || '').trim(), 2000) || title;
  return { title, message };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface EmailLinks {
  /** The monitor's page in the app. */
  monitorUrl: string;
  /** Where to turn email alerts off for this monitor. */
  settingsUrl: string;
}

export function emailContent(src: NotificationSource, n: { title: string; message: string }, links: EmailLinks): EmailContent {
  const source = safeHttpUrl(src.sourceUrl);
  // No CR/LF in a header, whatever the page contained.
  const subject = cut(oneLine(`${src.monitorName} · ${n.title}`), 150);
  const footer = `You get this email because email alerts are on for “${src.monitorName}”. Turn them off: ${links.settingsUrl}`;

  const text = [n.title, '', n.message, '', source ? `View it: ${source}` : '', `Open in Monitorly: ${links.monitorUrl}`, '', '—', footer]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <p style="margin:0 0 16px;font-size:13px;color:#64748b">${e(src.monitorName)}</p>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px">
    <h1 style="margin:0 0 8px;font-size:18px;line-height:1.4">${e(n.title)}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#334155;white-space:pre-line">${e(n.message)}</p>
    ${source ? `<a href="${e(source)}" style="display:inline-block;margin-right:12px;padding:8px 14px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">View it</a>` : ''}
    <a href="${e(links.monitorUrl)}" style="display:inline-block;padding:8px 14px;border:1px solid #cbd5e1;color:#0f172a;border-radius:8px;text-decoration:none;font-size:14px">Open in Monitorly</a>
  </div>
  <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">You get this email because email alerts are on for “${e(src.monitorName)}”. <a href="${e(links.settingsUrl)}" style="color:#64748b">Turn them off</a>.</p>
</div>
</body></html>`;

  return { subject, text, html };
}
