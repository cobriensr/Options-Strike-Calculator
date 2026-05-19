/**
 * LazySection — non-auth-gated companion to `GatedSection`.
 *
 * Wraps a section that ships with React.lazy() in the same nav-anchor +
 * <ErrorBoundary> + <Suspense> sandwich GatedSection produces, minus
 * the `gate` prop. Used by App.tsx sections that don't need
 * auth-gating (Risk Calculator, Market Regime, Futures, Chart
 * Analysis) so the inline `<span id /> + <ErrorBoundary> + <Suspense
 * fallback={<SkeletonSection lines={N} />}>` quad collapses to a
 * single declarative wrapper.
 *
 * Layout invariants match GatedSection:
 *
 *   - The nav anchor `<span id={id} />` always renders FIRST (so smooth
 *     scrolling lands on the anchor, not inside the panel).
 *   - `block scroll-mt-28` on the anchor leaves room for the sticky
 *     header on a hash jump.
 *   - <ErrorBoundary label> wraps the panel so a render error in one
 *     section doesn't blow up the whole page.
 *   - <Suspense fallback> is opt-in via the `fallback` prop; sections
 *     that don't lazy-load can omit it.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2N)
 */

import { Suspense, type ReactNode } from 'react';
import ErrorBoundary from './ErrorBoundary';

export interface LazySectionProps {
  /** Nav anchor id — matches a `NavSection.id` from `SectionNav`. */
  id: string;
  /** Human-readable label passed to the ErrorBoundary fallback header. */
  label: string;
  /** Optional Suspense fallback. When omitted, no Suspense boundary is created. */
  fallback?: ReactNode;
  children: ReactNode;
}

export default function LazySection({
  id,
  label,
  fallback,
  children,
}: LazySectionProps) {
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
