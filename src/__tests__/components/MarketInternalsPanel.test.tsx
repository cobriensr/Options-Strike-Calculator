import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MarketInternalsPanel } from '../../components/MarketInternals/MarketInternalsPanel';
import type {
  InternalBar,
  InternalSymbol,
  RegimeResult,
  ExtremeEvent,
} from '../../types/market-internals';
import type { UseMarketInternalsResult } from '../../hooks/useMarketInternals';

// ── Hook mock ──────────────────────────────────────────────

const mockResult = vi.hoisted(() => ({
  current: null as UseMarketInternalsResult | null,
}));

vi.mock('../../hooks/useMarketInternals', () => ({
  useMarketInternals: () => mockResult.current,
}));

// ── Utility mocks ─────────────────────────────────────────

const mockRegime = vi.hoisted(() => ({
  current: null as RegimeResult | null,
}));

const mockEvents = vi.hoisted(() => ({
  current: [] as ExtremeEvent[],
}));

vi.mock('../../utils/market-regime', () => ({
  classifyTickBand: vi.fn(() => 'neutral'),
  classifyRegime: vi.fn(() => mockRegime.current),
}));

vi.mock('../../utils/extreme-detector', () => ({
  detectExtremes: vi.fn(() => mockEvents.current),
}));

// ── Helpers ────────────────────────────────────────────────

function emptyLatest(): Record<InternalSymbol, InternalBar | null> {
  return { $TICK: null, $ADD: null, $VOLD: null, $TRIN: null };
}

function setHook(partial: Partial<UseMarketInternalsResult>): void {
  mockResult.current = {
    bars: [],
    latestBySymbol: emptyLatest(),
    loading: false,
    error: null,
    asOf: '2026-04-15T18:00:00Z',
    ...partial,
  };
}

function setRegime(partial: Partial<RegimeResult>): void {
  mockRegime.current = {
    regime: 'neutral',
    confidence: 0,
    evidence: [],
    scores: { range: 0, trend: 0, neutral: 1 },
    ...partial,
  };
}

function makeEvent(partial: Partial<ExtremeEvent>): ExtremeEvent {
  return {
    ts: '2026-04-15T16:18:00Z',
    symbol: '$TICK',
    value: 650,
    band: 'extreme',
    label: 'Confirming trend',
    pinned: false,
    ...partial,
  };
}

beforeEach(() => {
  setHook({});
  setRegime({});
  mockEvents.current = [];
});

// ── Tests ──────────────────────────────────────────────────

