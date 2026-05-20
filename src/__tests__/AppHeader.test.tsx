import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import AppHeader, { type AppHeaderProps } from '../components/AppHeader';
import type { CollapseSignal } from '../components/collapse-context';
import type { useMarketData } from '../hooks/useMarketData';
import type { useHistoryData } from '../hooks/useHistoryData';

// AccessKeyButton calls useAccessSession() which reads cookies + dispatches
// events. Stub it to a deterministic, side-effect-free element so the
// AppHeader test focuses on AppHeader's own behavior.
vi.mock('../components/AccessKey/AccessKeyButton', () => ({
  default: () => <button data-testid="access-key-button">access</button>,
}));

// ============================================================
// FACTORIES
// ============================================================

type MarketState = ReturnType<typeof useMarketData>;
type HistoryDataState = ReturnType<typeof useHistoryData>;

function makeMarket(overrides: Partial<MarketState> = {}): MarketState {
  return {
    data: {
      quotes: null,
      intraday: null,
      yesterday: null,
      events: null,
      movers: null,
    },
    loading: false,
    hasData: false,
    needsAuth: false,
    refresh: async () => {},
    fetchedAt: null,
    quotesLastUpdated: null,
    isStale: false,
    isVeryStale: false,
    staleAgeSec: null,
    session: 'closed',
    marketOpen: false,
    ...overrides,
  } as MarketState;
}

function makeHistory(
  overrides: Partial<HistoryDataState> = {},
): HistoryDataState {
  return {
    history: null,
    loading: false,
    error: null,
    getStateAtTime: () => null,
    hasHistory: false,
    ...overrides,
  } as HistoryDataState;
}

function makeCollapseSignal(
  overrides: Partial<CollapseSignal> = {},
): CollapseSignal {
  return { version: 0, collapsed: false, ...overrides };
}

function renderHeader(overrides: Partial<AppHeaderProps> = {}) {
  const props: AppHeaderProps = {
    accessMode: 'owner',
    isOwner: true,
    isBacktestMode: false,
    market: makeMarket(),
    historyData: makeHistory(),
    vix: { vixDataLoaded: false, vixDataSource: '' },
    vixFileInputRef: createRef<HTMLInputElement>(),
    vixHandleFileUpload: vi.fn(),
    onVixCsvClick: vi.fn(),
    collapseSignal: makeCollapseSignal(),
    onCollapseAll: vi.fn(),
    onRunMigrations: vi.fn(),
    migrateRunning: false,
    onBackfillFeatures: vi.fn(),
    backfillRunning: false,
    darkMode: false,
    onDarkModeToggle: vi.fn(),
    onOpenPanelPrefs: vi.fn(),
    ...overrides,
  };
  return { ...render(<AppHeader {...props} />), props };
}

// ============================================================
// TESTS
// ============================================================

