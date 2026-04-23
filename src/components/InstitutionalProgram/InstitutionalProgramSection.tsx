import { useMemo, useState } from 'react';
import { useInstitutionalProgram } from '../../hooks/useInstitutionalProgram.js';
import { SectionBox } from '../ui';
import { CeilingChart } from './CeilingChart.js';
import { OpeningBlocksCard } from './OpeningBlocksCard.js';
import { RegimeBanner } from './RegimeBanner.js';
import { StrikeConcentrationChart } from './StrikeConcentrationChart.js';
import { TodayProgramCard } from './TodayProgramCard.js';

/**
 * SPXW institutional program tracker — regime indicator built on
 * floor-brokered mfsl/cbmo/slft blocks. Surfaces all three mfsl
 * implications from docs/0dte-findings.md:
 *
 *   1. Non-directional: pair-level direction only, never per-leg
 *   2. Strike concentration: StrikeConcentrationChart
 *   3. Opening positioning: OpeningBlocksCard (with date picker for
 *      backtesting prior days)
 *
 * Mounts in a SectionBox so it matches the rest of the app and
 * participates in the global collapse-all broadcast.
 */
export function InstitutionalProgramSection() {
  // Date picker for backtesting. Empty string = today. YYYY-MM-DD otherwise.
  const [backtestDate, setBacktestDate] = useState('');
  const { data, loading, error } = useInstitutionalProgram(
    60,
    backtestDate || undefined,
  );

  const latestDate = useMemo(
    () => data?.days[data.days.length - 1]?.date ?? null,
    [data],
  );

  const headerRight = latestDate ? (
    <span className="text-muted font-mono text-[11px]">
      last day {latestDate}
    </span>
  ) : null;

  const badge = backtestDate ? 'HISTORICAL' : null;
  const badgeColor = backtestDate ? 'var(--color-amber-500)' : undefined;

  let body;
  if (loading) {
    body = <div className="text-muted text-sm">Loading institutional program…</div>;
  } else if (error || !data) {
    body = (
      <div className="text-sm text-red-400">
        Program tracker unavailable
        {error ? <span className="text-red-500"> ({error.message})</span> : null}
      </div>
    );
  } else {
    const today = data.days[data.days.length - 1] ?? null;
    body = (
      <div className="flex flex-col gap-4">
        {/* Backtesting date picker — drives the today/blocks slot only.
            The ceiling chart and strike heatmap always show the rolling
            window; only the "today" card and opening-blocks feed change. */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-muted text-xs">Opening-ATM date:</label>
          <input
            type="date"
            value={backtestDate}
            onChange={(e) => setBacktestDate(e.target.value)}
            className="border-edge bg-surface text-text rounded border px-2 py-1 font-mono text-xs"
            max={new Date().toISOString().slice(0, 10)}
          />
          {backtestDate && (
            <button
              type="button"
              onClick={() => setBacktestDate('')}
              className="text-muted hover:text-text text-xs underline underline-offset-2"
            >
              reset to today
            </button>
          )}
        </div>

        <RegimeBanner days={data.days} />
        <TodayProgramCard today={today} blocks={data.today.blocks} />
        <OpeningBlocksCard
          blocks={data.today.blocks}
          dateLabel={data.today.date}
        />
        <CeilingChart days={data.days} />
        <StrikeConcentrationChart />
      </div>
    );
  }

  return (
    <SectionBox
      label="SPXW Institutional Program"
      badge={badge}
      badgeColor={badgeColor}
      headerRight={headerRight}
      collapsible
    >
      {body}
    </SectionBox>
  );
}
