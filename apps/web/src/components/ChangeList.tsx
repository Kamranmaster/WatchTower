import { Link } from 'react-router';
import type { ChangeEventDto } from '@monitorly/contracts';
import { relativeTime } from '../lib/format';

const TYPE: Record<ChangeEventDto['eventType'], { label: string; className: string }> = {
  new_item: { label: 'New', className: 'bg-emerald-50 text-emerald-700' },
  item_changed: { label: 'Updated', className: 'bg-amber-50 text-amber-800' },
  item_removed: { label: 'Removed', className: 'bg-slate-100 text-slate-600' },
  page_changed: { label: 'Page changed', className: 'bg-indigo-50 text-indigo-700' },
};

/** Only link to http(s): event URLs come from third-party pages. */
const safeHref = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : undefined);

/** What the rules engine (and the AI review, if any) decided about this change. */
function Verdict({ event }: { event: ChangeEventDto }) {
  const { verdict, ai } = event;
  if (verdict === 'pending') {
    return <p className="mt-1 text-xs text-slate-400">{ai?.status === 'pending' ? 'AI is reviewing this change…' : 'Checking your filters…'}</p>;
  }
  if (verdict === 'filtered_out') {
    return <p className="mt-1 text-xs text-slate-500">Filtered out: {event.matchReasons.join('; ') || 'didn’t match your filters'}</p>;
  }
  if (verdict === 'not_relevant') {
    return <p className="mt-1 text-xs text-slate-500">Not relevant (AI){ai?.reason ? `: ${ai.reason}` : ''}</p>;
  }
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      <p className="font-medium text-emerald-700">
        Matched{event.matchedTerms.length > 0 ? ` · ${event.matchedTerms.join(', ')}` : ''}
      </p>
      {ai?.status === 'done' && ai.summary && <p className="text-slate-600">AI: {ai.summary}</p>}
      {ai && ai.status !== 'done' && ai.reason && <p className="text-slate-400">{ai.reason}</p>}
    </div>
  );
}

export function ChangeList({ events, showMonitor = false }: { events: ChangeEventDto[]; showMonitor?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100">
      {events.map((event) => {
        const type = TYPE[event.eventType];
        const href = safeHref(event.sourceUrl);
        const dimmed = event.verdict === 'filtered_out' || event.verdict === 'not_relevant';
        return (
          <li key={event.id} className={`flex gap-3 py-3 ${dimmed ? 'opacity-60' : ''}`}>
            <span className={`mt-0.5 h-fit shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${type.className}`}>{type.label}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={`font-medium hover:underline ${event.eventType === 'item_removed' ? 'text-slate-500 line-through' : 'text-slate-900'}`}
                  >
                    {event.title}
                  </a>
                ) : (
                  <span className="font-medium text-slate-900">{event.title}</span>
                )}
                {showMonitor && event.monitorName && (
                  <Link to={`/monitors/${event.monitorId}`} className="text-xs text-slate-500 hover:text-indigo-600">
                    {event.monitorName}
                  </Link>
                )}
              </div>
              {event.description && <p className="mt-0.5 whitespace-pre-line text-sm text-slate-600">{event.description}</p>}
              <Verdict event={event} />
            </div>
            <span className="shrink-0 text-xs text-slate-400" title={new Date(event.detectedAt).toLocaleString()}>
              {relativeTime(event.detectedAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
