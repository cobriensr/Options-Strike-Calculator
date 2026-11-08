# Futures front month: one contract per CME session

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development, one implementer stream at a time (CLAUDE.md). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the one-minute carry-basis spikes in the `futures_bars` root series. Each root's contract is chosen once per CME session, from the previous session's volume, and only ever moves forward. Every bar records the contract it came from. The same rule is used live and in every repair. History is then repaired from 2026-09-04.

**Architecture:**
- uw-stream stores its per-contract volume tally per CME trade date in Neon.
- On a session's first print, it writes that session's contract to a decisions table. A row there never changes.
- Every bar of a trade date comes from that contract, and carries it in `futures_bars.contract`.
- The TypeScript repairs (the gap cron and the backfill scripts) read and write the same table instead of replaying a tally.
- A one-time seed fills the table from UW daily candles.
- A one-time repair rewrites the bars that came from the wrong contract and tags the rest.

**Tech stack:** uw-stream (Python asyncio + asyncpg), Vercel functions and tsx scripts (TypeScript), Neon Postgres, UW REST (daily candles, trade prints).

**Background:**
- `docs/superpowers/specs/2026-11-06-futures-sept-bar-backfill.md`, section "Finding: front-month flips".
- **Owner decision, 2026-11-06:** option A, pick at the session open. It was chosen over option B: switch during the day once the next contract has led the day's volume for K straight minutes.
- **Owner decision, 2026-11-07: the mix.** `docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md` Phase 6 (session strike-calculator-16) had planned a different rule for the same code: a later contract takes over after leading the UTC-day tally for 120 straight minute closes. The owner chose a mix of the two:
  - **Kept from that spec:** task 6a (the `futures_bars.contract` column, carried by the shared insert and fetch in `api/_lib/futures-bars.ts`) and the contract parser from task 6b (`parseContract`, `canonicalContract`, `compareExpiry`, `nullSeedContract`, `CONTRACT_CYCLE`, `MONTH_CODES` in `api/_lib/futures-contracts.ts`).
  - **Replaced:** the 120-close streak (`replayRollForward`, `ROLL_GUARD_CLOSES`, `SEED_LOOKBACK_DAYS`) gives way to this plan's per-session pick.
  - **Why:** on a typical ES roll the streak switches mid-morning (about 10:30 CT if Dec starts out-trading Sept at 08:30 CT), which puts a ~55-point calendar-spread step inside the session the owner trades. The session pick puts the step at the 17:00 CT open.
  - **Ownership:** this plan owns the rule end to end, replacing tasks 6b (the rule half), 6c, 6d and 6e of that spec.
  - **Deadline:** live before 2026-12-09, the ESZ6 → ESH7 roll.

## Why

**Today's rule** (`uw-stream/src/handlers/futures_trades.py` rule 5, mirrored by `replayFrontMonth`): each minute's contract is whichever has the most deduped volume since 00:00 UTC. The tally lives in memory.

- **Midnight resets:** at 00:00 UTC the tally starts from zero, so the first back-month lots of the day lead it.
  - Seen live: CL 11-05 00:00, one minute about $1–2 off.
  - Seen in the backfill: CL 09-07 00:00, and RTY 09-14 00:00–02:00, about five flips of ±21 points while the two months traded near parity.
- **Restarts:** a uw-stream restart also empties the tally. That is the likely cause of the live CL minutes at 09-30 02:36 and 10-29 01:19, both deploy days.
- **Mid-session roll:** the roll lands at whatever minute the two tallies cross (ES 09-14 13:45 UTC). That can fall inside the Globex window `auto-prefill-premarket` reads (17:00 → 08:30 CT), which would make the Globex high/low one basis too wide.
- **Why "keep the incumbent until it is overtaken" isn't enough on its own:** at 00:00 the incumbent's day volume is zero as well, so one back-month lot still counts as overtaking.

## The rule

1. **Trade date.** `tradeDate(ts)` is the America/Chicago calendar date of `ts + 7 h`.
   - The session for trade date D runs from 17:00 CT the evening before to 17:00 CT on D. Nothing trades 16:00–17:00 CT.
   - UW daily candles use the same sessions. Probe 2026-11-06 (`docs/tmp/uw-futures-run/daily-candle-probe.mjs`): the ESZ6 candle `date` 2026-11-04 has `start` 11-03T23:00Z and `end` 11-04T23:00Z.
2. **Contract names.** Every contract is handled under its one canonical name, `canonicalContract(root, sym, ref)`: root, CME month code, last year digit (`ESZ26` is `ESZ6`). The ref is the trade date D.
   - A symbol whose canonical name is null (a spread, another root, a two-digit year outside the window) is ignored everywhere.
   - Expiry order is `compareExpiry(parseContract(…))`. A one-digit year is the one year in [ref − 1, ref + 8] ending in that digit, so `ESH0` near 2029-12 is 2030.
3. **One contract per root per trade date**, in `futures_front_month (product, trade_date)`.
   - The row is written once by whoever needs it first: uw-stream, the gap cron or a script.
   - Writes use `ON CONFLICT DO NOTHING` and then re-read the row, so every writer ends up with the same answer.
   - A row is never updated.
   - Every writer refuses a decision row dated after the current trade date. The current date is allowed: the seed writes the running session's row.
4. **The decision for D** (`decideFrontMonth` / `decide_front`):
   - **I** is the contract of the latest decision row before D.
   - **V** is the per-contract volume of the latest trade date before D that has volume rows.
   - **C** is the contract in V with the most volume among those that expire after I. A tie goes to the earlier expiry.
   - **The decision:** front(D) = C if V[C] > V[I], else I. A contract missing from V counts as 0.
   - **No incumbent:** take the contract with the most volume in V (tie: earlier expiry).
   - **No incumbent and no V:** `nullSeedContract(root, D)`, the first contract in the root's cycle that hasn't stopped trading. The writer logs a warning naming the root and date. A seed that is too early can only make the roll one session late.
   - **D after the current trade date:** refused.
