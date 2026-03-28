# Theta Decay Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a theta decay sparkline with 3 stat cards to the AdvancedSection panel, filling the empty space below the 10-delta IC Snapshot.

**Architecture:** New `ThetaDecayChart` component using inline SVG (zero deps). Renders inside the existing `AdvancedSection` gated on the same `results` conditional as the IC Snapshot. Consumes `calcThetaCurve()` which is already built, tested, and exported.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, inline SVG, Vitest + @testing-library/react

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/components/ThetaDecayChart.tsx` | Create | SVG sparkline + 3 stat cards + all derived calculations |
| `src/__tests__/components/ThetaDecayChart.test.tsx` | Create | Unit tests for rendering, interpolation, entry window, edge cases |
| `src/components/AdvancedSection.tsx` | Modify (line ~341) | Add `<ThetaDecayChart>` inside the results block after IC Snapshot |

---

### Task 1: ThetaDecayChart — Failing Tests

**Files:**
- Create: `src/__tests__/components/ThetaDecayChart.test.tsx`

- [ ] **Step 1: Write failing tests for ThetaDecayChart**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ThetaDecayChart from '../../components/ThetaDecayChart';

// Mock calcThetaCurve so tests don't depend on BS pricing math
vi.mock('../../utils/calculator', () => ({
  calcThetaCurve: vi.fn(),
}));

import { calcThetaCurve } from '../../utils/calculator';

const mockCurve = [
  { hoursRemaining: 6.5, premiumPct: 100, thetaPerHour: 0 },
  { hoursRemaining: 6, premiumPct: 91.2, thetaPerHour: 8.8 },
  { hoursRemaining: 5.5, premiumPct: 82.1, thetaPerHour: 9.1 },
  { hoursRemaining: 5, premiumPct: 72.5, thetaPerHour: 9.6 },
  { hoursRemaining: 4.5, premiumPct: 62.3, thetaPerHour: 10.2 },
  { hoursRemaining: 4, premiumPct: 51.8, thetaPerHour: 10.5 },
  { hoursRemaining: 3.5, premiumPct: 41.0, thetaPerHour: 10.8 },
  { hoursRemaining: 3, premiumPct: 30.5, thetaPerHour: 10.5 },
  { hoursRemaining: 2.5, premiumPct: 21.0, thetaPerHour: 9.5 },
  { hoursRemaining: 2, premiumPct: 13.0, thetaPerHour: 8.0 },
  { hoursRemaining: 1.5, premiumPct: 7.0, thetaPerHour: 6.0 },
  { hoursRemaining: 1, premiumPct: 3.0, thetaPerHour: 4.0 },
  { hoursRemaining: 0.5, premiumPct: 0.8, thetaPerHour: 2.2 },
];

function defaultProps(
  overrides: Partial<Parameters<typeof ThetaDecayChart>[0]> = {},
) {
  return {
    spot: 5800,
    sigma: 0.2,
    strikeDistance: 100,
    hoursRemaining: 3.2,
    ...overrides,
  };
}

describe('ThetaDecayChart', () => {
  beforeEach(() => {
    vi.mocked(calcThetaCurve).mockReturnValue(mockCurve);
  });

  it('renders section header', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(
      screen.getByText(/theta decay/i),
    ).toBeInTheDocument();
  });

  it('renders SVG element', () => {
    const { container } = render(<ThetaDecayChart {...defaultProps()} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('viewBox', '0 0 300 60');
  });

  it('renders now marker when hoursRemaining is in range', () => {
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 3.2 })} />,
    );
    // Amber circle for now marker
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeInTheDocument();
  });

  it('hides now marker when hoursRemaining > 6.5', () => {
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 7 })} />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeUndefined();
  });

  it('hides now marker when hoursRemaining < 0.5', () => {
    const { container } = render(
      <ThetaDecayChart {...defaultProps({ hoursRemaining: 0.3 })} />,
    );
    const circles = container.querySelectorAll('circle');
    const amberCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#f59e0b',
    );
    expect(amberCircle).toBeUndefined();
  });

  it('renders three stat cards', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(screen.getByText(/peak/i)).toBeInTheDocument();
    expect(screen.getByText(/prem now/i)).toBeInTheDocument();
    expect(screen.getByText(/entry/i)).toBeInTheDocument();
  });

  it('shows peak theta value from curve', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    // Peak is 10.8% at 3.5h in mockCurve
    expect(screen.getByText('10.8%')).toBeInTheDocument();
    expect(screen.getByText('@ 3.5h')).toBeInTheDocument();
  });

  it('interpolates premium at current hoursRemaining', () => {
    // hoursRemaining=3.2 is between 3.5h (41.0%) and 3.0h (30.5%)
    // Linear interp: 41.0 + (30.5 - 41.0) * (3.5 - 3.2) / (3.5 - 3.0) = 41.0 - 6.3 = 34.7
    render(<ThetaDecayChart {...defaultProps({ hoursRemaining: 3.2 })} />);
    expect(screen.getByText('34.7%')).toBeInTheDocument();
  });

  it('shows em-dash for prem now when hoursRemaining out of range', () => {
    render(<ThetaDecayChart {...defaultProps({ hoursRemaining: 7 })} />);
    // Should show em-dash for prem now
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('computes entry window as ET clock times', () => {
    // Mean thetaPerHour = (0+8.8+9.1+9.6+10.2+10.5+10.8+10.5+9.5+8.0+6.0+4.0+2.2) / 13 ≈ 7.63
    // Points >= 7.63: 8.8(6h), 9.1(5.5h), 9.6(5h), 10.2(4.5h), 10.5(4h), 10.8(3.5h), 10.5(3h), 9.5(2.5h), 8.0(2h)
    // Contiguous: 6h down to 2h
    // ET clock: 16-6=10a to 16-2=2p → "10a\u20132p"
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(screen.getByText('10a\u20132p')).toBeInTheDocument();
  });

  it('does not render when curve is empty', () => {
    vi.mocked(calcThetaCurve).mockReturnValue([]);
    const { container } = render(<ThetaDecayChart {...defaultProps()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders caption text', () => {
    render(<ThetaDecayChart {...defaultProps()} />);
    expect(
      screen.getByText(/premium remaining for 10-delta/i),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/components/ThetaDecayChart.test.tsx`
