/**
 * SkeletonSection — loading placeholder matching SectionBox shape.
 *
 * Replaces minimal "Loading..." Suspense fallbacks with a shimmer effect
 * that preserves layout stability during lazy-load.
 */

import { memo } from 'react';

interface Props {
  /** Number of skeleton content bars (default 4) */
  lines?: number;
  /** If true, adds extra bars for taller sections */
  tall?: boolean;
}

const WIDTH_CYCLE = ['100%', '85%', '70%', '90%'] as const;

const SkeletonSection = memo(function SkeletonSection({
  lines = 4,
  tall = false,
}: Props) {
  const totalLines = tall ? lines + 4 : lines;

  return (
    <div
      aria-busy="true"
      className="border-edge border-t-edge-strong bg-surface mt-6 rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 first:mt-0"
    >
      {/* Header skeleton */}
      <div className="bg-surface-alt mb-3.5 h-3 w-[120px] animate-pulse rounded-full" />

      {/* Content bars */}
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: totalLines }, (_, i) => (
          <div
            key={i}
            className="bg-surface-alt h-2.5 animate-pulse rounded"
            style={{
              width: WIDTH_CYCLE[i % WIDTH_CYCLE.length],
              animationDelay: `${i * 80}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
});

export default SkeletonSection;
