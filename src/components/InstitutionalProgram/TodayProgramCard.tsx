import type {
  DailyProgramSummary,
  InstitutionalBlock,
} from '../../hooks/useInstitutionalProgram.js';

interface Props {
  today: DailyProgramSummary | null;
  blocks: InstitutionalBlock[];
}

/**
 * Today's dominant program pair + expandable block log for the
 * ceiling track. Shows the institutional "ceiling view" of SPX
 * alongside the raw blocks that generated it.
 */
export function TodayProgramCard({ today, blocks }: Props) {
  const ceilingBlocks = blocks.filter((b) => b.program_track === 'ceiling');

  if (!today?.dominant_pair) {
    return (
      <div className="border-edge bg-surface-alt rounded-lg border p-4 text-sm text-slate-500">
        No paired institutional ceiling blocks detected today yet. (First poll
        at 08:45 CT.)
      </div>
    );
  }

  const { low_strike, high_strike, direction, total_size, total_premium } =
    today.dominant_pair;
  const spot = today.avg_spot ?? 0;
  const ceilingPct = today.ceiling_pct_above_spot ?? 0;

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Metric label="Spread" value={`${low_strike} / ${high_strike}`} />
      <Metric
        label="Direction"
        value={direction.toUpperCase()}
        tone={
          direction === 'sell' ? 'green' : direction === 'buy' ? 'red' : 'gray'
        }
      />
      <Metric label="Contracts" value={total_size.toLocaleString()} />
      <Metric
        label="Premium"
        value={`$${(total_premium / 1_000_000).toFixed(1)}M`}
      />
      <Metric label="Spot" value={spot.toFixed(2)} />
      <Metric
        label="Ceiling above spot"
        value={`${(ceilingPct * 100).toFixed(1)}%`}
        tone="blue"
      />
      <details className="md:col-span-3">
        <summary className="cursor-pointer text-sm text-slate-400">
          All ceiling blocks today ({ceilingBlocks.length})
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs text-slate-300">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="p-1 text-left">Time (UTC)</th>
                <th className="p-1 text-right">Strike</th>
                <th className="p-1">Type</th>
                <th className="p-1 text-right">DTE</th>
                <th className="p-1 text-right">Size</th>
                <th className="p-1 text-right">Premium</th>
                <th className="p-1">Side</th>
                <th className="p-1">Cond</th>
              </tr>
            </thead>
            <tbody>
              {ceilingBlocks.map((b) => (
                <tr
                  key={b.executed_at + b.option_chain_id}
                  className="border-b border-slate-900"
                >
                  <td className="p-1 font-mono">
                    {new Date(b.executed_at)
                      .toISOString()
                      .slice(11, 19)}
                  </td>
                  <td className="p-1 text-right font-mono">{b.strike}</td>
                  <td className="p-1">{b.option_type[0]!.toUpperCase()}</td>
                  <td className="p-1 text-right">{b.dte}</td>
                  <td className="p-1 text-right">
                    {b.size.toLocaleString()}
                  </td>
                  <td className="p-1 text-right">
                    ${(b.premium / 1000).toFixed(0)}k
                  </td>
                  <td className="p-1">{b.side ?? '—'}</td>
                  <td className="p-1 text-slate-500">{b.condition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string;
  tone?: 'slate' | 'blue' | 'green' | 'red' | 'gray';
}) {
  const toneClass = {
    slate: 'text-slate-100',
    blue: 'text-blue-300',
    green: 'text-green-300',
    red: 'text-red-300',
    gray: 'text-slate-400',
  }[tone];
  return (
    <div className="border-edge bg-surface-alt rounded-lg border p-3">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
