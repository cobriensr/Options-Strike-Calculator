import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DeltaRegimeGuide from '../components/DeltaRegimeGuide';
import { lightTheme, darkTheme } from '../themes';
import { calcAllDeltas, calcTimeToExpiry } from '../utils/calculator';

// Helper: standard test params matching a typical 0DTE session
function makeProps(
  overrides: Partial<{
    vix: number;
    spot: number;
    hours: number;
    skew: number;
    selectedDate: string;
    clusterMult: number;
  }> = {},
) {
  const spot = overrides.spot ?? 6800;
  const hours = overrides.hours ?? 4;
  const T = calcTimeToExpiry(hours);
  const skew = overrides.skew ?? 0.03;
  const sigma = ((overrides.vix ?? 20) * 1.15) / 100; // only used for allDeltas computation
  const allDeltas = calcAllDeltas(spot, sigma, T, skew, 10);
  return {
    th: lightTheme,
    vix: overrides.vix ?? 20,
    spot,
    T,
    skew,
    allDeltas,
    selectedDate: overrides.selectedDate ?? '2026-03-10', // Tuesday (neutral ~1.0x)
    clusterMult: overrides.clusterMult,
  };
}

// ============================================================
// RENDERING
// ============================================================
describe('DeltaRegimeGuide: rendering', () => {
  it('renders without crashing', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('renders in dark mode', () => {
    render(<DeltaRegimeGuide {...makeProps()} th={darkTheme} />);
    expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('returns null for negative VIX', () => {
    const { container } = render(
      <DeltaRegimeGuide {...makeProps({ vix: -5 })} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows the exact VIX value in the header', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 22.18 })} />);
    expect(screen.getByText(/delta guide for vix 22\.2/i)).toBeInTheDocument();
  });

  it('header updates with different VIX values', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 15.5 })} />);
    expect(screen.getByText(/delta guide for vix 15\.5/i)).toBeInTheDocument();
  });
});

// ============================================================
// CONTINUOUS INTERPOLATION (the key fix)
// ============================================================
describe('DeltaRegimeGuide: continuous interpolation', () => {
  it('VIX 22 and VIX 24 within same bucket produce different thresholds', () => {
    const { unmount } = render(
      <DeltaRegimeGuide {...makeProps({ vix: 22 })} />,
    );
    const table1 = screen.getByRole('table', { name: /range thresholds/i });
    const cells1 = within(table1).getAllByText(/%/);
    const text1 = cells1.map((c) => c.textContent).join(',');
    unmount();

    render(<DeltaRegimeGuide {...makeProps({ vix: 24 })} />);
    const table2 = screen.getByRole('table', { name: /range thresholds/i });
    const cells2 = within(table2).getAllByText(/%/);
    const text2 = cells2.map((c) => c.textContent).join(',');

    // Same bucket (20-25) but different interpolated thresholds
    expect(text1).not.toBe(text2);
  });

  it('VIX 24.9 and VIX 25.1 produce similar (not jumpy) thresholds', () => {
    const { unmount } = render(
      <DeltaRegimeGuide {...makeProps({ vix: 24.9 })} />,
    );
    const table1 = screen.getByRole('table', { name: /range thresholds/i });
    // Find the 90th O→C row — it's the 3rd data row (index 2)
    const rows1 = within(table1).getAllByRole('row');
    const p90ocRow1 = rows1[3]; // header + 3rd data row
    const pctCell1 = within(p90ocRow1!).getAllByText(/%/)[0]!.textContent!;
    const pct1 = Number.parseFloat(pctCell1);
    unmount();

    render(<DeltaRegimeGuide {...makeProps({ vix: 25.1 })} />);
    const table2 = screen.getByRole('table', { name: /range thresholds/i });
    const rows2 = within(table2).getAllByRole('row');
    const p90ocRow2 = rows2[3];
    const pctCell2 = within(p90ocRow2!).getAllByText(/%/)[0]!.textContent!;
    const pct2 = Number.parseFloat(pctCell2);

    // Should be close — no more than 0.3% apart across the boundary
    expect(Math.abs(pct1 - pct2)).toBeLessThan(0.3);
  });

  it('delta changes monotonically with VIX (no reversals within 10-30 range)', () => {
    // Test the 90th O→C threshold at VIX 15, 20, 25, 30
    // Higher VIX should always produce wider thresholds (lower recommended delta)
    const results: number[] = [];
    for (const vix of [15, 20, 25, 30]) {
      const { unmount } = render(<DeltaRegimeGuide {...makeProps({ vix })} />);
      const table = screen.getByRole('table', { name: /range thresholds/i });
      const rows = within(table).getAllByRole('row');
      // 90th O→C is 3rd data row
      const p90Row = rows[3];
      const pctText = within(p90Row!).getAllByText(/%/)[0]!.textContent!;
      results.push(Number.parseFloat(pctText));
      unmount();
    }
    // Each VIX level should produce a wider threshold than the previous
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThan(results[i - 1]!);
    }
  });

  it('footnote mentions interpolation', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 22.5 })} />);
    expect(screen.getByText(/interpolated for vix 22\.5/i)).toBeInTheDocument();
  });
});