5. **Forward only.** A contract expiring on or before I is never chosen, so a false lead can at most roll one session early. That alone keeps the series from rolling back only when each date is decided after the one before it, so `ensureFrontMonth` (and `ensure_front`) enforces the order itself (Phase 2 review, 2026-11-07):
   - **Why:** ES is ESZ6 on 11-03; ESH7 out-trades on 11-04, ESZ6 again on 11-05. In order, 11-05 and 11-06 are both ESH7. Deciding 11-06 first, from the same incumbent but 11-05's volume, gave ESZ6, and 11-05 decided afterwards gave ESH7: a roll back, stored for good.
   - **Fill forward:** before deciding D, it decides each undecided date that has volume rows between I's date and D, oldest first. With no incumbent there is nothing to fill.
   - **Ceiling:** if the answer expires after the contract of the earliest decision after D, it writes that contract instead and warns, naming the product, date, wanted contract, ceiling and incumbent.
   - **Accepted risk:** the inputs are read in one statement and the row is inserted in another. A volume row landing in between, while another process decides a different date, can leave one out-of-order pair (a model found 98 in 300,000 random schedules; none without the volume writer). Closing it would take a conditional insert, and it is left open.
6. **Minutes.** The bar for minute m comes only from front(tradeDate(m)), and its `contract` is that name. If that contract printed nothing in m, the minute is a gap. This is unchanged: there is no back-month fallback.
   - Where two spellings of one contract both have a candle row in a minute (REST paths), the bar is the larger-volume spelling's row (a tie goes to the code-point smaller key), as in the 6b parser tests. The live handler folds both spellings' prints into one bar.

**Expected effect, ES Sept→Dec:** the old rule switched 09-14 13:45 UTC. The new rule switches at the 17:00 CT open after the first full session in which Dec out-traded Sept. Phase 3b prints each root's switch sessions.

## Global constraints

- **Secrets:**
  - Never print `UW_API_KEY` or `DATABASE_URL`. Scripts load `.env.local` inside the process.
  - `.env.local` points at PRODUCTION Neon.
- **Deploy windows:**
  - No uw-stream push 08:30–15:00 CT.
  - This plan touches no `nightly/src`.
