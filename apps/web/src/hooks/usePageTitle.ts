import { useEffect } from 'react';

/** Sets the browser tab title ("Dashboard · Monitorly"); screen readers announce it on navigation. */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Monitorly` : 'Monitorly';
  }, [title]);
}
