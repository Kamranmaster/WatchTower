import { Link } from 'react-router';
import type { ChangeEventDto } from '@monitorly/contracts';
import { relativeTime } from '../lib/format';
import { Time, cx } from './ui';

const TYPE: Record<ChangeEventDto['eventType'], { label: string; className: string }> = {
  new_item: { label: 'New', className: 'bg-emerald-50 text-emerald-800' },
  item_changed: { label: 'Updated', className: 'bg-amber-50 text-amber-900' },
  item_removed: { label: 'Removed', className: 'bg-slate-100 text-slate-700' },
  page_changed: { label: 'Page changed', className: 'bg-indigo-50 text-indigo-800' },
};

/** Only link to http(s): event URLs come from third-party pages. */
const safeHref = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : undefined);

export const changeAnchor = (id: string) => `change-${id}`;

/** What the rules engine (and the AI review, if any) decided about this change. */
function Verdict({ event }: { event: ChangeEventDto }) {
  const { verdict, ai } = event;
  if (verdict === 'pending') {
    return <p className="mt-1 text-xs text-slate-500">{ai?.status === 'pending' ? 'AI is reviewing this change…' : 'Checking your filters…'}</p>;
  }
  if (verdict === 'filtered_out') {
    return (
      <p className="mt-1 text-xs text-slate-600">
        <span className="font-medium">No alert</span> · filtered out: {event.matchReasons.join('; ') || 'didn’t match your filters'}
      </p>
    );
  }
  if (verdict === 'not_relevant') {
    return (
      <p className="mt-1 text-xs text-slate-600">
        <span className="font-medium">No alert</span> · AI judged it not relevant{ai?.reason ? `: ${ai.reason}` : ''}
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      <p className="font-medium text-emerald-800">
        <span aria-hidden="true">✓ </span>Alerted{event.matchedTerms.length > 0 ? ` · matched ${event.matchedTerms.join(', ')}` : ''}
      </p>
      {ai?.status === 'done' && ai.summary && <p className="text-slate-700">AI summary: {ai.summary}</p>}
      {ai && ai.status !== 'done' && ai.reason && <p className="text-slate-500">{ai.reason}</p>}
    </div>
  );
}

export function ChangeList({
  events,
  showMonitor = false,
  highlightId,
}: {
  events: ChangeEventDto[];
  showMonitor?: boolean;
  /** A change to point out (opened from a notification). */
  highlightId?: string;
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {events.map((event) => {
        const type = TYPE[event.eventType];
        const href = safeHref(event.sourceUrl);
        const noAlert = event.verdict === 'filtered_out' || event.verdict === 'not_relevant';
        const highlighted = event.id === highlightId;
        return (
          <li
            key={event.id}
            id={changeAnchor(event.id)}
            tabIndex={highlighted ? -1 : undefined}
            className={cx(
              'flex scroll-mt-24 gap-3 py-3',
              highlighted && '-mx-2 rounded-lg bg-indigo-50 px-2 ring-2 ring-indigo-300',
            )}
          >
            <span
              className={cx(
                'mt-0.5 h-fit shrink-0 rounded-md px-2 py-0.5 text-xs font-medium',
                noAlert ? 'bg-slate-100 text-slate-600' : type.className,
              )}
            >
              {type.label}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={cx(
                      'break-words font-medium hover:underline',
                      event.eventType === 'item_removed' ? 'text-slate-600 line-through' : noAlert ? 'text-slate-700' : 'text-slate-900',
                    )}
                  >
                    {event.title}
                    <span className="sr-only"> (opens the page in a new tab)</span>
                  </a>
                ) : (
                  <span className={cx('break-words font-medium', noAlert ? 'text-slate-700' : 'text-slate-900')}>{event.title}</span>
                )}
                {showMonitor && event.monitorName && (
                  <Link to={`/monitors/${event.monitorId}`} className="text-xs text-slate-500 hover:text-indigo-700">
                    {event.monitorName}
                  </Link>
                )}
              </div>
              {event.description && <p className="mt-0.5 whitespace-pre-line break-words text-sm text-slate-600">{event.description}</p>}
              <Verdict event={event} />
            </div>
            <Time iso={event.detectedAt} className="shrink-0 text-xs text-slate-500">
              {relativeTime(event.detectedAt)}
            </Time>
          </li>
        );
      })}
    </ul>
  );
}
