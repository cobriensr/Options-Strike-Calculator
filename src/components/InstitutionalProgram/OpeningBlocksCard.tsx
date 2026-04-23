import type { InstitutionalBlock } from '../../hooks/useInstitutionalProgram.js';

interface Props {
  blocks: InstitutionalBlock[];
}

/**
 * Today's first-hour near-ATM institutional blocks (opening_atm track).
 * These are the rare but high-conviction mfsl/cbmo/slft prints that
 * hit at 08:30-09:30 CT — implication #3 of the mfsl deep-dive.
 */
export function OpeningBlocksCard({ blocks }: Props) {
  const openingBlocks = blocks.filter((b) => b.program_track === 'opening_atm');

  if (!openingBlocks.length) {
    return (
      <div className="border-edge bg-surface-alt rounded-lg border p-3 text-sm text-slate-500">
        No opening-hour institutional blocks detected today (08:30-09:30 CT,
        near-ATM, mfsl/cbmo/slft).
      </div>
    );
  }

  return (
    <div className="border-edge bg-surface-alt rounded-lg border p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">
          Today's opening institutional blocks
        </h3>
        <span className="text-xs text-slate-500">
          {openingBlocks.length} block{openingBlocks.length === 1 ? '' : 's'}{' '}
          — 08:30-09:30 CT, near-ATM
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-slate-300">
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              <th className="p-1 text-left">Time (CT)</th>
              <th className="p-1 text-right">Strike</th>
              <th className="p-1">Type</th>
              <th className="p-1 text-right">DTE</th>
              <th className="p-1 text-right">Size</th>
              <th className="p-1 text-right">Premium</th>
              <th className="p-1 text-right">Mny</th>
              <th className="p-1">Cond</th>
            </tr>
          </thead>
          <tbody>
            {openingBlocks.map((b) => {
              const ct = new Date(
                new Date(b.executed_at).getTime() - 5 * 3600 * 1000,
              );
              return (
                <tr
                  key={b.executed_at + b.option_chain_id}
                  className="border-b border-slate-900"
                >
                  <td className="p-1 font-mono">
                    {ct.toISOString().slice(11, 19)}
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
                  <td className="p-1 text-right">
                    {(b.moneyness_pct * 100).toFixed(2)}%
                  </td>
                  <td className="p-1 text-slate-500">{b.condition}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
