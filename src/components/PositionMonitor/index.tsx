import { useRef, useState, useCallback, useMemo } from 'react';
import { useIsOwner } from '../../hooks/useIsOwner';
import { SectionBox } from '../ui';
import { parseStatement, applyBSEstimates } from './statement-parser';
import AccountOverview from './AccountOverview';
import DataQualityAlerts from './DataQualityAlerts';
import ExecutionQuality from './ExecutionQuality';
import PortfolioRiskSummary from './PortfolioRiskSummary';
import PositionTable from './PositionTable';
import PositionVisuals from './PositionVisuals';
import TradeLog from './TradeLog';
import type { DailyStatement } from './types';

interface PositionMonitorProps {
  spotPrice: number;
}

// ── Self-contained time → T conversion ──────────────────

/** 0DTE session: 8:30 CT – 15:00 CT */
const SESSION_CLOSE_MIN = 15 * 60; // 3:00 PM CT in minutes

function timeToT(hour: number, minute: number): number | null {
  const totalMin = hour * 60 + minute;
  const hoursRemaining = (SESSION_CLOSE_MIN - totalMin) / 60;
  if (hoursRemaining <= 0) return null;
  // T as fraction of year (matches calculator convention)
  return hoursRemaining / (365.25 * 24);
}

// ── Component ───────────────────────────────────────────

