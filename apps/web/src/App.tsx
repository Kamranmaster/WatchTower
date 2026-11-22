import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
import { GuestOnly, RequireAuth } from './components/RouteGuards';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { MonitorDetailPage } from './pages/MonitorDetailPage';
import { EditMonitorPage, NewMonitorPage } from './pages/MonitorFormPages';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SystemPage } from './pages/SystemPage';

const router = createBrowserRouter([
  {
    element: <GuestOnly />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/register', element: <AuthPage mode="register" /> },
    ],
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <Layout />,
        children: [
          {
            // A crash inside one page keeps the header, so the user can navigate away.
            errorElement: <RouteError />,
            children: [
              { path: '/', element: <DashboardPage /> },
              { path: '/monitors/new', element: <NewMonitorPage /> },
              { path: '/monitors/:id', element: <MonitorDetailPage /> },
              { path: '/monitors/:id/edit', element: <EditMonitorPage /> },
              { path: '/notifications', element: <NotificationsPage /> },
              { path: '/settings', element: <SettingsPage /> },
              ...(import.meta.env.DEV ? [{ path: '/system', element: <SystemPage /> }] : []),
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