- **Deploy order: migrations, then Vercel, then Railway.** The shared insert in `futures-bars.ts` names `contract` on every insert, and the uw-stream handler swallows flush errors. So no commit that writes `contract` reaches main before #204 is applied in prod, and no uw-stream deploy that writes it goes out before that either.
- **Migrations:** apply only when ours are the only ones pending (memory `others-migrations`). Their owners applied #201–#203 on 2026-11-07 (prod's top is #203), so #204 and #205 are the only pending ones unless main adds another before step 4.
- **Tests never touch a real database:** use PGlite or `vi.mock`, and mocks in uw-stream.
- **Prod writes** are idempotent and resumable. The Phase 6 repair keeps a backup of every row it changes.
- **Readers are unaffected:** `futures_bars` gains a nullable `contract` column and nothing else. No reader changes, and no new endpoint, so the UW auth rule is not touched.
- **Every phase** passes `npm run review` (and uw-stream's pytest + ruff for Phase 5), gets a code-reviewer verdict, and is committed on its own.

## Review focus

Inputs the phases must test explicitly (the owning phase is in brackets):

1. **DST weekends** move the session open between 22:00Z and 23:00Z (2026-11-01, 2027-03-14). Test both sides of each boundary. [Phase 2 vectors, used by Phase 5 too]
2. **Year digits:** one-digit years wrap each decade (`ESZ9` → `ESH0`), and UW may send two-digit years (`ESZ26`), which share one tally key and one `contract` value with `ESZ6`. [Phase 2 vectors]
3. **A late last minute:** session D−1's last minute, still open in memory, can receive a print after D's decision. It stays on D−1's contract. [Phase 5]
4. **Restarts:** a restart inside a session, or across the open before a row exists, never changes a decided session's contract. [Phase 2 PGlite, Phase 5]
5. **Neon unreachable while deciding:**
   - uw-stream does not cache the failure, logs the minute as a gap, and retries on the next flush.
   - The cron fails that root by name. [Phases 4a, 5]
6. **Dates decided out of order** (a gap date the cron reaches after a later live row, or a seed re-run over stored rows): the series never rolls back. [Phase 2 PGlite, Phase 3b, Phase 5]

## Data dependencies

- **Migration #204 (from the other spec's task 6a, renumbered from its #203):** `futures_bars.contract TEXT` (nullable), with a `NOT VALID` CHECK allowing only the row's own root, one CME month code and a one- or two-digit year. No index.
- **Migration #205:** two tables.

  ```sql
  CREATE TABLE IF NOT EXISTS futures_contract_volume (
    product    TEXT        NOT NULL,
    trade_date DATE        NOT NULL,
    contract   TEXT        NOT NULL,
    volume     BIGINT      NOT NULL,
    source     TEXT        NOT NULL CHECK (source IN ('live', 'candles')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product, trade_date, contract)
  );
  CREATE TABLE IF NOT EXISTS futures_front_month (
    product    TEXT        NOT NULL,
    trade_date DATE        NOT NULL,
    contract   TEXT        NOT NULL,
    source     TEXT        NOT NULL CHECK (source IN ('live', 'cron', 'script', 'candles')),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product, trade_date)
  );
  ```

  - About 20 volume rows and 6 decision rows per session. No pruning.
  - `contract` in both tables is the canonical name.
  - **`futures_contract_volume` writes:**
    - uw-stream: `ON CONFLICT DO UPDATE SET volume = GREATEST(volume, EXCLUDED.volume), source = 'live'`.
    - The seed: `DO NOTHING`, and only for trade dates before the current one.
- **UW `GET /futures/{contract}/candles?interval=1d&range=6m`:**
  - Keys: `date`, `start`, `end`, `o h l c` (strings), and `v`. `vol` and `tv` carry the same number as `v`.
  - Expired months are still served: ESU6 from 07-07, CLX6 from 07-21.
  - Candle volume runs about 4–6% below `futures_session_stats.session_volume`; the two sources count differently.
- **UW REST trade prints** (existing pager in `api/_lib/futures-flow-repair.ts`).
- No new env vars.

## Phases

### Phase 1: take in 6a and the parser; the tables (small)

Files:
- The six commits from ref `archive/futures-p6-roll-forward` (tip `af648a7c`; the other session drops them from its branch), oldest first: `9c065552`, `d69aea32`, `5b2180b9`, `143fbc49`, `f976a467`, `af648a7c`. Their rulings (year window, canonical names, an out-of-window two-digit key skipped rather than folded) are in `.worktrees/futures-contract-month/.superpowers/sdd/futures-contract-mix-repair-2026-11-06/progress.md`. They touch `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `api/_lib/futures-bars.ts`, `api/__tests__/futures-bars-pglite.test.ts`, `api/_lib/futures-contracts.ts`, `api/__tests__/futures-contracts.test.ts` and `api/__tests__/fixtures/futures-roll-cases.json`. They were reviewed in their own session.
- New work: `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`.

Steps:
- [x] Cherry-pick the six onto this branch, rebased on origin/main. Their migration #203 collides with main's #203 (market_snapshots): renumber it to #204 in the migration, its tests and its comments.
- [x] Add #205, the two tables above. Update `db.test.ts` per CLAUDE.md "DB Migrations".
- [x] Gate, review (the renumber and #205 only), commit. **No push** until #204 and #205 are applied in prod. Done 2026-11-07, local, ending at 859734c6.
- [x] Apply #204 and #205 once they are the only ones pending. Then push. Done 2026-11-08: #204 and #205 applied about 06:42Z, after main's #206; Phases 1–3b pushed (8e7e6430..9c2d02d9).

### Phase 2: the session rule in TypeScript (medium)

Files:
- `api/_lib/futures-contracts.ts`
- `api/__tests__/futures-contracts.test.ts`
- `api/__tests__/fixtures/futures-roll-cases.json`, the shared case fixture read by both test suites (Phase 5 reads it from Python)
- new `api/_lib/futures-front-month.ts`
- new `api/__tests__/futures-front-month-pglite.test.ts`

Consumes (Phase 1): `parseContract`, `canonicalContract`, `compareExpiry`, `nullSeedContract`, `CONTRACT_CYCLE`.

Removes: `replayRollForward`, `RollForwardResult`, `ROLL_GUARD_CLOSES`, `SEED_LOOKBACK_DAYS` and the helpers only they use, their tests and the fixture's streak cases. The parser cases stay.

Produces:
- In `futures-contracts.ts`:
  - `cmeTradeDate(tsIso: string): string`: YYYY-MM-DD.
  - `decideFrontMonth(incumbent: string | null, volumes: ReadonlyMap<string, number>, root: FuturesRoot, tradeDate: string): string`. Rule 4; volume keys are canonicalized and null names dropped.
  - `pickScheduledFront<T extends ContractMinute>(byContract: ReadonlyMap<string, readonly T[]>, contractFor: (tradeDate: string) => string | undefined): Array<{ contract: string; row: T }>`. Rule 6, including the two-spelling case.
- In `futures-front-month.ts`:
  - `ensureFrontMonth(product: FuturesRoot, tradeDate: string, source: 'cron' | 'script'): Promise<string>`. It reads the row; when it is absent, it fills forward and decides by rules 4 and 5 from the tables, applies the ceiling, inserts with DO NOTHING and re-reads. A stored row costs one query; a miss costs four statements with nothing to fill and 5 + 3k with k dates to fill. It logs a warning on the cycle fallback and on a clamp, and throws on a date after the current trade date. DB errors propagate.
  - `fetchFrontMonthSchedule(product: FuturesRoot, tradeDates: readonly string[], source: 'cron' | 'script'): Promise<{ contractFor(tradeDate: string): string | undefined; contracts: string[] }>`. It calls `ensureFrontMonth` for each distinct date. Callers pass only the trade dates their minutes fall on, so weekends get no rows.
  - `insertContractVolumes(rows: ReadonlyArray<{ product: FuturesRoot; tradeDate: string; contract: string; volume: number }>): Promise<number>` and `insertFrontMonthRows(rows: ReadonlyArray<{ product: FuturesRoot; tradeDate: string; contract: string }>): Promise<number>`. Both are batched unnest inserts with DO NOTHING, 500 rows per chunk, `withDbRetry`, `source = 'candles'`, and are used by Phases 3b and 4a. Each checks every row before writing any: a non-canonical contract is refused, `insertContractVolumes` refuses a trade date on or after the current one (a running session's volume is partial), and `insertFrontMonthRows` refuses one after it.
- In the fixture: a `decideFrontMonth` or `pickScheduledFront` case may carry `throws` (a message pattern) instead of an answer. The call must raise. The `format` text says how a port checks it.

Steps:
- [x] Fixture cases plus failing tests:
  - **`cmeTradeDate`:**
    - `2026-11-05T22:59Z` → `2026-11-05` and `23:00Z` → `2026-11-06` (CST).
    - `2026-09-14T21:59Z` → `09-14` and `22:00Z` → `09-15` (CDT).
    - The 2026-11-01 Sunday open at `23:00Z` → `11-02`.
    - Both sides of 2027-03-14.
  - **`decideFrontMonth`:**
    - Keeps the incumbent when it out-traded.
    - Rolls forward when a later month out-traded.
    - Never rolls back to an earlier month that has more volume.
    - A tie keeps the incumbent.
    - Empty volumes keep the incumbent.
    - An expired incumbent with no volume rolls to the later month.
    - No incumbent → the contract with the most volume.
    - No incumbent and no volume → `nullSeedContract` (CL in November → `CLZ6`).
    - `ESZ26` and `ESZ6` volumes are one contract; a spread key is ignored.
    - `ESH0` beats `ESZ9` at trade date 2029-12-20.
  - **`pickScheduledFront`:**
    - Minutes either side of a session open take different contracts.
    - A minute where the scheduled contract has no row is left out, not filled.
    - Two spellings in one minute: the larger-volume row wins.
  - **PGlite:**
    - `ensureFrontMonth` writes once, and a second call returns the stored row even after the volumes change.
    - V is read from the latest earlier trade date across a weekend.
    - With no rows at all, it returns the cycle seed and logs a warning.
    - A future trade date is refused.
- [x] Implement until green.
- [x] Gate, review, commit. Done 2026-11-07, local: 24c0a6bc, d1cde054, then review fixes 2cb039f2, 39af7aa9, a9515286 (fill forward, ceiling, insert date guards, fixture `throws`).

### Phase 3a: a shared daily-candle fetch and a stored-decision read (small)

The Phase 3b seed and the Phase 4a cron both read daily candles (owner decision 2026-11-07: the cron refreshes volumes on every run, see Phase 4a), so the fetch lives in `api/_lib`, where both can import it.

Files:
- new `api/_lib/futures-daily-candles.ts`
- new `api/__tests__/futures-daily-candles.test.ts`
- `api/_lib/futures-front-month.ts` and `api/__tests__/futures-front-month-pglite.test.ts`: one read for the Phase 3b seed

Produces:
- In `futures-front-month.ts`, `fetchStoredFrontMonths(product: FuturesRoot, fromDate: string, toDate: string): Promise<Map<string, string>>`: the stored decision rows in [fromDate, toDate], trade date → canonical contract, in one query. A stored row that isn't an outright of the product throws, naming it (as `decideFrontMonth` does for a bad incumbent). PGlite tests: the range bounds, another product's rows left out, the corrupt-row throw, a DB reject propagating.
- `cycleContracts(root: FuturesRoot, fromMonth: string, toMonth: string): string[]`: the root's `CONTRACT_CYCLE` contracts whose contract month is in [fromMonth, toMonth] (YYYY-MM), as canonical names in expiry order.
- `fetchDailyContractVolumes(apiKey: string, root: FuturesRoot, contracts: readonly string[], range: string): Promise<Array<{ contract: string; tradeDate: string; volume: number }>>`:
  - One `uwFetch` + `withRetry` call per contract (`/futures/{contract}/candles?interval=1d&range=<range>`), at most `UW_CONCURRENCY_CAP` at once.
  - **Parse** with Zod: `date` is YYYY-MM-DD, `v` is a non-negative integer. `contract` is the canonical name.
  - An empty array is a contract with no history, not an error.
  - A non-array response or a malformed row throws an error naming the root and the contract.
- **`range` (found 2026-11-07):** UW's operation page accepts `1d, 3d, 5d, 1w, 1m, 3m, 6m, 1y, 5y`. They count calendar days back from now, not sessions. A read-only ESZ6 probe on Saturday 11-07 with `interval=1d` gave:
  - `5d`: 3 rows;
  - `1w`: 5 rows;
  - `1m`: 21 rows, 10-09 to 11-06.

  The seed uses `6m` and the cron `1m` (see Constants).
- **An empty result can be a fault.** `uwFetch` turns a body with no `data` into `[]`, so callers decide which empty contracts are errors (Phases 3b and 4a). The fetch can also return the running session's partial row. Callers drop rows dated on or after the current trade date before `insertContractVolumes`, which refuses the whole batch otherwise.

Steps:
- [x] Failing tests, with `uwFetch` mocked: the cycle list for ES, CL and GC across a year end; one call per contract; an empty contract; a malformed row and a non-array response each named; a `uwFetch` rejection propagates.
- [x] Implement, gate, review, commit. Done 2026-11-07, local: 49911645, 68cc385d, plus review fixes.

### Phase 3b: seed the table from daily candles (medium)

Files:
- new `scripts/backfill-futures-front-month.ts`
- new `scripts/_lib/futures-front-month-backfill.ts` and its `.test.ts`
- `tsconfig.scripts.json`

What the seed does:
- **Fetch:** for each root, `fetchDailyContractVolumes` over `cycleContracts(root, '2026-07', six months past today)` with `range=6m`. That is about 28 calls.
  - Why six months: three would leave out the next quarterly contract. On 11-07, ES would get ESU6 and ESZ6 but not ESH7, so the Dec→Mar roll could never be seen.
  - A fetch error fails that root, named, and the other roots still run.
  - **An empty result** fails the root by name for any listed contract up to and including the second cycle contract after the current month. On 11-07 that is ESU6, ESZ6 and ESH7 for ES, and through CLF7 for CL. Read as no volume, it would let a challenger roll early.
- **Volumes** go in for trade dates before the current one, and before any decision row, so the two tables are written together in one run.
- **Decisions:**
  - From 2026-07-28 through the current trade date, worked out in memory by `decideFrontMonth`, oldest first.
  - The incumbent for 07-28 is the contract with the most volume on 07-27.
  - **A stored row wins** (`fetchStoredFrontMonths`, read once per root before the walk): where a date already has a decision, the walk takes it as that date's answer and carries on from it. Rows are write-once, so this keeps a re-run (Phase 5 step 1, after the gap cron has been deciding) in line with what is stored, instead of writing a chain that disagrees with it.
  - One row is written per trade date that has candle volume, plus the current trade date.
- **Check after writing:** read the root's series back with `fetchStoredFrontMonths`. Any later date holding an earlier-expiring contract fails the root, naming the pair, and the exit code is 1.
- **Run it before any other decider writes** where possible: the first run is rollout step 4, before Phase 4a reaches main.
- **Output:** each root's switches (trade date, from → to, the deciding session's two volumes), so they can be compared with the old rule's switch minutes.
- **Flags:** `--dry-run` and `--roots`. There is no market-hours guard; it makes about 30 light calls.

Steps:
- [x] Failing tests, with `fetchDailyContractVolumes`, `fetchStoredFrontMonths` and the two insert functions mocked:
  - A synthetic two-contract history rolls once, on the session after volume crosses.
  - A fetch error fails its root by name, and the other roots still run.
  - An empty result for ESZ6 fails ES by name; an empty one for a far month (CLK7 on 11-07) does not fail CL.
  - The current trade date's volume is not written.
  - Volumes are inserted before decisions.
  - A stored row in the middle of the range is kept, and the walk continues from it: a stored ESH7 a session before candles would roll makes every later row ESH7 or later.
  - The check after writing names an out-of-order pair and fails its root, and the other roots still run.
  - A dry run writes nothing.
- [x] Implement, gate, review, commit. Done 2026-11-08, on main.
- [x] Once #205 is in prod: a dry run, then the real run. Record the switch list in this doc.
  - **Real run 2026-11-08, about 07:20Z:**
    - Every root got 75 decision rows, 07-28 → 11-08.
    - Volume rows, 07-27 → 11-06: ES 189, NQ 182, RTY 163, CL 573, GC 311, ZN 183.
    - A read-only check found every root's contract spans contiguous, with no overlap.
  - **Switches** (first session on the new contract, and the deciding session's volumes):
    - ES, NQ and RTY: 09-15, U6 → Z6, from 09-14 (ES 849,992 vs 737,362; NQ 341,924 vs 312,278; RTY 120,937 vs 63,390). The old rule switched ES intraday on 09-14 at 13:45 UTC.
    - CL:
      - 08-19 CLU6 → CLV6 (08-18: 129,573 vs 30,691);
      - 09-21 CLV6 → CLX6 (09-18: 189,087 vs 38,708);
      - 10-19 CLX6 → CLZ6 (10-16: 196,766 vs 41,247).
    - GC: 07-30 GCQ6 → GCZ6 (07-29: 114,976 vs 24,178).
    - ZN: 08-28 ZNU6 → ZNZ6 (08-27: 1,123,214 vs 343,122).

### Phase 4a: the gap cron reads the table (medium)

Files: `api/cron/backfill-futures-gaps.ts`, `api/__tests__/backfill-futures-gaps.test.ts`, `api/_lib/futures-flow-repair.ts` (comment only), `api/_lib/futures-front-month.ts` and `api/__tests__/futures-front-month-pglite.test.ts` (the two warnings below).

- [x] **Failing tests** first:
  - Before each root's schedule is read, its volumes are refreshed: daily candles for the incumbent and the next two cycle contracts, written with `insertContractVolumes` for trade dates before the current one only.
  - A refresh failure (UW error, malformed candle, DB reject, or an empty candle result for the incumbent) fails that root by name with a Sentry exception that carries the root and the range. It writes no decision row for that root. The other roots still run, and the run reports partial.
  - A fetched row for the current trade date is dropped before `insertContractVolumes`, and the run logs each root's refreshed row count.
  - Candles are fetched only for `schedule.contracts`, and `/futures/contracts` is no longer called.
  - Gap minutes either side of a session open land on their own session's contract.
  - Every inserted bar carries its scheduled `contract`.
  - A DB error in the schedule read fails the root in each pass with a Sentry exception, and the run reports partial or error.
  - PGlite: a clamp, and a cycle-seed fallback, each send one warning-level Sentry message tagged with product and trade date, besides the log line.
- [x] **Then the change:**
  - **The two warnings in `futures-front-month.ts` go to Sentry** (ruling 2026-11-07), as `captureMessage` at warning level with `product` and `trade_date` tags. Once the seed has run, either one means something unexpected: a clamp means a late volume row or an out-of-order decision, and a cycle seed means a root has no history. A log line alone would go unseen.
  - **Volume refresh first** (owner decision 2026-11-07). For each root: take the incumbent (the latest decision row; with none, the cycle seed for the current trade date). Take `cycleContracts` from its month, first three. Call `fetchDailyContractVolumes` with `range=1m`, then `insertContractVolumes` for trade dates before the current one. That is about 18 calls and about 400 rows a run.
    - Why `1m` and not `1w`: if the cron is down for more than a week, `1w` would leave the older missed sessions with no volume rows. Re-writes are DO NOTHING, so the longer range costs nothing but rows.
    - Why: otherwise nothing writes volume between the Phase 3b seed and Phase 5, or on any day uw-stream is down. A decision made from old volume is permanent.
    - Candle rows are `DO NOTHING`, so a session uw-stream already wrote keeps its live tally.
  - The trade dates of the window's gap minutes and of the NULL-flow runs go to `fetchFrontMonthSchedule(root, dates, 'cron')`.
  - Both passes use `pickScheduledFront` and pass `contract` to the shared insert.
  - **Why `contract` must be valid:** #204's CHECK runs before the conflict arbiter, so one malformed name fails the whole 500-row chunk, minutes already stored included (the other spec's `task-6c-brief.md` §5 and §8). Decision rows hold canonical names, which pass by construction; the insert still checks each `contract` with `parseContract`, writing NULL with a warning for one that fails.
  - Rewrite header steps 2–3.
- [x] Gate, review, commit. This needs the Phase 3b seed run before it reaches main: from then on, the 06:00 UTC cron reads the table. Done 2026-11-08: 3976cc47, f14ae81e, then review fixes 110c4a1c, 220d351f and one test fix.
  - **What review added (2026-11-08):**
    - **Library:** the refresh lives in `api/_lib/futures-volume-refresh.ts` (`refreshFrontMonthVolumes`) for Phase 4b to reuse.
    - **Refresh only when needed:** a root refreshes only when a schedule date is undecided. With every date stored it repairs from the stored schedule, so a UW daily-candle outage can't block repair inside the 3-day window.
    - **Freshness:** the incumbent's newest daily candle must reach the trade date of the root's latest `futures_bars` row before the current session. Otherwise the root fails as stale and nothing is decided, because until Phase 5 the cron makes the running session's permanent decision every morning.
    - **Deadline:** `FLOW_DEADLINE_MS` is 540 s.
  - **Known failure mode, accepted:**
    - **The trigger:** the incumbent expires while the cron is down, so no decision rolled off it in time. Its candles stop, and the root fails as stale on every run.
    - **The fix:** insert that root's next decision row by hand (`source = 'script'`).
    - **Why it stays:** in normal running the roll lands a day or two before expiry (CLU6 → CLV6 on 08-19; CLU6's last session was 08-20). Checking any contract's candle instead would let a missing incumbent candle read as 0 and roll early, permanently.
    - **Holidays:** a holiday session that UW files under another date fails the same way, until the next full session.

### Phase 4b: the scripts read the table (medium)

Files: `scripts/_lib/futures-flow-backfill.ts` and its test, `scripts/_lib/futures-bar-backfill.ts` and its test.

- [x] **Failing tests:**
  - A UTC day is split at the session open into pieces, and each piece pages only that session's contract.
  - A late minute pages only its own piece, not the day from 00:00.
  - The bar backfill writes each bar's `contract`.
- [x] **Then the change:**
  - `pageDayContracts` takes `{ contract, fromMs, toMs }` pieces. The fixed three candidates and the 00:00 UTC tally go. Pages drop by only 5–15% on a Sept-style bar run, since a back month is a small share of volume outside roll week (Phase 4b's model; the earlier "two thirds" was wrong). The flow script gains most, because a late NULL minute no longer pages from 00:00 UTC.
  - `futures-flow-backfill.ts` imports `CONTRACT_CYCLE` and `MONTH_CODES` from `futures-contracts.ts` instead of keeping its own copies.
- [x] Remove anything this leaves unused.
- [x] Gate, review, commit. Done 2026-11-08: 343dc127, 887c4cb1, b86b8f11, 09f9fcdb plus review fixes. The scripts refuse trade dates before 07-28, and `--dry-run` and `--compare` read stored decisions only.

### Phase 4c: remove the old replay (small)

Files: `api/_lib/futures-contracts.ts`, `api/__tests__/futures-contracts.test.ts`.

- [x] Delete `replayFrontMonth` and its tests.
- [x] Grep for every reference to it (calls, comments, docs in `api/` and `scripts/`) and fix each one.
- [x] Gate, review, commit. Done 2026-11-08 (aad9c73f, on main). `frontMonthCandidates` stays: `fetch-futures-session-stats` uses it.

### Phase 5a: one volume source per session (small)

Ruling 2026-11-08, from the Phase 4a review: within one (product, trade date), every volume row comes from one source, and the first writer wins.

Why: candle rows are DO NOTHING per (product, trade date, contract). After a restart mid-session, a partial live tally for the incumbent could sit next to a challenger's full-session candle volume and roll early. A partial session from one source is no worse than today's live rule.

Who writes first: live rows land while the session runs, and candle rows only after it ends (`insertContractVolumes` refuses the current date). So in practice live wins wherever uw-stream saw the session, and candles fill sessions it missed entirely.

Files: `api/_lib/futures-front-month.ts`, `api/__tests__/futures-front-month-pglite.test.ts`.

- [ ] **Failing PGlite tests:**
  - A date with `live` rows gets no candle rows, not even for a contract the live tally never saw.
  - A date with only candle rows keeps today's per-contract DO NOTHING, so a refresh still adds a contract the seed didn't fetch.
  - A date with no rows gets every row.
  - The return value counts only the rows inserted.
  - The statement count is unchanged.
- [ ] **Then the change:** `insertContractVolumes` skips any row whose (product, trade date) already has a `live` row. Do it in the same unnest statement (`WHERE NOT EXISTS`), not a separate read.
- [ ] Gate, review, commit, push. It must be on main before Phase 5b deploys.

### Phase 5b: uw-stream decides live (large; push after a 17:00 CT open)

Files: `uw-stream/src/handlers/futures_trades.py`, new `uw-stream/src/futures_front_month.py`, `uw-stream/src/db.py`, `uw-stream/tests/test_futures_trades_handler.py`, new `uw-stream/tests/test_futures_front_month.py`.

Produces:
- **Pure functions, held to the shared fixture** (`api/__tests__/fixtures/futures-roll-cases.json`): `trade_date(ts: datetime) -> date`, `parse_contract`, `canonical_contract` and `null_seed_contract` (ports of the TS parser) and `decide_front(incumbent: str | None, volumes: Mapping[str, int], product: str, trade_date: date) -> str`. Fixture cases with `throws` must raise.
- **DB functions:**
  - `async ensure_front(product: str, trade_date: date) -> str | None`: the same read / fill forward / decide / ceiling / insert DO NOTHING / re-read as `ensureFrontMonth` (rules 4 and 5), with `source = 'live'`.
    - **The fill is capped** at 10 dates a call, oldest first, so a long backlog can't stall the handler's flush (each filled date is three round trips). Past the cap it returns None, the minute is a gap, and the next flush carries on from where the fill stopped.
    - **A clamp** logs `kind="front_month_clamped"` at error level (so it reaches Sentry, like Phase 4a's message), with the product, date, wanted contract, ceiling and incumbent.
    - **The module docstring** carries rule 5's accepted risk: the read and the insert are separate statements.
    - None on a DB error or at the fill cap.
  - `async load_tally(product: str, trade_date: date) -> dict[str, int]`.
  - `async save_tally(rows: Sequence[tuple[str, date, str, int]]) -> None`: one upsert with GREATEST. It never writes a (product, trade date) that already has `candles` rows (`WHERE NOT EXISTS`, in the same statement), per Phase 5a's one-source rule.
- **`db.py`:** public `fetch` and `execute` helpers that go through `_with_db_retry`, if the module doesn't already have them.

Handler changes:
- **The tally** is keyed by (product, trade date) and canonical contract.
  - The first time the process sees a (product, trade date), it loads that row set from the table, so a restart carries on counting.
  - It is saved when minutes are emitted (about once a minute), and before a new trade date's decision is asked for.
- **Before folding a batch,** each (product, trade date) in it without a cached decision goes to `ensure_front`. A minute's contract is the cached decision for its own trade date.
  - A failed lookup is not cached.
  - At emit time, an unknown decision makes the minute a gap. It is logged once per window as `kind="front_month_unknown"` at error level (so it reaches Sentry), with the product and trade date.
- **Every emitted bar** carries `contract`.
- **Removed:** the `_front_sym` snapshots, `_session_date` / `_roll_session`, and the prior-day straggler special case. A straggler now just uses its own trade date's contract.
- **Docstring:** rewrite rule 5. `front_sym_absent` stays.
- **One source per session** (Phase 5a): `save_tally` skips a session that already has candle rows, and the cron's refresh skips a session that has live rows. Test the live side: a session with candle rows gets no live rows.

Steps:
- [ ] **Rewrite the front-month tests** (today's lines ~399–529, 786, 881) to the new rule, with the database mocked:
  - **Session open:** after a roll, the 16:59 CT and 17:00 CT minutes take different contracts.
  - **Midnight UTC:** a back month leading in the first minutes after midnight UTC doesn't change the contract.
  - **Restart:** a restart carries the tally on from the table and keeps the session's contract.
  - **Straggler:** a late print for D−1's last minute uses D−1's contract.
  - **DB error at the open:** the minute becomes a gap with an error log, and the next flush retries.
  - **Order, in `test_futures_front_month.py`:** twins of the PGlite block "ensureFrontMonth: the series only moves forward, whatever order dates…" in `api/__tests__/futures-front-month-pglite.test.ts`. The fixture can't pin these, since they are the DB layer. Run them against a dict-backed stand-in monkeypatched over the module's read and insert functions:
    - a gap with volume rows is filled first;
    - the ESZ6/ESH7 flicker gives the same rows in both orders;
    - an old date decided after a later row never passes it;
    - late volume rows;
    - no incumbent means no fill;
    - the clamp, over ordered and over already-disordered rows, and its log;
    - the cap: 12 undecided dates, so the first call fills 10 and returns None, and the second completes.
  - **Duplicates** still don't inflate the tally.
  - **Two spellings** (`ESZ26`, `ESZ6`) fold into one tally key and one bar.
  - **Fixture:** the parity test against the shared fixture passes.
- [ ] Implement. Run pytest + ruff in uw-stream, then gate, review and commit.
- [ ] **Deploy after the 17:00 CT open,** not just after 15:00 CT, and only with #204 in prod.
  - **Why the timing matters:** uw-stream's first tally starts at its first boot. If it deployed at 15:30 CT, the next session's decision would rest on 30 minutes of volume. After the open, the session that just closed has a final daily candle.
  - **Steps:**
    1. Re-run the Phase 3b seed. It writes that session's volumes and the new session's decision.
    2. Push uw-stream.
  - Later restarts resume the saved tally, so this matters only for the first deploy.
  - **Check:**
    - At the following session open, a `live` decision row appears.
    - Bars keep arriving, with `contract` filled.
    - No `front_month_unknown`, and no Sentry errors.

### Phase 6: repair history, 2026-09-04 → the Phase 5 deploy (medium-large; outside market hours)

Files: `scripts/_lib/futures-bar-backfill.ts` and its test, `scripts/backfill-futures-bars.ts`, `api/_lib/futures-bars.ts`, `api/__tests__/futures-bars-pglite.test.ts`.

The new `--repair` mode works per root and UTC day:
- **Rebuild:** read the existing bars, page the scheduled contract for each session piece (Phase 4b), and rebuild each minute with the `FlowMinute` builder in `futures-flow-repair.ts` (`ohlc` plus flow).
- **Classify each minute:**
  - **keep:** an existing bar whose open, high, low and close all lie in [rebuilt low − 1 tick, rebuilt high + 1 tick]. Live bars that miss websocket prints still pass, since they are a subset of the REST prints (10-30 compare). Its `contract` is set to the scheduled contract where it is NULL.
  - **rewrite:** an existing bar outside that band, where a rebuilt bar exists → UPDATE OHLCV, flow and `contract`.
  - **delete:** an existing bar outside the band with no rebuilt bar, because the scheduled contract printed nothing countable → DELETE. The rule says that minute is a gap.
  - **fill:** no bar, but a rebuilt bar exists → INSERT DO NOTHING, with `contract`. These are minutes the old rule left empty.
- **Safety:**
  - Before any write, every row to be updated or deleted is appended in full to `docs/tmp/uw-futures-run/front-month-repair-<runId>.jsonl`, so the run can be undone.
  - UPDATE and DELETE only touch a row whose open and close are unchanged since the read (R6), and both are batched with unnest (R5): new `updateFuturesBars` and `deleteFuturesBars` in `api/_lib/futures-bars.ts`. The keep-class tag is a batched `UPDATE … SET contract = … WHERE contract IS NULL`.
  - The market-hours guard applies, along with `--max-pages`, and the exit code is 1 on any failed root-day.
  - **Run order (Phase 4b review):** run `--repair` before the flow script over 09-04 onward. `--repair` rewrites the flow of a bar built from another contract. The flow script's 2% volume check isn't like for like on such a bar, and pre-Phase-5 bars have no `contract` to guard on.
  - **`--max-pages`:** raise it to about 150,000 for this run, from the default 20,000 (see the estimate below).

Steps:
- [ ] **Failing tests:**
  - Classification across all four classes, using ES prices about 67 points apart for the wrong contract and a websocket-short bar that must be kept.
  - A kept bar gets its `contract`; one already tagged is left alone.
  - The backup is written before any write.
  - PGlite: the conditional UPDATE skips a row changed since the read, DELETE returns the deleted ts, and fill never overwrites.
- [ ] Implement, gate, review, commit, push.
- [ ] Dry run: counts per root per class. Expect rewrites around each roll and at the known flips, and few deletes.
- [ ] Write run, then a second dry run. It must show 0 rewrite, 0 delete and 0 untagged.
- [ ] The jump screen (`roll-flips.mjs`) from 09-04 on must show:
  - one step per roll, at a session open;
  - none of the known flips (CL 09-07, RTY 09-14, CL 09-30, 10-29, 11-05).

### Phase 7: docs and memory (small)

- [ ] Results section here; mark the Sept plan's finding resolved.
- [ ] Update the futures line in the CLAUDE.md uw-stream blurb and `uw-stream/README.md` if it describes the old rule.
- [ ] Update memory `project_futures_integration` and `project_futures_contract_mix_repair`.

## Rollout order

1. Phase 1 (local).
2. Phase 2.
3. Phases 3a and 3b.
4. Apply #204 and #205 (#201–#203 went in on 2026-11-07), push Phases 1–3b, run the seed. **Done 2026-11-08.**
5. Phases 4a, 4b, 4c. **Done 2026-11-08.**
6. Phase 5a (push any time), then Phase 5b: re-run the seed after a 17:00 CT open, then push uw-stream. Before 2026-12-09.
7. Phase 6, outside market hours.
8. Phase 7.

Between steps 5 and 6, the cron fills gaps by the new rule while live bars still follow the old one. Phase 6 covers that window.

**Estimate for Phase 6:**
- About 46 trading days. The Sept run paged about 2,500–3,000 pages per weekday across the six roots, and paging one contract per piece saves only 5–15% of that (Phase 4b's model): a back month is a small share of volume outside roll week. So about 115–140k pages (corrected 2026-11-08, from 60–90k).
- The Sept run did 43,130 pages in about 54 minutes (≈ 800 pages/min), so expect 2.4–2.9 hours.

## Constants

- **Trade-date offset:** +7 h on America/Chicago wall time. The 17:00 CT open becomes the next date.
- **One-digit year window:** [ref − 1, ref + 8], ref being the trade date's year (from the 6b parser).
- **One tick, the Phase 6 band:** ES 0.25, NQ 0.25, RTY 0.10, CL 0.01, GC 0.10, ZN 1/64 = 0.015625.
- **Seed start:** trade date 2026-07-27, the first full session in UW's daily candles; the first decision row is 2026-07-28 (owner, 2026-11-08).
  - UW serves daily candles from 07-21, but 07-21 to 07-24 hold only a sliver of each session: RTY September traded 73 to 1,685 a day, then 144,241 on 07-27.
  - The first dry run (2026-11-08, start 07-21) rolled RTY to December on 07-24, from 218 vs 73. Rolls only move forward, so that would have held RTY on December through September.
- **Daily candles:** `interval=1d`, volume from `v`; `range=6m` for the seed and `range=1m` for the cron. `range` counts calendar days back from now (probe 2026-11-07: `1w` gave 5 sessions, `1m` 21).
- **Live fill cap:** 10 dates per `ensure_front` call (Phase 5). The TypeScript fill is uncapped: its callers are a cron and scripts.
- **Repair window:** 2026-09-04 00:00 UTC → the Phase 5 deploy.

## Open questions (defaults taken)

1. **Candles and the live tally count volume differently.** History decisions use candles; live decisions use the tally (deduped outright non-block prints). Default: accept it. Only a session where the two contracts nearly tie could roll one session apart.
2. **Holiday sessions.** CME may file a holiday session under the next trade date while `tradeDate` splits it at 17:00 CT. Default: accept it. The decision reads the latest earlier date that has volume, and readers only ask about dates their minutes fall on.
3. **No incumbent and no volume** (the seed never ran for a root). Default: the cycle seed with a warning, not an error. It can only make that root roll one session late, and the gap cron refills within its 3-day window.
4. **Bars that are short but from the right contract.** Phase 6 leaves live bars that are short because of websocket drops but come from the right contract. Replacing them with the fuller REST bars is a separate decision.
5. **A tie in V keeps the incumbent.**
6. **History before 2026-09-04 is not re-derived.** Its `contract` stays NULL.
   - Between 07-28 (the first stored decision) and 09-03, the bars keep their own switch points, and three rolls fall inside: GC on 07-30, CL on 08-19 and ZN on 08-28 (Phase 4b review, 2026-11-08).
   - The history scripts refuse dates before 07-28. Repairing 07-28..09-03 would mean starting Phase 6 there instead of 09-04. The other spec's repaired April–June ES/NQ bars keep that repair's switch points (one June roll per root), not a session-open pick: UW has no trades or daily candles before July, and that spec's own sources would be needed to move them. Default: leave them.
