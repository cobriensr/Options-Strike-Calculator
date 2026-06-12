# Frontend Recomposition — Phase 3 Implementation Plan (Today Command Band)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dense, read-only market-state strip above all panels — SPX/SPY + freshness, VIX + regime, 0DTE gamma gate, expected range, market phase + CT clock — per Phase 3 of the rev-2 recomposition spec.

**Architecture:** New `src/components/TodayBand/` consuming ONLY existing state: `market` (spot, freshness, server `marketOpen`), `dVix` fallback, pure lookups (`findBucket`, `estimateRange`, `currentSessionStage`, `getCTTime`), `useNowMinute` for the clock tick, and `useRegime0dte()` called by the band itself (the hook is localStorage-cached and window-gated; `Regime0dte`'s panel keeps its own call — the hook dedupes nothing but is cheap, 45s poll inside 08:30–15:00 CT only). Not a registry panel: always visible, not reorderable, not hidden by panel prefs. Not sticky in v1.

**Explicit source decisions (two competing options existed for each):**
- **Open/closed for the freshness pill:** server `market.data.quotes?.marketOpen` — consistent with AppHeader's LIVE/STALE/CLOSED badge (`AppHeader/index.tsx:141-173`). The clock slot's phase label uses client `currentSessionStage()` — it's the trading-phase vocabulary (opening-range / credit-spreads / …), not an open/closed gate.
- **VIX:** live `market.data.quotes?.vix?.price`, falling back to `Number.parseFloat(dVix)` (the manual input, default '19') when no live quote. The fallback renders with a `SET` micro-tag so a manual value is never mistaken for live.

**Tech Stack:** React 19, Tailwind 4 (post-Phase-0 scale: `text-xs`=10px, `text-display`=22px). Phases 0–1 must be landed (uses `text-display`; tiers irrelevant here).

**Execution-environment rules:** Same as prior phase plans.

---

### Task 1: `TodayBand` component + tests

**Files:**
- Create: `src/components/TodayBand/index.tsx`, `src/components/TodayBand/BandStat.tsx`
- Test: `src/components/TodayBand/__tests__/TodayBand.test.tsx`

- [ ] **Step 1: Failing test** — fixture a `MarketDataState`-shaped object (follow the mock pattern in `src/__tests__/hooks/useMarketData.test.ts`); mock `useRegime0dte` and `useNowMinute` with `vi.mock`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TodayBand from '../index';

vi.mock('../../../hooks/useRegime0dte', () => ({
  useRegime0dte: () => ({
    displayData: { gate: 'calm', asOfCtMin: 600 },
    isWindowOpen: true,
    loading: false,
    error: null,
    data: null,
    fetchedAt: null,
    refresh: () => {},
  }),
}));
vi.mock('../../../hooks/useNowMinute', () => ({
  useNowMinute: () => new Date('2026-06-11T15:00:00Z').getTime(),
}));

const quotes = {
  spy: { price: 572.1, open: 0, high: 0, low: 0, prevClose: 0, change: 0, changePct: 0 },
  spx: { price: 5721.4, open: 0, high: 0, low: 0, prevClose: 0, change: 0, changePct: 0 },
  vix: { price: 19.2, open: 0, high: 0, low: 0, prevClose: 0, change: 0, changePct: 0 },
  vix1d: null, vix9d: null, vvix: null,
  marketOpen: true,
  asOf: '2026-06-11T15:00:00Z',
};

function marketFixture(over: Record<string, unknown> = {}) {
  return {
    data: { quotes, intraday: null, yesterday: null, events: null, movers: null },
    loading: false, hasData: true, needsAuth: false,
    refresh: async () => {}, fetchedAt: 1, quotesFetchedAt: 1,
    isStale: false, isVeryStale: false, staleAgeSec: null,
    session: 'regular', marketOpen: true,
    ...over,
  } as never;
}

describe('TodayBand', () => {
  it('renders spot, VIX regime, gamma gate, range, and LIVE pill', () => {
    render(<TodayBand market={marketFixture()} dVix="19" linkable />);
    expect(screen.getByText('5721')).toBeInTheDocument();        // SPX big number
    expect(screen.getByText(/VIX 18–20/)).toBeInTheDocument();   // bucket label
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText(/CALM/i)).toBeInTheDocument();       // gamma gate chip
    expect(screen.getByText(/1\.\d{2}%/)).toBeInTheDocument();   // median range %
  });

  it('falls back to manual VIX with a SET tag when quotes are absent', () => {
    render(
      <TodayBand
        market={marketFixture({ data: { quotes: null, intraday: null, yesterday: null, events: null, movers: null } })}
        dVix="22"
        linkable={false}
      />,
    );
    expect(screen.getByText('SET')).toBeInTheDocument();
    expect(screen.getByText(/VIX 20–25/)).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('omits the spot slot entirely without quotes', () => {
    render(
      <TodayBand
        market={marketFixture({ data: { quotes: null, intraday: null, yesterday: null, events: null, movers: null } })}
        dVix="19"
        linkable={false}
      />,
    );
    expect(screen.queryByText('SPX')).toBeNull();
  });

  it('slots scroll-link to their panels when linkable', () => {
    render(<TodayBand market={marketFixture()} dVix="19" linkable />);
    expect(
      screen.getByRole('link', { name: /vix regime/i }),
    ).toHaveAttribute('href', '#sec-regime');
  });
});
```

- [ ] **Step 2: Run — FAIL.** Then implement `BandStat.tsx` (the horizontal variant of OpeningRangeCheck's StatCell):

```tsx
import { memo, type ReactNode } from 'react';

/** One slot in the TodayBand: caps label over a mono value + sub line.
 *  When `href` is set the slot is a link to its full panel. */
export const BandStat = memo(function BandStat({
  label,
  value,
  sub,
  color,
  href,
  ariaLabel,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  href?: string;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <div className="text-tertiary font-sans text-xs font-bold tracking-[0.08em] uppercase">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-display font-bold" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-muted mt-0.5 font-mono text-xs">{sub}</div>}
    </>
  );
  return href ? (
    <a
      href={href}
      aria-label={ariaLabel ?? label}
      className="hover:bg-surface-alt block rounded-md px-3 py-2 no-underline transition-colors"
    >
      {body}
    </a>
  ) : (
    <div className="px-3 py-2">{body}</div>
  );
});
```

- [ ] **Step 3: Implement `TodayBand/index.tsx`:**

```tsx
import { memo } from 'react';
import { theme } from '../../themes';
import { findBucket, estimateRange } from '../../data/vixRangeStats';
import { currentSessionStage } from '../../data/marketHours';
import { getCTTime } from '../../utils/timezone';
import { useNowMinute } from '../../hooks/useNowMinute';
import { useRegime0dte } from '../../hooks/useRegime0dte';
import { gateMeta } from '../Regime0dte/gate';
import { StatusBadge } from '../ui';
import { BandStat } from './BandStat';
import type { MarketDataState } from '../../hooks/useMarketData';

const STAGE_LABEL: Record<string, string> = {
  'pre-market': 'PRE-MARKET',
  'opening-range': 'OPENING RANGE',
  'credit-spreads': 'CREDIT SPREADS',
  directional: 'DIRECTIONAL',
  bwb: 'BWB',
  'late-bwb': 'LATE BWB',
  flat: 'GO FLAT',
  'post-close': 'POST-CLOSE',
  'half-day': 'HALF DAY',
  closed: 'CLOSED',
};

/**
 * TodayBand — the always-visible market-state strip above all panels.
 * Read-only recomposition of state App.tsx already holds; each slot
 * deep-links to its full panel (calculator view only). Not sticky (v1),
 * not a registry panel, never hidden by panel prefs.
 */
const TodayBand = memo(function TodayBand({
  market,
  dVix,
  linkable,
}: {
  market: MarketDataState;
  dVix: string;
  /** Anchor links only exist on the calculator view. */
  linkable: boolean;
}) {
  const nowMs = useNowMinute();
  const regime0dte = useRegime0dte();

  const quotes = market.data.quotes;
  const liveVix = quotes?.vix?.price ?? null;
  const manualVix = Number.parseFloat(dVix);
  const vix = liveVix ?? (Number.isNaN(manualVix) ? null : manualVix);
  const bucket = vix != null ? findBucket(vix) : null;
  const est = vix != null ? estimateRange(vix) : null;
  const spx = quotes?.spx?.price ?? null;

  const zoneColor = bucket
    ? bucket.zone === 'go'
      ? theme.green
      : bucket.zone === 'caution'
        ? theme.caution
        : theme.red
    : undefined;

  const ct = getCTTime(new Date(nowMs));
  const stage = STAGE_LABEL[currentSessionStage(new Date(nowMs))] ?? 'CLOSED';
  const clock = `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')} CT`;

  const gate =
    regime0dte.isWindowOpen && regime0dte.displayData
      ? gateMeta(regime0dte.displayData.gate)
      : null;

  const href = (anchor: string) => (linkable ? anchor : undefined);

  return (
    <section
      aria-label="Today"
      className="border-edge bg-surface mb-6 flex flex-wrap items-stretch justify-between gap-x-2 gap-y-3 rounded-[14px] border-[1.5px] px-2 py-2.5 shadow-[var(--shadow-subtle)]"
    >
      {spx != null && (
        <BandStat
          label="SPX"
          value={spx.toFixed(0)}
          sub={
            <>
              SPY {quotes?.spy?.price?.toFixed(2) ?? '—'}{' '}
              <StatusBadge
                label={
                  quotes?.marketOpen
                    ? market.isStale
                      ? 'STALE'
                      : 'LIVE'
                    : 'CLOSED'
                }
                color={
                  quotes?.marketOpen
                    ? market.isVeryStale
                      ? theme.red
                      : market.isStale
                        ? theme.caution
                        : theme.green
                    : theme.textMuted
                }
                dot
              />
            </>
          }
          href={href('#results')}
          ariaLabel="SPX spot — jump to results"
        />
      )}
      {vix != null && bucket && (
        <BandStat
          label="VIX Regime"
          value={
            <>
              {vix.toFixed(1)}
              {liveVix == null && (
                <span className="text-muted ml-1.5 align-middle font-sans text-xs font-bold">
                  SET
                </span>
              )}
            </>
          }
          sub={bucket.label}
          color={zoneColor}
          href={href('#sec-regime')}
          ariaLabel="VIX regime — jump to Market Regime"
        />
      )}
      <BandStat
        label="0DTE Gamma"
        value={
          gate ? (
            <span className={gate.chipClass + ' rounded px-2 py-0.5 text-md'}>
              {gate.label}
            </span>
          ) : (
            <span className="text-muted text-md">PRE-OPEN</span>
          )
        }
        sub={gate ? undefined : '08:30–15:00 CT'}
        href={href('#sec-regime-0dte')}
        ariaLabel="0DTE gamma regime — jump to panel"
      />
      {est && (
        <BandStat
          label="Expected Range"
          value={`${est.medHL.toFixed(2)}%`}
          sub={
            spx != null
              ? `±${Math.round((est.medHL / 100) * spx)} pts · 90th ${est.p90HL.toFixed(2)}%`
              : `90th ${est.p90HL.toFixed(2)}%`
          }
          href={href('#sec-regime')}
          ariaLabel="Expected daily range — jump to Market Regime"
        />
      )}
      <BandStat label={stage} value={clock} />
    </section>
  );
});

export default TodayBand;
```

Implementation notes for the executor:
- `gateMeta`'s `chipClass` is currently raw dark-palette (`Regime0dte/gate.ts` — known S2 offender; Phase 6/7 tokenizes it). Reusing it keeps the gate look consistent between band and panel; do not invent a second gate styling.
- Verify `gateMeta`'s actual export signature before use (`grep -n 'export' src/components/Regime0dte/gate.ts`) — adjust the property names (`label`, `chipClass`) to what exists.
- `theme.textMuted` — confirm the key exists in `src/themes/index.ts` (it does: `textMuted`).
- Importing `gate.ts` into the eager bundle pulls a few hundred bytes out of the lazy Regime0dte chunk — acceptable; do NOT import the whole `Regime0dte` component.

- [ ] **Step 4: Run tests — PASS** (`npx vitest run src/components/TodayBand`). Adjust fixture property names against the real `MarketDataState` if the interface drifted.

- [ ] **Step 5: Commit** (`feat(design): Add TodayBand market-state strip` + push).

---

### Task 2: Mount in both views

**Files:**
- Modify: `src/App.tsx` (calculator branch ~line 1570; alerts branch ~line 1554)

- [ ] **Step 1:** Calculator view: render inside the content container, ABOVE the subtitle, so it's the first thing in the column (App.tsx, inside `<div className="mx-auto max-w-[660px] px-5 pt-6 pb-12 lg:max-w-6xl">`):

```tsx
              <div className="mx-auto max-w-[660px] px-5 pt-6 pb-12 lg:max-w-6xl">
                <TodayBand market={market} dVix={dVix} linkable />
                {/* Subtitle — below sticky header */}
                …
```

- [ ] **Step 2:** Alerts view: between `{notificationPrompt}` and `<OptionsAlertsView …>`, wrapped to match that view's padding (check `OptionsAlertsView`'s own container for the right horizontal padding class; the alerts shell is `h-dvh flex flex-col overflow-hidden`, so the band is a fixed-height flex child — `shrink-0`):

```tsx
        <>
          {notificationPrompt}
          <div className="shrink-0 px-5 pt-4">
            <TodayBand market={market} dVix={dVix} linkable={false} />
          </div>
          <OptionsAlertsView … />
        </>
```

- [ ] **Step 3:** Import `TodayBand` in App.tsx (eager import — it's above-the-fold chrome, not a lazy panel). The subtitle paragraphs' `mb-8` spacing may need to drop to `mb-6` — judge from the screenshot pass.

- [ ] **Step 4: Verify**

```bash
npx vitest run src && npx tsc --noEmit && npx eslint src --max-warnings=0 && npm run build
```

App-level render tests (`src/__tests__/App.panel-render.test.tsx`) may need the `useRegime0dte` mock added to their setup — same `vi.mock` as Task 1's test.

- [ ] **Step 5: Commit** (`feat(design): Mount TodayBand on calculator and alerts views` + push).

---

### Task 3: Phase-end verification + review

- [ ] **Step 1:** Scoped or full verification per tree state + `npm run build`.
- [ ] **Step 2:** `code-reviewer` agent over the Phase 3 commit range; apply feedback.
- [ ] **Step 3:** Screenshot pass, both themes, both views, signed-out and owner: band shows SET-tagged manual VIX when signed out; PRE-OPEN gamma slot outside the window; LIVE/STALE pill matches the header badge; slots link-scroll on the calculator view only. After-hours check: stage label reads POST-CLOSE/CLOSED, clock ticks on the minute.
