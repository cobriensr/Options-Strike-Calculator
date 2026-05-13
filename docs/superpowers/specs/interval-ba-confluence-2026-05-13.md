# Interval B/A — cross-symbol confluence (SPY + SPXW + QQQ)

**Created:** 2026-05-13 (market open, post-edge-validation)
**Parent specs:**
- [interval-ba-ask-alert-2026-05-12.md](./interval-ba-ask-alert-2026-05-12.md) — original SPXW handler + alert path
- [interval-ba-push-v2-2026-05-12.md](./interval-ba-push-v2-2026-05-12.md) — Web Push fan-out via VAPID

## Goal

Detect when the same-direction Interval B/A signal fires on **multiple** of SPY, SPXW, and QQQ within a tight time window (90s), tag the alert row with which other tickers participated, and gate phone-push notifications to confluence events only by default. Solo fires continue to land in the DB and the in-app feed but stop hammering the device.

The 2026-05-13 SPY/QQQ edge analysis ([interval-ba-analysis-spy-20260513-092202.md](../../tmp/interval-ba-analysis-spy-20260513-092202.md), [interval-ba-analysis-qqq-20260513-092206.md](../../tmp/interval-ba-analysis-qqq-20260513-092206.md)) confirms the same 75% / $250K thresholds apply across all three tickers, so no per-ticker calibration is needed. The 2026-05-12 confluence-vs-solo analysis ([interval-ba-confluence-vs-solo-20260512-231709.md](../../tmp/interval-ba-confluence-vs-solo-20260512-231709.md)) shows the SPXW CALL hit-rate lifts from **53.3% (solo) → 61.3% (+SPY or +QQQ within 90s)** — that +8pp is the prize.

## Decided design

| Knob | Value | Source |
|---|---|---|
| Ratio threshold | **0.75** for all 3 tickers | empirical edge cuts, all 3 tickers |
| Premium floor | **$250,000** for all 3 tickers | inherit SPXW (calibrating SPY/QQQ floors would delay; current floor already gates 75% of QQQ and 80% of SPY backfilled fires) |
| Confluence window | **90 seconds** symmetric around fire | confluence-vs-solo run |
| Bucket window | **300 seconds** (unchanged) | existing |
| Confluence tag granularity | **list of tickers** (e.g. `['SPY','QQQ']`), not a 2way/3way label | preserves info for downstream queries without committing to a tier scheme |
| Default push policy | **confluence-only ON** by default; solo SPXW push suppressed until user opts in | volume forecast = ~205 alerts/day if all-solo pushes; user choice from 2026-05-13 scoping |
| In-app feed | shows **all** fires (solo + confluence), confluence ones get a pill | confluence is post-hoc-visible without phone push |

## Architecture (delta from current SPXW-only)

```
WS subscriptions
  option_trades:SPY   ─┐
  option_trades:SPXW   ├──► each routes to its own IntervalBAHandler instance
  option_trades:QQQ   ─┘    (subclass of OptionTradesHandler, same as today)
                              │
                              │  on every fire:
                              ▼
            shared module-level RecentFires registry  (key: ticker, dir; value: deque[(ts, …)])
                              │
                              │  lookback ±90s for OTHER-ticker same-direction fires
                              ▼
            confluence_tickers = ['SPY', 'QQQ']  →  written to interval_ba_alerts row
                              │
                              ▼
            push fan-out — title decorated, gated by confluence-only setting
```

Critical correctness note: the registry MUST be process-local. uw-stream runs one Railway service, single asyncio loop — concurrent writes are not a concern, but **out-of-order ticks** are. Each handler's `_observe` is called from one drain task per channel, but the registry is written from 3 handlers. Use an `asyncio.Lock` per ticker pair or a simple threading.Lock (the GIL covers the deque mutations; the lock matters only if a future change moves handlers onto separate threads).

## Phases

Each phase is independently shippable. After each phase: run `npm run review` (or pytest for uw-stream), spawn the code-reviewer subagent, fix findings, commit + push, move on.

### Phase 1 — DB migration + confluence_tickers column

**Files:**
- `api/_lib/db-migrations.ts` — Migration #146 adding `confluence_tickers TEXT[]` to `interval_ba_alerts`
- `api/__tests__/db.test.ts` — update applied-migrations list + SQL call count

