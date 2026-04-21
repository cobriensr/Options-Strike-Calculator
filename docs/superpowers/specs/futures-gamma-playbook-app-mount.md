# FuturesGammaPlaybook — App.tsx mount patch

## Summary

Phase 1D.3 ships the `FuturesGammaPlaybook` widget end-to-end (five panels:
regime header, playbook rules, ES levels, regime timeline, triggers). This
patch wires the widget into `src/App.tsx` so it renders below the existing
GEX Landscape section and so its `PlaybookBias` payload is forwarded into
the analyze endpoint alongside the existing `gexLandscapeBias`.

A parallel session currently holds uncommitted edits in `App.tsx` (time
editing feature, ~135 lines). Apply the steps below once that work is
committed and the tree is clean.

## 1. Imports to add

Add the lazy component near the other lazy mounts (around line 101–106):

```ts
const FuturesGammaPlaybook = lazy(() =>
  import('./components/FuturesGammaPlaybook').catch(handleStaleChunk),
);
```

Add the `PlaybookBias` type import near the top of the file (grouping with
other type imports):

```ts
import type { PlaybookBias } from './components/FuturesGammaPlaybook/types';
```

## 2. State to add

Immediately below `const [gexBiasContext, setGexBiasContext] = useState<...>`
(around line 494), add:

```ts
const [playbookBiasContext, setPlaybookBiasContext] =
  useState<PlaybookBias | null>(null);
```

Note the type difference from `gexBiasContext` (which is a preformatted
`string | null` produced by `formatBiasForClaude`). `FuturesGammaPlaybook`
emits the structured `PlaybookBias` object — we stash the object here and
let `useAnalysisContext` format it on the way out (or forward it structured;
see §4).

## 3. JSX to add

Place the mount immediately after the existing `<GexLandscape>` block
(around line 1122, after its closing `</ErrorBoundary>`). Use the same
`isOwner && (market.hasData || !!historySnapshot)` guard so the widget
only appears for the owner with loaded data:

```tsx
{isOwner && (market.hasData || !!historySnapshot) && (
  <>
    <span id="sec-futures-gamma-playbook" className="block scroll-mt-28" />
    <ErrorBoundary label="Futures Gamma Playbook">
      <Suspense fallback={<SkeletonSection lines={6} tall />}>
        <FuturesGammaPlaybook
          marketOpen={market.marketOpen}
          onBiasChange={setPlaybookBiasContext}
        />
      </Suspense>
    </ErrorBoundary>
  </>
)}
```

Note the widget sources its own data — no props for `strikes`, `timestamp`,
etc. That's intentional; `useFuturesGammaPlaybook(marketOpen)` aggregates
`useGexPerStrike` + `useFuturesData` + `useSpotGexHistory` internally.

## 4. Analyze context wiring

`playbookBiasContext` is a `PlaybookBias` object, not a string. Two options:

### Option A — serialize inline (preferred, minimal diff)

In the `useAnalysisContext(...)` call around line 629, pass a formatted
string:

```ts
playbookBias: playbookBiasContext
  ? JSON.stringify(playbookBiasContext)
  : null,
```

Then in `src/hooks/useAnalysisContext.ts` add a new field alongside the
existing `gexLandscapeBias`:

```ts
// UseAnalysisContextParams
playbookBias?: string | null;

// destructure
playbookBias,

// inside the returned object
playbookBias: playbookBias ?? undefined,

// add to the deps array
playbookBias,
```

And mirror the field on `AnalysisContext` in
`src/components/ChartAnalysis/types.ts`:

```ts
playbookBias?: string | null;
```

### Option B — structured passthrough (future-friendlier)

If the analyze prompt should see the structured object, extend the types
on both sides with a typed `playbookBias?: PlaybookBias | null` field and
let the prompt formatter (`api/_lib/analyze-context.ts`) render it into
human-readable copy alongside the existing `formatSpotExposuresForClaude`
helpers. This is slightly more code but matches the pattern used for
other structured bias payloads.

Pick Option A for now — minimal churn, keeps the bias surface string-shaped
like `gexLandscapeBias`. Option B can land whenever the analyze prompt is
reworked to consume structured bias payloads.

## 5. Verification checklist

After applying:

- [ ] `npm run lint` — zero TypeScript + ESLint errors.
- [ ] `npm run test:run` — all vitest suites pass.
- [ ] `npm run dev` — the widget renders below GEX Landscape; collapsing
      it, scrubbing through timestamps, and jumping dates all work.
- [ ] DevTools network panel: no new endpoints fire on mount beyond the
      already-wired `/api/gex-per-strike`, `/api/futures-snapshot`,
      `/api/spot-gex-history`, and (owner-only live) `/api/max-pain-current`.
- [ ] Analyze endpoint manual trigger — confirm the `playbookBias` field
      appears in the outgoing request payload (visible in the Anthropic
      call site's logging).
