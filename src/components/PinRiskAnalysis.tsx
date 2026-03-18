import type { Theme } from '../themes';
import { tint } from '../utils/ui-utils';
import type { ChainResponse, ChainStrike } from '../types/api';

interface Props {
  th: Theme;
  chain: ChainResponse;
  spot: number;
}

interface OIStrike {
  strike: number;
  putOI: number;
  callOI: number;
  totalOI: number;
  distFromSpot: number;
  distPct: string;
  side: 'put' | 'call' | 'both';
}

/**
 * Combines put and call OI at each strike, returns top N by total OI.
 */
function getTopOIStrikes(
  puts: readonly ChainStrike[],
  calls: readonly ChainStrike[],
  spot: number,
  topN: number = 8,
): OIStrike[] {
  const oiMap = new Map<number, { putOI: number; callOI: number }>();

  for (const p of puts) {
    const entry = oiMap.get(p.strike) ?? { putOI: 0, callOI: 0 };
    entry.putOI = p.oi;
    oiMap.set(p.strike, entry);
  }
  for (const c of calls) {
    const entry = oiMap.get(c.strike) ?? { putOI: 0, callOI: 0 };
    entry.callOI = c.oi;
    oiMap.set(c.strike, entry);
  }

  const strikes: OIStrike[] = [];
  for (const [strike, { putOI, callOI }] of oiMap) {
    const totalOI = putOI + callOI;
    if (totalOI === 0) continue;
    const distFromSpot = strike - spot;
    strikes.push({
      strike,
      putOI,
      callOI,
      totalOI,
      distFromSpot,
      distPct: ((distFromSpot / spot) * 100).toFixed(2),
      side: putOI > callOI * 2 ? 'put' : callOI > putOI * 2 ? 'call' : 'both',
    });
  }

  strikes.sort((a, b) => b.totalOI - a.totalOI);
  return strikes.slice(0, topN);
}

function formatOI(oi: number): string {
  if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
  return String(oi);
}

export default function PinRiskAnalysis({ th, chain, spot }: Props) {
  const topStrikes = getTopOIStrikes(chain.puts, chain.calls, spot);

  if (topStrikes.length === 0) {
    return (
      <p className="text-muted text-xs italic">
        No open interest data available in the current chain.
      </p>
    );
  }

  const maxOI = topStrikes[0]?.totalOI ?? 1;

  // Identify if any top OI strike is within 0.5% of spot (pin risk zone)
  const pinRiskStrikes = topStrikes.filter(
    (s) => Math.abs(s.distFromSpot / spot) < 0.005,
  );
  const hasPinRisk = pinRiskStrikes.length > 0;

  return (
    <div>
      {/* Pin risk warning banner */}
      {hasPinRisk && (
        <div
          className="mb-3 flex items-start gap-3 rounded-[10px] p-3 sm:items-center sm:p-4"
          style={{
            backgroundColor: tint(th.caution, '10'),
            border: '1.5px solid ' + tint(th.caution, '30'),
          }}
        >
          <div
            className="h-3 w-3 shrink-0 rounded-full"
            style={{
              backgroundColor: th.caution,
              boxShadow: '0 0 8px ' + tint(th.caution, '66'),
            }}
          />
          <div>
            <span
              className="font-sans text-[10px] font-bold tracking-widest uppercase"
              style={{ color: th.caution }}
            >
              PIN RISK
            </span>
            <span className="text-secondary ml-2.5 font-sans text-[11px]">
              High OI at {pinRiskStrikes.map((s) => s.strike).join(', ')} —
              within 0.5% of spot. Price may gravitate toward these strikes near
              settlement.
            </span>
          </div>
        </div>
      )}

      {/* OI heatmap table */}
      <div className="bg-surface border-edge overflow-hidden rounded-[10px] border">
        <table className="w-full border-collapse text-left font-mono text-[11px]">
          <thead>
            <tr className="border-edge border-b">
              <th className="text-tertiary px-3 py-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                Strike
              </th>
              <th className="text-tertiary px-3 py-2 text-right font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                Put OI
              </th>
              <th className="text-tertiary px-3 py-2 text-right font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                Call OI
              </th>
              <th className="text-tertiary px-3 py-2 text-right font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                Total
              </th>
              <th className="text-tertiary px-3 py-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                Dist
              </th>
              <th className="text-tertiary w-[30%] px-3 py-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                {/* bar column */}
              </th>
            </tr>
          </thead>
          <tbody>
            {topStrikes.map((s) => {
              const isNearSpot = Math.abs(s.distFromSpot / spot) < 0.005;
              const barColor =
                s.side === 'put'
                  ? th.red
                  : s.side === 'call'
                    ? th.green
                    : th.accent;

              return (
                <tr
                  key={s.strike}
                  className="border-edge border-b last:border-b-0"
                  style={
                    isNearSpot
                      ? { backgroundColor: tint(th.caution, '08') }
                      : undefined
                  }
                >
                  <td className="px-3 py-1.5">
                    <span
                      className="font-bold"
                      style={isNearSpot ? { color: th.caution } : undefined}
                    >
                      {s.strike}
                    </span>
                    {isNearSpot && (
                      <span
                        className="ml-1.5 font-sans text-[8px] font-bold"
                        style={{ color: th.caution }}
                      >
                        PIN
                      </span>
                    )}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right"
                    style={{ color: s.putOI > s.callOI ? th.red : undefined }}
                  >
                    {formatOI(s.putOI)}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right"
                    style={{ color: s.callOI > s.putOI ? th.green : undefined }}
                  >
                    {formatOI(s.callOI)}
                  </td>
                  <td className="text-primary px-3 py-1.5 text-right font-bold">
                    {formatOI(s.totalOI)}
                  </td>
                  <td className="text-muted px-3 py-1.5 text-[10px]">
                    {s.distFromSpot > 0 ? '+' : ''}
                    {s.distFromSpot.toFixed(0)} ({s.distPct}%)
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
                      <div
                        className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
                        style={{
                          width: (s.totalOI / maxOI) * 100 + '%',
                          backgroundColor: barColor,
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-muted mt-2 font-sans text-[10px] leading-relaxed">
        Top strikes by combined open interest. High OI near spot creates
        &ldquo;gravity&rdquo; — MMs delta-hedging large positions can pin price
        at settlement. Avoid short strikes near high-OI zones.
      </p>
    </div>
  );
}
