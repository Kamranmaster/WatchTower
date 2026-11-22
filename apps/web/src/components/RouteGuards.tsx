import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../hooks/useAuth';
import { ErrorState, PageLoading } from './ui';

/** Renders child routes only for logged-in users; otherwise sends them to /login and back afterwards. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <PageLoading />;
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorState title="Couldn’t load Monitorly" error={me.error} onRetry={() => me.refetch()} retrying={me.isFetching} />
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  return <Outlet />;
}

/**
 * Login/register pages: bounce logged-in users on. Right after logging in that means back to
 * the page that sent them to /login (RequireAuth put it in the location state).
 */
export function GuestOnly() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <PageLoading />;
  if (me.data) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;
  return <Outlet />;
}
