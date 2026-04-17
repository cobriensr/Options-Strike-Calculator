/**
 * PyramidTrackerModal — small, shared overlay primitive used by the chain
 * and leg form modals.
 *
 * The app does not bundle a dialog library (no radix-ui / react-aria), so we
 * roll a minimal accessible overlay:
 *   - fixed backdrop that dismisses on click
 *   - centred panel with `role="dialog"` + `aria-modal="true"`
 *   - Escape-to-close via a window keydown listener
 *   - first-input autofocus on mount (best-effort)
 *   - returns focus to the element that opened it (the browser handles this
 *     automatically when the trigger stays mounted)
 *
 * This primitive is local to `PyramidTracker/` by design — both forms need
 * the same overlay boilerplate, but nothing outside the feature does. If the
 * pyramid experiment is abandoned the entire folder drops in one `rm -rf`.
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

export default function PyramidTrackerModal({
  open,
  title,
  onClose,
  children,
  testId,
}: PyramidTrackerModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape-to-close. Attached only while open so closed modals have zero
  // listener cost and closed-over refs stay fresh.
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Autofocus the first focusable input inside the panel on open. Falls back
  // to focusing the panel itself so keyboard users can tab from a known
  // anchor if the form has no focusable inputs yet.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel == null) return;
    const firstInput = panel.querySelector<HTMLElement>(
      'input, select, textarea, button',
    );
    (firstInput ?? panel).focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center overflow-y-auto p-4 sm:items-center"
      data-testid={testId}
    >
      {/* Backdrop: click dismisses. Rendered as a button so screen readers
          can announce it as interactive. */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-black/60"
        tabIndex={-1}
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