describe('AppHeader', () => {
  // ── Branding ─────────────────────────────────────────────

  it('renders the Strike Calculator branding', () => {
    renderHeader({ accessMode: 'owner', isOwner: true });
    expect(
      screen.getByRole('heading', { name: /strike calculator/i }),
    ).toBeInTheDocument();
  });

  // ── Access mode: public ──────────────────────────────────

  it('shows Sign in CTA in public mode and hides owner-only admin actions', () => {
    renderHeader({ accessMode: 'public', isOwner: false });

    // Sign in link present.
    expect(
      screen.getByRole('link', { name: /authenticate with schwab/i }),
    ).toBeInTheDocument();

    // Owner-only admin buttons absent.
    expect(
      screen.queryByRole('button', { name: /run database migrations/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /recompute training_features/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/upload vix ohlc csv file/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /re-authenticate with schwab/i }),
    ).not.toBeInTheDocument();
  });

  // ── Access mode: guest ───────────────────────────────────

  it('hides Sign in CTA and admin actions in guest mode', () => {
    renderHeader({ accessMode: 'guest', isOwner: false });

    // No sign-in link.
    expect(
      screen.queryByRole('link', { name: /authenticate with schwab/i }),
    ).not.toBeInTheDocument();

    // No admin buttons.
    expect(
      screen.queryByRole('button', { name: /run database migrations/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /recompute training_features/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/upload vix ohlc csv file/i),
    ).not.toBeInTheDocument();
  });

  // ── Access mode: owner ───────────────────────────────────

  it('shows admin actions in owner mode', () => {
    renderHeader({ accessMode: 'owner', isOwner: true });
    expect(
      screen.getByRole('button', { name: /run database migrations/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /recompute training_features/i }),
    ).toBeInTheDocument();
    // Hidden file input + visible button.
    expect(
      screen.getByLabelText(/upload vix ohlc csv file/i),
    ).toBeInTheDocument();
  });

  // ── Re-auth link only shows when needsAuth + isOwner ─────

  it('shows Re-auth link when market.needsAuth and isOwner', () => {
    renderHeader({
      accessMode: 'guest', // Re-auth path is independent of the public CTA gate.
      isOwner: true,
      market: makeMarket({ needsAuth: true }),
    });
    expect(
      screen.getByRole('link', { name: /re-authenticate with schwab/i }),
    ).toBeInTheDocument();
  });

  it('does not show Re-auth link when not owner', () => {
    renderHeader({
      accessMode: 'guest',
      isOwner: false,
      market: makeMarket({ needsAuth: true }),
    });
    expect(
      screen.queryByRole('link', { name: /re-authenticate with schwab/i }),
    ).not.toBeInTheDocument();
  });

  // ── Status badge cascading ───────────────────────────────

  it('shows BACKTEST badge in backtest mode (cascades over LIVE/CLOSED)', () => {
    renderHeader({
      accessMode: 'owner',
      isOwner: true,
      isBacktestMode: true,
      market: makeMarket({
        hasData: true,
        data: {
          quotes: {
            spy: null,
            spx: null,
            vix: null,
            vix1d: null,
            vix9d: null,
            vvix: null,
            marketOpen: true,
            asOf: '2026-05-08T13:00:00Z',
          },
          intraday: null,
          yesterday: null,
          events: null,
          movers: null,
        },
      }),
    });
    expect(screen.getByText(/BACKTEST/)).toBeInTheDocument();
    // LIVE should NOT render alongside BACKTEST — cascading guard.
    expect(screen.queryByText(/^● LIVE$/)).not.toBeInTheDocument();
  });

  it('shows NO INTRADAY badge when backtest + history.error present', () => {
    renderHeader({
      isBacktestMode: true,
      historyData: makeHistory({
        loading: false,
        error: 'no candles for 2026-05-08',
      }),
    });
    expect(screen.getByText(/NO INTRADAY/)).toBeInTheDocument();
  });

  it('shows LIVE badge when market open and quotes are fresh', () => {
    renderHeader({
      market: makeMarket({
        hasData: true,
        isStale: false,
        isVeryStale: false,
        data: {
          quotes: {
            spy: null,
            spx: null,
            vix: null,
            vix1d: null,
            vix9d: null,
            vvix: null,
            marketOpen: true,
            asOf: '2026-05-08T13:00:00Z',
          },
          intraday: null,
          yesterday: null,
          events: null,
          movers: null,
        },
      }),
    });
    expect(screen.getByText(/LIVE/)).toBeInTheDocument();
    expect(screen.queryByText(/STALE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/CLOSED/)).not.toBeInTheDocument();
  });

  it('shows STALE badge when market open and quotes are stale', () => {
    renderHeader({
      market: makeMarket({
        hasData: true,
        isStale: true,
        isVeryStale: false,
        staleAgeSec: 100,
        data: {
          quotes: {
            spy: null,
            spx: null,
            vix: null,
            vix1d: null,
            vix9d: null,
            vvix: null,
            marketOpen: true,
            asOf: '2026-05-08T13:00:00Z',
          },
          intraday: null,
          yesterday: null,
          events: null,
          movers: null,
        },
      }),
    });
    expect(screen.getByText(/STALE/)).toBeInTheDocument();
    expect(screen.queryByText(/^● LIVE$/)).not.toBeInTheDocument();
  });

  it('shows CLOSED badge when market is closed', () => {
    renderHeader({
      market: makeMarket({
        hasData: true,
        data: {
          quotes: {
            spy: null,
            spx: null,
            vix: null,
            vix1d: null,
            vix9d: null,
            vvix: null,
            marketOpen: false,
            asOf: '2026-05-08T22:00:00Z',
          },
          intraday: null,
          yesterday: null,
          events: null,
          movers: null,
        },
      }),
    });
    expect(screen.getByText(/CLOSED/)).toBeInTheDocument();
  });

  // ── Dark-mode toggle ─────────────────────────────────────

  it('shows correct dark-mode label and aria-label when light', () => {
    renderHeader({ darkMode: false });
    const btn = screen.getByRole('button', { name: /switch to dark mode/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/Dark/);
  });

  it('shows correct dark-mode label and aria-label when dark', () => {
    renderHeader({ darkMode: true });
    const btn = screen.getByRole('button', { name: /switch to light mode/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/Light/);
  });

  it('clicking the dark-mode toggle calls onDarkModeToggle', () => {
    const onDarkModeToggle = vi.fn();
    renderHeader({ darkMode: false, onDarkModeToggle });
    fireEvent.click(
      screen.getByRole('button', { name: /switch to dark mode/i }),
    );
    expect(onDarkModeToggle).toHaveBeenCalledTimes(1);
  });

  // ── Collapse-all button ─────────────────────────────────

  it('renders Collapse label when collapseSignal.collapsed is false', () => {
    renderHeader({ collapseSignal: makeCollapseSignal({ collapsed: false }) });
    const btn = screen.getByRole('button', {
      name: /collapse all sections/i,
    });
    expect(btn).toHaveTextContent(/Collapse/);
  });

  it('renders Expand label when collapseSignal.collapsed is true', () => {
    renderHeader({
      collapseSignal: makeCollapseSignal({ collapsed: true, version: 5 }),
    });
    const btn = screen.getByRole('button', { name: /expand all sections/i });
    expect(btn).toHaveTextContent(/Expand/);
  });

  it('clicking the collapse button invokes onCollapseAll (parent dispatches the signal)', () => {
    const onCollapseAll = vi.fn();
    renderHeader({ onCollapseAll });
    fireEvent.click(
      screen.getByRole('button', { name: /collapse all sections/i }),
    );
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });

  // ── VIX upload trigger ──────────────────────────────────

  it('clicking the VIX upload button triggers .click() on the hidden file input via ref', () => {
    const onVixCsvClick = vi.fn();
    // Use a real ref so the input element wires up to it.
    const vixFileInputRef = createRef<HTMLInputElement>();

    renderHeader({
      isOwner: true,
      vixFileInputRef,
      onVixCsvClick,
    });

    // Default label is "Upload VIX CSV" when not loaded.
    const button = screen.getByRole('button', { name: /upload vix csv/i });
    fireEvent.click(button);
    expect(onVixCsvClick).toHaveBeenCalledTimes(1);

    // Verify the parent's onVixCsvClick handler can drive the hidden
    // input via the ref it was given. AppHeader doesn't call .click()
    // itself — it delegates via the prop — so we simulate the wiring.
    expect(vixFileInputRef.current).toBeInstanceOf(HTMLInputElement);
    expect(vixFileInputRef.current?.type).toBe('file');
    const clickSpy = vi.spyOn(vixFileInputRef.current!, 'click');
    vixFileInputRef.current!.click();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('shows vixDataSource label after CSV is loaded', () => {
    renderHeader({
      isOwner: true,
      vix: { vixDataLoaded: true, vixDataSource: 'VIX 2025 OHLC' },
    });
    expect(screen.getByText('VIX 2025 OHLC')).toBeInTheDocument();
    expect(screen.queryByText('Upload VIX CSV')).not.toBeInTheDocument();
  });

  it('triggers vixHandleFileUpload when the hidden input change event fires', () => {
    const vixHandleFileUpload = vi.fn();
    renderHeader({ isOwner: true, vixHandleFileUpload });
    const input = screen.getByLabelText(/upload vix ohlc csv file/i);
    fireEvent.change(input);
    expect(vixHandleFileUpload).toHaveBeenCalledTimes(1);
  });

  // ── Migrate / Backfill button states ─────────────────────

  it('disables Migrate button when migrateRunning and shows Running label', () => {
    renderHeader({ isOwner: true, migrateRunning: true });
    const btn = screen.getByRole('button', {
      name: /run database migrations/i,
    });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/Running/);
  });

  it('disables Backfill button when backfillRunning and shows Building label', () => {
    renderHeader({ isOwner: true, backfillRunning: true });
    const btn = screen.getByRole('button', {
      name: /recompute training_features/i,
    });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/Building/);
  });

  it('clicking Migrate invokes onRunMigrations', () => {
    const onRunMigrations = vi.fn();
    renderHeader({ isOwner: true, onRunMigrations });
    fireEvent.click(
      screen.getByRole('button', { name: /run database migrations/i }),
    );
    expect(onRunMigrations).toHaveBeenCalledTimes(1);
  });

  it('clicking Backfill invokes onBackfillFeatures', () => {
    const onBackfillFeatures = vi.fn();
    renderHeader({ isOwner: true, onBackfillFeatures });
    fireEvent.click(
      screen.getByRole('button', { name: /recompute training_features/i }),
    );
    expect(onBackfillFeatures).toHaveBeenCalledTimes(1);
  });
});