Expected: FAIL — module `../../components/ThetaDecayChart` not found

- [ ] **Step 3: Commit test file**

```bash
git add src/__tests__/components/ThetaDecayChart.test.tsx
git commit -m "test: add failing tests for ThetaDecayChart component"
```

---

### Task 2: ThetaDecayChart — Implementation

**Files:**
- Create: `src/components/ThetaDecayChart.tsx`

- [ ] **Step 1: Create the ThetaDecayChart component**

```tsx
import { calcThetaCurve } from '../utils/calculator';

interface ThetaDecayChartProps {
  spot: number;
  sigma: number;
  strikeDistance: number;
  hoursRemaining: number;
}

const VIEW_W = 300;
const VIEW_H = 60;

/** Map hoursRemaining (6.5 → 0.5) to SVG x (0 → VIEW_W) */
function xScale(h: number): number {
  return ((6.5 - h) / 6) * VIEW_W;
}

/** Map premiumPct (100 → 0) to SVG y (0 → VIEW_H) */
function yScale(pct: number): number {
  return ((100 - pct) / 100) * VIEW_H;
}

/** Interpolate premium % at a given hoursRemaining from the discrete curve */
function interpolatePremium(
  curve: ReadonlyArray<{ hoursRemaining: number; premiumPct: number }>,
  h: number,
): number | null {
  if (h > 6.5 || h < 0.5) return null;
  // Find the two bracketing points
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (h <= a.hoursRemaining && h >= b.hoursRemaining) {
      const t = (a.hoursRemaining - h) / (a.hoursRemaining - b.hoursRemaining);
      return Math.round((a.premiumPct + (b.premiumPct - a.premiumPct) * t) * 10) / 10;
    }
  }
  return null;
}

/** Find the contiguous range of hours where thetaPerHour >= session average */
function calcEntryWindow(
  curve: ReadonlyArray<{ hoursRemaining: number; thetaPerHour: number }>,
): string {
  if (curve.length === 0) return '\u2014';
  const mean =
    curve.reduce((sum, p) => sum + p.thetaPerHour, 0) / curve.length;
  if (mean <= 0) return '\u2014';

  // Find all contiguous runs above mean
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  let runStart = -1;

  for (let i = 0; i < curve.length; i++) {
    if (curve[i]!.thetaPerHour >= mean) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1) {
        const len = i - runStart;
        if (len > bestLen) {
          bestLen = len;
          bestStart = runStart;
          bestEnd = i - 1;
        }
        runStart = -1;
      }
    }
  }
  // Close trailing run
  if (runStart !== -1) {
    const len = curve.length - runStart;
    if (len > bestLen) {
      bestStart = runStart;
      bestEnd = curve.length - 1;
    }
  }

  if (bestStart === -1) return '\u2014';

  const startH = curve[bestStart]!.hoursRemaining;
  const endH = curve[bestEnd]!.hoursRemaining;

  return formatETRange(startH, endH);
}

/** Convert hoursRemaining pair to ET clock time range string */
function formatETRange(startH: number, endH: number): string {
  return formatETHour(16 - startH) + '\u2013' + formatETHour(16 - endH);
}

/** Format a 24h ET hour as "10a", "12p", "1p", etc. */
function formatETHour(hour24: number): string {
  const h = Math.round(hour24);
  if (h === 0 || h === 24) return '12a';
  if (h === 12) return '12p';
  if (h < 12) return h + 'a';
  return (h - 12) + 'p';
}

export default function ThetaDecayChart({
  spot,
  sigma,
  strikeDistance,
  hoursRemaining,
}: ThetaDecayChartProps) {
  const curve = calcThetaCurve(spot, sigma, strikeDistance, 'put');
  if (curve.length === 0) return null;

  // Build SVG polyline points
  const linePoints = curve
    .map((p) => xScale(p.hoursRemaining) + ',' + yScale(p.premiumPct))
    .join(' ');

  // Area path: line + close along bottom
  const first = curve[0]!;
  const last = curve.at(-1)!;
  const areaD =
    'M' +
    curve
      .map((p) => xScale(p.hoursRemaining) + ',' + yScale(p.premiumPct))
      .join(' L') +
    ' L' +
    xScale(last.hoursRemaining) +
    ',' +
    VIEW_H +
    ' L' +
    xScale(first.hoursRemaining) +
    ',' +
    VIEW_H +
    ' Z';

  // Now marker
  const showNow = hoursRemaining >= 0.5 && hoursRemaining <= 6.5;
  const premNow = interpolatePremium(curve, hoursRemaining);
  const nowX = showNow ? xScale(hoursRemaining) : 0;
  const nowY = showNow && premNow !== null ? yScale(premNow) : 0;

  // Peak theta
  let peakTheta = 0;
  let peakHours = 0;
  for (const p of curve) {
    if (p.thetaPerHour > peakTheta) {
      peakTheta = p.thetaPerHour;
      peakHours = p.hoursRemaining;
    }
  }

  // Entry window
  const entryWindow = calcEntryWindow(curve);

  return (
    <div className="border-edge mt-3.5 border-t pt-3.5">
      <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Theta Decay (10{'\u0394'} put)
      </div>

      {/* SVG Sparkline */}
      <div className="bg-surface-alt rounded-lg p-3">
        <svg
          viewBox={'0 0 ' + VIEW_W + ' ' + VIEW_H}
          className="h-[60px] w-full"
          role="img"
          aria-label="Theta decay curve showing premium remaining over time"
        >
          <defs>
            <linearGradient id="theta-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.03" />
            </linearGradient>
          </defs>

          {/* Area fill */}
          <path d={areaD} fill="url(#theta-fill)" />

          {/* Line */}
          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
          />

          {/* Now marker */}
          {showNow && premNow !== null && (
            <>
              <line
                x1={nowX}
                y1={0}
                x2={nowX}
                y2={VIEW_H}
                stroke="#f59e0b"
                strokeWidth="0.75"
                strokeDasharray="2,2"
                opacity="0.4"
              />
              <circle cx={nowX} cy={nowY} r={3.5} fill="#f59e0b" />
              <text
                x={nowX + 6}
                y={nowY - 4}
                fill="#f59e0b"
                fontSize="8"
                fontFamily="monospace"
              >
                {premNow.toFixed(1) + '% left'}
              </text>
            </>
          )}

          {/* Axis labels */}
          <text x="2" y="8" fill="currentColor" fontSize="7" fontFamily="monospace" opacity="0.3">
            100%
          </text>
          <text x="2" y={VIEW_H - 2} fill="currentColor" fontSize="7" fontFamily="monospace" opacity="0.3">
            0%
          </text>
        </svg>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[9px]">
          <span>open</span>
          <span>close</span>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div className="bg-surface-alt rounded-lg p-[7px_8px]">
          <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.08em] uppercase">
            Peak {'\u03B8'}/hr
          </div>
          <div className="text-primary mt-0.5 font-mono text-[14px] font-medium">
            {peakTheta > 0 ? peakTheta + '%' : '\u2014'}
          </div>
          {peakTheta > 0 && (
            <div className="text-muted font-mono text-[8px]">
              {'@ ' + peakHours + 'h'}
            </div>
          )}
        </div>
        <div className="bg-surface-alt rounded-lg p-[7px_8px]">
          <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.08em] uppercase">
            Prem Now
          </div>
          <div className="text-primary mt-0.5 font-mono text-[14px] font-medium">
            {premNow !== null ? premNow.toFixed(1) + '%' : '\u2014'}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg p-[7px_8px]">
          <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.08em] uppercase">
            Entry
          </div>
          <div className="text-primary mt-0.5 font-mono text-[14px] font-medium">
            {entryWindow}
          </div>
        </div>
      </div>

      <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
        Premium remaining for 10-delta OTM put across the session.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/components/ThetaDecayChart.test.tsx`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/ThetaDecayChart.tsx
