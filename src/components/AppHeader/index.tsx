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
 *   - The status pills sit in one group: BACKTEST with Loading… or
 *     NO INTRADAY in backtest mode, otherwise LIVE/STALE/CLOSED.
 *   - Below lg the header must stay one control row tall: 62px on a
 *     phone, 69px from sm. The mobile SectionNav strip under it is sticky
 *     at `top-[57px]` (the header already overlaps it by 5px on a phone
 *     and 12px from sm), and
 *     the section anchors' `scroll-mt-28` assumes header + strip, so a
 *     wrapping header would slide over the strip. Instead the controls
 *     row scrolls sideways like that strip, its items keep their natural
 *     width, and the status pills sort first so they stay in view. From
 *     sm the title keeps one line too. Those rules all use `max-lg:`
 *     variants, so at lg and up the row is laid out as before.
 *   - The hidden file input for VIX CSV uploads must stay co-located
 *     with the visible button so `useRef` can drive `.click()`.
 *
 * The component takes data as props (no hooks called here) so App.tsx
 * remains the single owner of the underlying state — easier to test and
 * easier to reason about during a snapshot debugger walkthrough. Two
 * children are self-contained:
 *
 *   - `SchwabExpiryBadge` polls its own owner-only status endpoint, and
 *     nothing else reads that state.
 *   - `QuoteStatusBadge` runs the 5 s quote-staleness clock
 *     (`useQuoteStaleness`) so the tick re-renders only that pill (F1).
 */

import type { FocusEvent, Ref } from 'react';
import AccessKeyButton from '../AccessKey/AccessKeyButton';
import { StatusBadge } from '../ui';
import { theme } from '../../themes';
import type { useMarketData } from '../../hooks/useMarketData';
import type { useHistoryData } from '../../hooks/useHistoryData';
import type { useVixData } from '../../hooks/useVixData';
import type { CollapseSignal } from '../collapse-context';
import QuoteStatusBadge from './QuoteStatusBadge';
import SchwabAuthLink from './SchwabAuthLink';
import SchwabExpiryBadge from './SchwabExpiryBadge';
import { ViewToggle } from '../ViewToggle';
import type { ViewMode } from '../../hooks/useViewMode';

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
  /** Opens the show/hide-panels modal. */
  onOpenPanelPrefs: () => void;
  /** Active top-level view (calculator vs alerts). */
  view: ViewMode;
  /** Switches the top-level view. */
  onViewChange: (view: ViewMode) => void;
}

/**
 * Brings a header control that takes focus fully into view. Below lg the
 * controls row scrolls sideways, and the browser leaves a control that is
 * already partly visible where it is, with its focus ring cut off. A
 * no-op at lg and up, where the whole row is on screen. React focus
 * events bubble through portals, so focus inside a dialog opened from
 * the row is skipped. jsdom has no `scrollIntoView`, hence the optional
 * call.
 */
function scrollFocusedIntoView(e: FocusEvent<Element>) {
  if (!e.currentTarget.contains(e.target)) return;
  e.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
  onOpenPanelPrefs,
  view,
  onViewChange,
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
        {/* From sm the title keeps one line, so the header stays one
            control row tall; on a phone it wraps to leave the pills room. */}
        <div className="sm:max-lg:shrink-0">
          <div className="text-accent hidden font-sans text-[10px] font-bold tracking-[0.2em] uppercase sm:block">
            0DTE Options
          </div>
          <h1 className="text-primary m-0 font-serif text-[18px] leading-tight font-bold sm:text-[20px]">
            Strike Calculator
          </h1>
        </div>
        {/* Below lg this row scrolls sideways. Its padding keeps a focus
            ring in view at either end of the row (the negative margins
            cancel the top, bottom and right padding; the left padding is
            the gap after the title). The scroll padding and
            scrollFocusedIntoView do the same for a control that takes
            focus part-way off the edge. */}
        <div
          onFocus={scrollFocusedIntoView}
          className="scrollbar-hide flex items-center gap-1.5 max-lg:-my-1.5 max-lg:-mr-1.5 max-lg:scroll-px-1.5 max-lg:overflow-x-auto max-lg:p-1.5 max-lg:*:shrink-0 sm:gap-2"
        >
          <ViewToggle view={view} onViewChange={onViewChange} />
          {/* Status pills. Below lg the group sorts first so the pills stay
              in view. At lg `contents` drops the group's box, so the pills
              are direct items of the row after ViewToggle, as before.
              `empty:hidden` keeps an empty group from adding a gap. */}
          <div className="flex items-center gap-1.5 empty:hidden max-lg:order-first sm:gap-2 lg:contents">
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
              <QuoteStatusBadge
                quotesMarketOpen={market.data.quotes?.marketOpen ?? false}
                quotesFetchedAt={market.quotesFetchedAt}
                session={market.session}
              />
            )}
          </div>
          {accessMode === 'public' && (
            <SchwabAuthLink
              ariaLabel="Authenticate with Schwab"
              text="Sign in"
            />
          )}
          {/* Access-key entry point. In the calculator view the sidebar
              bottomSlot is the canonical mount on lg+, so this header
              instance is hidden there (lg:hidden) to avoid duplicate
              controls. In the alerts view there is no sidebar, so the
              header is the canonical Access Key mount on desktop too and
              must stay visible at every breakpoint. */}
          <span className={view === 'alerts' ? undefined : 'lg:hidden'}>
            <AccessKeyButton compact />
          </span>
          {/* Owner-only refresh-token countdown. It brings its own Re-auth
              link when the login is close to lapsing, and hides that link
              while the 401-driven Re-auth below is already showing. */}
          <SchwabExpiryBadge
            isOwner={isOwner}
            reauthPromptShown={market.needsAuth}
          />
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
            onClick={onOpenPanelPrefs}
            aria-label="Show or hide panels"
            title="Show or hide panels"
            className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="2.25"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <span className="text-[11px] font-semibold">Panels</span>
          </button>
          <button
            onClick={onDarkModeToggle}
            aria-label={
              darkMode ? 'Switch to light mode' : 'Switch to dark mode'
            }
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