describe('MarketInternalsPanel', () => {
  // ────────────────────────────────────────────────────────
  // Regime badge tests
  // ────────────────────────────────────────────────────────

  it('shows RANGE DAY regime with confidence percentage', () => {
    setHook({ bars: [] });
    setRegime({
      regime: 'range',
      confidence: 0.8,
      evidence: ['TICK oscillating'],
      scores: { range: 0.5, trend: 0.1, neutral: 0.4 },
    });

    render(<MarketInternalsPanel marketOpen={true} />);

    const label = screen.getByTestId('regime-label');
    expect(label.textContent).toBe('RANGE DAY');
    expect(label.getAttribute('data-regime')).toBe('range');
    expect(label.className).toMatch(/cyan/);

    expect(screen.getByTestId('regime-confidence').textContent).toBe('80%');
    expect(screen.getByTestId('regime-evidence').textContent).toContain(
      'TICK oscillating',
    );
  });

  it('shows TREND DAY regime with violet styling', () => {
    setHook({ bars: [] });
    setRegime({
      regime: 'trend',
      confidence: 0.65,
      evidence: ['TICK pinned extreme 40% of session', 'VOLD directional'],
      scores: { range: 0.1, trend: 0.6, neutral: 0.3 },
    });

    render(<MarketInternalsPanel marketOpen={true} />);

    const label = screen.getByTestId('regime-label');
    expect(label.textContent).toBe('TREND DAY');
    expect(label.className).toMatch(/violet/);
    expect(screen.getByTestId('regime-confidence').textContent).toBe('65%');
  });

  it('shows NEUTRAL regime muted when confidence < 0.3', () => {
    setHook({ bars: [] });
    setRegime({
      regime: 'neutral',
      confidence: 0.2,
      evidence: ['Insufficient data (5 TICK bars)'],
      scores: { range: 0, trend: 0, neutral: 1 },
    });

    render(<MarketInternalsPanel marketOpen={true} />);

    const label = screen.getByTestId('regime-label');
    expect(label.textContent).toBe('NEUTRAL');
    // Muted styling — neutral-500 text, neutral-800 bg
    expect(label.className).toMatch(/neutral-500/);
  });

  // ────────────────────────────────────────────────────────
  // Event log tests
  // ────────────────────────────────────────────────────────

  it('shows extreme events with correct labels', () => {
    setHook({ bars: [] });
    setRegime({ regime: 'range', confidence: 0.7 });
    mockEvents.current = [
      makeEvent({
        ts: '2026-04-15T15:30:00Z',
        value: 450,
        label: 'FADE candidate',
      }),
      makeEvent({
        ts: '2026-04-15T16:00:00Z',
        value: 680,
        label: 'FADE candidate',
      }),
    ];

    render(<MarketInternalsPanel marketOpen={true} />);

    const rows = screen.getAllByTestId('extreme-event-row');
    expect(rows).toHaveLength(2);

    // Events should be newest-first (reversed from detector output)
    const firstRow = rows[0]!;
    expect(firstRow.textContent).toContain('FADE candidate');
    expect(firstRow.textContent).toContain('+680');
  });

  it('shows "No extreme events yet" when detectExtremes returns empty', () => {
    setHook({ bars: [] });
    setRegime({});
    mockEvents.current = [];

    render(<MarketInternalsPanel marketOpen={true} />);

    expect(screen.getByTestId('no-extreme-events')).toBeInTheDocument();
    expect(screen.getByText(/no extreme events yet/i)).toBeInTheDocument();
  });

  it('renders pinned events with a pinned indicator', () => {
    setHook({ bars: [] });
    setRegime({ regime: 'trend', confidence: 0.7 });
    mockEvents.current = [
      makeEvent({
        ts: '2026-04-15T15:30:00Z',
        value: 700,
        label: 'Confirming trend',
        pinned: true,
      }),
      makeEvent({
        ts: '2026-04-15T16:00:00Z',
        value: 450,
        label: 'Confirming trend',
        pinned: false,
      }),
    ];

    render(<MarketInternalsPanel marketOpen={true} />);

    const rows = screen.getAllByTestId('extreme-event-row');
    // Reversed: the pinned event (15:30) is now second in display
    const pinnedRow = rows.find(
      (r) => r.getAttribute('data-pinned') === 'true',
    );
    expect(pinnedRow).toBeTruthy();
    expect(within(pinnedRow!).getByText('pinned')).toBeInTheDocument();

    // The non-pinned row should not have the data-pinned attribute
    const unpinnedRow = rows.find(
      (r) => r.getAttribute('data-pinned') !== 'true',
    );
    expect(unpinnedRow).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────
  // Loading state
  // ────────────────────────────────────────────────────────

  it('shows badge placeholders and empty event log during loading', () => {
    setHook({ loading: true });
    setRegime({});
    mockEvents.current = [];

    render(<MarketInternalsPanel marketOpen={true} />);

    // Badge should render placeholder cells
    expect(screen.getByTestId('market-internal-tick').textContent).toMatch(
      /\u2014/,
    );
    expect(screen.getByTestId('market-internal-add').textContent).toMatch(
      /\u2014/,
    );

    // No events
    expect(screen.getByTestId('no-extreme-events')).toBeInTheDocument();
  });

  // ────────────────────────────────────────────────────────
  // Event ordering
  // ────────────────────────────────────────────────────────

  it('renders events newest-first', () => {
    setHook({ bars: [] });
    setRegime({ regime: 'range', confidence: 0.6 });
    mockEvents.current = [
      makeEvent({
        ts: '2026-04-15T14:00:00Z',
        value: 420,
        label: 'FADE candidate',
      }),
      makeEvent({
        ts: '2026-04-15T15:00:00Z',
        value: 500,
        label: 'FADE candidate',
      }),
      makeEvent({
        ts: '2026-04-15T16:00:00Z',
        value: 650,
        label: 'FADE candidate',
      }),
    ];

    render(<MarketInternalsPanel marketOpen={true} />);

    const rows = screen.getAllByTestId('extreme-event-row');
    expect(rows).toHaveLength(3);

    // First displayed should be the newest (16:00 -> +650)
    expect(rows[0]!.textContent).toContain('+650');
    // Last displayed should be the oldest (14:00 -> +420)
    expect(rows[2]!.textContent).toContain('+420');
  });
});
