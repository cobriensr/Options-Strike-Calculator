# Theta Decay Chart — Design Spec

## Summary

Add a theta decay visualization to the AdvancedSection panel, filling the empty space below the 10-delta IC Snapshot. Uses the existing `calcThetaCurve()` utility (built and tested, no current UI) to show how OTM option premium decays across the trading day, with a "now" marker and three stat cards for peak theta, current premium remaining, and optimal entry window.

## Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Strike reference | 10-delta put | Same reference used by IC Snapshot above; keeps panel self-contained |
| Rendering approach | Inline SVG sparkline | Zero dependencies, smooth curve, supports "now" marker; first SVG in codebase but self-contained |
| Primary metric | Premium remaining % | Descending 100% to ~0% curve; "now" marker shows current position |
| Supplementary info | 3 stat cards (Peak theta/hr, Premium Now, Entry Window) | Mirrors existing grid card pattern; Entry Window is the most actionable derived value |

## Component: `ThetaDecayChart`

### Location

New file: `src/components/ThetaDecayChart.tsx`

### Props

```typescript
interface ThetaDecayChartProps {
  spot: number;
  sigma: number;           // 10-delta put sigma (row.putSigma)
  strikeDistance: number;   // spot - putSnapped
  hoursRemaining: number;  // results.hoursRemaining
}
```

### Rendering gate

Rendered inside `AdvancedSection.tsx`, below the IC Snapshot IIFE, gated on:
- `results` exists
- 10-delta row exists and is not an error
- `calcThetaCurve()` returns a non-empty array

Same conditional pattern as the existing IC Snapshot block.

### Layout (top to bottom)

1. **Section header**: `THETA DECAY (10-DELTA PUT)` in the standard `text-tertiary` uppercase tracking style
2. **SVG sparkline** inside `bg-surface-alt rounded-lg p-3`:
   - `viewBox="0 0 300 60"`, width 100%, height ~60px
   - Area fill with vertical gradient (accent color, 25% top opacity to ~3% bottom)
   - Polyline stroke in accent color, 1.5px
   - X-axis: hours remaining mapped linearly (6.5h at left edge, 0.5h at right edge)
   - Y-axis: premium % (100% at top, 0% at bottom)
   - Data: 13 points from `calcThetaCurve()` mapped to SVG coordinates
   - "Now" marker (when `hoursRemaining` is within 0.5-6.5h range):
     - Vertical dashed line in amber (#f59e0b), 0.75px stroke-dasharray
     - Filled circle (r=3.5) in amber at the interpolated position
     - Inline text label: `XX% left` in amber monospace 8px
   - Subtle axis labels: `open` / `close` below chart, `100%` / `0%` on left edge
3. **Three stat cards** in `grid-cols-3 gap-2`:
   - **Peak theta/hr**: Highest `thetaPerHour` value from the curve, with `@ X.Xh` subtitle showing when it occurs
   - **Prem Now**: Premium % interpolated at current `hoursRemaining` from the curve data
   - **Entry Window**: Contiguous hour range where `thetaPerHour >= session average`, displayed as ET clock time (e.g., `11a-1p`)
4. **Caption**: italic muted text: `Premium remaining for 10-delta OTM put across the session.`

### Entry Window calculation

```
1. Compute mean thetaPerHour across all 13 curve points
2. Find all points where thetaPerHour >= mean
3. Take the contiguous run (longest if multiple)
4. Convert boundary hoursRemaining values to ET clock times:
   - Market close = 4:00 PM ET
   - clockHour = 16 - hoursRemaining
   - Format as e.g. "11a-1p" (12-hour, no minutes when on the hour)
5. If no points exceed mean or outside market hours: show em-dash
```

### "Now" marker interpolation

The curve has discrete 0.5h steps. When `hoursRemaining` falls between two points:
- Linear interpolation between the two bracketing points for both x-position and premium %
- If `hoursRemaining` > 6.5 or < 0.5: marker is hidden

### SVG coordinate mapping

```
xScale: hoursRemaining -> SVG x
  x = ((6.5 - hoursRemaining) / 6.0) * viewBoxWidth

yScale: premiumPct -> SVG y
  y = ((100 - premiumPct) / 100) * viewBoxHeight
```

Points are connected with straight line segments (not Bezier curves) for simplicity and accuracy to the underlying data. The area fill path closes to the bottom-right and bottom-left corners.

## Integration into AdvancedSection

The component slots into `AdvancedSection.tsx` inside the `{results && (...)}` block, after the IC Snapshot IIFE (line ~341), before the closing `</div>` of that block. It shares the same conditional: only renders when `results` and a valid 10-delta row exist.

No new props needed on `AdvancedSection` — all required data (`spot`, `sigma`, `strikeDistance`, `hoursRemaining`) is derivable from the existing `results` prop.

## Styling

All styling uses existing Tailwind classes and CSS variables from the theme system:
- `bg-surface-alt`, `rounded-lg` for containers
- `text-tertiary` for headers and labels
- `text-primary` for values
- `font-mono` for numbers
- `text-muted` for captions
- SVG colors: theme accent for the curve, `#f59e0b` (amber) for the now marker

## Edge cases

| Condition | Behavior |
|-----------|----------|
| No results or no 10-delta row | Section not rendered |
| `calcThetaCurve` returns empty (far OTM, zero premium) | Section not rendered |
| `hoursRemaining` outside 0.5-6.5h | Sparkline renders without "now" marker; Prem Now shows em-dash |
| All `thetaPerHour` values equal (flat curve) | Entry Window shows em-dash |
| Before market open | Section renders based on model params; now marker hidden |

## Testing

- Unit test for `ThetaDecayChart` rendering with mock curve data
- Verify "now" marker interpolation at exact data points and between points
- Verify entry window calculation with known theta curves
- Verify the component doesn't render when curve is empty

## Dependencies

- `calcThetaCurve` from `src/utils/iron-condor.ts` (already exported via `calculator.ts`)
- No new packages
- No new hooks or state
