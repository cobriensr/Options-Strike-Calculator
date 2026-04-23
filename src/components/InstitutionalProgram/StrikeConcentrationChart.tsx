import { useState } from 'react';
import { useStrikeHeatmap } from '../../hooks/useInstitutionalProgram.js';

/**
 * Horizontal bar chart: top 40 strikes by cumulative institutional
 * premium over the selected window. Answers implication #2 —
 * "where has the big money been building positions?"
 *
 * Switchable between ceiling track (9-month program) and opening_atm
 * track (first-hour near-ATM blocks).
 */
export function StrikeConcentrationChart() {
  const [track, setTrack] = useState<'ceiling' | 'opening_atm'>('ceiling');
  const [days, setDays] = useState<30 | 60 | 90>(60);
  const { data, loading } = useStrikeHeatmap(track, days);

  if (loading) {
    return (
      <div className="border-edge bg-surface-alt rounded-lg border p-3 text-xs text-slate-500">
        Loading strike concentration…
      </div>
    );
  }

  if (!data || !data.rows.length) {
    return (
      <div className="border-edge bg-surface-alt rounded-lg border p-3 text-xs text-slate-500">
        No strike-concentration data yet for {track} track over last {days}{' '}
        days.
      </div>
    );
  }

  const cells = data.rows;
  // Sort by strike descending for a natural "above-spot up top" layout
  // with a spot reference line overlaid.
  const sorted = [...cells].sort((a, b) => b.strike - a.strike);
  const maxPrem = Math.max(...sorted.map((c) => c.total_premium));
  const spot = data.spot;

  const W = 680;
  const rowH = 20;
  const gap = 3;
  const barStart = 170;
  const totalH = sorted.length * (rowH + gap) + 40;

  // Index of the first row whose strike is <= spot — draw the spot
  // indicator right above that row.
  const spotRowIdx =
    spot != null ? sorted.findIndex((c) => c.strike <= spot) : -1;

  return (
    <figure
      className="border-edge bg-surface-alt rounded-lg border p-3"
      aria-labelledby="strike-heatmap-caption"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <figcaption
          id="strike-heatmap-caption"
          className="text-xs text-slate-400"
        >
          Strike concentration — cumulative institutional premium,{' '}
          {track.replace('_', '-')} track, last {days} days
          {spot != null && <> (spot ≈ {spot.toFixed(0)})</>}
        </figcaption>
        <div className="flex gap-1">
          <select
            value={track}
            onChange={(e) =>
              setTrack(e.target.value as 'ceiling' | 'opening_atm')
            }
            className="border-edge bg-surface rounded border px-2 py-1 text-xs text-slate-300"
            aria-label="Track filter"
          >
            <option value="ceiling">Ceiling (180-300 DTE)</option>
            <option value="opening_atm">Opening ATM (0-7 DTE)</option>
          </select>
          <select
            value={days}
            onChange={(e) =>
              setDays(Number.parseInt(e.target.value, 10) as 30 | 60 | 90)
            }
            className="border-edge bg-surface rounded border px-2 py-1 text-xs text-slate-300"
            aria-label="Window size"
          >
            <option value={30}>30d</option>
            <option value={60}>60d</option>
            <option value={90}>90d</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${totalH}`}
          role="img"
          aria-label="Cumulative institutional premium per strike"
          className="block w-full"
        >
          {sorted.map((c, i) => {
            const y = i * (rowH + gap);
            const barW = (c.total_premium / maxPrem) * (W - barStart - 20);
            const fillColor =
              c.option_type === 'call'
                ? 'var(--color-call, #22c55e)'
                : 'var(--color-put, #ef4444)';
            return (
              <g key={`${c.strike}-${c.option_type}`}>
                <text
                  x={barStart - 8}
                  y={y + rowH * 0.7}
                  textAnchor="end"
                  fontSize="11"
                  fill="var(--color-text, #cbd5e1)"
                  fontFamily="var(--font-mono)"
                >
                  {c.strike}
                  {c.option_type[0]!.toUpperCase()}
                </text>
                <rect
                  x={barStart}
                  y={y}
                  width={Math.max(barW, 1)}
                  height={rowH}
                  fill={fillColor}
                  opacity={0.7}
                  rx={2}
                >
                  <title>
                    {`${c.strike} ${c.option_type}: $${(c.total_premium / 1e6).toFixed(2)}M across ${c.active_days} days (${c.total_contracts.toLocaleString()} contracts, last ${c.last_seen_date})`}
                  </title>
                </rect>
                <text
                  x={barStart + barW + 4}
                  y={y + rowH * 0.7}
                  fontSize="10"
                  fill="var(--color-text-muted, #94a3b8)"
                >
                  ${(c.total_premium / 1e6).toFixed(1)}M · {c.active_days}d
                </text>
              </g>
            );
          })}
          {spotRowIdx >= 0 && (
            <g>
              <line
                x1={barStart}
                y1={spotRowIdx * (rowH + gap) - 2}
                x2={W - 10}
                y2={spotRowIdx * (rowH + gap) - 2}
                stroke="var(--color-accent, #60a5fa)"
                strokeWidth="1.25"
                strokeDasharray="4 2"
              />
              <text
                x={barStart + 4}
                y={spotRowIdx * (rowH + gap) - 5}
                fontSize="10"
                fill="var(--color-accent, #60a5fa)"
                fontFamily="var(--font-mono)"
              >
                SPX ≈ {spot?.toFixed(0)}
              </text>
            </g>
          )}
        </svg>
      </div>
    </figure>
  );
}
