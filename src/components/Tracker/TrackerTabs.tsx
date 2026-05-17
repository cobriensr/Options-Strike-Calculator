/**
 * TrackerTabs — three-way tab switcher for the Tracker section.
 *
 * Tabs:
 *   - Active     status='active' rows
 *   - Watchlist  Active rows with DTE ≤ 7 OR an unread alert
 *   - Archive    status IN ('closed','expired') rows
 *
 * Counts come from the parent so each tab can show a badge with the
 * number of rows in that view.
 */

import { memo } from 'react';

export type TrackerTab = 'active' | 'watchlist' | 'archive';

const TAB_LABELS: Record<TrackerTab, string> = {
  active: 'Active',
  watchlist: 'Watchlist',
  archive: 'Archive',
};

interface Props {
  current: TrackerTab;
  onChange: (next: TrackerTab) => void;
  counts: Record<TrackerTab, number>;
}

export const TrackerTabs = memo(function TrackerTabs({
  current,
  onChange,
  counts,
}: Props) {
  return (
    <div
      role="tablist"
      aria-label="Tracker tabs"
      className="border-edge mb-3 flex items-center gap-1 border-b"
    >
      {(Object.keys(TAB_LABELS) as TrackerTab[]).map((tab) => {
        const active = tab === current;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`tracker-tab-${tab}`}
            onClick={() => onChange(tab)}
            className={
              'cursor-pointer px-3 py-2 font-sans text-[13px] font-semibold ' +
              'transition-colors ' +
              (active
                ? 'text-accent border-accent -mb-px border-b-2'
                : 'text-secondary hover:text-primary')
            }
          >
            {TAB_LABELS[tab]}
            <span
              className={
                'ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold ' +
                (active
                  ? 'text-accent bg-accent-bg'
                  : 'text-tertiary bg-surface-alt')
              }
            >
              {counts[tab]}
            </span>
          </button>
        );
      })}
    </div>
  );
});
