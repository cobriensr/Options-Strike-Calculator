import { lazy, Suspense } from 'react';
import SkeletonSection from '../SkeletonSection';
import ErrorBoundary from '../ErrorBoundary';
import { handleStaleChunk } from '../../utils/handle-stale-chunk';

// Feed code stays code-split; only this lightweight wrapper is eager.
const LotteryFinderSection = lazy(() =>
  import('../LotteryFinder')
    .then((m) => ({ default: m.LotteryFinderSection }))
    .catch(handleStaleChunk),
);
const SilentBoomSection = lazy(() =>
  import('../SilentBoom')
    .then((m) => ({ default: m.SilentBoomSection }))
    .catch(handleStaleChunk),
);

export interface OptionsAlertsViewProps {
  /** Live market-open flag, threaded to each feed's polling gate. */
  marketOpen: boolean;
  /** Owner/guest + market-or-snapshot gate (mirrors the calculator gate). */
  hasMarketContext: boolean;
}

/**
 * Full-screen alerts view: a responsive 50/50 split with Lottery Finder and
 * Silent Boom, each pane scrolling independently. Below the `xl` breakpoint
 * (1280px) the panes stack vertically (Lottery on top); at `xl` and wider
 * they sit side-by-side (Lottery on the left).
 *
 * Layout: the root is `flex-1 min-h-0` inside App's `h-dvh` alerts shell, so
 * it fills the viewport beneath the header. It is `flex-col xl:flex-row`, so
 * `flex-1` splits the cross-axis evenly in either orientation. Each pane is
 * `flex-1 min-h-0 min-w-0 overflow-y-auto` — `min-h-0`/`min-w-0` let a flex
 * child shrink below its content size, which is what gives each pane its own
 * bounded scroll region instead of growing the page. The Lottery pane's
 * divider flips from a bottom border (stacked) to a right border (side-by-side)
 * at the breakpoint.
 */
export function OptionsAlertsView({
  marketOpen,
  hasMarketContext,
}: OptionsAlertsViewProps) {
  if (!hasMarketContext) {
    return (
      <main
        id="options-alerts-main"
        aria-label="Options alerts"
        className="flex min-h-0 flex-1 items-center justify-center p-8 text-center"
      >
        <p className="text-secondary max-w-md text-sm">
          Options alerts need live market context. Sign in or load a snapshot to
          see Lottery Finder and Silent Boom fires.
        </p>
      </main>
    );
  }

  return (
    <main
      id="options-alerts-main"
      aria-label="Options alerts"
      className="flex min-h-0 flex-1 flex-col xl:flex-row"
    >
      <section
        aria-label="Lottery Finder alerts"
        className="border-edge min-h-0 min-w-0 flex-1 overflow-y-auto border-b xl:border-r xl:border-b-0"
      >
        <ErrorBoundary label="Lottery Finder">
          <Suspense fallback={<SkeletonSection lines={6} />}>
            <LotteryFinderSection marketOpen={marketOpen} compact />
          </Suspense>
        </ErrorBoundary>
      </section>
      <section
        aria-label="Silent Boom alerts"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <ErrorBoundary label="Silent Boom">
          <Suspense fallback={<SkeletonSection lines={6} />}>
            <SilentBoomSection marketOpen={marketOpen} compact />
          </Suspense>
        </ErrorBoundary>
      </section>
    </main>
  );
}
