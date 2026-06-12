import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContractTapeChart } from '../components/charts/ContractTapeChart';
import { viewBoxHeightFor } from '../constants/chart-layout';
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

// ============================================================
// HISTORICAL FIRES — Task B of lottery-reignition-ui-2026-05-17
// ============================================================

describe('ContractTapeChart: historical fire markers', () => {
  // Multi-bar span so the chart has a real session timeline to clamp
  // historical-fire timestamps into.
  const bars = [
    makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.2 }),
    makeBar({ ts: '2026-05-08T15:00:00Z', avgPrice: 1.3 }),
    makeBar({ ts: '2026-05-08T15:30:00Z', avgPrice: 1.5 }),
    makeBar({ ts: '2026-05-08T16:00:00Z', avgPrice: 1.7 }),
    makeBar({ ts: '2026-05-08T16:30:00Z', avgPrice: 1.9 }),
  ];

  it('renders one orange dashed line per historical fire', () => {
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T16:30:00Z"
        historicalFires={[
          { triggerTimeCt: '2026-05-08T14:30:00Z', entryPrice: 0.5 },
          { triggerTimeCt: '2026-05-08T15:00:00Z', entryPrice: 0.7 },
          { triggerTimeCt: '2026-05-08T15:45:00Z', entryPrice: 1.1 },
        ]}
        ariaLabel="tape"
      />,
    );
    const historicalLines = container.querySelectorAll(
      '[data-testid="historical-fire-line"]',
    );
    expect(historicalLines.length).toBe(3);
    historicalLines.forEach((line) => {
      expect(line.getAttribute('stroke')).toBe('rgb(251, 146, 60)');
      expect(line.getAttribute('stroke-dasharray')).toBe('2 3');
    });
  });

  it('still renders the purple latest-fire line when historicalFires is set', () => {
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T16:30:00Z"
        historicalFires={[
          { triggerTimeCt: '2026-05-08T14:30:00Z', entryPrice: 0.5 },
        ]}
        ariaLabel="tape"
      />,
    );
    const latestLine = container.querySelector(
      '[data-testid="latest-fire-line"]',
    );
    expect(latestLine).not.toBeNull();
    expect(latestLine!.getAttribute('stroke')).toBe('rgb(196, 181, 253)');
  });

  it('renders no historical lines when historicalFires is undefined', () => {
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T16:30:00Z"
        ariaLabel="tape"
      />,
    );
    const historicalLines = container.querySelectorAll(
      '[data-testid="historical-fire-line"]',
    );
    expect(historicalLines.length).toBe(0);
  });

  it('renders no historical lines when historicalFires is empty', () => {
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T16:30:00Z"
        historicalFires={[]}
        ariaLabel="tape"
      />,
    );
    const historicalLines = container.querySelectorAll(
      '[data-testid="historical-fire-line"]',
    );
    expect(historicalLines.length).toBe(0);
  });

  it('skips a historical fire whose timestamp equals markerTs (no double-draw)', () => {
    // Defensive: if the API ever sent the latest fire inside the
    // historicalFires array (it shouldn't — Phase 1 slices it off),
    // the chart must not paint the latest fire in two colors.
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T16:30:00Z"
        historicalFires={[
          { triggerTimeCt: '2026-05-08T14:30:00Z', entryPrice: 0.5 },
          { triggerTimeCt: '2026-05-08T16:30:00Z', entryPrice: 1.9 }, // same as markerTs
        ]}
        ariaLabel="tape"
      />,
    );
    expect(
      container.querySelectorAll('[data-testid="historical-fire-line"]').length,
    ).toBe(1);
  });

  it('clamps a historical fire timestamp outside the series window to the chart edge', () => {
    // 12:00 UTC is before the first bar (14:30 UTC) — line should still
    // render at x = PAD_X (left edge) instead of being dropped or NaN'd.
    const { container } = render(
      <ContractTapeChart
        series={bars}
        markerTs="2026-05-08T16:30:00Z"
        historicalFires={[
          { triggerTimeCt: '2026-05-08T12:00:00Z', entryPrice: 0.3 },
        ]}
        ariaLabel="tape"
      />,
    );
    const line = container.querySelector(
      '[data-testid="historical-fire-line"]',
    );
    expect(line).not.toBeNull();
    const x1 = Number(line!.getAttribute('x1'));
    expect(Number.isFinite(x1)).toBe(true);
    // PAD_X = 4 in the source — the clamped position should land at PAD_X.
    expect(x1).toBe(4);
  });
});

// ============================================================
// PIXEL-HEIGHT MODE — viewBoxHeightFor helper
// ============================================================

describe('viewBoxHeightFor', () => {
  it('falls back when width is unmeasured or zero (jsdom)', () => {
    expect(viewBoxHeightFor(200, 280, null, 130)).toBe(130);
    expect(viewBoxHeightFor(200, 280, 0, 130)).toBe(130);
  });

  it('derives viewBox height so SVG units stay square', () => {
    // 800px-wide column at 280px tall: 200 viewBox units across 800px
    // = 0.25 units/px, so 280px tall = 70 viewBox units.
    expect(viewBoxHeightFor(200, 280, 800, 130)).toBe(70);
    // Narrower column → taller viewBox (same px height, fewer px/unit).
    expect(viewBoxHeightFor(200, 280, 400, 130)).toBe(140);
  });
});

describe('ContractTapeChart: pixelHeight mode', () => {
  const bars = [
    makeBar({ ts: '2026-05-08T14:30:00Z', avgPrice: 1.2 }),
    makeBar({ ts: '2026-05-08T14:31:00Z', avgPrice: 1.3 }),
  ];

  it('pins the svg to the pixel height and keeps the fallback viewBox when unmeasured (jsdom)', () => {
    render(
      <ContractTapeChart series={bars} pixelHeight={280} ariaLabel="tape" />,
    );
    const svg = screen.getByRole('img', { name: 'tape' });
    expect(svg.getAttribute('style')).toContain('height: 280px');
    // jsdom measures container width 0 → fallback viewBox height (130).
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 130');
  });

  it('applies no inline height style without pixelHeight', () => {
    render(<ContractTapeChart series={bars} ariaLabel="tape" />);
    const svg = screen.getByRole('img', { name: 'tape' });
    expect(svg.getAttribute('style')).toBeNull();
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 130');
  });
});
