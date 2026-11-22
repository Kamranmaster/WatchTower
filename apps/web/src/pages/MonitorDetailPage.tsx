import { useEffect, useState, type ReactNode } from 'react';
import type { CheckRunDto, MonitorDto } from '@monitorly/contracts';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  useDeleteMonitor,
  useMonitor,
  useMonitorEvents,
  useMonitorRuns,
  useSetMonitorPaused,
  type EventFilter,
} from '../hooks/useMonitors';
import { usePageTitle } from '../hooks/usePageTitle';
import { ChangeList, changeAnchor } from '../components/ChangeList';
import { useToast } from '../components/Toasts';
import { ApiError } from '../lib/api';
import { FETCH_MODE_LABELS, MONITOR_TYPE_LABELS, describeRules, formatInterval, nextCheckText, relativeTime } from '../lib/format';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FilterTabs,
  ListSkeleton,
  LoadMore,
  Skeleton,
  StatusBadge,
  Time,
} from '../components/ui';

export function MonitorDetailPage() {
  const { id = '' } = useParams();
  const query = useMonitor(id);
  usePageTitle(query.data?.name ?? (query.isError ? 'Monitor' : undefined));

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-4">
        <BackLink />
        {missing ? (
          <Card className="py-10 text-center">
            <h1 className="text-xl font-bold tracking-tight">Monitor not found</h1>
            <p className="mt-1 text-sm text-slate-600">It may have been deleted, or the link is wrong.</p>
            <ButtonLink to="/" className="mt-5">
              Back to dashboard
            </ButtonLink>
          </Card>
        ) : (
          <>
            <h1 className="sr-only">Monitor</h1>
            <ErrorState title="Couldn’t load this monitor" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />
          </>
        )}
      </div>
    );
  }
  return <MonitorDetail monitor={query.data} />;
}

