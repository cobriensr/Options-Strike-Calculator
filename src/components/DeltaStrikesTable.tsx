import type { Theme } from '../themes';
import type { DeltaRow, DeltaRowError } from '../types';
import { mkTh, mkTd } from './ui';

interface Props {
  th: Theme;
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  spot: number;
}

export default function DeltaStrikesTable({ th, allDeltas, spot }: Props) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 13 }} role="table" aria-label="Strike prices by delta">
        <thead>
          <tr style={{ backgroundColor: th.tableHeader }}>
            <th style={mkTh(th, 'center')}>Delta</th>
            <th style={mkTh(th, 'left', th.red)}>Put (SPX)</th>
            <th style={mkTh(th, 'left', th.red)}>{'\u2192'} Snap</th>
            <th style={mkTh(th, 'left', th.red)}>SPY</th>
            <th style={mkTh(th, 'right', th.red)}>Put $</th>
            <th style={mkTh(th, 'right', th.red)}>Δ</th>
            <th style={mkTh(th, 'right', th.red)}>Γ</th>
            <th style={mkTh(th, 'left', th.green)}>Call (SPX)</th>
            <th style={mkTh(th, 'left', th.green)}>{'\u2192'} Snap</th>
            <th style={mkTh(th, 'left', th.green)}>SPY</th>
            <th style={mkTh(th, 'right', th.green)}>Call $</th>
            <th style={mkTh(th, 'right', th.green)}>Δ</th>
            <th style={mkTh(th, 'right', th.green)}>Γ</th>
            <th style={mkTh(th, 'left')}>Width</th>
          </tr>
        </thead>
        <tbody>
          {allDeltas.map((row, i) => {
            if ('error' in row) return null;
            const r = row as DeltaRow;
            return (
              <tr key={r.delta} style={{ backgroundColor: i % 2 === 1 ? th.tableRowAlt : th.surface }}>
                <td style={{ ...mkTd(th), textAlign: 'center', fontWeight: 700, color: th.accent }}>{r.delta}{'\u0394'}</td>
                <td style={{ ...mkTd(th), color: th.red, fontWeight: 500 }}>{r.putStrike}</td>
                <td style={{ ...mkTd(th), color: th.red, opacity: 0.8 }}>{r.putSnapped}</td>
                <td style={{ ...mkTd(th), color: th.red, opacity: 0.65 }}>{r.putSpySnapped}</td>
                <td style={{ ...mkTd(th), color: th.red, textAlign: 'right', fontWeight: 600 }}>{r.putPremium.toFixed(2)}</td>
                <td style={{ ...mkTd(th), color: th.red, textAlign: 'right', fontSize: 12 }}>{(r.putActualDelta * 100).toFixed(1)}</td>
                <td style={{ ...mkTd(th), color: th.red, textAlign: 'right', fontSize: 11, opacity: 0.7 }}>{r.putGamma.toFixed(4)}</td>
                <td style={{ ...mkTd(th), color: th.green, fontWeight: 500 }}>{r.callStrike}</td>
                <td style={{ ...mkTd(th), color: th.green, opacity: 0.8 }}>{r.callSnapped}</td>
                <td style={{ ...mkTd(th), color: th.green, opacity: 0.65 }}>{r.callSpySnapped}</td>
                <td style={{ ...mkTd(th), color: th.green, textAlign: 'right', fontWeight: 600 }}>{r.callPremium.toFixed(2)}</td>
                <td style={{ ...mkTd(th), color: th.green, textAlign: 'right', fontSize: 12 }}>{(r.callActualDelta * 100).toFixed(1)}</td>
                <td style={{ ...mkTd(th), color: th.green, textAlign: 'right', fontSize: 11, opacity: 0.7 }}>{r.callGamma.toFixed(4)}</td>
                <td style={{ ...mkTd(th), color: th.textSecondary }}>{r.callStrike - r.putStrike}<span style={{ fontSize: 11, color: th.textMuted, marginLeft: 3 }}>({((r.callStrike - r.putStrike) / spot * 100).toFixed(1)}%)</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