```sql
ALTER TABLE interval_ba_alerts
ADD COLUMN IF NOT EXISTS confluence_tickers TEXT[];

CREATE INDEX IF NOT EXISTS idx_interval_ba_alerts_confluence
  ON interval_ba_alerts USING GIN (confluence_tickers);
```

GIN index because we'll filter `WHERE 'SPY' = ANY(confluence_tickers)` etc. in the feed endpoint.

### Phase 2 — Generalize handler to SPY/SPXW/QQQ

**Files:**
- `uw-stream/src/handlers/interval_ba.py` — rename `SPXWIntervalBAHandler` to `IntervalBAHandler`, add `ticker` constructor arg, remove the `if ticker != "SPXW": return` guard
- `uw-stream/src/channel_registry.py` — add `option_trades:SPY` and `option_trades:QQQ` to the exact dict
- `uw-stream/src/config.py` — add `interval_ba_tickers: list[str] = ['SPY', 'SPXW', 'QQQ']` (forward-compat; lets us drop a ticker without code change if signal degrades)
- `uw-stream/tests/test_interval_ba.py` — parameterize existing tests by ticker, add SPY + QQQ smoke tests

Open question: does each handler instance have its own queue, drain task, and DB write batch — or do we want one shared queue? **Default pick: one instance per ticker.** Each gets its own queue so SPY's 10K ticks/day don't backpressure SPXW's 50K. This matches today's invariant in `main._build_handlers` (one instance per class). Subclasses of `IntervalBAHandler` per ticker (`SPYIntervalBAHandler`, `SPXWIntervalBAHandler`, `QQQIntervalBAHandler`) preserve the one-instance-per-class invariant without changing the dispatcher.

### Phase 3 — Shared RecentFires registry + confluence tagging

**Files:**
- `uw-stream/src/handlers/recent_fires.py` (NEW) — module-level deque keyed by `(ticker, option_type)`; methods `record(ticker, opt_type, fired_at)` and `lookup_confluence(ticker, opt_type, fired_at, window_sec)` → `list[str]` of OTHER tickers that fired same-direction in the window
- `uw-stream/src/handlers/interval_ba.py` — on successful fire, call `record(...)` AND `lookup_confluence(...)`; pass result into the alert row tuple as a list (or NULL)
- `uw-stream/tests/test_recent_fires.py` (NEW) — unit tests for window semantics, pruning, ordering

The registry needs:
- Bounded memory: deque maxlen=200 per `(ticker, opt_type)` key is more than enough for 90s @ ~1 fire/minute peak
- Time-based eviction is not required if maxlen is small; old entries get pushed out naturally
- Symmetric window: a fire records itself, then looks back. The "look forward" half of the symmetric window is handled by the LATER-firing handler's lookback — there's no need to re-tag already-written rows.

