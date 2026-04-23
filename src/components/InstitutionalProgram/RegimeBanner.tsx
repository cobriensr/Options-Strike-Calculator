import type { DailyProgramSummary } from '../../hooks/useInstitutionalProgram.js';

interface Props {
  days: DailyProgramSummary[];
}

/**
 * Surfaces a regime-change banner when either:
 *   - 5-day-avg ceiling moved >0.5pp vs prior 5-day-avg (rising/pulling-in)
 *   - Majority direction flipped (sell → buy or vice versa)
 *
 * Returns null when the signal is quiet so the section stays clean.
 */
export function RegimeBanner({ days }: Props) {
  if (days.length < 10) return null;

  const recent = days.slice(-5);
  const prior = days.slice(-10, -5);

  const recentValues = recent
    .map((d) => d.ceiling_pct_above_spot)
    .filter((v): v is number => v != null);
  const priorValues = prior
    .map((d) => d.ceiling_pct_above_spot)
    .filter((v): v is number => v != null);

  if (!recentValues.length || !priorValues.length) return null;

  const recentAvg =
    recentValues.reduce((s, v) => s + v, 0) / recentValues.length;
  const priorAvg = priorValues.reduce((s, v) => s + v, 0) / priorValues.length;
  const deltaPct = recentAvg - priorAvg;

  const recentDirs = recent
    .map((d) => d.dominant_pair?.direction)
    .filter((d): d is 'sell' | 'buy' | 'mixed' => !!d);
  const priorDirs = prior
    .map((d) => d.dominant_pair?.direction)
    .filter((d): d is 'sell' | 'buy' | 'mixed' => !!d);

  const recentMaj = majority(recentDirs);
  const priorMaj = majority(priorDirs);
  const directionFlip =
    recentMaj != null && priorMaj != null && recentMaj !== priorMaj;

  if (Math.abs(deltaPct) < 0.005 && !directionFlip) return null;

  let tone: 'green' | 'red' | 'amber' = 'amber';
  if (directionFlip) tone = 'red';
  else if (deltaPct > 0) tone = 'green';

  const toneClass = {
    green: 'border-green-800 bg-green-950/30 text-green-200',
    red: 'border-red-800 bg-red-950/30 text-red-200',
    amber: 'border-amber-800 bg-amber-950/30 text-amber-200',
  }[tone];

  return (
    <div className={`rounded-lg border p-3 text-sm ${toneClass}`} role="status">
      <strong>Regime signal: </strong>
      {directionFlip ? (
        <>
          Direction flip — majority shifted from <code>{priorMaj}</code> to{' '}
          <code>{recentMaj}</code> over the past 5 days.
        </>
      ) : (
        <>
          Ceiling {deltaPct > 0 ? 'rising' : 'pulling in'} — 5-day avg vs prior
          5-day avg: {deltaPct > 0 ? '+' : ''}
          {(deltaPct * 100).toFixed(2)} pp.
        </>
      )}
    </div>
  );
}

function majority<T extends string>(xs: T[]): T | null {
  if (!xs.length) return null;
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: { v: T; n: number } | null = null;
  for (const [v, n] of counts) {
    if (!best || n > best.n) best = { v, n };
  }
  return best?.v ?? null;
}
