# uw-stream: let Neon sleep (drop the asyncpg connection floor)

Date: 2026-11-16. Owner approved the fix in conversation ("yes please").

## Goal

Stop uw-stream's asyncpg pool from waking the Neon compute the moment it
suspends, so the database can scale to zero when no market is open (weekends,
the CME 16:00–17:00 CT daily break).

## Why (evidence, read-only, 2026-11-16)

- Neon's operations list for the weekend of 11-14 to 11-16: 149 compute suspends
  between Sat 14:05 and Sun 22:56 UTC, each followed by a start 0–2 s later. The
  period, about 5 min 15 s, is Neon's 300 s idle timeout plus its ~15 s check
  grid, not a client timer.
- Railway's network-flow log for uw-stream, Sun 11-15: at 21:36:46.692 UTC Neon
  closed uw-stream's two idle connections; at 21:36:46.711 (19 ms later)
  uw-stream opened a new connection to the Neon pooler, and the compute started
  at 21:36:47; a second connection followed at 21:36:49.003.
- Cause: `init_pool` in `uw-stream/src/db.py` creates the pool with `min_size=2`.
  In asyncpg 0.32.0, `PoolConnectionHolder._release_on_close` calls
  `Pool._schedule_min_size_maintenance`, which reconnects as soon as
  `get_size() < min_size`. Connections at the floor are also exempt from the
  300 s `max_inactive_connection_lifetime` close
  (`_deactivate_inactive_connection` returns when `get_size() <= min_size`).
  `min_size=0` turns both off (`not self._minsize` returns early).
- `uw-stream/requirements.txt` asks for `asyncpg>=0.29.0`, and the Docker pip
  layer is cached, so the version in production changed with no commit here.

Cost: with the 2-CU minimum, an awake weekend is up to about 100 CU-hours.

## Approaches considered

- **Pool floor.** (a) `min_size=0`. (b) Keep `min_size=2` and set a short
  `max_inactive_connection_lifetime`. **Picked (a):** (b) does nothing for floor
  connections, which are exempt from the inactive close, and the floor
  maintenance would still reconnect on every suspend.
- **Version.** (a) Exact pin `asyncpg==0.32.0`. (b) A range `>=0.32,<0.33`.
  **Picked (a):** the fix and the comments in `db.py` are checked against 0.32.0
  source; a pin makes the next pool-behavior change a reviewed diff (Dependabot
  already watches `/uw-stream`).

## Change (one phase, one commit)

- `uw-stream/src/db.py` `init_pool`: `min_size=0`, keep `max_size=10`,
  `command_timeout=30`, `init=_init_connection`. Update the comment, the log line
  (`min=0 max=10`) and the module docstring (it still says the pool size is 5).
- Boot check, so a bad `DATABASE_URL` still fails at boot: with `min_size=0`
  `create_pool` opens no connection, and on a weekend nothing writes until the
  Sunday 17:00 CT open. After the pool is created, `init_pool` runs `SELECT 1`
  through `fetch` (the existing transient retry). If the check raises, close
  the pool, reset `_pool` to None and re-raise, so `init_pool` stays idempotent
  and nothing holds a half-made pool. The check's connection is closed after
  300 s idle (or by Neon's suspend) and nothing reconnects it.
- `uw-stream/requirements.txt`: `asyncpg==0.32.0`, with a one-line comment
  pointing at this spec.
- `uw-stream/tests/test_db.py`: assert `min_size == 0` and `max_size == 10`;
  the boot check runs once; a failing check closes the pool, leaves `_pool` None
  and raises; a second `init_pool` after a success does not re-run the check.
- `uw-stream/README.md` Pipeline diagnostics: the pool now starts at 0
  connections, not 2. `pool_size_min` at 0 in a quiet minute is normal.

## Acceptance

- The tests above pass in the uw-stream suite, and `npm run review` is green
  (commit gate).
- After deploy (Railway): the boot log shows `asyncpg pool ready (min=0 max=10)`
  and no boot error; minute lines keep writing.
- Next idle window: Neon's operations list shows a suspend with no start until
  the next real write (the CME break today 16:00–17:00 CT if the deploy is
  live by then, otherwise the weekend of 11-21 to 11-23).

## Data dependencies

None: no migration, no env var.

## Thresholds / constants

`min_size=0`, `max_size=10` (unchanged), asyncpg `==0.32.0`. asyncpg's default
`max_inactive_connection_lifetime` (300 s) stays.

## Open questions

None blocking. Cost of the change: the first write after an idle stretch waits
for a connect, plus a compute start if Neon was suspended (about 0.5 s); the
existing `_with_db_retry` covers a transient failure on that connect.
