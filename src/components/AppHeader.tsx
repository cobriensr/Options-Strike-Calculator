/**
 * AppHeader — sticky top bar containing branding + status badge + admin
 * controls + dark-mode toggle.
 *
 * Extracted from `App.tsx` lines ~763-972 verbatim. Owner-only admin
 * actions (Migrate / Backfill / VIX upload / Re-auth) render conditionally
 * inside the same flex row as collapse-all and dark-mode buttons; on
 * non-owner sessions they're absent. The sign-in CTA only shows on the
 * `'public'` access mode.
 *
 * Design notes:
 *
 *   - The header is wrapped in `<header>` with sticky positioning + a
 *     translucent backdrop-blur. Don't move the wrapper — the layout
 *     container above it depends on the sticky context.
 *   - The status badge cascades from most-severe to least-severe
 *     (BACKTEST > NO INTRADAY > LIVE/STALE/CLOSED). Only one renders.
 *   - The hidden file input for VIX CSV uploads must stay co-located
 *     with the visible button so `useRef` can drive `.click()`.
 *
 * The component takes data as props (no hooks called here) so App.tsx
 * remains the single owner of the underlying state — easier to test and
 * easier to reason about during a snapshot debugger walkthrough.
 */

import type { Ref } from 'react';
import AccessKeyButton from './AccessKey/AccessKeyButton';
import { StatusBadge } from './ui';
import { theme } from '../themes';
import type { useMarketData } from '../hooks/useMarketData';
import type { useHistoryData } from '../hooks/useHistoryData';
import type { useVixData } from '../hooks/useVixData';
import type { CollapseSignal } from './collapse-context';

// ── Owner-only admin link to /api/auth/init ───────────────────────────

interface SchwabAuthLinkProps {
  ariaLabel: string;
  text: string;
  color?: string;
}

function SchwabAuthLink({ ariaLabel, text, color }: SchwabAuthLinkProps) {
  return (
    <a
      href="/api/auth/init"
      className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base no-underline transition-all duration-200"
      style={color ? { color } : undefined}
      aria-label={ariaLabel}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="3"
          y="7"
          width="10"
          height="8"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5.5 7V5a2.5 2.5 0 015 0v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[11px] font-semibold">{text}</span>
    </a>
  );
}

// ── Header props ─────────────────────────────────────────────────────

type MarketState = ReturnType<typeof useMarketData>;
type HistoryDataState = ReturnType<typeof useHistoryData>;
type VixDataLike = Pick<
  ReturnType<typeof useVixData>,
  'vixDataLoaded' | 'vixDataSource'
>;

export interface AppHeaderProps {
  /** Outer access mode — 'public' shows the sign-in CTA. */
  accessMode: 'public' | 'guest' | 'owner';
  /** Strict owner gate — admin buttons only render when true. */
  isOwner: boolean;
  /** Backtest banner cascades over the live/closed badges. */
  isBacktestMode: boolean;
  /** Live market state from `useMarketData` (status badge inputs). */
  market: MarketState;
  /** History fetch status — drives the BACKTEST/NO INTRADAY sub-badges. */
  historyData: HistoryDataState;
  /** VIX upload mount state — drives the upload-button label. */
  vix: VixDataLike;
  /** Hidden input ref for the VIX upload trigger. */
  vixFileInputRef: Ref<HTMLInputElement>;
  /** VIX CSV upload handler. */
  vixHandleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** VIX CSV button click → triggers the hidden input. */
  onVixCsvClick: () => void;
  /** Collapse-all signal (controls expand/collapse button label). */
  collapseSignal: CollapseSignal;
  onCollapseAll: () => void;
  /** Migrate DB button handler + in-flight flag. */
  onRunMigrations: () => void;
  migrateRunning: boolean;
  /** Backfill features button handler + in-flight flag. */
  onBackfillFeatures: () => void;
  backfillRunning: boolean;
  /** Dark-mode toggle. */
  darkMode: boolean;
  onDarkModeToggle: () => void;
}

