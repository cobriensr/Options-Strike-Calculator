import { useInstitutionalProgram } from '../../hooks/useInstitutionalProgram.js';
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
 *   3. Opening positioning: OpeningBlocksCard
 */
export function InstitutionalProgramSection() {
  const { data, loading, error } = useInstitutionalProgram(60);

  if (loading) {
    return (
      <section className="border-edge bg-surface-alt rounded-xl border p-6 text-sm text-slate-500">
        Loading institutional program tracker…
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-sm text-red-400">
        Institutional program tracker unavailable{' '}
        {error ? <span className="text-red-500">({error.message})</span> : null}
      </section>
    );
  }

  const today = data.days[data.days.length - 1] ?? null;

  return (
    <section
      aria-labelledby="inst-program-heading"
      className="border-edge bg-surface-alt space-y-4 rounded-xl border p-6"
    >
      <header className="flex items-baseline justify-between">
        <h2
          id="inst-program-heading"
          className="text-lg font-semibold text-slate-100"
        >
          SPXW Institutional Program Tracker
        </h2>
        <span className="text-xs text-slate-500">
          mfsl / cbmo / slft — ceiling (180-300 DTE) + opening-ATM (0-7 DTE)
        </span>
      </header>

      <RegimeBanner days={data.days} />
      <TodayProgramCard today={today} blocks={data.today.blocks} />
      <OpeningBlocksCard blocks={data.today.blocks} />
      <CeilingChart days={data.days} />
      <StrikeConcentrationChart />
    </section>
  );
}
