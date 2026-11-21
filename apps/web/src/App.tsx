import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { GuestOnly, RequireAuth } from './components/RouteGuards';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { MonitorDetailPage } from './pages/MonitorDetailPage';
import { EditMonitorPage, NewMonitorPage } from './pages/MonitorFormPages';
import { NotFoundPage } from './pages/NotFoundPage';
import { SystemPage } from './pages/SystemPage';

const router = createBrowserRouter([
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <AuthPage mode="login" /> },
      { path: '/register', element: <AuthPage mode="register" /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: <DashboardPage /> },
          { path: '/monitors/new', element: <NewMonitorPage /> },
          { path: '/monitors/:id', element: <MonitorDetailPage /> },
          { path: '/monitors/:id/edit', element: <EditMonitorPage /> },
          ...(import.meta.env.DEV ? [{ path: '/system', element: <SystemPage /> }] : []),
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
