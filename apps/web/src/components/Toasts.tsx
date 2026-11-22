import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NotificationDto } from '@monitorly/contracts';
import { errorMessage } from '../lib/api';
import { cx } from './ui';

type Toast =
  | { id: number; kind: 'success' | 'error'; message: string }
  | { id: number; kind: 'notification'; notification: NotificationDto; onOpen: () => void };

type NewToast = Toast extends infer T ? (T extends Toast ? Omit<T, 'id'> : never) : never;

interface ToastApi {
  success(message: string): void;
  /** Accepts an Error (shows its friendly message) or a string. */
  error(error: unknown, prefix?: string): void;
  notification(notification: NotificationDto, onOpen: () => void): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DURATION: Record<Toast['kind'], number> = { success: 4_000, error: 8_000, notification: 8_000 };
const MAX_TOASTS = 4;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

/**
 * Feedback messages ("Monitor paused", "Couldn't save: …") and live alert pop-ups, in one
 * stack. The live region is always in the page, so screen readers announce new toasts;
 * timers pause while a toast is hovered or focused.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((toast: NewToast) => {
    setToasts((list) => {
      // The same live alert can arrive twice (reconnects): show it once.
      const rest =
        toast.kind === 'notification'
          ? list.filter((x) => !(x.kind === 'notification' && x.notification.id === toast.notification.id))
          : list;
      return [...rest, { ...toast, id: nextId.current++ } as Toast].slice(-MAX_TOASTS);
    });
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push({ kind: 'success', message }),
      error: (error, prefix) => push({ kind: 'error', message: prefix ? `${prefix}: ${errorMessage(error)}` : errorMessage(error) }),
      notification: (notification, onOpen) => push({ kind: 'notification', notification, onOpen }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-live="polite"
        aria-label="Messages"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex flex-col items-stretch gap-2 sm:left-auto sm:w-96"
      >
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismissRef.current(), DURATION[toast.kind]);
    return () => clearTimeout(timer);
  }, [paused, toast.kind]);

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cx(
        'pointer-events-auto flex items-start gap-2 rounded-lg border bg-white p-3 shadow-lg',
        toast.kind === 'error' ? 'border-red-200' : 'border-slate-200',
      )}
    >
      {toast.kind === 'notification' ? (
        <button
          type="button"
          className="min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-indigo-600"
          onClick={() => {
            onDismiss();
            toast.onOpen();
          }}
        >
          <span className="block text-xs font-medium text-indigo-700">New alert · {toast.notification.monitorName ?? 'Monitor'}</span>
          <span className="block truncate text-sm font-semibold text-slate-900">{toast.notification.title}</span>
          <span className="line-clamp-2 block text-sm text-slate-600">{toast.notification.message}</span>
        </button>
      ) : (
        <p className={cx('min-w-0 flex-1 text-sm', toast.kind === 'error' ? 'text-red-800' : 'text-slate-800')}>
          <span aria-hidden="true" className={cx('mr-1.5 font-bold', toast.kind === 'error' ? 'text-red-600' : 'text-emerald-600')}>
            {toast.kind === 'error' ? '!' : '✓'}
          </span>
          {toast.message}
        </p>
      )}
      <button
        type="button"
        className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-600"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