function BackLink() {
  return (
    <Link to="/" className="inline-block text-sm font-medium text-slate-600 hover:text-slate-900">
      <span aria-hidden="true">← </span>Dashboard
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading monitor…</span>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-1/2" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

function MonitorDetail({ monitor }: { monitor: MonitorDto }) {
  const navigate = useNavigate();
  const toast = useToast();
  const setPaused = useSetMonitorPaused();
  const remove = useDeleteMonitor();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const active = monitor.status === 'active';
  const pauseLabel = active ? 'Pause' : monitor.status === 'paused' ? 'Resume' : 'Retry now';
  const { keywords, locations, excludeKeywords } = monitor.rules;
  const hasRules = keywords.length + locations.length + excludeKeywords.length > 0;

  const togglePaused = () =>
    setPaused.mutate(
      { id: monitor.id, paused: active },
      {
        onSuccess: () => toast.success(active ? 'Monitor paused. No checks until you resume it.' : 'Checking it now.'),
        onError: (err) => toast.error(err, `Couldn’t ${active ? 'pause' : 'resume'} the monitor`),
      },
    );

  const onDelete = () =>
    remove.mutate(monitor.id, {
      onSuccess: () => {
        toast.success(`Deleted “${monitor.name}”.`);
        navigate('/', { replace: true });
      },
      onError: (err) => {
        setConfirmDelete(false);
        toast.error(err, 'Couldn’t delete the monitor');
      },
    });

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight">{monitor.name}</h1>
            <StatusBadge status={monitor.status} />
          </div>
          <a
            href={monitor.url}
            target="_blank"
            rel="noreferrer noopener"
            // relative: keeps the screen-reader-only text inside the clipped link (no sideways scroll).
            className="relative mt-1 block truncate text-sm text-indigo-700 hover:underline"
          >
            {monitor.url}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" loading={setPaused.isPending} onClick={togglePaused}>
            {pauseLabel}
          </Button>
          <ButtonLink variant="secondary" to={`/monitors/${monitor.id}/edit`}>
            Edit
          </ButtonLink>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

      {monitor.status === 'error' && (
        <Alert>
          <p className="font-medium">
            Checks stopped after {monitor.consecutiveFailures} failure{monitor.consecutiveFailures === 1 ? '' : 's'} in a row.
          </p>
          {monitor.lastError && <p className="mt-0.5">Last error: {monitor.lastError}</p>}
          <p className="mt-1">
            If the page needs JavaScript, try{' '}
            <Link to={`/monitors/${monitor.id}/edit`} className="font-medium underline">
              a full browser
            </Link>{' '}
            as the loading method. Then click “Retry now”.
          </p>
        </Alert>
      )}
      {monitor.status === 'paused' && <Alert tone="info">This monitor is paused. Resume it to start checking again.</Alert>}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <Info label="Next check">{active ? nextCheckText(monitor.nextCheckAt) : monitor.status === 'paused' ? 'Paused' : 'Stopped'}</Info>
        <Info label="Last checked">
          {monitor.lastCheckedAt ? <Time iso={monitor.lastCheckedAt}>{relativeTime(monitor.lastCheckedAt)}</Time> : 'Never'}
        </Info>
        <Info label="Frequency">{formatInterval(monitor.checkIntervalMinutes)}</Info>
        <Info label="Alerts">
          {[monitor.notifyInApp && 'In-app', monitor.notifyEmail && 'Email'].filter(Boolean).join(' + ') || 'Off'}
          {monitor.aiReview && <span className="block text-xs font-normal text-slate-500">AI-reviewed</span>}
        </Info>
      </dl>

      <Card className="space-y-4" aria-labelledby="watching-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="watching-heading" className="text-base font-semibold">
            What we’re watching for
          </h2>
          <Link to={`/monitors/${monitor.id}/edit`} className="text-sm font-medium text-indigo-700 hover:underline">
            Edit filters
          </Link>
        </div>
        <blockquote className="break-words border-l-4 border-indigo-200 pl-4 text-slate-700">{monitor.instruction}</blockquote>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-600">Page type</dt>
            <dd className="font-medium">{MONITOR_TYPE_LABELS[monitor.monitorType]}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Loading method</dt>
            <dd className="font-medium">
              {FETCH_MODE_LABELS[monitor.fetchMode]}
              {monitor.resolvedFetchMode && ` — using ${monitor.resolvedFetchMode === 'http' ? 'simple' : 'full browser'}`}
            </dd>
          </div>
        </dl>
        <p className="text-sm font-medium text-slate-800">{describeRules(monitor.monitorType, monitor.rules)}</p>
        {hasRules && (
          <dl className="space-y-2 text-sm">
            <RuleRow label="Must mention (all)" items={keywords} />
            <RuleRow label="Locations (any)" items={locations} />
            <RuleRow label="Ignore if it mentions (any)" items={excludeKeywords} exclude />
          </dl>
        )}
      </Card>

      <Changes monitor={monitor} />

      <CheckHistory monitorId={monitor.id} />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${monitor.name}”?`}
        confirmLabel="Delete monitor"
        pending={remove.isPending}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        Its change history and alerts are deleted too. This can’t be undone. To stop checks for a while instead, pause it.
      </ConfirmDialog>
    </div>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="mt-1 font-semibold">{children}</dd>
    </div>
  );
}

function RuleRow({ label, items, exclude }: { label: string; items: string[]; exclude?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <dt className="shrink-0 text-slate-600 sm:w-48">{label}</dt>
      <dd className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Chip key={item} tone={exclude ? 'exclude' : 'default'}>
            {item}
          </Chip>
        ))}
      </dd>
    </div>
  );
}

/** Points out the change a notification linked to (#change-<eventId>) once it's on screen. */
function useLinkedChange(loadedIds: string[]) {
  const { hash } = useLocation();
  const target = hash.startsWith('#change-') ? hash.slice('#change-'.length) : undefined;
  const found = target !== undefined && loadedIds.includes(target);
  useEffect(() => {
    if (!found || !target) return;
    const el = document.getElementById(changeAnchor(target));
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  }, [found, target]);
  return found ? target : undefined;
}

function Changes({ monitor }: { monitor: MonitorDto }) {
  const [filter, setFilter] = useState<EventFilter>('all');
  const events = useMonitorEvents(monitor.id, filter);
  const list = events.data?.pages.flatMap((p) => p.events) ?? [];
  const highlightId = useLinkedChange(list.map((e) => e.id));

  return (
    <Card aria-labelledby="changes-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="changes-heading" className="text-base font-semibold">
            Changes
          </h2>
          {monitor.itemCount != null && <p className="text-sm text-slate-600">{monitor.itemCount} items on the page at the last check</p>}
        </div>
        <FilterTabs
          label="Show changes"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All changes' },
            { value: 'matched', label: 'Alerts only' },
          ]}
        />
      </div>
      {events.isPending ? (
        <ListSkeleton label="changes" />
      ) : events.isError && list.length === 0 ? (
        <div className="mt-3">
          <ErrorState compact title="Couldn’t load changes" error={events.error} onRetry={() => events.refetch()} retrying={events.isFetching} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState title={filter === 'matched' ? 'No alerts yet' : 'No changes yet'}>
          {filter === 'matched'
            ? 'None of the changes so far matched your filters. Switch to “All changes” to see what was filtered out and why.'
            : monitor.hasBaseline
              ? 'We compare every check with the last one and list new, updated and removed items here.'
              : 'The first check saves the page as a baseline. Changes are detected from the next check on.'}
        </EmptyState>
      ) : (
        <>
          <div className="mt-2">
            <ChangeList events={list} highlightId={highlightId} />
          </div>
          <LoadMore
            hasMore={events.hasNextPage}
            loading={events.isFetchingNextPage}
            error={events.isFetchNextPageError ? events.error : null}
            onLoad={() => void events.fetchNextPage()}
            label="Load older changes"
          />
        </>
      )}
    </Card>
  );
}

const RUN_STATUS: Record<CheckRunDto['status'], { label: string; className: string }> = {
  queued: { label: 'Waiting for a worker', className: 'bg-slate-100 text-slate-700' },
  running: { label: 'Checking…', className: 'bg-indigo-50 text-indigo-800' },
  succeeded: { label: 'Done', className: 'bg-emerald-50 text-emerald-800' },
  failed: { label: 'Failed, retrying', className: 'bg-amber-50 text-amber-900' },
  skipped: { label: 'Skipped', className: 'bg-slate-100 text-slate-700' },
  dead: { label: 'Gave up', className: 'bg-red-50 text-red-800' },
};

const RUN_PAGES = [10, 30, 100];

function CheckHistory({ monitorId }: { monitorId: string }) {
  const [step, setStep] = useState(0);
  const limit = RUN_PAGES[step]!;
  const runs = useMonitorRuns(monitorId, limit);
  const canShowMore = runs.data !== undefined && runs.data.length >= limit && step < RUN_PAGES.length - 1;

  return (
    <Card aria-labelledby="history-heading">
      <h2 id="history-heading" className="text-base font-semibold">
        Check history
      </h2>
      {runs.isPending ? (
        <ListSkeleton rows={2} label="check history" />
      ) : runs.isError && !runs.data ? (
        <div className="mt-3">
          <ErrorState compact title="Couldn’t load check history" error={runs.error} onRetry={() => runs.refetch()} retrying={runs.isFetching} />
        </div>
      ) : runs.data.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No checks yet. The first one runs at the time shown above.</p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {runs.data.map((run) => {
              const status = RUN_STATUS[run.status];
              return (
                <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Time iso={run.scheduledFor} className="w-32 shrink-0 text-slate-700">
                    {relativeTime(run.scheduledFor)}
                  </Time>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
                  {run.outcome && <span className="text-slate-700">{outcomeText(run)}</span>}
                  {run.durationMs != null && <span className="text-slate-500">{(run.durationMs / 1000).toFixed(1)} s</span>}
                  {run.attempts > 1 && <span className="text-slate-500">{run.attempts} attempts</span>}
                  {run.error && <span className="w-full break-words text-red-700 sm:w-auto">{run.error}</span>}
                </li>
              );
            })}
          </ul>
          {canShowMore && (
            <div className="flex justify-center pt-3">
              <Button variant="secondary" onClick={() => setStep((s) => s + 1)} loading={runs.isPlaceholderData}>
                Show more checks
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function outcomeText(run: CheckRunDto): string {
  switch (run.outcome) {
    case 'baseline':
      return 'Baseline saved';
    case 'unchanged':
      return 'No changes';
    case 'changed':
      return run.changeCount ? `${run.changeCount} change${run.changeCount === 1 ? '' : 's'}` : 'Changes already reported';
    case 'incomplete':
      return 'Page looked incomplete; not compared';
    case 'rebaselined':
      return 'New page layout accepted';
    case 'stale':
      return 'Superseded by a newer check';
    default:
      return '';
  }
}