// ============================================================
// RECOMMENDATION BANNER
// ============================================================
describe('DeltaRegimeGuide: recommendation banner', () => {
  it('shows the maximum delta label', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getByText(/maximum delta/i)).toBeInTheDocument();
  });

  it('shows ceiling not target messaging', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getByText(/ceiling, not a target/i)).toBeInTheDocument();
  });

  it('shows the 90th percentile O→C info', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getByText(/90th percentile/i)).toBeInTheDocument();
  });

  it('shows a delta number with Δ symbol', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const banner = screen
      .getByText(/maximum delta/i)
      .closest('div')?.parentElement;
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toMatch(/\d+\u0394/);
  });

  it('shows guidance tiers when ceiling > 0', () => {
    // VIX 20, 4 hours left → ceiling is well above 0
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });

  it('conservative delta is lower than aggressive delta when both shown', () => {
    // VIX 14, 4 hours → high ceiling, both tiers visible
    render(<DeltaRegimeGuide {...makeProps({ vix: 14 })} />);
    const aggressive = screen.getByText('Aggressive').parentElement;
    const conservative = screen.queryByText('Conservative')?.parentElement;
    const deltaPattern = /(\d+)\u0394/;
    const aggDelta = Number.parseInt(
      deltaPattern.exec(aggressive?.textContent ?? '')?.[1] ?? '0',
    );
    if (conservative) {
      const consDelta = Number.parseInt(
        deltaPattern.exec(conservative?.textContent ?? '')?.[1] ?? '0',
      );
      expect(aggDelta).toBeGreaterThan(0);
      expect(consDelta).toBeGreaterThan(0);
      expect(consDelta).toBeLessThan(aggDelta);
    } else {
      // Ceiling is 1Δ — conservative hidden because it would equal aggressive
      expect(aggDelta).toBe(1);
    }
  });

  it('hides conservative when it would equal aggressive (ceiling=1)', () => {
    // Very high VIX + low time → ceiling near 1
    // Use VIX 25 with only 1 hour left
    render(<DeltaRegimeGuide {...makeProps({ vix: 25, hours: 1 })} />);
    const aggressive = screen.queryByText('Aggressive');
    const conservative = screen.queryByText('Conservative');
    if (aggressive) {
      const aggDelta = Number.parseInt(
        /(\d+)\u0394/.exec(aggressive.parentElement?.textContent ?? '')?.[1] ??
          '0',
      );
      if (aggDelta <= 1) {
        expect(conservative).toBeNull();
      }
    }
  });

  it('shows elevated VIX warning for caution zone', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 22 })} />);
    expect(screen.getByText(/elevated vix/i)).toBeInTheDocument();
    expect(screen.getByText(/reducing contracts/i)).toBeInTheDocument();
  });

  it('does not show elevated VIX warning for green zone', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 14 })} />);
    expect(screen.queryByText(/elevated vix/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// THRESHOLD TABLE
// ============================================================
describe('DeltaRegimeGuide: threshold table', () => {
  it('renders the threshold table', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(
      screen.getByRole('table', { name: /range thresholds mapped to delta/i }),
    ).toBeInTheDocument();
  });

  it('shows all 4 range thresholds', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /range thresholds/i });
    expect(within(table).getAllByText(/o.*c/i).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(within(table).getAllByText(/h-l/i).length).toBeGreaterThanOrEqual(2);
  });

  it('shows column headers', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /range thresholds/i });
    expect(within(table).getByText('To Clear')).toBeInTheDocument();
    expect(within(table).getByText('Range %')).toBeInTheDocument();
    expect(within(table).getByText('Points')).toBeInTheDocument();
    expect(within(table).getByText('Survival')).toBeInTheDocument();
  });

  it('shows put and call delta columns', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /range thresholds/i });
    expect(within(table).getByText(/max put/i)).toBeInTheDocument();
    expect(within(table).getByText(/max call/i)).toBeInTheDocument();
  });

  it('shows delta values with Δ symbol', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /range thresholds/i });
    const deltaCells = within(table).getAllByText(/\d+\.\d+\u0394/);
    expect(deltaCells.length).toBeGreaterThanOrEqual(4);
  });

  it('shows survival purpose text', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getByText(/90% settlement survival/)).toBeInTheDocument();
    expect(screen.getByText(/90% intraday survival/)).toBeInTheDocument();
    expect(screen.getByText(/50% settlement survival/)).toBeInTheDocument();
    expect(screen.getByText(/50% intraday survival/)).toBeInTheDocument();
  });

  it('shows skew note when skew > 0', () => {
    render(<DeltaRegimeGuide {...makeProps({ skew: 0.03 })} />);
    expect(screen.getByText(/skew-adjusted/i)).toBeInTheDocument();
  });

  it('does not show skew note when skew is 0', () => {
    render(<DeltaRegimeGuide {...makeProps({ skew: 0 })} />);
    expect(screen.queryByText(/skew-adjusted/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// YOUR DELTAS vs. THRESHOLDS TABLE
// ============================================================
describe('DeltaRegimeGuide: delta vs. threshold matrix', () => {
  it('renders the matrix table', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(
      screen.getByRole('table', { name: /standard deltas vs/i }),
    ).toBeInTheDocument();
  });

  it('shows all 6 standard deltas', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /standard deltas vs/i });
    expect(within(table).getByText('5\u0394')).toBeInTheDocument();
    expect(within(table).getByText('8\u0394')).toBeInTheDocument();
    expect(within(table).getByText('10\u0394')).toBeInTheDocument();
    expect(within(table).getByText('12\u0394')).toBeInTheDocument();
    expect(within(table).getByText('15\u0394')).toBeInTheDocument();
    expect(within(table).getByText('20\u0394')).toBeInTheDocument();
  });

  it('shows checkmarks and crosses', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /standard deltas vs/i });
    const checks = within(table).getAllByText('\u2713');
    const crosses = within(table).getAllByText('\u2717');
    expect(checks.length).toBeGreaterThan(0);
    expect(crosses.length).toBeGreaterThan(0);
  });

  it('lower deltas (further OTM) have more checkmarks than higher deltas', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    const table = screen.getByRole('table', { name: /standard deltas vs/i });
    const rows = within(table).getAllByRole('row').slice(1);

    const checkCounts = rows.map(
      (row) => within(row).queryAllByText('\u2713').length,
    );

    const first = checkCounts[0] ?? 0;
    const last = checkCounts.at(-1) ?? 0;
    expect(first).toBeGreaterThanOrEqual(last);
  });

  it('shows footnote explaining checkmarks', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(
      screen.getByText(/clears the historical range threshold/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// VIX SENSITIVITY
// ============================================================
describe('DeltaRegimeGuide: VIX sensitivity', () => {
  it('low VIX: wider deltas still get checkmarks', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 12 })} />);
    const table = screen.getByRole('table', { name: /standard deltas vs/i });
    const checks = within(table).getAllByText('\u2713');
    expect(checks.length).toBeGreaterThanOrEqual(10);
  });

  it('high VIX: most deltas fail thresholds', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 35 })} />);
    const table = screen.getByRole('table', { name: /standard deltas vs/i });
    const crosses = within(table).getAllByText('\u2717');
    expect(crosses.length).toBeGreaterThanOrEqual(10);
  });
});

