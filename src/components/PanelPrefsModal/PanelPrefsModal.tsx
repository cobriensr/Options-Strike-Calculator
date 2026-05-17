/**
 * PanelPrefsModal — gear-icon modal for choosing which home-page sections
 * render for the current identity (owner cookie session or guest key).
 *
 * Reads the panel registry filtered by the caller's `(isAuthenticated,
 * hasMarketOrSnapshot)` context so a guest never sees a checkbox for the
 * Futures Calculator they couldn't reach anyway. The `results` panel is
 * excluded — hiding the calculator output is not a useful UX.
 *
 * Spec: docs/superpowers/specs/panel-prefs-2026-05-17.md
 */

import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  getPanelRegistry,
  PANEL_GROUP_ORDER,
  type PanelRegistryEntry,
} from '../../constants/panel-registry';
import type { PanelPrefs } from '../../hooks/usePanelPrefs';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  panelPrefs: PanelPrefs;
  isAuthenticated: boolean;
  hasMarketOrSnapshot: boolean;
}

export function PanelPrefsModal({
  isOpen,
  onClose,
  panelPrefs,
  isAuthenticated,
  hasMarketOrSnapshot,
}: Props) {
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Stash whatever owned focus when the modal opened (the gear button,
    // typically) so we can restore focus on close per WCAG 2.4.3.
    triggerRef.current = document.activeElement as HTMLElement | null;
    doneButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      triggerRef.current?.focus();
    };
  }, [isOpen, onClose]);

  const handleReset = useCallback(() => {
    panelPrefs.reset();
  }, [panelPrefs]);

  if (!isOpen) return null;

  const registry = getPanelRegistry({
    isAuthenticated,
    hasMarketOrSnapshot,
  }).filter((entry) => entry.id !== 'results');
  const grouped = new Map<string, PanelRegistryEntry[]>();
  for (const entry of registry) {
    const bucket = grouped.get(entry.group) ?? [];
    bucket.push(entry);
    grouped.set(entry.group, bucket);
  }

  const totalHidden = registry.filter((e) => panelPrefs.isHidden(e.id)).length;
  const totalVisible = registry.length - totalHidden;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="panel-prefs-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="bg-surface border-edge-strong flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2
              id="panel-prefs-title"
              className="text-primary font-serif text-lg font-bold"
            >
              Show / Hide Panels
            </h2>
            <p className="text-secondary mt-1 text-sm">
              Pick which sections appear on the home page. Your selection is
              saved server-side and follows you across devices.
            </p>
          </div>
          <span className="text-tertiary shrink-0 font-mono text-xs whitespace-nowrap">
            {totalVisible}/{registry.length} visible
          </span>
        </div>

        <div className="-mr-2 flex-1 overflow-y-auto pr-2">
          {PANEL_GROUP_ORDER.filter((group) => grouped.has(group)).map(
            (group) => {
              const entries = grouped.get(group) ?? [];
              return (
                <section key={group} className="mb-4 last:mb-0">
                  <h3 className="text-tertiary mb-2 font-sans text-[11px] font-semibold tracking-wider uppercase">
                    {group}
                  </h3>
                  <ul className="space-y-1">
                    {entries.map((entry) => {
                      const visible = !panelPrefs.isHidden(entry.id);
                      return (
                        <li key={entry.id}>
                          <label className="border-edge hover:bg-surface-alt flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors">
                            <input
                              type="checkbox"
                              checked={visible}
                              onChange={() => panelPrefs.toggle(entry.id)}
                              className="accent-accent h-4 w-4 cursor-pointer"
                              aria-label={`${visible ? 'Hide' : 'Show'} ${entry.label}`}
                            />
                            <span className="text-primary flex-1">
                              {entry.label}
                            </span>
                            <span className="text-tertiary font-mono text-[10px]">
                              {entry.id}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            },
          )}
        </div>

        <div className="border-edge mt-4 flex gap-2 border-t pt-4">
          <button
            type="button"
            onClick={handleReset}
            disabled={totalHidden === 0}
            className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset (show all)
          </button>
          <button
            ref={doneButtonRef}
            type="button"
            onClick={onClose}
            className="bg-accent flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
