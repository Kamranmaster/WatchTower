import { useEffect, useId, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useLogout, useMe } from '../hooks/useAuth';
import { useOnline } from '../hooks/useOnline';
import { usePopover } from '../hooks/usePopover';
import { LiveAlerts, NotificationBell } from './Notifications';
import { useToast } from './Toasts';
import { ButtonLink, cx } from './ui';

const navClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    'rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-600',
    isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:text-slate-900',
  );

const menuItemClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    'block w-full rounded-md px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-indigo-600',
    isActive ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-700 hover:bg-slate-50',
  );

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/notifications', label: 'Notifications' },
  ...(import.meta.env.DEV ? [{ to: '/system', label: 'System' }] : []),
];

/**
 * After in-app navigation, move focus to the new page's heading (or the main area), the
 * way a full page load would, so keyboard and screen reader users start at the content.
 */
function useFocusOnNavigate(main: React.RefObject<HTMLElement | null>) {
  const { pathname, hash } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const target = main.current?.querySelector<HTMLElement>('h1') ?? main.current;
      if (!target) return;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      // Links to a spot on the page (#change-…) scroll there themselves.
      if (!hash) window.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(frame);
    // Only on page changes, not when the hash changes.
  }, [pathname, main]);
}

/** Account menu on desktop; on small screens it also holds the page links. */
function AccountMenu() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const toast = useToast();
  const popover = usePopover();
  const panelId = useId();
  const initial = user?.name.trim()[0]?.toUpperCase() ?? '?';

  return (
    <div className="relative" ref={popover.container}>
      <button
        ref={popover.trigger}
        type="button"
        onClick={popover.toggle}
        aria-expanded={popover.open}
        aria-controls={panelId}
        className="flex h-10 items-center gap-2 rounded-md px-2 text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-600"
      >
        <span className="sr-only sm:hidden">Menu</span>
        <svg viewBox="0 0 24 24" className="h-5 w-5 sm:hidden" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
        </svg>
        <span aria-hidden="true" className="hidden h-7 w-7 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 sm:grid">
          {initial}
        </span>
        <span className="hidden max-w-32 truncate sm:inline">
          <span className="sr-only">Account menu for </span>
          {user?.name}
        </span>
      </button>

      {popover.open && (
        <div
          id={panelId}
          className="fixed inset-x-2 top-16 z-30 rounded-lg border border-slate-200 bg-white p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-60"
        >
          <div className="border-b border-slate-100 px-3 pb-2 pt-1">
            <p className="truncate text-sm font-medium text-slate-900">{user?.name}</p>
            <p className="truncate text-xs text-slate-500">{user?.email}</p>
          </div>
          <nav aria-label="Account" className="pt-2">
            <ul className="space-y-0.5">
              {NAV.map((item) => (
                <li key={item.to} className="sm:hidden">
                  <NavLink to={item.to} end={item.end} className={menuItemClass}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
              <li className="sm:hidden">
                <NavLink to="/monitors/new" className={menuItemClass}>
                  New monitor
                </NavLink>
              </li>
              <li>
                <NavLink to="/settings" className={menuItemClass}>
                  Settings
                </NavLink>
              </li>
              <li>
                <button
                  type="button"
                  className={menuItemClass({ isActive: false })}
                  disabled={logout.isPending}
                  onClick={() =>
                    logout.mutate(undefined, {
                      onSuccess: () => navigate('/login'),
                      onError: (err) => {
                        toast.error(err, 'Couldn’t log out');
                        navigate('/login');
                      },
                    })
                  }
                >
                  {logout.isPending ? 'Logging out…' : 'Log out'}
                </button>
              </li>
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}

function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
      You’re offline. What you see may be out of date; it refreshes when you’re back online.
    </div>
  );
}

export function Layout() {
  const { data: user } = useMe();
  const main = useRef<HTMLElement>(null);
  useFocusOnNavigate(main);

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-sm font-medium text-indigo-700 shadow focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="flex items-center gap-2 rounded-md text-lg font-bold tracking-tight focus-visible:outline-2 focus-visible:outline-indigo-600">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-sm text-white">
              M
            </span>
            Monitorly
          </Link>
          <nav aria-label="Main" className="hidden sm:block">
            <ul className="flex gap-1">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className={navClass}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/* max-sm:hidden, not "hidden sm:inline-flex": the button's own inline-flex would win. */}
            <ButtonLink to="/monitors/new" className="max-sm:hidden">
              + New monitor
            </ButtonLink>
            <NotificationBell />
            <AccountMenu />
          </div>
        </div>
        <OfflineBanner />
      </header>
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 focus:outline-none sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <LiveAlerts userId={user?.id} />
    </div>
  );
}
