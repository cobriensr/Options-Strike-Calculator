/**
 * BacktestDiag — Diagnostic overlay showing data sources during backtest mode.
 * Only renders when historySnapshot is active. Shows the raw values feeding
 * each input so you can verify correctness at a glance.
 *
 * Add to App.tsx temporarily for testing, remove when satisfied.
 *
 * Usage:
 *   <BacktestDiag snapshot={historySnapshot} history={historyData} />
 */

import { useState } from 'react';
import type {
  HistorySnapshot,
  UseHistoryDataReturn,
} from '../hooks/useHistoryData';

interface Props {
  snapshot: HistorySnapshot | null;
  history: UseHistoryDataReturn;
  timeHour: string;
  timeMinute: string;
  timeAmPm: string;
  timezone: string;
}

export default function BacktestDiag({
  snapshot,
  history,
  timeHour,
  timeMinute,
  timeAmPm,
  timezone,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (!snapshot) return null;

  const displayTime = `${timeHour}:${timeMinute} ${timeAmPm} ${timezone}`;

  const rows: [string, string][] = [
    ['Mode', '\u25CF BACKTEST'],
    ['Date', history.history?.date ?? '\u2014'],
    [
      'Entry Time',
      `${displayTime} \u2192 candle ${snapshot.candleIndex + 1}/${snapshot.totalCandles}`,
    ],
    ['SPX Spot', snapshot.spot.toFixed(2)],
    ['SPY', snapshot.spy.toFixed(2)],
    ['VIX', snapshot.vix?.toFixed(2) ?? 'no data'],
    ['VIX prevClose', snapshot.vixPrevClose?.toFixed(2) ?? 'no data'],
    ['VIX1D', snapshot.vix1d?.toFixed(2) ?? 'n/a (no history)'],
    ['VIX9D', snapshot.vix9d?.toFixed(2) ?? 'no data'],
    ['VVIX', snapshot.vvix?.toFixed(2) ?? 'no data'],
    ['SPX Open', snapshot.runningOHLC.open.toFixed(2)],
    ['SPX Hi→Now', snapshot.runningOHLC.high.toFixed(2)],
    ['SPX Lo→Now', snapshot.runningOHLC.low.toFixed(2)],
    ['Prev Close', snapshot.previousClose.toFixed(2)],
    [
      'Gap',
      snapshot.previousClose > 0
        ? (
            ((snapshot.runningOHLC.open - snapshot.previousClose) /
              snapshot.previousClose) *
            100
          ).toFixed(2) + '%'
        : '—',
    ],
    [
      'Open Range',
      snapshot.openingRange
        ? `${snapshot.openingRange.low.toFixed(0)}–${snapshot.openingRange.high.toFixed(0)} (${snapshot.openingRange.rangePts.toFixed(1)} pts)`
        : 'incomplete',
    ],
    [
      'Yesterday',
      snapshot.yesterday
        ? `${snapshot.yesterday.date}: ${snapshot.yesterday.rangePct}% range`
        : 'no data',
    ],
  ];

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 9999,
        backgroundColor: 'var(--color-surface)',
        color: 'var(--color-primary)',
        borderRadius: 10,
        padding: '12px 16px',
        fontSize: 11,
        fontFamily: 'monospace',
        lineHeight: 1.6,
        maxWidth: 320,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        border: '1px solid var(--color-edge)',
      }}
    >
      <button
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        style={{
          fontWeight: 700,
          fontSize: 12,
          marginBottom: collapsed ? 0 : 6,
          color: 'var(--color-backtest)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
        }}
      >
        Backtest Diagnostic
        <span aria-hidden="true" style={{ fontSize: 10, color: 'var(--color-muted)' }}>
          {collapsed ? '▲' : '▼'}
        </span>
      </button>
      {!collapsed && (
        <>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label}>
                  <td
                    style={{
                      padding: '1px 8px 1px 0',
                      color: 'var(--color-muted)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </td>
                  <td
                    style={{
                      padding: '1px 0',
                      color:
                        value === 'no data' || value.includes('n/a')
                          ? 'var(--color-danger)'
                          : 'var(--color-primary)',
                      textAlign: 'right',
                    }}
                  >
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.error && (
            <div style={{ marginTop: 6, color: 'var(--color-danger)', fontSize: 10 }}>
              Error: {history.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
