import { usePageTitle } from '../hooks/usePageTitle';
import { ButtonLink } from '../components/ui';

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="py-24 text-center">
      <p className="text-sm font-semibold text-indigo-700">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">The link may be old, or the page was moved.</p>
      <ButtonLink to="/" className="mt-6">
        Back to dashboard
      </ButtonLink>
    </div>
  );
}