git commit -m "feat: add ThetaDecayChart component with SVG sparkline and stat cards"
```

---

### Task 3: Integrate into AdvancedSection

**Files:**
- Modify: `src/components/AdvancedSection.tsx` (line ~341, after IC Snapshot IIFE)

- [ ] **Step 1: Add import at top of AdvancedSection.tsx**

After the existing imports (line 4), add:

```tsx
import ThetaDecayChart from './ThetaDecayChart';
```

- [ ] **Step 2: Add ThetaDecayChart below IC Snapshot**

In `AdvancedSection.tsx`, find the closing of the IC Snapshot IIFE at line ~341 (the `})()}`). After it, but still inside the `{results && (` block (before the closing `</div>` at line ~342), add:

```tsx
          {/* Theta Decay — premium curve + entry timing */}
          {(() => {
            const ref = results.allDeltas.find(
              (r) => !('error' in r) && r.delta === 10,
            );
            if (!ref || 'error' in ref) return null;
            return (
              <ThetaDecayChart
                spot={results.spot}
                sigma={ref.putSigma}
                strikeDistance={results.spot - ref.putSnapped}
                hoursRemaining={results.hoursRemaining}
              />
            );
          })()}
```

- [ ] **Step 3: Run existing AdvancedSection tests to check no regressions**

Run: `npx vitest run src/__tests__/components/AdvancedSection.test.tsx`
Expected: All existing tests PASS

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/components/AdvancedSection.tsx
git commit -m "feat: integrate ThetaDecayChart into AdvancedSection below IC Snapshot"
```
