import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../hooks/useAuth';
import { Alert, PageLoading } from './ui';

/** Renders child routes only for logged-in users; otherwise sends them to /login and back afterwards. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <PageLoading />;
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert>{me.error.message}</Alert>
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Login/register pages: bounce already-logged-in users to the dashboard. */
export function GuestOnly() {
  const me = useMe();
  if (me.isPending) return <PageLoading />;
  if (me.data) return <Navigate to="/" replace />;
  return <Outlet />;
}