export default function AppHeader({
  accessMode,
  isOwner,
  isBacktestMode,
  market,
  historyData,
  vix,
  vixFileInputRef,
  vixHandleFileUpload,
  onVixCsvClick,
  collapseSignal,
  onCollapseAll,
  onRunMigrations,
  migrateRunning,
  onBackfillFeatures,
  backfillRunning,
  darkMode,
  onDarkModeToggle,
}: AppHeaderProps) {
  return (
    <header
      className="border-edge sticky top-0 z-50 border-b backdrop-blur-md"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--color-page) 85%, transparent)',
      }}
    >
      <div className="mx-auto flex max-w-[660px] items-center justify-between px-5 py-2 sm:py-3 lg:max-w-6xl">
        <div>
          <div className="text-accent hidden font-sans text-[10px] font-bold tracking-[0.2em] uppercase sm:block">
            0DTE Options
          </div>
          <h1 className="text-primary m-0 font-serif text-[18px] leading-tight font-bold sm:text-[20px]">
            Strike Calculator
          </h1>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {isBacktestMode && (
            <StatusBadge label="BACKTEST" color={theme.backtest} dot />
          )}
          {isBacktestMode && historyData.loading && (
            <StatusBadge label="Loading…" color={theme.textMuted} />
          )}
          {isBacktestMode && historyData.error && !historyData.loading && (
            <StatusBadge
              label="NO INTRADAY"
              color={theme.red}
              dot
              title={historyData.error}
            />
          )}
          {!isBacktestMode && market.hasData && (
            <StatusBadge
              // FE-STATE-001: three-state live badge.
              //   Market closed             → CLOSED (muted)
              //   Market open, fresh        → LIVE   (green)
              //   Market open, stale  >=90s → STALE  (caution/yellow)
              //   Market open, stale >=180s → STALE  (red)
              // isVeryStale implies isStale, so the severity check
              // cascades from most-severe to least-severe.
              label={
                market.data.quotes?.marketOpen
                  ? market.isStale
                    ? 'STALE'
                    : 'LIVE'
                  : 'CLOSED'
              }
              color={
                market.data.quotes?.marketOpen
                  ? market.isVeryStale
                    ? theme.red
                    : market.isStale
                      ? theme.caution
                      : theme.green
                  : theme.textMuted
              }
              dot
              title={
                market.isStale && market.staleAgeSec != null
                  ? `Quotes ${market.staleAgeSec}s old${market.isVeryStale ? ' — 3+ missed polls' : ''}`
                  : undefined
              }
            />
          )}
          {accessMode === 'public' && (
            <SchwabAuthLink
              ariaLabel="Authenticate with Schwab"
              text="Sign in"
            />
          )}
          {/* Access-key entry point for non-desktop viewports. The
              sidebar bottomSlot is the canonical mount on lg+, so
              this header instance is hidden there to avoid duplicate
              controls. */}
          <span className="lg:hidden">
            <AccessKeyButton compact />
          </span>
          {market.needsAuth && isOwner && (
            <SchwabAuthLink
              ariaLabel="Re-authenticate with Schwab"
              text="Re-auth"
              color={theme.red}
            />
          )}
          <button
            onClick={onCollapseAll}
            aria-label={
              collapseSignal.collapsed
                ? 'Expand all sections'
                : 'Collapse all sections'
            }
            title={
              collapseSignal.collapsed
                ? 'Expand all sections'
                : 'Collapse all sections'
            }
            className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
          >
            <span className="text-[11px] font-semibold">
              {collapseSignal.collapsed ? '⊞ Expand' : '⊟ Collapse'}
            </span>
          </button>
          {isOwner && (
            <button
              onClick={onRunMigrations}
              disabled={migrateRunning}
              aria-label="Run database migrations"
              title="Run DB migrations"
              className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200 disabled:cursor-wait disabled:opacity-50"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <ellipse
                  cx="8"
                  cy="4"
                  rx="5"
                  ry="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M3 4v4c0 1.1 2.24 2 5 2s5-.9 5-2V4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M3 8v4c0 1.1 2.24 2 5 2s5-.9 5-2V8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              <span className="text-[11px] font-semibold">
                {migrateRunning ? 'Running…' : 'Migrate DB'}
              </span>
            </button>
          )}
          {isOwner && (
            <button
              onClick={onBackfillFeatures}
              disabled={backfillRunning}
              aria-label="Recompute training_features for all dates"
              title="Backfill training_features (rebuilds NOPE + flow + GEX feature columns for every date)"
              className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200 disabled:cursor-wait disabled:opacity-50"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M2 8a6 6 0 1 0 1.5-3.97"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M1 1v4h4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-[11px] font-semibold">
                {backfillRunning ? 'Building…' : 'Backfill'}
              </span>
            </button>
          )}
          {isOwner && (
            <>
              <input
                ref={vixFileInputRef}
                type="file"
                accept=".csv"
                onChange={vixHandleFileUpload}
                className="hidden"
                aria-label="Upload VIX OHLC CSV file"
              />
              <button
                onClick={onVixCsvClick}
                className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
              >
                <span className="text-[11px] font-semibold">
                  {vix.vixDataLoaded ? vix.vixDataSource : 'Upload VIX CSV'}
                </span>
              </button>
            </>
          )}
          <button
            onClick={onDarkModeToggle}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
          >
            {darkMode ? '☀️' : '🌙'}
            <span className="text-[11px] font-semibold">
              {darkMode ? 'Light' : 'Dark'}
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
