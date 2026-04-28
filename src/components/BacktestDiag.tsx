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

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
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

interface Position {
  x: number;
  y: number;
}

const POSITION_STORAGE_KEY = 'backtestDiag.position';

function loadStoredPosition(): Position | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Position).x === 'number' &&
      typeof (parsed as Position).y === 'number'
    ) {
      return { x: (parsed as Position).x, y: (parsed as Position).y };
    }
  } catch {
    // fall through
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export default function BacktestDiag({
  snapshot,
  history,
  timeHour,
  timeMinute,
  timeAmPm,
  timezone,
}: Readonly<Props>) {
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<Position | null>(loadStoredPosition);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  useEffect(() => {
    if (!position) return;
    try {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
    } catch {
      // localStorage may be unavailable (private mode, quota); ignore
    }
  }, [position]);

  useEffect(() => {
    if (!position || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;
    const nextX = clamp(position.x, 0, maxX);
    const nextY = clamp(position.y, 0, maxY);
    if (nextX !== position.x || nextY !== position.y) {
      setPosition({ x: nextX, y: nextY });
    }
    // Run once on mount to rescue off-screen saved positions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDragStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!containerRef.current) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleDragMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPosition({
      x: clamp(dragRef.current.origX + dx, 0, window.innerWidth - rect.width),
      y: clamp(dragRef.current.origY + dy, 0, window.innerHeight - rect.height),
    });
  };

  const handleDragEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

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

  const containerStyle: CSSProperties = {
    position: 'fixed',
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
    touchAction: 'none',
    ...(position
      ? { top: position.y, left: position.x }
      : { bottom: 12, right: 12 }),
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: collapsed ? 0 : 6,
        }}
      >
        <button
          type="button"
          aria-label="Drag panel"
          title="Drag to move"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          style={{
            cursor: 'grab',
            background: 'none',
            border: 'none',
            padding: '0 4px',
            color: 'var(--color-muted)',
            fontSize: 12,
            lineHeight: 1,
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          ⋮⋮
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          style={{
            fontWeight: 700,
            fontSize: 12,
            color: 'var(--color-backtest)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flex: 1,
            background: 'none',
            border: 'none',
            padding: 0,
            textAlign: 'left',
          }}
        >
          Backtest Diagnostic{' '}
          <span
            aria-hidden="true"
            style={{ fontSize: 10, color: 'var(--color-muted)' }}
          >
            {collapsed ? '▲' : '▼'}
          </span>
        </button>
      </div>
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
            <div
              style={{
                marginTop: 6,
                color: 'var(--color-danger)',
                fontSize: 10,
              }}
            >
              Error: {history.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
