/**
 * VolumePerStrike — the "top 5 volume magnets" panel.
 *
 * Surfaces the strikes with the highest call and put volume for today's
 * 0DTE SPX options. Matches the visual vocabulary of the SOFBOT GEX panel
 * from the design reference: ranked rows with rank / strike / ΔVOL /
 * two-segment bar (width = magnitude, fill = call/put share) / total /
 * C/P raw / magnet badges.
 *
 * Data flow:
 *   useVolumePerStrike → snapshots → rankByVolume(topN=5) + findMagnets
 *   + computeVolumeDelta per row → rendered grid rows.
 *
 * The component is pure-functional rendering over the data returned by
 * the hook. Mode toggles, scrub controls, and overlays are intentionally
 * absent for v1 — this panel answers exactly one question ("where is
 * today's 0DTE flow concentrating?") with no knobs.
 */

import { memo, useMemo, type ReactNode } from 'react';
import { theme } from '../themes';
import { SectionBox } from './ui';
import type { VolumePerStrikeSnapshot, VolumePerStrikeRow } from '../types/api';
import {
  findMagnets,
  rankByVolume,
  computeVolumeDelta,
  distFromSpot,
} from '../utils/volume-per-strike';

// ── Constants ────────────────────────────────────────────

const TOP_N = 5;
const DELTA_OFFSET_SLOTS = 5; // 5-min window at 1-min cron cadence

// Olive for the put-share fill — avoids the red "bad/bearish" connotation
// that would otherwise overload a put-heavy bar with directional meaning.
// The panel is about positioning, not prediction.
const PUT_FILL = '#a89550';

// ── Formatters ───────────────────────────────────────────

function formatNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatPct(pct: number | null): string {
  if (pct == null) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function formatDistance(dist: number): string {
  if (Math.abs(dist) < 0.5) return 'ATM';
  const sign = dist > 0 ? '+' : '';
  return `${sign}${dist.toFixed(0)}pts`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

function signColor(pct: number | null): string {
  if (pct == null || pct === 0) return theme.textMuted;
  return pct > 0 ? theme.green : theme.red;
}

// ── Props ────────────────────────────────────────────────

interface Props {
  snapshots: VolumePerStrikeSnapshot[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** Current SPX spot price for distance-from-spot + ATM detection. */
  spot: number | null;
}

// ── Sub-components ───────────────────────────────────────

function HeaderRow() {
  return (
    <div
      className="grid grid-cols-[24px_88px_72px_1fr_72px_104px] items-center gap-2 px-2 pb-1 font-mono text-[9px] tracking-wider uppercase"
      style={{ color: theme.textMuted }}
      role="row"
    >
      <div>Rk</div>
      <div>Strike</div>
      <div>ΔVol</div>
      <div>Bar</div>
      <div className="text-right">Vol</div>
      <div className="text-right">Flow C/P</div>
    </div>
  );
}

interface RowProps {
  rank: number;
  row: VolumePerStrikeRow;
  maxBarValue: number;
  isMaxCall: boolean;
  isMaxPut: boolean;
  spot: number | null;
  snapshots: VolumePerStrikeSnapshot[];
}

function VolumeRow({
  rank,
  row,
  maxBarValue,
  isMaxCall,
  isMaxPut,
  spot,
  snapshots,
}: RowProps) {
  const total = row.callVolume + row.putVolume;

  // Bar width scales by the row's ranking key (max of call vs put) so the
  // top-ranked row is always at 100% and the rest sort down visually.
  const rowKey = Math.max(row.callVolume, row.putVolume);
  const barWidthPct = maxBarValue > 0 ? (rowKey / maxBarValue) * 100 : 0;

  // Within the bar, split by the call/put share of TOTAL volume at this
  // strike. A put-heavy strike is mostly olive, a call-heavy strike is
  // mostly green. Total width still encodes magnitude.
  const callSharePct = total > 0 ? (row.callVolume / total) * 100 : 0;
  const putSharePct = total > 0 ? (row.putVolume / total) * 100 : 0;

  const totalDelta = computeVolumeDelta(
    snapshots,
    row.strike,
    'total',
    DELTA_OFFSET_SLOTS,
  );

  const dist = spot != null ? distFromSpot(row.strike, spot) : null;
  const isAtm = dist != null && Math.abs(dist) < 0.5;

  // Magnet row outline — green for max-call, amber for max-put. If a row
  // is both (rare but possible when one strike dominates both sides),
  // green wins for consistency.
  let borderColor = 'rgba(255,255,255,0.04)';
  if (isMaxCall) borderColor = 'rgba(34, 197, 94, 0.55)';
  else if (isMaxPut) borderColor = 'rgba(234, 179, 8, 0.55)';

  // Flow-pressure ratio for the HOT badge — matches GexPerStrike's idiom.
  const totalOi = row.callOi + row.putOi;
  const flowPressure = totalOi > 0 ? (total / totalOi) * 100 : 0;

  return (
    <div
      className="grid grid-cols-[24px_88px_72px_1fr_72px_104px] items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-[11px]"
      style={{
        border: `1px solid ${borderColor}`,
        background: 'rgba(255,255,255,0.02)',
      }}
      role="row"
      data-testid={`volume-row-${row.strike}`}
    >
      {/* Rank */}
      <div style={{ color: theme.textMuted }}>{rank}</div>

      {/* Strike + distance-from-spot subtitle */}
      <div>
        <div
          className="text-[13px] font-bold"
          style={{ color: isAtm ? theme.accent : theme.text }}
        >
          {row.strike}
          {isAtm && (
            <span
              className="ml-1 text-[9px] font-normal"
              style={{ color: theme.accent }}
            >
              {'\u25C4 ATM'}
            </span>
          )}
        </div>
        {dist != null && !isAtm && (
          <div className="text-[9px]" style={{ color: theme.textMuted }}>
            {formatDistance(dist)}
          </div>
        )}
      </div>

      {/* ΔVol — 5-min percent change on total (call + put) */}
      <div>
        <div
          className="text-[11px] font-semibold"
          style={{ color: signColor(totalDelta) }}
        >
          {formatPct(totalDelta)}
        </div>
        <div className="text-[9px]" style={{ color: theme.textMuted }}>
          vs 5m
        </div>
      </div>

      {/* Two-segment bar: width = magnitude, fill = call/put share */}
      <div className="relative h-3 overflow-hidden rounded-sm bg-white/[0.03]">
        <div
          className="absolute top-0 left-0 flex h-full rounded-sm"
          style={{ width: `${barWidthPct}%` }}
        >
          <div
            style={{
              width: `${callSharePct}%`,
              background: theme.green,
            }}
          />
          <div
            style={{
              width: `${putSharePct}%`,
              background: PUT_FILL,
            }}
          />
        </div>
      </div>

      {/* Total volume */}
      <div
        className="text-right text-[12px] font-bold"
        style={{ color: theme.text }}
      >
        {formatNum(total)}
      </div>

      {/* Flow C/P + magnet badges */}
      <div className="flex flex-col items-end gap-0.5 text-[10px]">
        <div style={{ color: theme.green }}>C {formatNum(row.callVolume)}</div>
        <div style={{ color: theme.red }}>P {formatNum(row.putVolume)}</div>
        <div className="mt-0.5 flex flex-wrap justify-end gap-1">
          {isMaxCall && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
              style={{
                background: 'rgba(34, 197, 94, 0.15)',
                color: theme.green,
              }}
            >
              MAX-C
            </span>
          )}
          {isMaxPut && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
              style={{
                background: 'rgba(234, 179, 8, 0.15)',
                color: '#eab308',
              }}
            >
              MAX-P
            </span>
          )}
          {flowPressure >= 100 && !isMaxCall && !isMaxPut && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
              style={{
                background: 'rgba(239, 68, 68, 0.12)',
                color: theme.red,
              }}
              title={`volume/OI × 100 = ${flowPressure.toFixed(0)}%`}
            >
              HOT{' '}
              {flowPressure >= 1000
                ? `${(flowPressure / 100).toFixed(1)}\u00D7`
                : `${flowPressure.toFixed(0)}%`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PlaceholderMessage({ children }: { children: ReactNode }) {
  return (
    <div
      className="py-8 text-center font-mono text-[10px]"
      style={{ color: theme.textMuted }}
    >
      {children}
    </div>
  );
}

// ── Main component ───────────────────────────────────────

export const VolumePerStrike = memo(function VolumePerStrike({
  snapshots,
  loading,
  error,
  onRefresh,
  spot,
}: Props) {
  const latest = snapshots.at(-1) ?? null;

  const { rankedRows, magnets, hasRealVolume } = useMemo(() => {
    const rows = rankByVolume(latest, TOP_N);
    const mag = findMagnets(latest);
    // Guard the all-zero pre-open edge case: findMagnets seeds from
    // -Infinity, so a snapshot where every row has 0 volume returns the
    // lowest strike as both magnets. We reject those as "no data" here
    // so the pre-open UI doesn't show a phantom MAX-C/MAX-P highlight.
    const hasReal = rows.some((r) => r.callVolume + r.putVolume > 0);
    return { rankedRows: rows, magnets: mag, hasRealVolume: hasReal };
  }, [latest]);

  const maxBarValue = useMemo(() => {
    if (rankedRows.length === 0) return 0;
    return Math.max(
      ...rankedRows.map((r) => Math.max(r.callVolume, r.putVolume)),
    );
  }, [rankedRows]);

  const asOfTime = formatTime(latest?.timestamp);

  const isEmpty = latest === null || rankedRows.length === 0 || !hasRealVolume;

  return (
    <SectionBox
      label="Top Volume Magnets · Live 0DTE"
      badge={asOfTime || null}
      collapsible
      headerRight={
        <button
          type="button"
          onClick={onRefresh}
          className="cursor-pointer rounded px-1.5 py-1 font-mono text-[10px]"
          style={{ color: theme.textMuted }}
          title="Refresh"
          aria-label="Refresh volume per strike"
        >
          {'\u21bb'}
        </button>
      }
    >
      {error && (
        <div
          className="mb-3 rounded border p-2 font-mono text-[10px]"
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            borderColor: 'rgba(239, 68, 68, 0.3)',
            color: theme.red,
          }}
        >
          {error}
        </div>
      )}

      {loading && snapshots.length === 0 ? (
        <PlaceholderMessage>Loading volume magnets...</PlaceholderMessage>
      ) : isEmpty ? (
        <PlaceholderMessage>
          Awaiting 0DTE flow — no qualifying volume yet
        </PlaceholderMessage>
      ) : (
        <div className="flex flex-col">
          <HeaderRow />
          <div className="flex flex-col gap-1.5">
            {rankedRows.map((row, i) => (
              <VolumeRow
                key={row.strike}
                rank={i + 1}
                row={row}
                maxBarValue={maxBarValue}
                isMaxCall={row.strike === magnets.maxCallStrike}
                isMaxPut={row.strike === magnets.maxPutStrike}
                spot={spot}
                snapshots={snapshots}
              />
            ))}
          </div>
        </div>
      )}
    </SectionBox>
  );
});
