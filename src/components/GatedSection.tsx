/**
 * GatedSection — auth-gated lazy-loaded section wrapper for App.tsx.
 *
 * Replaces nine verbatim copies of the same `gate` + nav-anchor +
 * <ErrorBoundary> + <Suspense> sandwich that surrounded each major
 * data-driven panel (DarkPoolLevels, TRACE Live, GEX Per Strike, GEX
 * Target, GEX Landscape, Futures Gamma Playbook, Zero Gamma, Market
 * Internals, etc.) inside `App.tsx`.
 *
 * The wrapper takes the gate as a `gate` prop so the App-level decision
 * (`isAuthenticated && (market.hasData || !!historySnapshot)`) is hoisted
 * to a single `hasMarketContext` constant and threaded through verbatim.
 *
 * Layout invariants preserved from the inline shape:
 *
 *   - The nav anchor `<span id={id} />` always renders FIRST (so smooth
 *     scrolling lands on the anchor, not inside the panel).
 *   - The anchor uses `block scroll-mt-28` to leave room for the sticky
 *     header on a hash jump.
 *   - <ErrorBoundary label> wraps the panel so a render error in one
 *     section doesn't blow up the whole page.
 *   - <Suspense fallback> is opt-in via the `fallback` prop; sections
 *     that don't lazy-load can omit it (the wrapper renders the children
 *     directly with no Suspense boundary).
 */

import { Suspense, type ReactNode } from 'react';
import ErrorBoundary from './ErrorBoundary';

export interface GatedSectionProps {
  /** When false the entire section (anchor + boundary + children) is omitted. */
  gate: boolean;
  /** Nav anchor id — matches a `NavSection.id` from `SectionNav`. */
  id: string;
  /** Human-readable label passed to the ErrorBoundary fallback header. */
  label: string;
  /** Optional Suspense fallback. When omitted, no Suspense boundary is created. */
  fallback?: ReactNode;
  children: ReactNode;
}

export default function GatedSection({
  gate,
  id,
  label,
  fallback,
  children,
}: GatedSectionProps) {
  if (!gate) return null;
  return (
    <>
      <span id={id} className="block scroll-mt-28" />
      <ErrorBoundary label={label}>
        {fallback === undefined ? (
          children
        ) : (
          <Suspense fallback={fallback}>{children}</Suspense>
        )}
      </ErrorBoundary>
    </>
  );
}
