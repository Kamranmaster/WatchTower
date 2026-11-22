import { Link, useNavigate, useParams } from 'react-router';
import { useCreateMonitor, useMonitor, useUpdateMonitor } from '../hooks/useMonitors';
import { usePageTitle } from '../hooks/usePageTitle';
import { MonitorForm } from '../components/MonitorForm';
import { useToast } from '../components/Toasts';
import { ApiError } from '../lib/api';
import { ButtonLink, Card, EmptyState, ErrorState, Skeleton } from '../components/ui';

export function NewMonitorPage() {
  usePageTitle('New monitor');
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateMonitor();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">New monitor</h1>
        <p className="text-slate-600">Tell us which page to watch and what you’re waiting for.</p>
      </header>
      <MonitorForm
        submitLabel="Create monitor"
        pending={create.isPending}
        error={create.error}
        onSubmit={async (values) => {
          const monitor = await create.mutateAsync({ ...values, name: values.name || undefined });
          toast.success(`Created “${monitor.name}”. The first check runs now and saves a baseline.`);
          navigate(`/monitors/${monitor.id}`);
        }}
        onCancel={() => navigate('/')}
      />
    </div>
  );
}

export function EditMonitorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const monitor = useMonitor(id);
  const update = useUpdateMonitor(id);
  usePageTitle(monitor.data ? `Edit ${monitor.data.name}` : 'Edit monitor');

  if (monitor.isPending) {
    return (
      <div role="status" className="mx-auto max-w-3xl space-y-6">
        <span className="sr-only">Loading monitor…</span>
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-48" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (monitor.isError) {
    const missing = monitor.error instanceof ApiError && monitor.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Edit monitor</h1>
        {missing ? (
          <Card>
            <EmptyState title="Monitor not found" action={<ButtonLink to="/">Back to dashboard</ButtonLink>}>
              It may have been deleted, or the link is wrong.
            </EmptyState>
          </Card>
        ) : (
          <ErrorState title="Couldn’t load this monitor" error={monitor.error} onRetry={() => monitor.refetch()} retrying={monitor.isFetching} />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link to={`/monitors/${id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
          <span aria-hidden="true">← </span>
          {monitor.data.name}
        </Link>
        <h1 className="mt-2 break-words text-2xl font-bold tracking-tight">Edit {monitor.data.name}</h1>
        <p className="text-slate-600">Changing the URL or the page type starts fresh: the next check records a new baseline.</p>
      </header>
      <MonitorForm
        // A different monitor always gets a fresh form.
        key={monitor.data.id}
        initial={monitor.data}
        submitLabel="Save changes"
        pending={update.isPending}
        error={update.error}
        onSubmit={async (values) => {
          await update.mutateAsync(values);
          toast.success('Changes saved.');
          navigate(`/monitors/${id}`);
        }}
        onCancel={() => navigate(`/monitors/${id}`)}
      />
    </div>
  );
}
