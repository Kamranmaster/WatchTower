import { isRouteErrorResponse, useRouteError } from 'react-router';
import { usePageTitle } from '../hooks/usePageTitle';
import { Button } from './ui';

/** Shown instead of a page that crashed while rendering, so the app never goes blank. */
export function RouteError() {
  const error = useRouteError();
  usePageTitle('Something went wrong');
  const detail = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : null;
  return (
    <div role="alert" className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-600">This page hit an unexpected problem. Reloading usually fixes it.</p>
      {detail && import.meta.env.DEV && <pre className="mt-4 overflow-x-auto rounded-md bg-slate-100 p-3 text-left text-xs text-slate-700">{detail}</pre>}
      <div className="mt-6 flex justify-center gap-3">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <a href="/" className="inline-flex items-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Go to dashboard
        </a>
      </div>
    </div>
  );
}
