import { theme } from '../themes';
import { tint } from '../utils/ui-utils';
import { getTopOIStrikes, formatOI } from '../utils/pin-risk';
import type { ChainResponse } from '../types/api';

interface Props {
  chain: ChainResponse;
  spot: number;
}

export default function PinRiskAnalysis({ chain, spot }: Readonly<Props>) {
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
            backgroundColor: tint(theme.caution, '10'),
            border: '1.5px solid ' + tint(theme.caution, '30'),
          }}
        >
          <div
            className="h-3 w-3 shrink-0 rounded-full"
            style={{
              backgroundColor: theme.caution,
              boxShadow: '0 0 8px ' + tint(theme.caution, '66'),
            }}
          />
          <div>
            <span
              className="font-sans text-[10px] font-bold tracking-widest uppercase"
              style={{ color: theme.caution }}
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
              <th
                scope="col"
                className="text-tertiary px-3 py-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              >
                Strike
              </th>
              <th
                scope="col"
                className="text-tertiary px-3 py-2 text-right font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              >
                Put OI
              </th>
              <th
                scope="col"
                className="text-tertiary px-3 py-2 text-right font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              >
                Call OI
              </th>
              <th
                scope="col"
                className="text-tertiary px-3 py-2 text-right font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              >
                Total
              </th>
              <th
                scope="col"
                className="text-tertiary px-3 py-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              >
                Dist
              </th>
              <th
                scope="col"
                aria-label="Visual indicator"
                className="text-tertiary w-[30%] px-3 py-2 font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              >
                {/* bar column */}
              </th>
            </tr>
          </thead>
          <tbody>
            {topStrikes.map((s) => {
              const isNearSpot = Math.abs(s.distFromSpot / spot) < 0.005;
              const barColor =
                s.side === 'put'
                  ? theme.red
                  : s.side === 'call'
                    ? theme.green
                    : theme.accent;

              return (
                <tr
                  key={s.strike}
                  className="border-edge border-b last:border-b-0"
                  style={
                    isNearSpot
                      ? { backgroundColor: tint(theme.caution, '08') }
                      : undefined
                  }
                >
                  <td className="px-3 py-1.5">
                    <span
                      className="font-bold"
                      style={isNearSpot ? { color: theme.caution } : undefined}
                    >
                      {s.strike}
                    </span>
                    {isNearSpot && (
                      <span
                        className="ml-1.5 font-sans text-[8px] font-bold"
                        style={{ color: theme.caution }}
                      >
                        PIN
                      </span>
                    )}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right"
                    style={{
                      color: s.putOI > s.callOI ? theme.red : undefined,
                    }}
                  >
                    {formatOI(s.putOI)}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right"
                    style={{
                      color: s.callOI > s.putOI ? theme.green : undefined,
                    }}
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
