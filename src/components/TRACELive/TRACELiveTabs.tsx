/**
 * TRACELiveTabs — gamma / charm / delta tab nav.
 *
 * Three buttons rendered in canonical reading order (gamma first per the
 * override hierarchy: regime → direction → corridor). Active tab shown
 * with the accent border and tinted surface; idle tabs are muted text on
 * surface-alt.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { TraceChart } from './types';

interface Props {
  readonly activeChart: TraceChart;
  readonly onSelect: (c: TraceChart) => void;
}

const TABS: ReadonlyArray<{ chart: TraceChart; label: string }> = [
  { chart: 'gamma', label: 'Gamma' },
  { chart: 'charm', label: 'Charm' },
  { chart: 'delta', label: 'Delta' },
];

function TRACELiveTabs({ activeChart, onSelect }: Readonly<Props>) {
  return (
    <div
      className="border-edge mt-3 flex border-b"
      role="tablist"
      aria-label="TRACE chart selector"
    >
      {TABS.map(({ chart, label }) => {
        const isActive = chart === activeChart;
        return (
          <button
            key={chart}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`trace-live-tab-${chart}`}
            id={`trace-live-tab-${chart}-btn`}
            className={
              'cursor-pointer border-b-2 px-4 py-2 font-sans text-[11px] font-bold tracking-wider uppercase transition-colors' +
              (isActive
                ? ''
                : ' text-muted hover:text-tertiary border-transparent')
            }
            style={
              isActive
                ? {
                    color: theme.accent,
                    borderColor: theme.accent,
                    backgroundColor: tint(theme.accent, '08'),
                  }
                : undefined
            }
            onClick={() => onSelect(chart)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default memo(TRACELiveTabs);
