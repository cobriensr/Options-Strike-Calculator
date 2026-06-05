import { lazy, Suspense } from 'react';
import SkeletonSection from '../SkeletonSection';
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
 * Full-screen alerts view: a fixed 50/50 vertical split with Lottery Finder
 * on top and Silent Boom on the bottom, each pane scrolling independently.
 *
 * Layout: the root is `flex-1 min-h-0` inside App's `h-dvh` alerts shell, so
 * it fills the viewport beneath the header. Each pane is `flex-1 min-h-0
 * overflow-y-auto` — `min-h-0` lets a flex child shrink below its content
 * height, which is what gives each pane its own bounded scroll region
 * instead of growing the page.
 */
export function OptionsAlertsView({
  marketOpen,
  hasMarketContext,
}: OptionsAlertsViewProps) {
  if (!hasMarketContext) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <p className="text-secondary max-w-md text-sm">
          Options alerts need live market context. Sign in or load a snapshot to
          see Lottery Finder and Silent Boom fires.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Lottery Finder alerts"
        className="border-edge min-h-0 flex-1 overflow-y-auto border-b"
      >
        <Suspense fallback={<SkeletonSection lines={6} />}>
          <LotteryFinderSection marketOpen={marketOpen} />
        </Suspense>
      </section>
      <section
        aria-label="Silent Boom alerts"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Suspense fallback={<SkeletonSection lines={6} />}>
          <SilentBoomSection marketOpen={marketOpen} />
        </Suspense>
      </section>
    </div>
  );
}
