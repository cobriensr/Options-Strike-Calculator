import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VolumePerStrike } from '../../components/VolumePerStrike';
import type {
  VolumePerStrikeRow,
  VolumePerStrikeSnapshot,
} from '../../types/api';

// ── Fixture builders ─────────────────────────────────────

function makeRow(
  strike: number,
  overrides: Partial<VolumePerStrikeRow> = {},
): VolumePerStrikeRow {
  return {
    strike,
    callVolume: 0,
    putVolume: 0,
    callOi: 0,
    putOi: 0,
    ...overrides,
  };
}

function makeSnapshot(
  timestamp: string,
  strikes: VolumePerStrikeRow[],
): VolumePerStrikeSnapshot {
  return { timestamp, strikes };
}

/**
 * A realistic top-5 snapshot. 6800 has the biggest call volume (MAX-C),
 * 6750 has the biggest put volume (MAX-P). 6785 is closest to spot 6780
 * (within 5 pts → ATM). All rows are above the "hasRealVolume" floor.
 */
function makeRealisticSnapshot(): VolumePerStrikeSnapshot {
  return makeSnapshot('2026-04-08T19:00:00Z', [
    makeRow(6750, {
      callVolume: 12400,
      putVolume: 65786,
      callOi: 500,
      putOi: 2900,
    }),
    makeRow(6760, {
      callVolume: 19800,
      putVolume: 36200,
      callOi: 800,
      putOi: 2100,
    }),
    makeRow(6785, {
      callVolume: 41600,
      putVolume: 9400,
      callOi: 1200,
      putOi: 800,
    }),
    makeRow(6800, {
      callVolume: 118509,
      putVolume: 5500,
      callOi: 4864,
      putOi: 200,
    }),
    makeRow(6810, {
      callVolume: 55000,
      putVolume: 4000,
      callOi: 2000,
      putOi: 300,
    }),
  ]);
}

const noop = vi.fn();

// ============================================================
// RENDERING & HEADERS
// ============================================================

describe('VolumePerStrike: basic rendering', () => {
  it('renders the section heading', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /top volume magnets/i }),
    ).toBeInTheDocument();
  });

  it('renders column headers when data is present', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    expect(screen.getByText('Rk')).toBeInTheDocument();
    expect(screen.getByText('Strike')).toBeInTheDocument();
    expect(screen.getByText('ΔVol')).toBeInTheDocument();
    expect(screen.getByText('Bar')).toBeInTheDocument();
    expect(screen.getByText('Vol')).toBeInTheDocument();
    expect(screen.getByText('Flow C/P')).toBeInTheDocument();
  });

  it('renders exactly 5 rows from a 5-strike snapshot', () => {
    const { container } = render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    const rows = container.querySelectorAll('[data-testid^="volume-row-"]');
    expect(rows).toHaveLength(5);
  });

  it('ranks rows so the highest max(C,P) is first', () => {
    // 6800 has callVolume 118509 (the biggest single-side value) → rank 1
    const { container } = render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="volume-row-"]'),
    );
    expect(rows[0]!.dataset.testid).toBe('volume-row-6800');
  });
});

// ============================================================
// MAGNET HIGHLIGHTING
// ============================================================

describe('VolumePerStrike: magnet highlighting', () => {
  it('marks the max-call strike with a MAX-C badge', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    expect(screen.getByText('MAX-C')).toBeInTheDocument();
  });

  it('marks the max-put strike with a MAX-P badge', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    expect(screen.getByText('MAX-P')).toBeInTheDocument();
  });

  it('places the MAX-C badge on the 6800 row (highest call volume)', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    const row6800 = screen.getByTestId('volume-row-6800');
    expect(within(row6800).getByText('MAX-C')).toBeInTheDocument();
  });

  it('places the MAX-P badge on the 6750 row (highest put volume)', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    const row6750 = screen.getByTestId('volume-row-6750');
    expect(within(row6750).getByText('MAX-P')).toBeInTheDocument();
  });
});

// ============================================================
// ATM DETECTION
// ============================================================

