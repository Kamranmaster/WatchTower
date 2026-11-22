import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useEffect, useId, useRef } from 'react';
import { Link, type LinkProps } from 'react-router';
import type { MonitorStatus } from '@monitorly/contracts';
import { errorMessage } from '../lib/api';

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

// ---------------------------------------------------------------- Button
type Variant = 'primary' | 'secondary' | 'danger' | 'danger-solid' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 focus-visible:outline-indigo-600',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-indigo-600',
  danger: 'bg-white text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50 focus-visible:outline-red-600',
  'danger-solid': 'bg-red-600 text-white hover:bg-red-500 focus-visible:outline-red-600',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-indigo-600',
};

const buttonClass = (variant: Variant, className?: string) =>
  cx(
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition',
    'focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    className,
  );

/** A navigation link that looks like a button (never nest a <button> inside a <Link>). */
export function ButtonLink({ variant = 'primary', className, ...props }: LinkProps & { variant?: Variant }) {
  return <Link {...props} className={buttonClass(variant, className)} />;
}

export function Button({
  variant = 'primary',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, className)}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Form fields
const inputClass = (error?: string) =>
  cx(
    'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset',
    'placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:outline-none disabled:bg-slate-50 disabled:text-slate-500',
    error ? 'ring-red-400 focus:ring-red-600' : 'ring-slate-300 focus:ring-indigo-600',
  );

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Shown after the label, e.g. a character counter. */
  aside?: ReactNode;
}

/** Label, input, then the error (or the hint), linked to the input for screen readers. */
function FieldShell({
  id,
  label,
  hint,
  error,
  aside,
  required,
  children,
}: FieldProps & { id: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="block text-sm font-medium text-slate-800">
          {label}
          {required && (
            <span className="text-red-600" aria-hidden="true">
              {' '}
              *
            </span>
          )}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="flex gap-1 text-sm text-red-700">
          <span aria-hidden="true">⚠</span>
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, props: { hint?: ReactNode; error?: string }) => (props.error || props.hint ? `${id}-msg` : undefined);

export function TextField({ label, hint, error, aside, ...props }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} aside={aside} required={props.required}>
      <input id={id} aria-invalid={!!error} aria-describedby={describedBy(id, { hint, error })} className={inputClass(error)} {...props} />
    </FieldShell>
  );
}

export function TextAreaField({ label, hint, error, aside, ...props }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} aside={aside} required={props.required}>
      <textarea id={id} aria-invalid={!!error} aria-describedby={describedBy(id, { hint, error })} className={inputClass(error)} {...props} />
    </FieldShell>
  );
}

export function SelectField({ label, hint, error, children, ...props }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={props.required}>
      <select id={id} aria-invalid={!!error} aria-describedby={describedBy(id, { hint, error })} className={inputClass(error)} {...props}>
        {children}
      </select>
    </FieldShell>
  );
}

