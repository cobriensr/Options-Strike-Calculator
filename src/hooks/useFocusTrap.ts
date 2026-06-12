/**
 * useFocusTrap — keep keyboard focus inside a container while it is active.
 *
 * Dialogs that set `aria-modal="true"` promise assistive tech that the
 * background is inert. Without a focus trap, Tab still walks out into that
 * "inert" background — a WCAG 2.4.3 / 2.1.2 failure (AUD-M20). This hook
 * closes the loop: Tab from the last focusable element wraps to the first,
 * and Shift+Tab from the first wraps to the last.
 *
 * Scope is deliberately narrow — it only handles the Tab cycle. Initial
 * focus and focus restoration on close stay with the caller (they already
 * own that logic and it varies per dialog). Escape-to-close is likewise the
 * caller's concern.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useFocusTrap(ref, isOpen);
 *   return <div ref={ref} role="dialog" aria-modal="true">…</div>;
 */
import { useEffect, type RefObject } from 'react';

// Elements that can hold keyboard focus. `[tabindex]` is filtered below to
// exclude negative tabindex (programmatic-only focus targets).
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(',');

function isHidden(el: HTMLElement): boolean {
  if (el.hidden) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  // getComputedStyle is unavailable / unreliable under some test runtimes;
  // guard so the trap degrades to "treat as visible" rather than throwing.
  const view = el.ownerDocument.defaultView;
  if (!view?.getComputedStyle) return false;
  const style = view.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    if (el.getAttribute('tabindex') === '-1') return false;
    return !isHidden(el);
  });
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(container);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        // Nothing to focus inside — keep focus from escaping the dialog.
        e.preventDefault();
        return;
      }
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab off the first element wraps to the last.
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        // Tab off the last element wraps to the first.
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [containerRef, active]);
}
