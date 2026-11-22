import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

/**
 * State for a dropdown panel opened by a button (disclosure pattern): closes on a click
 * outside, on Escape (focus goes back to the button) and when the page changes.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(close, [pathname, close]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (container.current && !container.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    // Tabbing out of the panel closes it too, so it never hides content behind it.
    const onFocus = (e: FocusEvent) => {
      if (container.current && e.target instanceof Node && !container.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open]);

  return { open, setOpen, close, toggle, container, trigger };
}
