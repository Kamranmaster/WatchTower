import type { ReactNode } from 'react';
import type { CheckRunDto } from '@monitorly/contracts';
import { Link, useNavigate, useParams } from 'react-router';
import { useDeleteMonitor, useMonitor, useMonitorEvents, useMonitorRuns, useSetMonitorPaused } from '../hooks/useMonitors';
import { ChangeList } from '../components/ChangeList';
import { FETCH_MODE_LABELS, MONITOR_TYPE_LABELS, describeRules, formatInterval, relativeTime } from '../lib/format';
import { Alert, Button, ButtonLink, Card, Chip, PageLoading, StatusBadge } from '../components/ui';

export function MonitorDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const query = useMonitor(id);
  const setPaused = useSetMonitorPaused();
  const remove = useDeleteMonitor();

  if (query.isPending) return <PageLoading />;
  if (query.isError) {
    return (
      <div className="space-y-4">
        <Alert>{query.error.message}</Alert>
        <Link to="/" className="text-sm font-medium text-indigo-600">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const monitor = query.data;
  const paused = monitor.status === 'paused';
  const { keywords, locations, excludeKeywords } = monitor.rules;
  const hasRules = keywords.length + locations.length + excludeKeywords.length > 0;

  const onDelete = () => {
    if (!window.confirm(`Delete "${monitor.name}"? Its history and alerts will be removed too.`)) return;
    remove.mutate(monitor.id, { onSuccess: () => navigate('/', { replace: true }) });
  };

  return (
    <div className="space-y-6">
      <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-800">
        ← Dashboard
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-2xl font-bold tracking-tight">{monitor.name}</h1>
            <StatusBadge status={monitor.status} />
          </div>
          <a href={monitor.url} target="_blank" rel="noreferrer noopener" className="mt-1 block truncate text-sm text-indigo-600 hover:underline">
            {monitor.url}
          </a>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" loading={setPaused.isPending} onClick={() => setPaused.mutate({ id: monitor.id, paused: !paused })}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <ButtonLink variant="secondary" to={`/monitors/${monitor.id}/edit`}>
            Edit
          </ButtonLink>
          <Button variant="danger" loading={remove.isPending} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      {(setPaused.error ?? remove.error) && <Alert>{(setPaused.error ?? remove.error)!.message}</Alert>}
      {monitor.status === 'error' && monitor.lastError && (
        <Alert>
          The last {monitor.consecutiveFailures} checks failed: {monitor.lastError}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Info label="Next check">{paused ? 'Paused' : relativeTime(monitor.nextCheckAt)}</Info>
        <Info label="Last checked">{relativeTime(monitor.lastCheckedAt)}</Info>
        <Info label="Frequency">{formatInterval(monitor.checkIntervalMinutes)}</Info>
        <Info label="Alerts">
          {[monitor.notifyInApp && 'In-app', monitor.notifyEmail && 'Email'].filter(Boolean).join(' + ') || 'Off'}
          {monitor.aiReview && <span className="block text-xs font-normal text-slate-500">AI-reviewed</span>}
        </Info>
      </div>

      <Card className="space-y-4">
        <h2 className="text-base font-semibold">What we’re watching for</h2>
        <blockquote className="border-l-4 border-indigo-200 pl-4 text-slate-700">{monitor.instruction}</blockquote>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Page type</dt>
            <dd className="font-medium">{MONITOR_TYPE_LABELS[monitor.monitorType]}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Loading method</dt>
            <dd className="font-medium">
              {FETCH_MODE_LABELS[monitor.fetchMode]}
              {monitor.resolvedFetchMode && ` — using ${monitor.resolvedFetchMode}`}
            </dd>
          </div>
        </dl>
        <p className="text-sm font-medium text-slate-800">{describeRules(monitor.monitorType, monitor.rules)}</p>
        {hasRules && (
          <div className="space-y-2 text-sm">
            <RuleRow label="Must mention (all)" items={keywords} />
            <RuleRow label="Locations (any)" items={locations} />
            <RuleRow label="Ignore if it mentions (any)" items={excludeKeywords} exclude />
          </div>
        )}
      </Card>

      <RecentChanges monitorId={monitor.id} hasBaseline={monitor.hasBaseline} itemCount={monitor.itemCount} />

      <CheckHistory monitorId={monitor.id} />
    </div>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 font-semibold">{children}</p>
    </Card>
  );
}

function RuleRow({ label, items, exclude }: { label: string; items: string[]; exclude?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 text-slate-500">{label}</span>
      {items.map((item) => (
        <Chip key={item} tone={exclude ? 'exclude' : 'default'}>
          {item}
        </Chip>
      ))}
    </div>
  );
}

const RUN_STATUS: Record<CheckRunDto['status'], { label: string; className: string }> = {
  queued: { label: 'Waiting for a worker', className: 'bg-slate-100 text-slate-600' },
  running: { label: 'Checking…', className: 'bg-indigo-50 text-indigo-700' },
  succeeded: { label: 'Done', className: 'bg-emerald-50 text-emerald-700' },
  failed: { label: 'Failed', className: 'bg-amber-50 text-amber-800' },
  skipped: { label: 'Skipped', className: 'bg-slate-100 text-slate-500' },
  dead: { label: 'Gave up', className: 'bg-red-50 text-red-700' },
};

function CheckHistory({ monitorId }: { monitorId: string }) {
  const runs = useMonitorRuns(monitorId);
  return (
    <Card>
      <h2 className="text-base font-semibold">Check history</h2>
      {runs.isPending ? (
        <p className="mt-2 text-sm text-slate-500">Loading…</p>
      ) : runs.isError ? (
        <p className="mt-2 text-sm text-red-600">{runs.error.message}</p>
      ) : runs.data.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No checks yet. The first one is scheduled for the time shown above.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {runs.data.map((run) => {
            const status = RUN_STATUS[run.status];
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-40 text-slate-700" title={new Date(run.scheduledFor).toLocaleString()}>
                  {relativeTime(run.scheduledFor)}
                </span>
                <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
                {run.outcome && <span className="text-slate-600">{outcomeText(run)}</span>}
                {run.durationMs != null && <span className="text-slate-400">{(run.durationMs / 1000).toFixed(1)} s</span>}
                {run.error && <span className="truncate text-red-600">{run.error}</span>}
              </li>
            );
          })}
        </ul>
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

function RecentChanges({ monitorId, hasBaseline, itemCount }: { monitorId: string; hasBaseline: boolean; itemCount: number | null }) {
  const events = useMonitorEvents(monitorId);
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold">Recent changes</h2>
        {itemCount != null && <span className="text-sm text-slate-500">{itemCount} items on the page at the last check</span>}
      </div>
      {events.isPending ? (
        <p className="mt-2 text-sm text-slate-500">Loading…</p>
      ) : events.isError ? (
        <p className="mt-2 text-sm text-red-600">{events.error.message}</p>
      ) : events.data.length > 0 ? (
        <div className="mt-2">
          <ChangeList events={events.data} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          {hasBaseline
            ? 'No changes detected yet. We compare every check with the last one and list new, updated and removed items here.'
            : 'Nothing yet. The first check saves the page as a baseline — changes are detected from the next check on.'}
        </p>
      )}
    </Card>
  );
}