**Caveat on symmetric semantics:** if SPXW fires at T=0 and SPY fires at T=+30s, the SPXW alert row written at T=0 will NOT have SPY in its `confluence_tickers` (SPY didn't exist yet). The SPY alert row written at T=+30s WILL have SPXW in its list. This is **asymmetric tagging on write** — acceptable trade-off, because:
- the downstream push notification at T=+30s tags "+SPXW" which is what we care about for actionable alerts
- the feed badge can either show "confluence partner exists" at query time (with a 90s correlated-query) or accept the slight asymmetry — recommend showing both rows in the feed with the same confluence pill rendered by the LATER row's data

Alternative considered and rejected: write a placeholder row at T=0 and UPDATE it at T=+30s. Too complex, and the asymmetry doesn't hurt — the actionable surface is the push notification.

### Phase 4 — Push payload + user setting

**Files:**
- `uw-stream/src/notify.py` — `build_payload(row, columns)` decorates the title with `+SPY +QQQ` when `confluence_tickers` is non-empty. Add a kwarg `confluence_only=True` that returns `None` to skip notify when the alert is solo
- `uw-stream/src/handlers/interval_ba.py` — read `settings.interval_ba_push_confluence_only` (default `True`) and pass to `build_payload`
- `uw-stream/src/config.py` — `interval_ba_push_confluence_only: bool = True`
- `api/_lib/push.ts` — no changes needed; payload is opaque to the fan-out service
- (Frontend) eventual toggle UI — defer to Phase 6

### Phase 5 — Backend feed + endpoints expose confluence

**Files:**
- `api/interval-ba-feed.ts` — return `confluence_tickers` array in the response; add optional `?confluenceOnly=1` query filter (`WHERE confluence_tickers IS NOT NULL AND array_length(confluence_tickers, 1) > 0`)
- `api/interval-ba-alerts.ts` — same: include in payload for the live banner
- `api/__tests__/interval-ba-feed.test.ts`, `api/__tests__/interval-ba-alerts.test.ts` — assertions for confluence pass-through

### Phase 6 — Frontend feed + banner UI

**Files:**
- `src/components/IntervalBAFeed/IntervalBARow.tsx` — pill showing `+SPY +QQQ` next to the ticker badge when `confluence_tickers` is non-empty
- `src/components/IntervalBAAlertBanner.tsx` — same pill in the live banner
- `src/components/IntervalBAFeed/IntervalBAFeed.tsx` — add a "Confluence only" filter toggle (drives `?confluenceOnly=1` on the feed endpoint)
- `src/hooks/useIntervalBAFeed.ts` — accept and forward `confluenceOnly` arg
- `src/__tests__/IntervalBARow.test.tsx` — pill rendering test

### Phase 7 — Backfill confluence tags onto historical rows

**Files:**
- `scripts/backfill_confluence_tags.py` (NEW) — one-shot, ticker-agnostic SQL pass: for each alert row, look back ±90s in the same table for OTHER-ticker same-direction fires and UPDATE `confluence_tickers`. Idempotent (skips rows that already have a non-NULL value unless `--force`).

After this runs once, the historical feed shows confluence pills for the entire 89-day backfill window, and we can validate the live tagging matches the same logic.

## Data dependencies

- **DB:** new column + GIN index on `interval_ba_alerts` (Phase 1)
- **Env vars:** none new — reuses `INTERNAL_NOTIFY_SECRET` and VAPID keys
- **External APIs:** none new — SPY/QQQ ticks already flow through `option_trades:*` WS subscriptions

## Open questions (with default picks noted)

1. **Per-ticker thresholds for SPY and QQQ.** Default: inherit SPXW (0.75 / $250K). Locked by 2026-05-13 edge analysis.
2. **Confluence window = 90s.** Default locked from confluence-vs-solo analysis. If false-positive rate is high in live, can be tightened in `config.py` without redeploy of the handler logic.
3. **Tier naming (2way vs 3way) in payload.** Default: just store the list; let the UI render `+SPY` (1 partner) vs `+SPY +QQQ` (2 partners). Avoids a "tier" semantic we'd have to maintain.
4. **Solo SPXW pushes by default.** Default: OFF (confluence-only). User can opt back in via the eventual frontend toggle.
5. **Asymmetric tagging.** Accepted (write-only-on-fire, see Phase 3). If the user wants symmetric tagging, Phase 7 can re-run on a cadence (cron) to catch the trailing partner, but the push payload at fire-time is the actionable surface.
6. **Per-ticker push opt-out.** Default: not exposed initially. Single global confluence-only toggle. Revisit if SPY/QQQ alerts in confluence still feel noisy after a week of live use.

## Rollout

- Ship Phases 1-3 (DB + handler + registry) without enabling SPY/QQQ subscriptions — confluence_tickers will start populating with empty lists on every SPXW fire. Verify no perf regression on the SPXW path.
- Flip the SPY + QQQ subscriptions on in `config.py` (Phase 2 deliverable). The registry will begin recording all three; SPXW rows will start showing real confluence partners.
- Ship Phases 4-5 (push gating + endpoint). Confluence-only push goes live with `interval_ba_push_confluence_only=True`. Watch for 24h.
- Ship Phase 6 (UI) once the live data has confluence pills to render.
- Phase 7 is independent — can run any time after Phase 1 to populate the historical table for the feed.

## Thresholds / constants summary

```
RATIO_THRESHOLD       = 0.75       # ask / total premium per 5-min bucket
PREMIUM_FLOOR         = 250_000    # USD, per bucket
BUCKET_SEC            = 300        # 5-min
CONFLUENCE_WINDOW_SEC = 90         # symmetric, but tagged on write only
RECENT_FIRES_MAX_LEN  = 200        # per (ticker, opt_type) deque cap
TICKERS               = ['SPY', 'SPXW', 'QQQ']
```