export default function PositionMonitor({ spotPrice }: PositionMonitorProps) {
  const [rawStatement, setRawStatement] = useState<DailyStatement | null>(null);
  // Snapshot spot price at upload time to avoid re-renders from
  // parent prop changes (calculator spot fluctuates on past dates)
  const [uploadSpot, setUploadSpot] = useState(spotPrice);
  const [collapsed, setCollapsed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Self-contained time picker for theta decay simulation
  // Default: 10:00 AM CT (a reasonable mid-morning time)
  const [simHour, setSimHour] = useState(10);
  const [simMinute, setSimMinute] = useState(0);
  const [decayEnabled, setDecayEnabled] = useState(false);

  // Stop-loss multiplier for realistic max loss estimates
  // 0 = theoretical max loss (full wing width), 2-4 = stop at Nx credit
  const [stopMultiplier, setStopMultiplier] = useState(0);

  // Apply theta decay — always return a new object so React
  // reconciliation is consistent (avoids switching between
  // the same rawStatement ref and a new decay-adjusted ref)
  const statement = useMemo(() => {
    if (!rawStatement) return null;
    if (!decayEnabled) return { ...rawStatement };
    const t = timeToT(simHour, simMinute);
    if (t == null || t <= 0) return { ...rawStatement };
    try {
      return applyBSEstimates(rawStatement, uploadSpot, 0, t);
    } catch {
      return { ...rawStatement };
    }
  }, [rawStatement, uploadSpot, decayEnabled, simHour, simMinute]);

  const handleUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setError(null);
      const reader = new FileReader();

      reader.onload = () => {
        try {
          const text = reader.result as string;
          setUploadSpot(spotPrice);
          const parsed = parseStatement(text, spotPrice);
          setRawStatement(parsed);
          setCollapsed(false);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Failed to parse file';
          setError(msg);
        }
      };

      reader.onerror = () => {
        setError('Failed to read file');
      };

      reader.readAsText(file);
      e.target.value = '';
    },
    [spotPrice],
  );

  // Owner gating — only render for authenticated owner (or local dev)
  // Placed after hooks to satisfy Rules of Hooks
  const isOwner = useIsOwner();
  if (!isOwner) return null;

  const spreadCount = statement
    ? statement.spreads.length + statement.ironCondors.length
    : 0;

  // Format sim time for display
  const fmtSimTime = () => {
    const h12 = simHour > 12 ? simHour - 12 : simHour;
    const amPm = simHour >= 12 ? 'PM' : 'AM';
    const min = String(simMinute).padStart(2, '0');
    return `${h12}:${min} ${amPm} CT`;
  };

  return (
    <SectionBox
      label="Position Monitor"
      badge={
        statement
          ? `${statement.date} \u2022 ${String(spreadCount)} spreads`
          : null
      }
      headerRight={
        <div className="flex items-center gap-2">
          {/* Upload button */}
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleUpload}
            className="hidden"
            aria-label="Upload paper trading statement CSV"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={
              'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold transition-colors duration-100 ' +
              (statement
                ? 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt'
                : 'border-chip-active-border bg-chip-active-bg text-chip-active-text')
            }
          >
            {statement ? 'Re-upload' : 'Upload Statement'}
          </button>

          {/* Theta decay toggle + time picker */}
          {statement && (
            <>
              <button
                type="button"
                onClick={() => setDecayEnabled((p) => !p)}
                className={
                  'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold transition-colors duration-100 ' +
                  (decayEnabled
                    ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
                    : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
                }
                title="Estimate theta decay at a specific time of day"
              >
                {decayEnabled ? `Decay: ${fmtSimTime()}` : 'Decay: Off'}
              </button>

              {/* Time slider — only shown when decay is on */}
              {decayEnabled && (
                <input
                  type="range"
                  min={510}
                  max={899}
                  step={5}
                  value={simHour * 60 + simMinute}
                  onChange={(e) => {
                    const val = Number.parseInt(e.target.value, 10);
                    setSimHour(Math.floor(val / 60));
                    setSimMinute(val % 60);
                  }}
                  className="accent-accent h-1.5 w-24 cursor-pointer"
                  aria-label="Simulation time"
                  title={fmtSimTime()}
                />
              )}
            </>
          )}

          {/* Collapse toggle */}
          {statement && (
            <button
              type="button"
              onClick={() => setCollapsed((p) => !p)}
              aria-expanded={!collapsed}
              className="border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold transition-colors duration-100"
            >
              {collapsed ? 'Show' : 'Hide'}
            </button>
          )}
        </div>
      }
    >
      {/* Error display */}
      {error && (
        <div
          role="alert"
          className="text-danger mb-3 font-mono text-[13px] font-medium"
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {!statement && !error && (
        <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-8 text-center">
          <div className="text-muted mb-1 text-[20px]">{'\u2014'}</div>
          <p className="text-secondary m-0 font-sans text-[13px]">
            No positions tracked.
          </p>
          <p className="text-muted m-0 mt-1 font-sans text-[11px]">
            Positions will appear here when detected in your account.
          </p>
        </div>
      )}

      {/* Dashboard content */}
      {statement && !collapsed && (
        <div className="flex flex-col gap-5">
          {/* Data Quality Alerts */}
          <DataQualityAlerts warnings={statement.warnings} />

          {/* Portfolio Risk Summary */}
          <PortfolioRiskSummary
            risk={statement.portfolioRisk}
            accountSummary={statement.accountSummary}
            spreads={statement.spreads}
            ironCondors={statement.ironCondors}
            hedges={statement.hedges}
            stopMultiplier={stopMultiplier}
            onStopMultiplierChange={setStopMultiplier}
          />

          {/* Position Visualizations (4-panel) */}
          <PositionVisuals
            spreads={statement.spreads}
            ironCondors={statement.ironCondors}
            hedges={statement.hedges}
            nakedPositions={statement.nakedPositions}
            trades={statement.trades}
            portfolioRisk={statement.portfolioRisk}
            spotPrice={spotPrice}
          />

          {/* Position Table */}
          <PositionTable
            spreads={statement.spreads}
            ironCondors={statement.ironCondors}
            hedges={statement.hedges}
            nakedPositions={statement.nakedPositions}
            spotPrice={spotPrice}
          />

          {/* Account Overview */}
          <AccountOverview
            cashEntries={statement.cashEntries}
            accountSummary={statement.accountSummary}
            pnl={statement.pnl}
            closedSpreads={statement.closedSpreads}
          />

          {/* Trade Log */}
          <TradeLog
            trades={statement.trades}
            cashEntries={statement.cashEntries}
            closedSpreads={statement.closedSpreads}
          />

          {/* Execution Quality */}
          <ExecutionQuality execution={statement.executionQuality} />
        </div>
      )}
    </SectionBox>
  );
}
