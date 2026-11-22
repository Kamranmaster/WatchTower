import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router';
import type { MonitorDto } from '@monitorly/contracts';
import { useMe } from '../hooks/useAuth';
import { useMonitors, useRecentEvents, useSetMonitorPaused } from '../hooks/useMonitors';
import { useNotifications } from '../hooks/useNotifications';
import { usePageTitle } from '../hooks/usePageTitle';
import { ChangeList } from '../components/ChangeList';
import { useToast } from '../components/Toasts';
import { formatInterval, hostOf, nextCheckText, relativeTime } from '../lib/format';
import { Button, ButtonLink, Card, EmptyState, ErrorState, FilterTabs, ListSkeleton, Skeleton, StatusBadge, Time, cx } from '../components/ui';

type StatusFilter = 'all' | MonitorDto['status'];

const nextCheckTime = (m: MonitorDto) => (m.status === 'active' ? Date.parse(m.nextCheckAt) : Number.MAX_SAFE_INTEGER);
type Sort = 'newest' | 'name' | 'changed' | 'next';

const SORTS: Record<Sort, { label: string; compare: (a: MonitorDto, b: MonitorDto) => number }> = {
  newest: { label: 'Newest first', compare: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) },
  name: { label: 'Name', compare: (a, b) => a.name.localeCompare(b.name) },
  changed: {
    label: 'Last change',
    compare: (a, b) => (b.lastChangeAt ? Date.parse(b.lastChangeAt) : 0) - (a.lastChangeAt ? Date.parse(a.lastChangeAt) : 0),
  },
  next: {
    label: 'Next check',
    // Paused and failing monitors aren't checked: they go last.
    compare: (a, b) => nextCheckTime(a) - nextCheckTime(b),
  },
};

export function DashboardPage() {
  usePageTitle('Dashboard');
  const { data: user } = useMe();
  const monitors = useMonitors();
  const firstName = user?.name.split(' ')[0];

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{firstName ? `Hi ${firstName}` : 'Dashboard'}</h1>
          <p className="text-slate-600">Here’s what Monitorly is watching for you.</p>
        </div>
        {/* On larger screens the header has this button. */}
        {monitors.data && monitors.data.length > 0 && (
          <ButtonLink to="/monitors/new" className="sm:hidden">
            + New monitor
          </ButtonLink>
        )}
      </div>

      {monitors.isPending ? (
        <DashboardSkeleton />
      ) : monitors.isError ? (
        <ErrorState title="Couldn’t load your monitors" error={monitors.error} onRetry={() => monitors.refetch()} retrying={monitors.isFetching} />
      ) : monitors.data.length === 0 ? (
        <Onboarding />
      ) : (
        <>
          <Stats monitors={monitors.data} />
          <NeedsAttention monitors={monitors.data} />
          <RecentMatches />
          <MonitorList monitors={monitors.data} />
        </>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading your monitors…</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-48" />
    </div>
  );
}

function Stats({ monitors }: { monitors: MonitorDto[] }) {
  const notifications = useNotifications();
  const count = (status: MonitorDto['status']) => monitors.filter((m) => m.status === status).length;
  const failing = count('error');
  const nextUp = monitors.filter((m) => m.status === 'active').sort((a, b) => nextCheckTime(a) - nextCheckTime(b))[0];
  const unread = notifications.data?.unreadCount;

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
      <Stat label="Active monitors" value={count('active')} detail={count('paused') ? `${count('paused')} paused` : `of ${monitors.length}`} />
      <Stat
        label="Unread alerts"
        value={unread ?? '—'}
        detail={
          <Link to="/notifications" className="font-medium text-indigo-700 hover:underline">
            View alerts
          </Link>
        }
      />
      <Stat label="Failing" value={failing} tone={failing > 0 ? 'bad' : undefined} detail={failing > 0 ? 'See below' : 'All checks OK'} />
      <Stat
        label="Next check"
        value={nextUp ? nextCheckText(nextUp.nextCheckAt) : '—'}
        detail={nextUp ? <span className="block truncate">{nextUp.name}</span> : 'No active monitors'}
        small
      />
    </dl>
  );
}

