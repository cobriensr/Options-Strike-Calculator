import { useState } from 'react';
import type { Theme } from '../themes';
import type { IronCondorLegs, CalculationResults, HedgeDelta, HedgeScenario } from '../types';
import { calcHedge } from '../utils/calculator';
import { HEDGE_DELTA_OPTIONS } from '../constants';
import { mkTh, mkTd, fmtDollar } from './ui';

interface Props {
  th: Theme;
  results: CalculationResults;
  ic: IronCondorLegs;
  contracts: number;
  skew: number;
}

export default function HedgeSection({ th, results, ic, contracts, skew }: Props) {
  const [hedgeDelta, setHedgeDelta] = useState<HedgeDelta>(2);
  const [showScenarios, setShowScenarios] = useState(false);

  const hedge = calcHedge({
    spot: results.spot,
    sigma: results.sigma,
    T: results.T,
    skew,
    icContracts: contracts,
    icCreditPts: ic.creditReceived,
    icMaxLossPts: ic.maxLoss,
    icShortPut: ic.shortPut,
    icLongPut: ic.longPut,
    icShortCall: ic.shortCall,
    icLongCall: ic.longCall,
    hedgeDelta,
  });

  const crashScenarios = hedge.scenarios.filter((s) => s.direction === 'crash');
  const rallyScenarios = hedge.scenarios.filter((s) => s.direction === 'rally');

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.14em', color: th.accent }}>
          Hedge Calculator (Reinsurance)
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif", marginRight: 4 }}>
            Hedge Δ
          </span>
          {HEDGE_DELTA_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setHedgeDelta(d)}
              role="radio"
              aria-checked={hedgeDelta === d}
              style={{
                padding: '3px 10px', borderRadius: 99, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                border: '1.5px solid ' + (hedgeDelta === d ? th.chipActiveBorder : th.chipBorder),
                backgroundColor: hedgeDelta === d ? th.chipActiveBg : th.chipBg,
                color: hedgeDelta === d ? th.chipActiveText : th.chipText,
                fontFamily: "'DM Mono', monospace", transition: 'all 0.1s',
              }}
            >
              {d}{'\u0394'}
            </button>
          ))}
        </div>
      </div>

      {/* Recommendation Summary */}
      <div style={{
        backgroundColor: th.surfaceAlt, borderRadius: 10, padding: 16,
        border: '1px solid ' + th.border, marginBottom: 12,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          {/* Put Hedge */}
          <div style={{ borderRight: '1px solid ' + th.border, paddingRight: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.red, fontFamily: "'Outfit', sans-serif", marginBottom: 8 }}>
              Put Hedge (Crash Protection)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <StatBox th={th} label="Buy Puts" value={String(hedge.recommendedPuts)} accent={th.red} large />
              <StatBox th={th} label="Strike" value={String(hedge.putStrikeSnapped)} />
              <StatBox th={th} label="Premium" value={hedge.putPremium.toFixed(2) + ' pts'} />
              <StatBox th={th} label="Cost" value={'$' + fmtDollar(hedge.putPremium * 100 * hedge.recommendedPuts)} />
            </div>
            <div style={{ fontSize: 10, color: th.textMuted, marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
              Breakeven at {'\u2193'}{hedge.breakEvenCrashPts} pts ({(hedge.breakEvenCrashPts / results.spot * 100).toFixed(1)}%)
            </div>
          </div>

          {/* Call Hedge */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: th.green, fontFamily: "'Outfit', sans-serif", marginBottom: 8 }}>
              Call Hedge (Rally Protection)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <StatBox th={th} label="Buy Calls" value={String(hedge.recommendedCalls)} accent={th.green} large />
              <StatBox th={th} label="Strike" value={String(hedge.callStrikeSnapped)} />
              <StatBox th={th} label="Premium" value={hedge.callPremium.toFixed(2) + ' pts'} />
              <StatBox th={th} label="Cost" value={'$' + fmtDollar(hedge.callPremium * 100 * hedge.recommendedCalls)} />
            </div>
            <div style={{ fontSize: 10, color: th.textMuted, marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
              Breakeven at {'\u2191'}{hedge.breakEvenRallyPts} pts ({(hedge.breakEvenRallyPts / results.spot * 100).toFixed(1)}%)
            </div>
          </div>
        </div>

        {/* Total Summary */}
        <div style={{
          marginTop: 12, paddingTop: 12, borderTop: '1px solid ' + th.border,
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
        }}>
          <StatBox th={th} label="Daily Hedge Cost" value={'$' + fmtDollar(hedge.dailyCostDollars)} accent={th.red} />
          <StatBox th={th} label="IC Credit" value={'$' + fmtDollar(ic.creditReceived * 100 * contracts)} accent={th.green} />
          <StatBox th={th} label="Net Credit After Hedge" value={'$' + fmtDollar(hedge.netCreditAfterHedge)} accent={hedge.netCreditAfterHedge > 0 ? th.green : th.red} />
          <StatBox th={th} label="Hedge % of Credit" value={(hedge.dailyCostDollars / (ic.creditReceived * 100 * contracts) * 100).toFixed(1) + '%'} />
        </div>
      </div>

      {/* Scenario Toggle */}
      <button
        onClick={() => setShowScenarios(!showScenarios)}
        style={{
          width: '100%', padding: '8px 14px', borderRadius: 8,
          border: '1px solid ' + th.border,
          backgroundColor: th.chipBg, color: th.textSecondary,
          cursor: 'pointer', fontSize: 12, fontWeight: 600,
          fontFamily: "'Outfit', sans-serif",
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        {showScenarios ? '\u25B2' : '\u25BC'} {showScenarios ? 'Hide' : 'Show'} P&L Scenario Table
      </button>

      {/* Scenario Table */}
      {showScenarios && (
        <div style={{ marginTop: 12 }}>
          {/* Crash Scenarios */}
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: th.red, fontFamily: "'Outfit', sans-serif", marginBottom: 6 }}>
            Crash Scenarios (SPX drops)
          </div>
          <ScenarioTable th={th} scenarios={crashScenarios} spot={results.spot} direction="crash" />

          {/* Rally Scenarios */}
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: th.green, fontFamily: "'Outfit', sans-serif", marginTop: 14, marginBottom: 6 }}>
            Rally Scenarios (SPX rises)
          </div>
          <ScenarioTable th={th} scenarios={rallyScenarios} spot={results.spot} direction="rally" />
        </div>
      )}

      <p style={{ fontSize: 11, color: th.textMuted, marginTop: 8, fontStyle: 'italic' }}>
        Hedge sized for breakeven at 1.5{'\u00D7'} distance to hedge strike. Buy {hedge.recommendedPuts} put{hedge.recommendedPuts === 1 ? '' : 's'} + {hedge.recommendedCalls} call{hedge.recommendedCalls === 1 ? '' : 's'} as a 0DTE strangle at {hedgeDelta}{'\u0394'}. All values theoretical (Black-Scholes, r=0). Actual fill prices may differ.
      </p>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatBox({ th, label, value, accent, large }: {
  th: Theme; label: string; value: string; accent?: string; large?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: th.textTertiary, fontFamily: "'Outfit', sans-serif" }}>
        {label}
      </div>
      <div style={{
        fontSize: large ? 22 : 14, fontWeight: large ? 800 : 600,
        fontFamily: "'DM Mono', monospace",
        color: accent ?? th.accent, marginTop: 2,
      }}>
        {value}
      </div>
    </div>
  );
}

function ScenarioTable({ th, scenarios, spot, direction }: {
  th: Theme; scenarios: readonly HedgeScenario[]; spot: number; direction: 'crash' | 'rally';
}) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 12 }} role="table" aria-label={'Hedge P&L ' + direction + ' scenarios'}>
        <thead>
          <tr style={{ backgroundColor: th.tableHeader }}>
            <th style={mkTh(th, 'right')}>Move</th>
            <th style={mkTh(th, 'right')}>SPX</th>
            <th style={mkTh(th, 'right')}>IC P&L</th>
            <th style={mkTh(th, 'right', direction === 'crash' ? th.red : th.green)}>
              {direction === 'crash' ? 'Put' : 'Call'} Hedge
            </th>
            <th style={mkTh(th, 'right')}>Hedge Cost</th>
            <th style={mkTh(th, 'right')}>Net P&L</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s, i) => {
            const spxLevel = direction === 'crash' ? spot - s.movePoints : spot + s.movePoints;
            const hedgePayout = direction === 'crash' ? s.hedgePutPnL : s.hedgeCallPnL;
            return (
              <tr key={s.movePoints} style={{ backgroundColor: i % 2 === 1 ? th.tableRowAlt : th.surface }}>
                <td style={{ ...mkTd(th), textAlign: 'right', fontWeight: 600 }}>
                  {direction === 'crash' ? '\u2193' : '\u2191'}{s.movePoints} <span style={{ fontSize: 10, color: th.textMuted }}>({s.movePct}%)</span>
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.textSecondary }}>
                  {Math.round(spxLevel)}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: s.icPnL >= 0 ? th.green : th.red, fontWeight: 600 }}>
                  {s.icPnL >= 0 ? '+' : ''}{fmtDollar(s.icPnL)}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: hedgePayout > 0 ? th.green : th.textMuted }}>
                  {hedgePayout > 0 ? '+$' + fmtDollar(hedgePayout) : '$0'}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.red, fontSize: 11 }}>
                  {fmtDollar(s.hedgeCost)}
                </td>
                <td style={{
                  ...mkTd(th), textAlign: 'right', fontWeight: 700, fontSize: 13,
                  color: s.netPnL >= 0 ? th.green : th.red,
                }}>
                  {s.netPnL >= 0 ? '+' : ''}${fmtDollar(s.netPnL)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}