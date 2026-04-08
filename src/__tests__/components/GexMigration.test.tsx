import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GexMigration } from '../../components/GexMigration';
import type { GexSnapshot, GexStrikeRow } from '../../utils/gex-migration';

// ── Fixture builders ─────────────────────────────────────

function makeStrike(
  strike: number,
  overrides: Partial<GexStrikeRow> = {},
): GexStrikeRow {
  return {
    strike,
    price: 6615,
    callGammaOi: 0,
    putGammaOi: 0,
    callGammaVol: 0,
    putGammaVol: 0,
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    ...overrides,
  };
}

/** Build a 21-snapshot series with a ramping positive-gamma strike. */
function buildRampSnapshots(
  strike: number,
  start: number,
  end: number,
  spot = 6615,
): GexSnapshot[] {
  const snapshots: GexSnapshot[] = [];
  for (let i = 0; i < 21; i++) {
    const t = i / 20;
    const v = start + (end - start) * t;
    snapshots.push({
      timestamp: new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(),
      price: spot,
      strikes: [makeStrike(strike, { callGammaOi: v })],
    });
  }
  return snapshots;
}

/** Build a series that produces a HIGH confidence target at 6615. */
function buildHighConfSnapshots(): GexSnapshot[] {
  const snapshots: GexSnapshot[] = [];
  for (let i = 0; i < 21; i++) {
    let v: number;
    if (i <= 15) {
      v = 100 + (i / 15) * 100; // 100 → 200 slow
    } else {
      v = 200 + ((i - 15) / 5) * 400; // 200 → 600 fast (burst)
    }
    snapshots.push({
      timestamp: new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(),
      price: 6615,
      strikes: [makeStrike(6615, { callGammaOi: v })],
    });
  }
  return snapshots;
}

// ── Tests ─────────────────────────────────────────────────

describe('GexMigration', () => {
  it('shows loading state when no snapshots and loading=true', () => {
    render(
      <GexMigration
        snapshots={[]}
        loading={true}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/Loading migration data/i)).toBeInTheDocument();
  });

  it('shows empty state when no snapshots and loading=false', () => {
    render(
      <GexMigration
        snapshots={[]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/No migration data available/i),
    ).toBeInTheDocument();
  });

  it('displays error message when error is set', () => {
    render(
      <GexMigration
        snapshots={[]}
        loading={false}
        error="Something broke"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/Something broke/i)).toBeInTheDocument();
  });

  it('renders the mode toggle with OI selected by default', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    const oiButton = screen.getByRole('button', { name: 'OI' });
    expect(oiButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'VOL' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'DIR' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('switches mode when VOL button is clicked', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'VOL' }));
    expect(screen.getByRole('button', { name: 'VOL' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renders an always-visible active mode caption', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    const caption = screen.getByTestId('gex-migration-mode-caption');
    expect(caption).toBeInTheDocument();
    // OI is default → description should mention standing dealer inventory
    expect(caption).toHaveTextContent(/OI/);
    expect(caption).toHaveTextContent(/standing dealer inventory/i);
  });

  it('updates the mode caption when the toggle changes', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    const caption = screen.getByTestId('gex-migration-mode-caption');
    expect(caption).toHaveTextContent(/standing dealer inventory/i);

    fireEvent.click(screen.getByRole('button', { name: 'VOL' }));
    expect(caption).toHaveTextContent(/today's fresh volume/i);

    fireEvent.click(screen.getByRole('button', { name: 'DIR' }));
    expect(caption).toHaveTextContent(/directionalized mm bid\/ask/i);
  });

  it('toggle buttons have title tooltips matching the mode descriptions', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'OI' })).toHaveAttribute(
      'title',
      expect.stringContaining('standing dealer inventory'),
    );
    expect(screen.getByRole('button', { name: 'VOL' })).toHaveAttribute(
      'title',
      expect.stringContaining("today's fresh volume"),
    );
    expect(screen.getByRole('button', { name: 'DIR' })).toHaveAttribute(
      'title',
      expect.stringContaining('directionalized'),
    );
  });

  it('renders the target strike when a magnet qualifies', () => {
    render(
      <GexMigration
        snapshots={buildHighConfSnapshots()}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    // Strike 6615 should appear as the target (rendered in heading-size font)
    expect(screen.getAllByText(/6615/i).length).toBeGreaterThan(0);
    // HIGH confidence label (may appear in both the signal cell and
    // the CRITICAL · HIGH badge, so use getAllByText)
    expect(screen.getAllByText(/HIGH/i).length).toBeGreaterThan(0);
  });

  it('renders the urgency leaderboard header', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/ALL STRIKES · 5-MIN URGENCY/i),
    ).toBeInTheDocument();
  });

  it('renders the migration sparklines section', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/GEX MIGRATION · 20MIN/i)).toBeInTheDocument();
  });

  it('renders the centroid tile when there are 2+ snapshots', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/GAMMA CENTROID · 20MIN/i)).toBeInTheDocument();
  });

  it('shows "no qualifying magnet" when no positive growing strike exists', () => {
    // Negative gamma ramping even more negative → no magnet
    const snapshots = buildRampSnapshots(6620, -100, -1500);
    render(
      <GexMigration
        snapshots={snapshots}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/No qualifying magnet/i)).toBeInTheDocument();
  });

  it('invokes onRefresh when refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /refresh migration data/i }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the snapshot count badge (n/21)', () => {
    render(
      <GexMigration
        snapshots={buildRampSnapshots(6620, 100, 1500)}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/21\/21/i)).toBeInTheDocument();
  });
});
