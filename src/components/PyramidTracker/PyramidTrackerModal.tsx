/**
 * PyramidTrackerModal — small, shared overlay primitive used by the chain
 * and leg form modals.
 *
 * The app does not bundle a dialog library (no radix-ui / react-aria), so we
 * roll a minimal accessible overlay:
 *   - fixed backdrop (div + onMouseDown target-check) that dismisses only
 *     when the press-and-release both originate on the backdrop; a drag
 *     started inside the dialog (e.g. highlighting text in a textarea) that
 *     ends over the backdrop does NOT dismiss
 *   - centred panel with `role="dialog"` + `aria-modal="true"`
 *   - Escape-to-close via a document keydown listener
 *   - focus trap: Tab / Shift+Tab cycles within the dialog so keyboard
 *     users can't tab into the page behind the modal
 *   - first-focusable autofocus on open (best-effort)
 *   - returns focus to the element that opened it (the browser handles this
 *     automatically when the trigger stays mounted)
 *
 * This primitive is local to `PyramidTracker/` by design — both forms need
 * the same overlay boilerplate, but nothing outside the feature does. If
 * the pyramid experiment is abandoned the entire folder drops in one
 * `rm -rf`.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface PyramidTrackerModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Optional testid — lets individual form tests target specific modals. */
  readonly testId?: string;
}

/** Selector for focusable descendants used by the Tab-trap handler. */
const FOCUSABLE_SELECTOR =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function PyramidTrackerModal({
  open,
  title,
  onClose,
  children,
  testId,
}: PyramidTrackerModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape-to-close + focus trap. Attached only while open so closed modals
  // have zero listener cost and closed-over refs stay fresh. Combined into
  // one keydown handler so both features share a single listener.
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: on Tab at the last focusable descendant, loop to first;
      // on Shift+Tab at the first, loop to last. Prevents keyboard users
      // from tabbing into the page behind the modal.
      const panel = panelRef.current;
      if (panel == null) return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Autofocus the first focusable input inside the panel on open. Falls
  // back to focusing the panel itself so keyboard users can tab from a
  // known anchor if the form has no focusable inputs yet.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel == null) return;
    const firstInput = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstInput ?? panel).focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center overflow-y-auto p-4 sm:items-center"
      data-testid={testId}
    >
      {/* Backdrop: dismiss only when the mouse press-and-release both
          originate on the backdrop itself. Uses onMouseDown + a target
          guard so drags started inside the dialog (e.g. highlighting text
          in a textarea) that end over the backdrop don't dismiss. A <div>
          (not <button>) avoids redundant SR announcement with the
          role="dialog" panel. */}
      <div
        aria-hidden="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="fixed inset-0 bg-black/60"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-surface border-edge relative z-[301] my-4 flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col rounded-xl border-[1.5px] shadow-xl outline-none"
      >
        <header className="border-edge flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <h2
            id={titleId}
            className="text-primary font-sans text-[14px] font-bold tracking-[0.08em] uppercase"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary cursor-pointer font-sans text-[18px] leading-none"
          >
            {'\u00D7'}
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