describe('VolumePerStrike: ATM detection', () => {
  it('marks the strike closest to spot with an ATM indicator', () => {
    // Spot 6785 exactly matches the 6785 strike in the snapshot
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6785}
      />,
    );
    const row6785 = screen.getByTestId('volume-row-6785');
    expect(within(row6785).getByText(/atm/i)).toBeInTheDocument();
  });

  it('does not mark a strike as ATM when spot is more than 0.5 pts away', () => {
    // Spot 6786 is 1 pt away from 6785 → NOT at-the-money.
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6786}
      />,
    );
    const row6785 = screen.getByTestId('volume-row-6785');
    expect(within(row6785).queryByText(/atm/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// ALL-ZERO GUARD (Phase 3 subtlety)
// ============================================================

describe('VolumePerStrike: all-zero guard', () => {
  it('shows the awaiting-flow placeholder when every row has zero volume', () => {
    const snap = makeSnapshot('2026-04-08T13:29:59Z', [
      makeRow(6790),
      makeRow(6795),
      makeRow(6800),
    ]);
    render(
      <VolumePerStrike
        snapshots={[snap]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6795}
      />,
    );
    expect(screen.getByText(/awaiting 0dte flow/i)).toBeInTheDocument();
    expect(screen.queryByText('MAX-C')).not.toBeInTheDocument();
    expect(screen.queryByText('MAX-P')).not.toBeInTheDocument();
  });

  it('renders rows normally once any row has positive volume', () => {
    const snap = makeSnapshot('2026-04-08T13:30:00Z', [
      makeRow(6790, { callVolume: 100 }),
      makeRow(6795),
      makeRow(6800),
    ]);
    render(
      <VolumePerStrike
        snapshots={[snap]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6795}
      />,
    );
    expect(screen.queryByText(/awaiting 0dte flow/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('volume-row-6790')).toBeInTheDocument();
  });
});

// ============================================================
// LOADING / ERROR / EMPTY
// ============================================================

describe('VolumePerStrike: loading and error states', () => {
  it('shows a loading placeholder when loading and no snapshots yet', () => {
    render(
      <VolumePerStrike
        snapshots={[]}
        loading={true}
        error={null}
        onRefresh={noop}
        spot={null}
      />,
    );
    expect(screen.getByText(/loading volume magnets/i)).toBeInTheDocument();
  });

  it('shows the empty placeholder when snapshots is empty and not loading', () => {
    render(
      <VolumePerStrike
        snapshots={[]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={null}
      />,
    );
    expect(screen.getByText(/awaiting 0dte flow/i)).toBeInTheDocument();
  });

  it('renders an error banner when error is set', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error="Failed to load"
        onRefresh={noop}
        spot={6780}
      />,
    );
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
  });

  it('invokes onRefresh when the refresh button is clicked', async () => {
    const onRefresh = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={onRefresh}
        spot={6780}
      />,
    );
    const btn = screen.getByRole('button', {
      name: /refresh volume per strike/i,
    });
    await userEvent.setup().click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// FORMATTING
// ============================================================

describe('VolumePerStrike: number formatting', () => {
  it('formats large volumes with K/M suffixes', () => {
    render(
      <VolumePerStrike
        snapshots={[makeRealisticSnapshot()]}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6780}
      />,
    );
    // 6800 row: call 118509, put 5500 → total 124009 → displayed as ~124.0K
    const row6800 = screen.getByTestId('volume-row-6800');
    expect(within(row6800).getByText(/124\.0K/)).toBeInTheDocument();
  });

  it('formats a negative 5-min delta with a minus sign', () => {
    // 6 snapshots of strike 6800 where total volume strictly decreases.
    // Volume is normally monotonic (cumulative day-total), but contract
    // roll/expiry or cancellations can produce net decreases — confirms
    // the component handles them without blowing up the sign logic.
    // past total = 1500, now total = 800 → delta ≈ -46.7%
    const series: VolumePerStrikeSnapshot[] = [
      makeSnapshot('2026-04-08T18:55:00Z', [
        makeRow(6800, { callVolume: 1000, putVolume: 500 }),
      ]),
      makeSnapshot('2026-04-08T18:56:00Z', [
        makeRow(6800, { callVolume: 900, putVolume: 450 }),
      ]),
      makeSnapshot('2026-04-08T18:57:00Z', [
        makeRow(6800, { callVolume: 800, putVolume: 400 }),
      ]),
      makeSnapshot('2026-04-08T18:58:00Z', [
        makeRow(6800, { callVolume: 700, putVolume: 400 }),
      ]),
      makeSnapshot('2026-04-08T18:59:00Z', [
        makeRow(6800, { callVolume: 600, putVolume: 350 }),
      ]),
      makeSnapshot('2026-04-08T19:00:00Z', [
        makeRow(6800, { callVolume: 500, putVolume: 300 }),
      ]),
    ];

    render(
      <VolumePerStrike
        snapshots={series}
        loading={false}
        error={null}
        onRefresh={noop}
        spot={6800}
      />,
    );

    const row = screen.getByTestId('volume-row-6800');
    expect(within(row).getByText(/^-46\.7%$/)).toBeInTheDocument();
  });
});
