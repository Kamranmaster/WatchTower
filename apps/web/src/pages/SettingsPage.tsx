import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { updateProfileSchema, type MonitorDto, type UserDto } from '@monitorly/contracts/api';
import { CHECK_INTERVAL_OPTIONS } from '@monitorly/contracts/constants';
import { useMe, useUpdateProfile } from '../hooks/useAuth';
import { useMonitors, useUpdateMonitor } from '../hooks/useMonitors';
import { usePageTitle } from '../hooks/usePageTitle';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useToast } from '../components/Toasts';
import { ApiError } from '../lib/api';
import { formatInterval, hostOf } from '../lib/format';
import { focusFirstInvalid, validate } from '../lib/validation';
import { Alert, Button, Card, Checkbox, EmptyState, ErrorState, ListSkeleton, SelectField, TextField, UnsavedChangesDialog } from '../components/ui';

export function SettingsPage() {
  usePageTitle('Settings');
  const { data: user } = useMe();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-slate-600">Your account and how Monitorly alerts you.</p>
      </header>
      {/* RequireAuth guarantees the user is loaded; the key resets the form if they change. */}
      {user && <AccountForm key={user.id} user={user} />}
      <MonitorAlerts emailOn={user?.emailNotifications !== false} />
    </div>
  );
}

