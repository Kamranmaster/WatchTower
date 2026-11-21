import { Link } from 'react-router';
import type { MonitorDto } from '@monitorly/contracts';
import { useMe } from '../hooks/useAuth';
import { useMonitors, useSetMonitorPaused } from '../hooks/useMonitors';
import { formatInterval, hostOf, relativeTime } from '../lib/format';
import { Alert, Button, ButtonLink, Card, PageLoading, StatusBadge } from '../components/ui';

export function DashboardPage() {
  const { data: user } = useMe();
  const monitors = useMonitors();

  if (monitors.isPending) return <PageLoading />;
  if (monitors.isError) return <Alert>{monitors.error.message}</Alert>;

  const list = monitors.data;
  const count = (status: MonitorDto['status']) => list.filter((m) => m.status === status).length;
  const nextUp = list
    .filter((m) => m.status === 'active')
    .sort((a, b) => Date.parse(a.nextCheckAt) - Date.parse(b.nextCheckAt))[0];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hi {user?.name.split(' ')[0]}</h1>
          <p className="text-slate-500">Here’s what Monitorly is watching for you.</p>
        </div>
        <ButtonLink to="/monitors/new">+ New monitor</ButtonLink>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Active monitors" value={count('active')} />
        <Stat label="Paused" value={count('paused')} />
        <Stat label="Failing" value={count('error')} tone={count('error') > 0 ? 'bad' : undefined} />
        <Stat label="Next check" value={nextUp ? relativeTime(nextUp.nextCheckAt) : '—'} small />
      </div>

      {list.length === 0 ? (
        <EmptyState />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {list.map((monitor) => (
              <MonitorRow key={monitor.id} monitor={monitor} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, tone, small }: { label: string; value: number | string; tone?: 'bad'; small?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 font-semibold tracking-tight ${small ? 'text-lg' : 'text-3xl'} ${tone === 'bad' ? 'text-red-600' : ''}`}>
        {value}
      </p>
    </Card>
  );
}

function MonitorRow({ monitor }: { monitor: MonitorDto }) {
  const setPaused = useSetMonitorPaused();
  const paused = monitor.status === 'paused';

  return (
    <li className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-slate-50">
      <Link to={`/monitors/${monitor.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-slate-900">{monitor.name}</span>
          <StatusBadge status={monitor.status} />
        </div>
        <p className="mt-0.5 truncate text-sm text-slate-500">
          {hostOf(monitor.url)} · {monitor.instruction}
        </p>
      </Link>
      <div className="hidden text-right text-sm text-slate-500 md:block">
        <p>{formatInterval(monitor.checkIntervalMinutes)}</p>
        <p>{paused ? 'Paused' : monitor.lastCheckedAt ? `Checked ${relativeTime(monitor.lastCheckedAt)}` : 'Not checked yet'}</p>
      </div>
      <Button
        variant="secondary"
        loading={setPaused.isPending}
        onClick={() => setPaused.mutate({ id: monitor.id, paused: !paused })}
      >
        {paused ? 'Resume' : 'Pause'}
      </Button>
    </li>
  );
}

function EmptyState() {
  return (
    <Card className="py-16 text-center">
      <h2 className="text-lg font-semibold">No monitors yet</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
        Add a website and describe what you’re waiting for — a job opening, a product back in stock — and we’ll keep an eye on it.
      </p>
      <ButtonLink to="/monitors/new" className="mt-6">
        Create your first monitor
      </ButtonLink>
    </Card>
  );
}
