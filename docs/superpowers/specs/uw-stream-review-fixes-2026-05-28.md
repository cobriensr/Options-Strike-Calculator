# uw-stream code-review fixes — 2026-05-28

## Goal

Fix the findings from the full code review of `uw-stream/` (the UnusualWhales
websocket consumer). Each fix ships with tests in the same commit.

## Findings → fixes

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | SPXW Interval-BA alerts silently dead if UW sends `underlying_symbol="SPX"` — the `_TICKER` guard compares the underlying-derived ticker, not the contract. | Guard on the **OCC root** parsed from `option_chain` (authoritative). Stamp alert rows with `self._TICKER`. Regression test: `underlying_symbol="SPX"` + SPXW chain must still fire. |
| 2 | Medium | Connector backoff is sticky — reset only on graceful close, not on a successful connect. A healthy session that drops inherits escalated backoff. | Reset `backoff` to `_INITIAL_BACKOFF_S` after a connection is **established** (`ws_connected=True`), matching UW's own reference sketch. |
| 3 | Medium | `IntervalBAHandler._ticks` chain keys never evicted — slow unbounded growth across days. | Amortized global sweep (`_prune_ticks_if_needed`) + drop emptied chains inline, mirroring `_prune_fired_if_needed`. |
| 4 | Low-Med | Shutdown drains consumers while producers (connector/router) still run → late messages enqueued post-drain are lost. | Cancel connector + router **first**, then drain handlers against a static queue, then cancel the rest. |
| 5 | Low-Med | Final-batch `schedule_notify` tasks orphaned + cancelled at loop close. | `notify.drain_pending(timeout)` awaited after handler drains. |
| 6 | Latent | `/healthz` treats market-closed silence as broken (503 after grace) — restart-loop trap if `healthcheckPath` is ever added. | Market-hours gate: outside RTH, a connected socket is healthy even with no recent message. Document in `railway.toml`. |
| 7 | Low | GEX deadlock-avoidance sort invariant relied on prose only. **On inspection the code is correct** (cron is per-`(ticker,expiry)`, WS tuple-sort reduces to strike order within the contended set). | Comment-harden both sides; no logic change. |
| 8 | Low | ~150 join frames fired back-to-back on every reconnect (lottery universe) — possible UW join-rate trip. | Light per-join pacing (`_JOIN_PACING_S`). |
| 9 | Minor | Push title `:.0f` rounds half-dollar strikes. | `%g`-style formatting that preserves fractional strikes. |
| 10 | Minor | `notify_alert` builds a fresh `aiohttp.ClientSession` per call. | Lazily-created shared session; closed on shutdown via `drain_pending`/`close_session`. |

## Phases (≤5 files each, tests in same commit, reviewer subagent per phase)

1. **Connector** (#2, #8) — `src/connector.py`, `tests/test_connector.py`
2. **Interval-BA** (#1, #3) — `src/handlers/interval_ba.py`, `tests/test_interval_ba.py`
3. **Notify** (#9, #10, #5) — `src/notify.py`, `tests/test_notify.py`
4. **Main lifecycle** (#4, #5) — `src/main.py`, `tests/test_main.py`
5. **Health + GEX comment + railway** (#6, #7) — `src/health.py`, `tests/test_health.py`, `src/handlers/gex_strike_expiry.py`, `api/cron/fetch-gex-strike-expiry-etfs.ts`, `railway.toml`

## Constraints

- Parallel sessions hold WIP in `classifier/`, `api/_lib/build-info.ts`, `package-lock.json`, `scripts/`. Use **targeted `git add`** of `uw-stream/` + this doc only.
- Commit directly to `main`. Run the uw-stream pytest suite per phase.
