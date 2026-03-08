import type { Theme } from '../themes';
import type { DeltaRow, IronCondorLegs, CalculationResults } from '../types';
import { buildIronCondor } from '../utils/calculator';
import { exportPnLComparison } from '../utils/exportXlsx';
import { mkTh, mkTd, fmtDollar } from './ui';

interface Props {
  th: Theme;
  results: CalculationResults;
  wingWidth: number;
  contracts: number;
  effectiveRatio: number;
  skewPct: number;
}

export default function IronCondorSection({ th, results, wingWidth, contracts, effectiveRatio, skewPct }: Props) {
  const icRows = results.allDeltas
    .filter((row): row is DeltaRow => !('error' in row))
    .map((r) => buildIronCondor(r, wingWidth, results.spot, results.T, effectiveRatio));

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.14em', color: th.accent, marginBottom: 10 }}>
        Iron Condor ({wingWidth}-pt wings)
      </div>

      {/* Legs Table */}
      <LegsTable th={th} icRows={icRows} />

      {/* P&L Profile Table */}
      <PnLProfileTable th={th} icRows={icRows} contracts={contracts} effectiveRatio={effectiveRatio} />

      <p style={{ fontSize: 11, color: th.textMuted, marginTop: 8, fontStyle: 'italic' }}>
        All dollar values: SPX $100 multiplier {'\u00D7'} {contracts} contract{contracts === 1 ? '' : 's'}. Put spread = sell short put / buy long put. Call spread = sell short call / buy long call. Iron Condor = both spreads combined. Individual spread PoP is single-tail (higher than IC). IC PoP = P(price between both BEs), not the product of spread PoPs. Premiums theoretical (r=0).
      </p>

      {/* Export Button */}
      <button
        onClick={() => exportPnLComparison({ results, contracts, effectiveRatio, skewPct })}
        aria-label="Export P&L comparison to Excel"
        style={{
          marginTop: 12, width: '100%', padding: '10px 16px', borderRadius: 8,
          border: '1.5px solid ' + th.accent,
          backgroundColor: th.accentBg, color: th.accent,
          cursor: 'pointer', fontSize: 13, fontWeight: 600,
          fontFamily: "'Outfit', sans-serif",
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}
      >
        {'\u2913'} Export All Wing Widths to Excel
      </button>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function LegsTable({ th, icRows }: { th: Theme; icRows: IronCondorLegs[] }) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 13 }} role="table" aria-label="Iron condor legs by delta">
        <thead>
          <tr style={{ backgroundColor: th.tableHeader }}>
            <th style={mkTh(th, 'center')}>Delta</th>
            <th style={mkTh(th, 'left', th.red)}>Long Put</th>
            <th style={mkTh(th, 'left', th.red)}>SPY</th>
            <th style={mkTh(th, 'left', th.red)}>Short Put</th>
            <th style={mkTh(th, 'left', th.red)}>SPY</th>
            <th style={mkTh(th, 'left', th.green)}>Short Call</th>
            <th style={mkTh(th, 'left', th.green)}>SPY</th>
            <th style={mkTh(th, 'left', th.green)}>Long Call</th>
            <th style={mkTh(th, 'left', th.green)}>SPY</th>
          </tr>
        </thead>
        <tbody>
          {icRows.map((ic, i) => (
            <tr key={ic.delta} style={{ backgroundColor: i % 2 === 1 ? th.tableRowAlt : th.surface }}>
              <td style={{ ...mkTd(th), textAlign: 'center', fontWeight: 700, color: th.accent }}>{ic.delta}{'\u0394'}</td>
              <td style={{ ...mkTd(th), color: th.red }}>{ic.longPut}</td>
              <td style={{ ...mkTd(th), color: th.red, opacity: 0.65 }}>{ic.longPutSpy}</td>
              <td style={{ ...mkTd(th), color: th.red, fontWeight: 600 }}>{ic.shortPut}</td>
              <td style={{ ...mkTd(th), color: th.red, fontWeight: 600, opacity: 0.65 }}>{ic.shortPutSpy}</td>
              <td style={{ ...mkTd(th), color: th.green, fontWeight: 600 }}>{ic.shortCall}</td>
              <td style={{ ...mkTd(th), color: th.green, fontWeight: 600, opacity: 0.65 }}>{ic.shortCallSpy}</td>
              <td style={{ ...mkTd(th), color: th.green }}>{ic.longCall}</td>
              <td style={{ ...mkTd(th), color: th.green, opacity: 0.65 }}>{ic.longCallSpy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PnLProfileTable({ th, icRows, contracts, effectiveRatio }: {
  th: Theme; icRows: IronCondorLegs[]; contracts: number; effectiveRatio: number;
}) {
  return (
    <>
      <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.14em', color: th.accent, marginTop: 16, marginBottom: 10 }}>
        P&L Profile {'\u2014'} {contracts} contract{contracts === 1 ? '' : 's'} (theoretical)
      </div>
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 13 }} role="table" aria-label="Iron condor P&L by delta">
          <thead>
            <tr style={{ backgroundColor: th.tableHeader }}>
              <th style={mkTh(th, 'center')}>Delta</th>
              <th style={mkTh(th, 'left')}>Side</th>
              <th style={mkTh(th, 'right')}>Credit</th>
              <th style={mkTh(th, 'right')}>Max Loss</th>
              <th style={mkTh(th, 'right')}>Buying Pwr</th>
              <th style={mkTh(th, 'right')}>RoR</th>
              <th style={mkTh(th, 'right')}>PoP</th>
              <th style={mkTh(th, 'right')}>SPX BE</th>
              <th style={mkTh(th, 'right')}>SPY BE</th>
            </tr>
          </thead>
          <tbody>
            {icRows.map((ic, i) => {
              const mult = 100 * contracts;
              const groupBg = i % 2 === 1 ? th.tableRowAlt : th.surface;
              const borderStyle = '2px solid ' + th.border;

              const rows = [
                {
                  key: ic.delta + '-put',
                  side: 'Put Spread',
                  sideColor: th.red,
                  credit: ic.putSpreadCredit,
                  maxLoss: ic.putSpreadMaxLoss,
                  ror: ic.putSpreadRoR,
                  pop: ic.putSpreadPoP,
                  be: ic.putSpreadBE.toFixed(0),
                  spyBe: Math.round(ic.putSpreadBE / effectiveRatio).toString(),
                  isFirst: true,
                  isLast: false,
                },
                {
                  key: ic.delta + '-call',
                  side: 'Call Spread',
                  sideColor: th.green,
                  credit: ic.callSpreadCredit,
                  maxLoss: ic.callSpreadMaxLoss,
                  ror: ic.callSpreadRoR,
                  pop: ic.callSpreadPoP,
                  be: ic.callSpreadBE.toFixed(0),
                  spyBe: Math.round(ic.callSpreadBE / effectiveRatio).toString(),
                  isFirst: false,
                  isLast: false,
                },
                {
                  key: ic.delta + '-ic',
                  side: 'Iron Condor',
                  sideColor: th.accent,
                  credit: ic.creditReceived,
                  maxLoss: ic.maxLoss,
                  ror: ic.returnOnRisk,
                  pop: ic.probabilityOfProfit,
                  be: ic.breakEvenLow.toFixed(0) + '\u2013' + ic.breakEvenHigh.toFixed(0),
                  spyBe: Math.round(ic.breakEvenLow / effectiveRatio) + '\u2013' + Math.round(ic.breakEvenHigh / effectiveRatio),
                  isFirst: false,
                  isLast: true,
                },
              ];

              return rows.map((r) => (
                <tr key={r.key} style={{
                  backgroundColor: groupBg,
                  borderBottom: r.isLast ? borderStyle : undefined,
                }}>
                  {r.isFirst && (
                    <td rowSpan={3} style={{ ...mkTd(th), textAlign: 'center', fontWeight: 700, color: th.accent, verticalAlign: 'middle', borderBottom: borderStyle }}>{ic.delta}{'\u0394'}</td>
                  )}
                  <td style={{
                    ...mkTd(th), color: r.sideColor,
                    fontWeight: r.isLast ? 700 : 500,
                    fontSize: r.isLast ? 13 : 12,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {r.side}
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.green,
                    fontWeight: r.isLast ? 700 : 500,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {'$' + fmtDollar(r.credit * mult)}
                    <div style={{ fontSize: 10, color: th.textMuted, fontWeight: 400 }}>{r.credit.toFixed(2)} pts</div>
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.red,
                    fontWeight: r.isLast ? 700 : 500,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {'$' + fmtDollar(r.maxLoss * mult)}
                    <div style={{ fontSize: 10, color: th.textMuted, fontWeight: 400 }}>{r.maxLoss.toFixed(2)} pts</div>
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.text,
                    fontWeight: r.isLast ? 700 : 500,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {'$' + fmtDollar(r.maxLoss * mult)}
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.accent,
                    fontWeight: r.isLast ? 700 : 600,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {(r.ror * 100).toFixed(1)}%
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.green,
                    fontWeight: r.isLast ? 700 : 600,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {(r.pop * 100).toFixed(1)}%
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.textSecondary,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {r.be}
                  </td>
                  <td style={{
                    ...mkTd(th), textAlign: 'right', color: th.textSecondary, opacity: 0.75,
                    borderBottom: r.isLast ? borderStyle : '1px solid ' + th.border,
                  }}>
                    {r.spyBe}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
