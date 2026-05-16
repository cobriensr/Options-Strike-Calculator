import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContractTapeChart } from '../components/LotteryFinder/ContractTapeChart';
import type { ContractTapeBar } from '../components/LotteryFinder/types';

// ── Fixture factory ──────────────────────────────────────────

function makeBar(overrides: Partial<ContractTapeBar> = {}): ContractTapeBar {
  return {
    ts: '2026-05-08T14:30:00Z',
    askVol: 100,
    bidVol: 50,
    midVol: 25,
    noSideVol: 5,
    totalVol: 180,
    avgPrice: 1.25,
    highPrice: 1.3,
    lowPrice: 1.2,
    ...overrides,
  };
}

// ============================================================
// EMPTY STATE
// ============================================================

describe('ContractTapeChart: empty state', () => {
  it('renders the no-data placeholder when series is empty', () => {
    render(<ContractTapeChart series={[]} ariaLabel="empty contract tape" />);
    expect(
      screen.getByText(/no tape data — daemon may not have indexed/i),
    ).toBeInTheDocument();
  });

  it('exposes the aria-label on the empty placeholder', () => {
    render(
      <ContractTapeChart series={[]} ariaLabel="AAPL 200C tape (empty)" />,
    );
    expect(screen.getByLabelText('AAPL 200C tape (empty)')).toBeInTheDocument();
  });
});

// ============================================================
// POPULATED — SMOKE
// ============================================================

describe('ContractTapeChart: populated rendering', () => {
  it('renders an SVG with the supplied aria-label when bars are present', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.2 }),
      makeBar({ ts: '2026-05-08T14:31:00Z', avgPrice: 1.25 }),
      makeBar({ ts: '2026-05-08T14:32:00Z', avgPrice: 1.3 }),
    ];
    render(
      <ContractTapeChart series={bars} ariaLabel="AAPL 200C tape (live)" />,
    );
    const chart = screen.getByLabelText('AAPL 200C tape (live)');
    expect(chart.tagName.toLowerCase()).toBe('svg');
  });

  it('renders rect bars for each minute with non-zero side volume', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z' }),
      makeBar({ ts: '2026-05-08T14:31:00Z' }),
    ];
    const { container } = render(
      <ContractTapeChart series={bars} ariaLabel="t" />,
    );
    // Each bar has bid + ask + mid > 0 → 3 rects per bar = 6 rects total.
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(6);
  });

  it('renders the volume-weighted price overlay path when ≥2 finite prices exist', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.2 }),
      makeBar({ ts: '2026-05-08T14:31:00Z', avgPrice: 1.4 }),
    ];
    const { container } = render(
      <ContractTapeChart series={bars} ariaLabel="t" />,
    );
    const path = container.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('d')).toMatch(/^M /);
  });

  it('renders min/max corner labels when prices vary', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.0 }),
      makeBar({ ts: '2026-05-08T14:31:00Z', avgPrice: 2.0 }),
    ];
    render(<ContractTapeChart series={bars} ariaLabel="t" />);
    expect(screen.getByText('$2.00')).toBeInTheDocument();
    expect(screen.getByText('$1.00')).toBeInTheDocument();
  });

  it('omits corner labels when price is flat (max === min)', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.0 }),
      makeBar({ ts: '2026-05-08T14:31:00Z', avgPrice: 1.0 }),
    ];
    render(<ContractTapeChart series={bars} ariaLabel="t" />);
    expect(screen.queryByText('$1.00')).not.toBeInTheDocument();
  });

  it('renders the fire-time vertical marker when markerTs is supplied', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z' }),
      makeBar({ ts: '2026-05-08T14:31:00Z' }),
      makeBar({ ts: '2026-05-08T14:32:00Z' }),
    ];
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T14:31:00Z"
        ariaLabel="t"
      />,
    );
    // A dashed marker line (stroke-dasharray="3 2") differentiates it from
    // the volume-baseline / pane-separator lines.
    const dashed = container.querySelector('line[stroke-dasharray="3 2"]');
    expect(dashed).not.toBeNull();
  });

  it('renders five CT-time axis labels (start / 3× mid / end)', () => {
    const bars = [
      makeBar({ ts: '2026-05-08T14:30:00Z' }),
      makeBar({ ts: '2026-05-08T15:30:00Z' }),
    ];
    const { container } = render(
      <ContractTapeChart series={bars} ariaLabel="t" />,
    );
    // 5-tick axis: 1 'start' + 3 'middle' (indices 1, 2, 3) + 1 'end'.
    expect(container.querySelectorAll('text[text-anchor="start"]').length).toBe(
      1,
    );
    expect(
      container.querySelectorAll('text[text-anchor="middle"]').length,
    ).toBe(3);
    // 'end' text-anchor is shared by axis label + max price label, which we
    // suppress here because prices are flat.
    expect(container.querySelectorAll('text[text-anchor="end"]').length).toBe(
      1,
    );
  });
});

// ============================================================
// CROSS-PANEL HOVER SYNC (Phase 5)
// ============================================================

describe('ContractTapeChart: cross-panel hover sync', () => {
  const bars = [
    makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.2 }),
    makeBar({ ts: '2026-05-08T14:31:00Z', avgPrice: 1.25 }),
    makeBar({ ts: '2026-05-08T14:32:00Z', avgPrice: 1.3 }),
  ];

  it('emits onHoverTime with a UTC-second when the cursor moves over a bar', () => {
    const onHoverTime = vi.fn();
    const { container } = render(
      <ContractTapeChart
        series={bars}
        onHoverTime={onHoverTime}
        ariaLabel="tape"
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    // jsdom returns zero-width rects; the implementation early-returns
    // on rect.width === 0, so stub the rect to satisfy the proximity
    // check and force a "near a bar" hit.
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 130,
      top: 0,
      left: 0,
      right: 200,
      bottom: 130,
      toJSON: () => ({}),
    });
    // Bar 1's center sits around x ≈ 100 in viewBox / rendered coords.
    fireEvent.mouseMove(root, { clientX: 100, clientY: 60 });
    expect(onHoverTime).toHaveBeenCalled();
    const last = onHoverTime.mock.calls.at(-1)?.[0];
    expect(typeof last).toBe('number');
    // The emitted value should be one of the bars' UTC seconds.
    const expected = bars.map((b) => Math.floor(Date.parse(b.ts) / 1000));
    expect(expected).toContain(last);
  });

  it('emits onHoverTime(null) on mouseleave', () => {
    const onHoverTime = vi.fn();
    const { container } = render(
      <ContractTapeChart
        series={bars}
        onHoverTime={onHoverTime}
        ariaLabel="tape"
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    fireEvent.mouseLeave(root);
    expect(onHoverTime).toHaveBeenLastCalledWith(null);
  });

  it('renders a synced cursor line when syncHoverTime is set', () => {
    const { container } = render(
      <ContractTapeChart
        series={bars}
        syncHoverTime={Math.floor(Date.parse('2026-05-08T14:31:00Z') / 1000)}
        ariaLabel="tape"
      />,
    );
    // The sync cursor uses an amber-dashed dasharray that no other
    // element in this chart shares.
    const syncLine = container.querySelector(
      'line[stroke-dasharray="1.5 1.5"]',
    );
    expect(syncLine).not.toBeNull();
  });

  it('omits the synced cursor when syncHoverTime is null', () => {
    const { container } = render(
      <ContractTapeChart series={bars} syncHoverTime={null} ariaLabel="tape" />,
    );
    expect(
      container.querySelector('line[stroke-dasharray="1.5 1.5"]'),
    ).toBeNull();
  });
});
