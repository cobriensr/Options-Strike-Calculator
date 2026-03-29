import { useRef, useState, useCallback } from 'react';
import { SectionBox } from '../ui';
import { parseStatement } from './statement-parser';
import AccountOverview from './AccountOverview';
import DataQualityAlerts from './DataQualityAlerts';
import ExecutionQuality from './ExecutionQuality';
import PortfolioRiskSummary from './PortfolioRiskSummary';
import PositionTable from './PositionTable';
import TradeLog from './TradeLog';
import type { DailyStatement } from './types';

interface PaperDashboardProps {
  spotPrice: number;
}

export default function PaperDashboard({ spotPrice }: PaperDashboardProps) {
  const [statement, setStatement] = useState<DailyStatement | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setError(null);
      const reader = new FileReader();

      reader.onload = () => {
        try {
          const text = reader.result as string;
          const parsed = parseStatement(text, spotPrice);
          setStatement(parsed);
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
      // Reset input so re-uploading the same file triggers onChange
      e.target.value = '';
    },
    [spotPrice],
  );

  // Owner gating — only render for authenticated owner
  // Placed after hooks to satisfy Rules of Hooks
  const isOwner = document.cookie.includes('sc-hint=');
  if (!isOwner) return null;

  const spreadCount = statement
    ? statement.spreads.length + statement.ironCondors.length
    : 0;

  return (
    <SectionBox
      label="Paper Dashboard"
      badge={
        statement ? `${statement.date} \u2022 ${String(spreadCount)} spreads` : null
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
        <div className="text-muted py-6 text-center font-sans text-sm">
          Upload a thinkorswim paperMoney account statement CSV to
          begin.
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
          <ExecutionQuality
            execution={statement.executionQuality}
          />
        </div>
      )}
    </SectionBox>
  );
}
