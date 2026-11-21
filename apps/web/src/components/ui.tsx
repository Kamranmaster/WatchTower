import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';
import { Link, type LinkProps } from 'react-router';
import type { MonitorStatus } from '@monitorly/contracts';

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

// ---------------------------------------------------------------- Button
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 focus-visible:outline-indigo-600',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
  danger: 'bg-white text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
};

const buttonClass = (variant: Variant, className?: string) =>
  cx(
    'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition',
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
    'placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:outline-none',
    error ? 'ring-red-300 focus:ring-red-500' : 'ring-slate-300 focus:ring-indigo-600',
  );

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
}

function FieldShell({ id, label, hint, error, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-sm text-red-600">
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

export function TextField({ label, hint, error, ...props }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input id={id} aria-invalid={!!error} aria-describedby={`${id}-msg`} className={inputClass(error)} {...props} />
    </FieldShell>
  );
}

export function TextAreaField({ label, hint, error, ...props }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <textarea id={id} aria-invalid={!!error} aria-describedby={`${id}-msg`} className={inputClass(error)} {...props} />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...props
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <select id={id} aria-invalid={!!error} className={inputClass(error)} {...props}>
        {children}
      </select>
    </FieldShell>
  );
}

export function Checkbox({ label, description, ...props }: { label: string; description?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex gap-3">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600" {...props} />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-slate-800">{label}</span>
        {description && <span className="block text-slate-500">{description}</span>}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- Display
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-xl border border-slate-200 bg-white p-6 shadow-sm', className)}>{children}</div>;
}

const STATUS_STYLES: Record<MonitorStatus, string> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  paused: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
};

export function StatusBadge({ status }: { status: MonitorStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', STATUS_STYLES[status])}>
      <span className={cx('h-1.5 w-1.5 rounded-full', status === 'active' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-slate-400')} />
      {status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

export function Chip({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'exclude' }) {
  return (
    <span
      className={cx(
        'inline-flex rounded-md px-2 py-0.5 text-xs font-medium',
        tone === 'exclude' ? 'bg-red-50 text-red-700 line-through decoration-red-300' : 'bg-indigo-50 text-indigo-700',
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function PageLoading() {
  return (
    <div className="flex justify-center py-24 text-slate-400">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'rounded-lg px-4 py-3 text-sm',
        tone === 'error' ? 'bg-red-50 text-red-700' : 'bg-indigo-50 text-indigo-700',
      )}
    >
      {children}
    </div>
  );
}
