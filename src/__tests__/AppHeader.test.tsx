import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import AppHeader, { type AppHeaderProps } from '../components/AppHeader';
import type { CollapseSignal } from '../components/collapse-context';
import type { MarketSession, useMarketData } from '../hooks/useMarketData';
import type { useHistoryData } from '../hooks/useHistoryData';
import type { ViewMode } from '../hooks/useViewMode';

// Counts SchwabExpiryBadge stub renders: a proxy for "did AppHeader itself
// re-render", since the stub is a plain (non-memo) child of the header.
const { expiryBadgeRender, accessKeyDialog } = vi.hoisted(() => ({
  expiryBadgeRender: vi.fn(),
  // Set `open` to render the stub's dialog, portaled to <body> like the
  // real AccessKeyModal.
  accessKeyDialog: { open: false },
}));

// AccessKeyButton calls useAccessSession() which reads cookies + dispatches
// events. Stub it to a deterministic, side-effect-free element so the
// AppHeader test focuses on AppHeader's own behavior.
vi.mock('../components/AccessKey/AccessKeyButton', async () => {
  const { createPortal } = await import('react-dom');
  return {
    default: () => (
      <>
        <button data-testid="access-key-button">access</button>
        {accessKeyDialog.open &&
          createPortal(
            <div role="dialog">
              <button type="button">Close</button>
            </div>,
            document.body,
          )}
      </>
    ),
  };
});

