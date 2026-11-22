import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';

/**
 * Guards a form with unsaved edits: in-app navigation is held until the user confirms
 * (render a ConfirmDialog from `blocker`), and closing or reloading the tab asks the browser
 * to warn. Call `allowNavigation()` right before a successful save navigates away.
 */
export function useUnsavedChanges(dirty: boolean) {
  const allowed = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && !allowed.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowed.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return {
    blocker,
    allowNavigation: () => {
      allowed.current = true;
    },
    /** After a failed save: protect the edits again. */
    blockNavigation: () => {
      allowed.current = false;
    },
  };
}