function AccountForm({ user }: { user: UserDto }) {
  const update = useUpdateProfile();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState({
    name: user.name,
    emailNotifications: user.emailNotifications,
    defaultCheckIntervalMinutes: user.defaultCheckIntervalMinutes,
  });
  const [values, setValues] = useState(saved);
  const [attempted, setAttempted] = useState(false);

  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const unsaved = useUnsavedChanges(dirty);
  const clientErrors = validate(updateProfileSchema, values);
  const serverErrors = update.error instanceof ApiError ? update.error.fieldErrors : {};
  const fieldError = (field: keyof typeof values) => (attempted ? clientErrors[field] : undefined) ?? serverErrors[field];
  const intervals = [...new Set<number>([...CHECK_INTERVAL_OPTIONS, values.defaultCheckIntervalMinutes])].sort((a, b) => a - b);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(clientErrors).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const input = { ...values, name: values.name.trim() };
    update.mutate(input, {
      onSuccess: (u) => {
        const next = { name: u.name, emailNotifications: u.emailNotifications, defaultCheckIntervalMinutes: u.defaultCheckIntervalMinutes };
        setSaved(next);
        setValues(next);
        setAttempted(false);
        toast.success('Settings saved.');
      },
      onError: (err) => {
        if (!(err instanceof ApiError && Object.keys(err.fieldErrors).length > 0)) toast.error(err, 'Couldn’t save your settings');
        focusFirstInvalid(formRef.current);
      },
    });
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-6" aria-label="Account settings">
      <UnsavedChangesDialog blocker={unsaved.blocker} />
      <Card className="space-y-5" aria-labelledby="profile-heading">
        <h2 id="profile-heading" className="text-base font-semibold">
          Profile
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            autoComplete="name"
            value={values.name}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            error={fieldError('name')}
            required
          />
          <TextField label="Email" type="email" value={user.email} disabled hint="Used to log in and for alert emails." />
        </div>
      </Card>

      <Card className="space-y-5" aria-labelledby="alerts-heading">
        <h2 id="alerts-heading" className="text-base font-semibold">
          Notifications
        </h2>
        <Checkbox
          label="Email alerts"
          description={`Master switch for alert emails to ${user.email}. When it’s off, no monitor sends email; in-app alerts keep working.`}
          checked={values.emailNotifications}
          onChange={(e) => setValues((v) => ({ ...v, emailNotifications: e.target.checked }))}
        />
        <div className="max-w-xs">
          <SelectField
            label="Default check frequency"
            hint="Pre-selected when you create a monitor."
            value={values.defaultCheckIntervalMinutes}
            onChange={(e) => setValues((v) => ({ ...v, defaultCheckIntervalMinutes: Number(e.target.value) }))}
            error={fieldError('defaultCheckIntervalMinutes')}
          >
            {intervals.map((m) => (
              <option key={m} value={m}>
                {formatInterval(m)}
              </option>
            ))}
          </SelectField>
        </div>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {dirty && <p className="text-sm text-slate-600">You have unsaved changes.</p>}
        {dirty && (
          <Button variant="secondary" onClick={() => setValues(saved)} disabled={update.isPending}>
            Discard
          </Button>
        )}
        <Button type="submit" loading={update.isPending} disabled={!dirty}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

/** In-app / email per monitor, changed in place. */
function MonitorAlerts({ emailOn }: { emailOn: boolean }) {
  const monitors = useMonitors();
  return (
    <Card padding="none" aria-labelledby="per-monitor-heading">
      <div className="p-4 sm:px-6 sm:pt-6">
        <h2 id="per-monitor-heading" className="text-base font-semibold">
          Alerts per monitor
        </h2>
        <p className="text-sm text-slate-600">Choose how each monitor tells you about matches. Changes save right away.</p>
        {!emailOn && (
          <Alert tone="warning" className="mt-3">
            Email alerts are off for your account (above), so monitors set to email won’t send any until you turn them back on.
          </Alert>
        )}
      </div>
      {monitors.isPending ? (
        <div className="px-4 pb-4 sm:px-6">
          <ListSkeleton rows={2} label="monitors" />
        </div>
      ) : monitors.isError ? (
        <div className="px-4 pb-4 sm:px-6">
          <ErrorState compact title="Couldn’t load your monitors" error={monitors.error} onRetry={() => monitors.refetch()} retrying={monitors.isFetching} />
        </div>
      ) : monitors.data.length === 0 ? (
        <EmptyState title="No monitors yet">
          <Link to="/monitors/new" className="font-medium text-indigo-700 hover:underline">
            Create a monitor
          </Link>{' '}
          to choose how it alerts you.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {monitors.data.map((m) => (
            <MonitorAlertRow key={m.id} monitor={m} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MonitorAlertRow({ monitor }: { monitor: MonitorDto }) {
  const update = useUpdateMonitor(monitor.id);
  const toast = useToast();
  // Shows the new value right away (optimistic); it snaps back if saving fails.
  const [optimistic, setOptimistic] = useState<{ notifyInApp?: boolean; notifyEmail?: boolean }>({});
  const set = (field: 'notifyInApp' | 'notifyEmail', value: boolean) => {
    setOptimistic((o) => ({ ...o, [field]: value }));
    update.mutate(
      { [field]: value },
      {
        onSuccess: () => toast.success(`${field === 'notifyEmail' ? 'Email' : 'In-app'} alerts ${value ? 'on' : 'off'} for “${monitor.name}”.`),
        onError: (err) => toast.error(err, `Couldn’t update “${monitor.name}”`),
        onSettled: () => setOptimistic(({ [field]: _, ...rest }) => rest),
      },
    );
  };
  const inApp = optimistic.notifyInApp ?? monitor.notifyInApp;
  const email = optimistic.notifyEmail ?? monitor.notifyEmail;
  const off = !inApp && !email;

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
      <div className="min-w-0 flex-1">
        <Link to={`/monitors/${monitor.id}`} className="block truncate font-medium text-slate-900 hover:underline">
          {monitor.name}
        </Link>
        <p className="truncate text-xs text-slate-500">
          {hostOf(monitor.url)}
          {off && <span className="text-amber-800"> · No alerts: matches are only listed on the monitor’s page</span>}
        </p>
      </div>
      <fieldset className="flex gap-5" aria-busy={update.isPending || undefined}>
        <legend className="sr-only">Alerts for {monitor.name}</legend>
        <Checkbox label="In-app" checked={inApp} onChange={(e) => set('notifyInApp', e.target.checked)} />
        <Checkbox label="Email" checked={email} onChange={(e) => set('notifyEmail', e.target.checked)} />
      </fieldset>
    </li>
  );
}