// SchwabExpiryBadge polls its own owner-only endpoint (covered by its own
// tests). Stub it so the header test makes no network calls and can assert
// the props it is wired with.
vi.mock('../components/AppHeader/SchwabExpiryBadge', () => ({
  default: ({
    isOwner,
    reauthPromptShown,
  }: {
    isOwner: boolean;
    reauthPromptShown: boolean;
  }) => {
    expiryBadgeRender();
    return (
      <span
        data-testid="schwab-expiry-badge-stub"
        data-owner={String(isOwner)}
        data-reauth-prompt={String(reauthPromptShown)}
      />
    );
  },
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
    fetchedAt: null,
    quotesFetchedAt: null,
    session: 'closed',
    marketOpen: false,
    ...overrides,
  };
}

/** `market.data` with a quotes payload whose `marketOpen` flag is set. */
function quotesData(marketOpen: boolean): MarketState['data'] {
  return {
    quotes: {
      spy: null,
      spx: null,
      vix: null,
      vix1d: null,
      vix9d: null,
      vvix: null,
      marketOpen,
      asOf: '2026-05-08T13:00:00Z',
    },
    intraday: null,
    yesterday: null,
    events: null,
    movers: null,
  };
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
    view: 'calculator' as ViewMode,
    onViewChange: vi.fn(),
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
  // ── View toggle ──────────────────────────────────────────

  it('renders the view toggle and switches view on click', () => {
    const onViewChange = vi.fn();
    renderHeader({ onViewChange });
    const alertsTab = screen.getByRole('button', { name: /options alerts/i });
    expect(alertsTab).toBeInTheDocument();
    fireEvent.click(alertsTab);
    expect(onViewChange).toHaveBeenCalledWith('alerts');
  });

  // ── Published height for the sticky stack ────────────────

  describe('header height', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      document.documentElement.style.removeProperty('--app-header-h');
    });

    it('publishes its height as --app-header-h on <html>, cleared on unmount', () => {
      const callbacks: Array<() => void> = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            callbacks.push(cb);
          }
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );
      const { unmount } = renderHeader();
      vi.spyOn(
        screen.getByRole('banner'),
        'getBoundingClientRect',
      ).mockReturnValue({ height: 90 } as DOMRect);
      act(() => {
        for (const cb of callbacks) cb();
      });
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--app-header-h')).toBe('90px');

      unmount();
      expect(root.style.getPropertyValue('--app-header-h')).toBe('');
    });
  });

  // ── Focus in the sideways-scrolling controls row ─────────

  describe('a control that takes focus', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      accessKeyDialog.open = false;
    });

    function spyOnScroll() {
      return vi.spyOn(Element.prototype, 'scrollIntoView');
    }

    it('is scrolled fully into view, by the nearest edge, when tabbed to', () => {
      const scrollIntoView = spyOnScroll();
      renderHeader();
      const panels = screen.getByRole('button', {
        name: 'Show or hide panels',
      });
      // Tab's keyup fires on the control that just took focus.
      act(() => panels.focus());
      fireEvent.keyUp(panels, { key: 'Tab' });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'nearest',
        inline: 'nearest',
      });
      expect(scrollIntoView.mock.contexts[0]).toBe(panels);
    });

    it('stays put when focused by a click, so the click lands', () => {
      const scrollIntoView = spyOnScroll();
      const onOpenPanelPrefs = vi.fn();
      renderHeader({ onOpenPanelPrefs });
      const panels = screen.getByRole('button', {
        name: 'Show or hide panels',
      });
      fireEvent.pointerDown(panels);
      fireEvent.mouseDown(panels);
      act(() => panels.focus());
      fireEvent.mouseUp(panels);
      fireEvent.click(panels);
      expect(onOpenPanelPrefs).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('ignores keys other than Tab', () => {
      const scrollIntoView = spyOnScroll();
      renderHeader();
      const panels = screen.getByRole('button', {
        name: 'Show or hide panels',
      });
      act(() => panels.focus());
      fireEvent.keyUp(panels, { key: 'Enter' });
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('leaves a dialog portaled out of the row alone', () => {
      const scrollIntoView = spyOnScroll();
      accessKeyDialog.open = true;
      renderHeader();
      const close = screen.getByRole('button', { name: 'Close' });
      expect(screen.getByRole('banner')).not.toContainElement(close);
      act(() => close.focus());
      // React bubbles the keyup from the portal to the row's handler.
      fireEvent.keyUp(close, { key: 'Tab' });
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  // ── Access Key button mount (sidebar vs header) ──────────

  it('keeps the Access Key button mobile-only (lg:hidden) in calculator view', () => {
    renderHeader({ view: 'calculator' });
    const btn = screen.getByTestId('access-key-button');
    expect(btn.parentElement).toHaveClass('lg:hidden');
  });

  it('shows the Access Key button on desktop in alerts view (no sidebar there)', () => {
    renderHeader({ view: 'alerts' });
    const btn = screen.getByTestId('access-key-button');
    expect(btn.parentElement).not.toHaveClass('lg:hidden');
  });

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

  // ── Schwab refresh-token countdown badge ─────────────────

  it.each([
    [true, false],
    [true, true],
    [false, false],
  ])(
    'wires the expiry badge with isOwner=%s and the 401 prompt state (needsAuth=%s)',
    (isOwner, needsAuth) => {
      renderHeader({ isOwner, market: makeMarket({ needsAuth }) });
      const stub = screen.getByTestId('schwab-expiry-badge-stub');
      expect(stub).toHaveAttribute('data-owner', String(isOwner));
      expect(stub).toHaveAttribute('data-reauth-prompt', String(needsAuth));
    },
  );

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

  it('shortens the backtest pills on a phone but keeps their full text for screen readers', () => {
    renderHeader({
      isBacktestMode: true,
      historyData: makeHistory({ error: 'no candles for 2026-05-08' }),
    });
    for (const [full, short] of [
      ['● BACKTEST', 'BT'],
      ['● NO INTRADAY', 'NO ID'],
    ] as const) {
      const shortLabel = screen.getByText(short, { exact: true });
      expect(shortLabel).toHaveAttribute('aria-hidden', 'true');
      // What assistive tech reads: the pill minus its aria-hidden parts.
      const exposed = (shortLabel.parentElement as HTMLElement).cloneNode(
        true,
      ) as HTMLElement;
      exposed.querySelectorAll('[aria-hidden="true"]').forEach((el) => {
        el.remove();
      });
      expect(exposed.textContent).toBe(full);
    }
    // The tooltip still carries the history error.
    expect(screen.getByTitle('no candles for 2026-05-08')).toHaveTextContent(
      '● NO INTRADAY',
    );
  });

  it('keeps the owner order in the DOM, so focus follows it: toggle, pills, Schwab warning, Re-auth, Access, tools', () => {
    renderHeader({
      isOwner: true,
      isBacktestMode: true,
      market: makeMarket({ needsAuth: true }),
    });
    const sequence = [
      screen.getByRole('navigation', { name: 'Application view' }),
      screen.getByText('BT', { exact: true }),
      screen.getByTestId('schwab-expiry-badge-stub'),
      screen.getByRole('link', { name: 'Re-authenticate with Schwab' }),
      screen.getByTestId('access-key-button'),
      screen.getByRole('button', { name: 'Collapse all sections' }),
      screen.getByRole('button', { name: 'Switch to dark mode' }),
    ];
    const header = screen.getByRole('banner');
    const inDomOrder = [...header.querySelectorAll('*')].filter((el) =>
      sequence.includes(el as HTMLElement),
    );
    expect(inDomOrder).toEqual(sequence);
  });

  // ── Quote staleness badge (useQuoteStaleness, F1) ────────
  //
  // Staleness is derived inside the badge from quotesFetchedAt + session +
  // the wall clock, so these tests drive it with fake time rather than
  // passing precomputed flags.

  describe('quote staleness badge', () => {
    const NOW = Date.UTC(2026, 4, 8, 14, 0, 0);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function renderWithQuotes(
      ageSec: number,
      { marketOpen = true, session = 'regular' as MarketSession } = {},
    ) {
      return renderHeader({
        market: makeMarket({
          hasData: true,
          session,
          quotesFetchedAt: NOW - ageSec * 1000,
          data: quotesData(marketOpen),
        }),
      });
    }

    it('shows a green LIVE badge with no title when quotes are fresh', () => {
      renderWithQuotes(10);
      const badge = screen.getByText(/^● LIVE$/);
      expect(badge.style.color).toContain('var(--color-success)');
      expect(badge).not.toHaveAttribute('title');
      expect(screen.queryByText(/STALE|CLOSED/)).not.toBeInTheDocument();
    });

    it('shows a caution STALE badge titled with the age once quotes are 90 s old', () => {
      renderWithQuotes(100);
      const badge = screen.getByText(/^● STALE$/);
      expect(badge.style.color).toContain('var(--color-caution)');
      expect(badge).toHaveAttribute('title', 'Quotes 100s old');
      expect(screen.queryByText(/^● LIVE$/)).not.toBeInTheDocument();
    });

    it('shows a red STALE badge with the missed-polls note once quotes are 180 s old', () => {
      renderWithQuotes(200);
      const badge = screen.getByText(/^● STALE$/);
      expect(badge.style.color).toContain('var(--color-danger)');
      expect(badge).toHaveAttribute(
        'title',
        'Quotes 200s old — 3+ missed polls',
      );
    });

    it('flips LIVE → STALE as the clock passes 90 s, with no new props', () => {
      renderWithQuotes(0);
      expect(screen.getByText(/^● LIVE$/)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(90_000);
      });
      expect(screen.getByText(/^● STALE$/)).toHaveAttribute(
        'title',
        'Quotes 90s old',
      );
    });

    it('the staleness tick re-renders only the badge, not the rest of the header', () => {
      renderWithQuotes(0);
      expiryBadgeRender.mockClear();

      act(() => {
        vi.advanceTimersByTime(95_000);
      });
      expect(screen.getByText(/^● STALE$/)).toBeInTheDocument();
      expect(expiryBadgeRender).not.toHaveBeenCalled();
    });

    it('shows a muted CLOSED badge with no staleness while the session is closed', () => {
      renderWithQuotes(300, { marketOpen: false, session: 'closed' });
      const badge = screen.getByText(/^● CLOSED$/);
      expect(badge.style.color).toContain('var(--color-muted)');
      expect(badge).not.toHaveAttribute('title');
    });

    it('keeps the CLOSED label in pre-market but still titles stale quotes', () => {
      // quotes.marketOpen drives the label (RTH only); the session drives
      // staleness, which also runs pre-market for the 08:30 CT prep.
      renderWithQuotes(100, { marketOpen: false, session: 'pre-market' });
      const badge = screen.getByText(/^● CLOSED$/);
      expect(badge.style.color).toContain('var(--color-muted)');
      expect(badge).toHaveAttribute('title', 'Quotes 100s old');
    });
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