function Stat({
  label,
  value,
  detail,
  tone,
  small,
}: {
  label: string;
  value: number | string;
  detail?: React.ReactNode;
  tone?: 'bad';
  small?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className={cx('mt-1 font-semibold tracking-tight', small ? 'text-lg' : 'text-3xl', tone === 'bad' && 'text-red-700')}>{value}</dd>
      {detail && <dd className="mt-0.5 text-xs text-slate-500">{detail}</dd>}
    </div>
  );
}

/** Failing monitors, up front, with what went wrong. */
function NeedsAttention({ monitors }: { monitors: MonitorDto[] }) {
  const failing = monitors.filter((m) => m.status === 'error');
  if (failing.length === 0) return null;
  return (
    <Card className="border-red-200" aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="text-base font-semibold text-red-800">
        Needs attention
      </h2>
      <p className="text-sm text-slate-600">
        Checks stopped after failing several times in a row. Open a monitor to see what went wrong (switching how the page is loaded often
        helps), then retry.
      </p>
      <ul className="mt-3 divide-y divide-red-100">
        {failing.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
            <Link to={`/monitors/${m.id}`} className="font-medium text-slate-900 hover:underline">
              {m.name}
            </Link>
            <span className="min-w-0 flex-1 truncate text-sm text-red-700">{m.lastError ?? 'Checks are failing'}</span>
            <PauseResumeButton monitor={m} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RecentMatches() {
  const events = useRecentEvents(5, true);
  return (
    <Card aria-labelledby="matches-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="matches-heading" className="text-base font-semibold">
          Recent alerts
        </h2>
        <Link to="/notifications" className="text-sm font-medium text-indigo-700 hover:underline">
          All notifications
        </Link>
      </div>
      {events.isPending ? (
        <ListSkeleton rows={2} label="recent alerts" />
      ) : events.isError ? (
        <div className="mt-3">
          <ErrorState compact title="Couldn’t load recent alerts" error={events.error} onRetry={() => events.refetch()} retrying={events.isFetching} />
        </div>
      ) : events.data.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">
          Nothing has matched your filters yet. When something does, it shows up here and in the bell. Every change, including filtered ones, is
          on each monitor’s page.
        </p>
      ) : (
        <div className="mt-1">
          <ChangeList events={events.data} showMonitor />
        </div>
      )}
    </Card>
  );
}

function MonitorList({ monitors }: { monitors: MonitorDto[] }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const query = useDeferredValue(search.trim().toLowerCase());

  const count = (s: MonitorDto['status']) => monitors.filter((m) => m.status === s).length;
  const visible = monitors
    .filter((m) => status === 'all' || m.status === status)
    .filter((m) => !query || [m.name, m.url, m.instruction].some((text) => text.toLowerCase().includes(query)))
    .sort(SORTS[sort].compare);
  const filtered = status !== 'all' || query !== '';

  return (
    <Card padding="none" aria-labelledby="monitors-heading">
      <div className="space-y-3 border-b border-slate-100 p-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="monitors-heading" className="text-base font-semibold">
            Your monitors <span className="text-sm font-normal text-slate-500">({monitors.length})</span>
          </h2>
          <FilterTabs
            label="Show monitors"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: monitors.length },
              { value: 'active', label: 'Active', count: count('active') },
              { value: 'paused', label: 'Paused', count: count('paused') },
              { value: 'error', label: 'Failing', count: count('error') },
            ]}
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">Search monitors</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, website or description"
              className="block w-full rounded-lg border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-600 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-lg border-0 py-2 pl-3 pr-8 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-600 focus:outline-none"
            >
              {Object.entries(SORTS).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {filtered ? `${visible.length} of ${monitors.length} monitors shown` : ''}
      </p>
      {visible.length === 0 ? (
        <EmptyState
          title="No monitors match"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setStatus('all');
                setSearch('');
              }}
            >
              Clear filters
            </Button>
          }
        >
          {query ? `Nothing matches “${search.trim()}”` : 'No monitors have this status right now.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {visible.map((monitor) => (
            <MonitorRow key={monitor.id} monitor={monitor} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Pause an active monitor; resume a paused one; retry a failing one (resuming clears the error). */
function PauseResumeButton({ monitor }: { monitor: MonitorDto }) {
  const setPaused = useSetMonitorPaused();
  const toast = useToast();
  const active = monitor.status === 'active';
  const label = active ? 'Pause' : monitor.status === 'paused' ? 'Resume' : 'Retry';
  const toggle = () =>
    setPaused.mutate(
      { id: monitor.id, paused: active },
      {
        onSuccess: () => toast.success(active ? `Paused “${monitor.name}”.` : `${label === 'Retry' ? 'Retrying' : 'Resumed'} “${monitor.name}”. Checking it now.`),
        onError: (err) => toast.error(err, `Couldn’t ${label.toLowerCase()} “${monitor.name}”`),
      },
    );
  return (
    <Button variant="secondary" loading={setPaused.isPending} onClick={toggle} aria-label={`${label} ${monitor.name}`}>
      {label}
    </Button>
  );
}

function MonitorRow({ monitor }: { monitor: MonitorDto }) {
  return (
    <li className="flex items-start gap-3 px-4 py-4 hover:bg-slate-50 sm:items-center sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/monitors/${monitor.id}`}
            className="truncate font-medium text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-600"
          >
            {monitor.name}
          </Link>
          <StatusBadge status={monitor.status} />
        </div>
        <p className="mt-0.5 truncate text-sm text-slate-600">
          {hostOf(monitor.url)} · {monitor.instruction}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
          <span>{formatInterval(monitor.checkIntervalMinutes)}</span>
          <span>
            {monitor.lastCheckedAt ? (
              <>
                Checked <Time iso={monitor.lastCheckedAt}>{relativeTime(monitor.lastCheckedAt)}</Time>
              </>
            ) : (
              'Not checked yet'
            )}
          </span>
          {monitor.lastChangeAt && (
            <span className="text-emerald-800">
              Changed <Time iso={monitor.lastChangeAt}>{relativeTime(monitor.lastChangeAt)}</Time>
            </span>
          )}
          {monitor.status === 'error' && monitor.lastError && <span className="max-w-full truncate text-red-700">{monitor.lastError}</span>}
        </p>
      </div>
      <PauseResumeButton monitor={monitor} />
    </li>
  );
}

function Onboarding() {
  const steps = [
    ['Pick a page', 'The exact page to watch, like a careers or product page.'],
    ['Say what you’re waiting for', 'In your own words. We turn it into filters you can check.'],
    ['Get alerted', 'In the app, live, and by email if you like. Only for changes that match.'],
  ];
  return (
    <Card className="text-center">
      <h2 className="text-lg font-semibold">Set up your first monitor</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
        Monitorly checks websites for you and tells you when the thing you’re waiting for shows up: a job opening, a product back in stock.
      </p>
      <ol className="mx-auto mt-6 grid max-w-3xl gap-4 text-left sm:grid-cols-3">
        {steps.map(([title, text], i) => (
          <li key={title} className="rounded-lg bg-slate-50 p-4">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-indigo-600 text-sm font-semibold text-white">
              {i + 1}
            </span>
            <p className="mt-2 font-medium text-slate-900">{title}</p>
            <p className="text-sm text-slate-600">{text}</p>
          </li>
        ))}
      </ol>
      <ButtonLink to="/monitors/new" className="mt-6">
        Create your first monitor
      </ButtonLink>
    </Card>
  );
}