export function Checkbox({
  label,
  description,
  ...props
}: { label: ReactNode; description?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex gap-3">
      <input
        id={id}
        type="checkbox"
        aria-describedby={description ? `${id}-desc` : undefined}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 accent-indigo-600"
        {...props}
      />
      <div className="text-sm">
        <label htmlFor={id} className="font-medium text-slate-800">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="text-slate-500">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Display
const CARD_PADDING = { none: '', compact: 'p-4', normal: 'p-4 sm:p-6' } as const;

export function Card({
  className,
  padding = 'normal',
  children,
  ...props
}: { className?: string; padding?: keyof typeof CARD_PADDING; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', CARD_PADDING[padding], className)} {...props}>
      {children}
    </section>
  );
}

const STATUS_STYLES: Record<MonitorStatus, string> = {
  active: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  paused: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
};
export const STATUS_LABELS: Record<MonitorStatus, string> = { active: 'Active', paused: 'Paused', error: 'Failing' };

export function StatusBadge({ status }: { status: MonitorStatus }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status],
      )}
    >
      <span
        aria-hidden="true"
        className={cx('h-1.5 w-1.5 rounded-full', status === 'active' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-slate-400')}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Chip({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'exclude' }) {
  return (
    <span
      className={cx(
        'inline-flex max-w-full break-words rounded-md px-2 py-0.5 text-xs font-medium',
        tone === 'exclude' ? 'bg-red-50 text-red-700 line-through decoration-red-300' : 'bg-indigo-50 text-indigo-700',
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={cx('motion-safe:animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex justify-center py-24 text-slate-400" role="status">
      <Spinner className="h-8 w-8" />
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Grey placeholder blocks while content loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('rounded-md bg-slate-200/70 motion-safe:animate-pulse', className)} />;
}

/** Placeholder for a list while it loads; announces "Loading …" to screen readers. */
export function ListSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" className="space-y-4 py-2">
      <span className="sr-only">Loading {label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-5 w-14 shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Alert({ children, tone = 'error', className }: { children: ReactNode; tone?: 'error' | 'info' | 'warning'; className?: string }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'rounded-lg px-4 py-3 text-sm',
        tone === 'error' ? 'bg-red-50 text-red-800' : tone === 'warning' ? 'bg-amber-50 text-amber-900' : 'bg-indigo-50 text-indigo-800',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** "Couldn't load X" with a retry button. Use for queries; mutations report through toasts. */
export function ErrorState({
  error,
  title = 'Couldn’t load this',
  onRetry,
  retrying,
  compact,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
}) {
  return (
    <div role="alert" className={cx('rounded-lg bg-red-50 text-sm text-red-800', compact ? 'px-4 py-3' : 'px-6 py-8 text-center')}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 text-red-700">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" className={compact ? 'mt-3' : 'mt-4'} onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** A row of mutually exclusive filter buttons ("All · Alerts only"). */
export function FilterTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md px-3 py-1 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-600',
            value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
          )}
        >
          {o.label}
          {o.count !== undefined && (
            <>
              <span aria-hidden="true" className="ml-1.5 text-xs text-slate-500">
                {o.count}
              </span>
              <span className="sr-only"> ({o.count})</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** "Load more" for paged lists, with its own loading and error state. */
export function LoadMore({
  hasMore,
  loading,
  error,
  onLoad,
  label = 'Load older',
}: {
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  onLoad: () => void;
  label?: string;
}) {
  if (!hasMore && !error) return null;
  return (
    <div className="flex flex-col items-center gap-2 pt-3">
      {error ? <p className="text-sm text-red-700">Couldn’t load more: {errorMessage(error)}</p> : null}
      <Button variant="secondary" onClick={onLoad} loading={loading}>
        {error ? 'Try again' : label}
      </Button>
    </div>
  );
}

/** A time that shows relative text and the exact date on hover (and to assistive tech). */
export function Time({ iso, children, className }: { iso: string; children: ReactNode; className?: string }) {
  const exact = new Date(iso).toLocaleString();
  return (
    <time dateTime={iso} title={exact} className={className}>
      {children}
    </time>
  );
}

// ---------------------------------------------------------------- Dialog
/**
 * Confirmation dialog on the native <dialog> element: focus is trapped inside, Escape
 * cancels, and focus returns to whatever opened it.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={children ? bodyId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onCancel();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its content) cancels.
        if (e.target === ref.current && !pending) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      {open && (
        <div className="p-6">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {children && (
            <div id={bodyId} className="mt-2 text-sm text-slate-600">
              {children}
            </div>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onCancel} disabled={pending} autoFocus>
              {cancelLabel}
            </Button>
            <Button variant={tone === 'danger' ? 'danger-solid' : 'primary'} onClick={onConfirm} loading={pending}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Asks before leaving a form with unsaved edits (pair with useUnsavedChanges). */
export function UnsavedChangesDialog({ blocker }: { blocker: { state: string; proceed?: () => void; reset?: () => void } }) {
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title="Discard your changes?"
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    >
      You have edits that haven’t been saved. If you leave now, they’ll be lost.
    </ConfirmDialog>
  );
}
