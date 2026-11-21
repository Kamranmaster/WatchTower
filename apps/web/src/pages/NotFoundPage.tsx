import { ButtonLink } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="py-24 text-center">
      <p className="text-sm font-semibold text-indigo-600">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Page not found</h1>
      <ButtonLink to="/" className="mt-6">
        Back to dashboard
      </ButtonLink>
    </div>
  );
}
