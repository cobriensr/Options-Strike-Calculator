/**
 * Hover tooltip for a GexPerStrike row.
 *
 * Floats near the cursor, pointer-events disabled so it never interferes
 * with the row's mouse tracking. Layout is a 3-column grid per greek:
 * label, net value, and call/put breakdown.
 */

import { theme } from '../../themes';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import {
  CHARM_POS,
  CHARM_NEG,
  VANNA_POS,
  VANNA_NEG,
  DEX_POS,
  DEX_NEG,
} from './colors';
import { formatNum } from './formatters';
import {
  getNetGamma,
  getNetCharm,
  getNetVanna,
  getCallGamma,
  getPutGamma,
  type ViewMode,
} from './mode';

export function GexTooltip({
  data,
  viewMode,
  x,
  y,
}: Readonly<{
  data: GexStrikeLevel;
  viewMode: ViewMode;
  x: number;
  y: number;
}>) {
  const netGex = getNetGamma(data, viewMode);
  const netCharmView = getNetCharm(data, viewMode);
  const netVannaView = getNetVanna(data, viewMode);
  const charmEffect = netCharmView > 0 ? 'Strengthening' : 'Weakening';
  const vannaDir =
    netVannaView > 0 ? 'Sell pressure if IV drops' : 'Buy pressure if IV drops';
  const volLabel =
    data.volReinforcement === 'reinforcing'
      ? 'Reinforcing'
      : data.volReinforcement === 'opposing'
        ? 'Opposing'
        : '—';

  return (
    <div
      className="pointer-events-none fixed z-50 min-w-[260px] rounded-md border border-[rgba(255,255,255,0.08)] p-3 font-mono text-[11px] shadow-xl backdrop-blur-xl"
      style={{
        left: x + 16,
        top: y - 120,
        backgroundColor: 'rgba(10,10,18,0.96)',
        color: theme.textSecondary,
      }}
    >
      <div
        className="mb-2 border-b border-[rgba(255,255,255,0.06)] pb-1.5 text-[13px] font-bold"
        style={{ color: theme.text }}
      >
        Strike {data.strike}
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-1">
        {/* Header row */}
        <span />
        <span className="text-[9px]" style={{ color: theme.textMuted }}>
          Net
        </span>
        <span className="text-[9px]" style={{ color: theme.textMuted }}>
          C / P
        </span>

        {/* GEX */}
        <span>GEX</span>
        <span
          className="font-semibold"
          style={{ color: netGex >= 0 ? theme.green : theme.red }}
        >
          {formatNum(netGex)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: theme.green }}>
            {formatNum(getCallGamma(data, viewMode))}
          </span>
          {' / '}
          <span style={{ color: theme.red }}>
            {formatNum(getPutGamma(data, viewMode))}
          </span>
        </span>

        {/* Charm */}
        <span>Charm</span>
        <span
          className="font-semibold"
          style={{
            color: netCharmView >= 0 ? CHARM_POS : CHARM_NEG,
          }}
        >
          {formatNum(netCharmView)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: CHARM_POS }}>
            {formatNum(
              viewMode === 'vol' ? data.callCharmVol : data.callCharmOi,
            )}
          </span>
          {' / '}
          <span style={{ color: CHARM_NEG }}>
            {formatNum(viewMode === 'vol' ? data.putCharmVol : data.putCharmOi)}
          </span>
        </span>

        {/* DEX (OI only — no vol variant from UW) */}
        <span>DEX</span>
        <span
          className="font-semibold"
          style={{ color: data.netDelta >= 0 ? DEX_POS : DEX_NEG }}
        >
          {formatNum(data.netDelta)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: DEX_POS }}>{formatNum(data.callDeltaOi)}</span>
          {' / '}
          <span style={{ color: DEX_NEG }}>{formatNum(data.putDeltaOi)}</span>
        </span>

        {/* Vanna */}
        <span>Vanna</span>
        <span
          className="font-semibold"
          style={{
            color: netVannaView >= 0 ? VANNA_POS : VANNA_NEG,
          }}
        >
          {formatNum(netVannaView)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: VANNA_POS }}>
            {formatNum(
              viewMode === 'vol' ? data.callVannaVol : data.callVannaOi,
            )}
          </span>
          {' / '}
          <span style={{ color: VANNA_NEG }}>
            {formatNum(viewMode === 'vol' ? data.putVannaVol : data.putVannaOi)}
          </span>
        </span>
      </div>

      {/* Analysis section */}
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-[rgba(255,255,255,0.06)] pt-2">
        <span>Charm Effect</span>
        <span
          style={{
            color: netCharmView > 0 ? CHARM_POS : CHARM_NEG,
          }}
        >
          {charmEffect}
        </span>
        <span>Vanna Hedge</span>
        <span
          className="text-[10px]"
          style={{
            color: netVannaView > 0 ? VANNA_POS : VANNA_NEG,
          }}
        >
          {vannaDir}
        </span>
        <span>Vol Flow</span>
        <span
          className="text-[10px]"
          style={{
            color:
              data.volReinforcement === 'reinforcing'
                ? theme.green
                : data.volReinforcement === 'opposing'
                  ? theme.red
                  : theme.textMuted,
          }}
        >
          {volLabel}
        </span>
      </div>
    </div>
  );
}