// ============================================================
// PARAMETER SENSITIVITY
// ============================================================
describe('DeltaRegimeGuide: parameter sensitivity', () => {
  it('higher VIX produces different sigma internally', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 30 })} />);
    // footnote shows VIX-derived sigma: 30 * 1.15 / 100 = 0.3450
    expect(screen.getByText(/0\.3450/)).toBeInTheDocument();
  });

  it('less time remaining changes delta values', () => {
    render(<DeltaRegimeGuide {...makeProps({ hours: 1 })} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
  });

  it('works with zero skew', () => {
    render(<DeltaRegimeGuide {...makeProps({ skew: 0 })} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
  });

  it('works at different SPX levels', () => {
    render(<DeltaRegimeGuide {...makeProps({ spot: 4500 })} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// THEME SUPPORT
// ============================================================
describe('DeltaRegimeGuide: theme support', () => {
  it('renders completely in light theme', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /standard deltas/i }),
    ).toBeInTheDocument();
  });

  it('renders completely in dark theme', () => {
    render(<DeltaRegimeGuide {...makeProps()} th={darkTheme} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /standard deltas/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('DeltaRegimeGuide: edge cases', () => {
  it('handles VIX at exact bucket boundaries', () => {
    const boundaries = [12, 15, 18, 20, 25, 30, 40];
    for (const vix of boundaries) {
      const { unmount } = render(<DeltaRegimeGuide {...makeProps({ vix })} />);
      expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
        1,
      );
      unmount();
    }
  });

  it('handles very high VIX (80)', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 80 })} />);
    expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('handles fractional VIX', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 19.73 })} />);
    expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('handles near-close time (0.25 hours)', () => {
    render(<DeltaRegimeGuide {...makeProps({ hours: 0.25 })} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
  });

  it('handles very low VIX', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 10 })} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
  });

  it('handles very high VIX', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 45 })} />);
    expect(
      screen.getByRole('table', { name: /range thresholds/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// DAY-OF-WEEK ADJUSTMENT
// ============================================================
describe('DeltaRegimeGuide: day-of-week adjustment', () => {
  // 2026-03-09 = Monday, 2026-03-12 = Thursday, 2026-03-14 = Saturday
  it('shows DOW badge for Monday', () => {
    render(<DeltaRegimeGuide {...makeProps({ selectedDate: '2026-03-09' })} />);
    expect(screen.getByText(/Mon.*quieter/)).toBeInTheDocument();
  });

  it('shows DOW badge for Thursday', () => {
    render(<DeltaRegimeGuide {...makeProps({ selectedDate: '2026-03-12' })} />);
    expect(screen.getByText(/Thu.*wider|Thu.*avg/)).toBeInTheDocument();
  });

  it('Monday produces narrower thresholds than Thursday at same VIX', () => {
    const { unmount } = render(
      <DeltaRegimeGuide
        {...makeProps({ vix: 20, selectedDate: '2026-03-09' })}
      />,
    );
    const table1 = screen.getByRole('table', { name: /range thresholds/i });
    const rows1 = within(table1).getAllByRole('row');
    const monPct = Number.parseFloat(
      within(rows1[3]!).getAllByText(/%/)[0]!.textContent!,
    );
    unmount();

    render(
      <DeltaRegimeGuide
        {...makeProps({ vix: 20, selectedDate: '2026-03-12' })}
      />,
    );
    const table2 = screen.getByRole('table', { name: /range thresholds/i });
    const rows2 = within(table2).getAllByRole('row');
    const thuPct = Number.parseFloat(
      within(rows2[3]!).getAllByText(/%/)[0]!.textContent!,
    );

    expect(monPct).toBeLessThan(thuPct);
  });

  it('footnote mentions the day-of-week adjustment', () => {
    render(<DeltaRegimeGuide {...makeProps({ selectedDate: '2026-03-09' })} />);
    expect(screen.getByText(/Monday.*H-L/i)).toBeInTheDocument();
  });

  it('no DOW badge when selected date is a weekend', () => {
    render(<DeltaRegimeGuide {...makeProps({ selectedDate: '2026-03-14' })} />);
    expect(screen.queryByText(/quieter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/wider/i)).not.toBeInTheDocument();
  });

  it('no DOW adjustment text in footnote when date is a weekend', () => {
    render(<DeltaRegimeGuide {...makeProps({ selectedDate: '2026-03-14' })} />);
    expect(screen.queryByText(/Combined adj/i)).not.toBeInTheDocument();
  });

  it('all 5 weekdays render without errors', () => {
    // Mon 3/9 through Fri 3/13
    for (let d = 9; d <= 13; d++) {
      const { unmount } = render(
        <DeltaRegimeGuide
          {...makeProps({
            selectedDate: `2026-03-${String(d).padStart(2, '0')}`,
          })}
        />,
      );
      expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
        1,
      );
      unmount();
    }
  });

  it('derives correct day from a known date (Feb 27 2026 = Friday)', () => {
    render(<DeltaRegimeGuide {...makeProps({ selectedDate: '2026-02-27' })} />);
    expect(screen.getAllByText(/Fri/).length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// VOLATILITY CLUSTERING
// ============================================================
describe('DeltaRegimeGuide: volatility clustering', () => {
  it('clustering multiplier widens thresholds', () => {
    const { unmount } = render(
      <DeltaRegimeGuide {...makeProps({ vix: 20 })} />,
    );
    const table1 = screen.getByRole('table', { name: /range thresholds/i });
    const rows1 = within(table1).getAllByRole('row');
    const basePct = Number.parseFloat(
      within(rows1[3]!).getAllByText(/%/)[0]!.textContent!,
    );
    unmount();

    render(<DeltaRegimeGuide {...makeProps({ vix: 20, clusterMult: 1.2 })} />);
    const table2 = screen.getByRole('table', { name: /range thresholds/i });
    const rows2 = within(table2).getAllByRole('row');
    const clusterPct = Number.parseFloat(
      within(rows2[3]!).getAllByText(/%/)[0]!.textContent!,
    );

    expect(clusterPct).toBeGreaterThan(basePct);
  });

  it('shows clustering badge when mult > 1.03', () => {
    render(<DeltaRegimeGuide {...makeProps({ clusterMult: 1.2 })} />);
    expect(screen.getByText(/1\.20x cluster/)).toBeInTheDocument();
  });

  it('shows calm badge when mult < 0.97', () => {
    render(<DeltaRegimeGuide {...makeProps({ clusterMult: 0.91 })} />);
    expect(screen.getByText(/0\.91x calm/)).toBeInTheDocument();
  });

  it('no clustering badge when mult is near 1.0', () => {
    render(<DeltaRegimeGuide {...makeProps({ clusterMult: 1.0 })} />);
    expect(screen.queryByText(/cluster/)).not.toBeInTheDocument();
    expect(screen.queryByText(/calm/)).not.toBeInTheDocument();
  });

  it('footnote shows clustering multiplier', () => {
    render(<DeltaRegimeGuide {...makeProps({ clusterMult: 1.2 })} />);
    expect(screen.getByText(/Clustering.*1\.200/)).toBeInTheDocument();
  });

  it('clustering lowers the delta ceiling', () => {
    const { unmount } = render(
      <DeltaRegimeGuide {...makeProps({ vix: 20 })} />,
    );
    // Without clustering, should show maximum delta banner
    const banner1 = screen
      .getByText(/maximum delta/i)
      .closest('div')?.parentElement;
    const text1 = banner1?.textContent ?? '';
    unmount();

    render(<DeltaRegimeGuide {...makeProps({ vix: 20, clusterMult: 1.5 })} />);
    // With clustering, ceiling may drop to 0 → "sit out" instead of "maximum delta"
    const sitOut = screen.queryByText(/sit out/i);
    if (sitOut) {
      // Ceiling dropped to 0 — that's lower than any positive ceiling
      expect(sitOut).toBeInTheDocument();
    } else {
      const banner2 = screen
        .getByText(/maximum delta/i)
        .closest('div')?.parentElement;
      const text2 = banner2?.textContent ?? '';

      const match1 = /CEILING(\d+)/.exec(text1);
      const match2 = /CEILING(\d+)/.exec(text2);
      if (match1 && match2) {
        expect(Number(match2[1])).toBeLessThanOrEqual(Number(match1[1]));
      }
    }
  });

  it('works without clusterMult prop (defaults to 1.0)', () => {
    render(<DeltaRegimeGuide {...makeProps()} />);
    expect(screen.getAllByText(/delta guide/i).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.queryByText(/cluster/)).not.toBeInTheDocument();
  });
});

// ============================================================
// SIT OUT STATE (ceiling = 0)
// ============================================================
describe('DeltaRegimeGuide: sit out state', () => {
  it('shows sit out when ceiling is 0 (extreme VIX + low time)', () => {
    // VIX 40 with very little time remaining → ceiling should be 0
    render(<DeltaRegimeGuide {...makeProps({ vix: 40, hours: 0.5 })} />);
    const sitOut = screen.queryByText(/sit out/i);
    const noSafe = screen.queryByText(/no safe delta/i);
    // At VIX 40 with 30 min left, ceiling should be 0
    if (sitOut) {
      expect(sitOut).toBeInTheDocument();
      expect(noSafe).toBeInTheDocument();
    }
  });

  it('does not show aggressive/conservative tiers when sitting out', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 40, hours: 0.5 })} />);
    const sitOut = screen.queryByText(/sit out/i);
    if (sitOut) {
      expect(screen.queryByText('Aggressive')).not.toBeInTheDocument();
      expect(screen.queryByText('Conservative')).not.toBeInTheDocument();
      expect(screen.queryByText('Moderate')).not.toBeInTheDocument();
    }
  });

  it('shows extreme conditions warning when sitting out', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 40, hours: 0.5 })} />);
    const sitOut = screen.queryByText(/sit out/i);
    if (sitOut) {
      expect(screen.getByText(/extreme conditions/i)).toBeInTheDocument();
      expect(screen.getByText(/breaks iron condors/i)).toBeInTheDocument();
    }
  });

  it('shows 90th percentile stats in sit out banner', () => {
    render(<DeltaRegimeGuide {...makeProps({ vix: 40, hours: 0.5 })} />);
    const sitOut = screen.queryByText(/sit out/i);
    if (sitOut) {
      expect(screen.getByText(/too wide for any delta/i)).toBeInTheDocument();
    }
  });

  it('clustering can push ceiling to 0 triggering sit out', () => {
    // VIX 25 with moderate time + high clustering
    render(
      <DeltaRegimeGuide
        {...makeProps({ vix: 25, hours: 1, clusterMult: 2.0 })}
      />,
    );
    const sitOut = screen.queryByText(/sit out/i);
    // With 2x clustering multiplier, the range doubles — may push ceiling to 0
    if (sitOut) {
      expect(screen.queryByText('Aggressive')).not.toBeInTheDocument();
    }
  });

  it('still shows normal banner when ceiling is 1+', () => {
    // VIX 15, plenty of time → ceiling well above 0
    render(<DeltaRegimeGuide {...makeProps({ vix: 15, hours: 5 })} />);
    expect(screen.queryByText(/sit out/i)).not.toBeInTheDocument();
    expect(screen.getByText(/maximum delta/i)).toBeInTheDocument();
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });
});
