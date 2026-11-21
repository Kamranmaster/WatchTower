import { NavLink, Outlet, useNavigate } from 'react-router';
import { useLogout, useMe } from '../hooks/useAuth';
import { Button } from './ui';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:text-slate-900'}`;

export function Layout() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
          <NavLink to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-sm text-white">M</span>
            Monitorly
          </NavLink>
          <nav className="flex gap-1">
            <NavLink to="/" end className={navClass}>
              Dashboard
            </NavLink>
            <NavLink to="/monitors/new" className={navClass}>
              New monitor
            </NavLink>
            {import.meta.env.DEV && (
              <NavLink to="/system" className={navClass}>
                System
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{user?.name}</span>
            <Button
              variant="ghost"
              loading={logout.isPending}
              onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login') })}
            >
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
