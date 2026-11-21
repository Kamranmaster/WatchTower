import { useNavigate, useParams } from 'react-router';
import { useCreateMonitor, useMonitor, useUpdateMonitor } from '../hooks/useMonitors';
import { MonitorForm } from '../components/MonitorForm';
import { Alert, PageLoading } from '../components/ui';

export function NewMonitorPage() {
  const navigate = useNavigate();
  const create = useCreateMonitor();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">New monitor</h1>
        <p className="text-slate-500">Tell us which page to watch and what you’re waiting for.</p>
      </header>
      <MonitorForm
        submitLabel="Create monitor"
        pending={create.isPending}
        error={create.error}
        onSubmit={(values) =>
          create.mutate(
            { ...values, name: values.name || undefined },
            { onSuccess: (monitor) => navigate(`/monitors/${monitor.id}`) },
          )
        }
        onCancel={() => navigate('/')}
      />
    </div>
  );
}

export function EditMonitorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const monitor = useMonitor(id);
  const update = useUpdateMonitor(id);

  if (monitor.isPending) return <PageLoading />;
  if (monitor.isError) return <Alert>{monitor.error.message}</Alert>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Edit {monitor.data.name}</h1>
        <p className="text-slate-500">Changing the URL starts fresh: the next check records a new baseline.</p>
      </header>
      <MonitorForm
        initial={monitor.data}
        submitLabel="Save changes"
        pending={update.isPending}
        error={update.error}
        onSubmit={(values) => update.mutate(values, { onSuccess: () => navigate(`/monitors/${id}`) })}
        onCancel={() => navigate(`/monitors/${id}`)}
      />
    </div>
  );
}
