# crypto-and-config audit — 2026-09-08

Rules audited: **R2** (no hand-rolled crypto / secret handling) and **R7** (no config until two callers; env vars declared + documented in the same commit; dead config removed).

Worktree: `.worktrees/llm-antipattern-audit` (clean checkout of `origin/main` @ `3dd9dd60`). Read-only; no source files modified. Five files under concurrent edit elsewhere (`api/_lib/uw-rate-limit.ts`, `api/_lib/uw-fetch.ts`, `api/_lib/sentry.ts`, two tests) were audited and any note on them is tagged **IN-FLIGHT**; the pending `UW_PER_MINUTE_CAP` env var is noted as in-flight, not as undocumented.

Severity key: **P1** realistic production failure / security weakness · **P2** latent · **P3** hygiene.

---

## Method — what was grepped, what was read, counts

### R2 greps (all with `__tests__` excluded)

| Pattern | Hits | Outcome |
| --- | --- | --- |
| `(===\|!==) process.env.X` / `process.env.X (===\|!==)` | 9 | All non-secret (`NODE_ENV`, `VERCEL_ENV`, `DRY_RUN`, `BYPASS_RESUME`) |
| `<secret\|token\|key\|apiKey...> (===\|!==\|==\|!=)` in api/, scripts/ | 5 | All false positives (`input_tokens`, `occToken !== null`) |
| `.includes(` / `.split(',')` on a line naming SECRET/KEY/TOKEN | 0 | — (`GUEST_ACCESS_KEYS.split(',')` is in guest-auth.ts and feeds `timingSafeEqual`, not `.includes`) |
| `Math.random()` | 10 | All retry-jitter or log-sampling; none id/security |
| `btoa\|atob\|'base64'\|base64url` | 17 | Basic-auth header encoding, image payloads, VAPID key transcoding — no "encryption" |
| custom hash loops (`* 31`, `* 33`, `charCodeAt` loop, `>>> 0`, `Math.imul`, fnv/djb2) | 2 sites (+1 boilerplate) | djb2 in LotteryFinder + SilentBoom is a localStorage key token; `charCodeAt` in usePushSubscription is RFC 8292 boilerplate |
| `Set-Cookie` builders | 3 files | guest-auth.ts (helper), guest-key/guest-logout (use helper), auth/callback.ts (hand-built — R2-2) |
| JWT / jsonwebtoken / jose / `crypto.subtle` / webcrypto | 0 | — |
| `from 'node:crypto'` importers | 12 files | All read (see below) |
| `req.query.(secret\|token\|key\|...)` | 0 | No secrets accepted via query string |
| outbound URLs with `?…(api_key\|token\|key\|secret)=${…}` | 0 in TS | FRED uses `URLSearchParams({api_key})` (its only auth mode); UW WS URL in Python (vendor-forced, scrubbed) |
| `logger.*({ …(apiKey\|token\|secret\|key…) })` | 1 | `uw-rate-limit.ts:76` logs `key` = Redis counter key name, not a secret **(IN-FLIGHT)** |
| Python: `compare_digest`, `hmac.`, `secrets.`, `import random`, `== token`, auth headers | 30 | Every token compare is `hmac.compare_digest`; `random` only for jitter/sampling |

### R2 files read in full or in the relevant region

`api/_lib/guest-auth.ts`, `api/_lib/auth-helpers.ts`, `api/_lib/cron-helpers.ts` (cronGuard), `api/_lib/cron-instrumentation.ts` (isCronAuthenticated, DSN parse), `api/auth/{init,callback,guest-key,guest-logout,whoami}.ts`, `api/_lib/schwab.ts` (entire), `api/panel-prefs.ts` (identity hash), `api/push/notify.ts`, `api/_lib/push.ts` (VAPID), `api/_lib/periscope-blob.ts` (randomUUID), `api/_lib/gexbot-parquet.ts` + `api/_lib/gexbot-client.ts` (sha256, auth header), `api/analyze.ts` (prompt hash), `api/ml/{analyze-plots,trigger-analyze}.ts`, `api/journal/backfill-features.ts`, `api/cron/takeit-fill-shap.ts`, `api/cron/backfill-futures-gaps.ts`, `api/_lib/alerts.ts` (Twilio), `api/_lib/takeit-bundle-loader.ts`, `api/periscope-chat-image.ts`, `api/events.ts` (FRED), `api/_lib/multileg-client.ts`, `src/components/LotteryFinder/index.tsx` (hashToken), `src/hooks/usePushSubscription.ts`, `scripts/entry-time-analysis.ts`, `sidecar/src/health.py` (both auth gates), `sidecar/src/takeit_server.py`, `sidecar/src/theta_launcher.py` (creds file), `uw-stream/src/{health,notify,sentry_setup,logger_setup,config}.py`, `classifier/src/server.py` (do_POST), `.github/workflows/ml-pipeline.yml`.

### R7 inventory sources

- `process.env.*` in `api/` (45 distinct names incl. 4 diagnostic probes), `scripts/` (44 names), `import.meta.env`/`process.env` in `src/`, `vite.config.ts`, `playwright.config.ts`
- `requireEnv` / `optionalEnv` / `requireEnvGroup` call sites (7)
- `api/_lib/env.ts` Zod schema (27 keys)
- CLAUDE.md "Environment Variables" table (20 names in 15 rows) + prose mentions
- `.env.example` (38 Vercel-section names + Railway reminder comment) — **third documentation surface, not in the brief but load-bearing**
- Python: `uw-stream/src/config.py` pydantic `Settings` (29 fields) + `os.environ` (4); `sidecar/src/config.py` `Settings` (6) + `os.environ` (15); `classifier/src` (4)
- `vercel.json` (only `VERCEL_GIT_PREVIOUS_SHA` in `ignoreCommand`; 83 cron entries / 77 unique paths + `/api/health`)
- `.github/workflows/{ci,ml-pipeline,neon_workflow}.yml` (7 secret names)
- `api/_lib/constants.ts` (58 exports) and `src/constants/*.ts` (≈40 exports): importer-file count per export via `grep -rlw`, excluding the defining file, `index.ts` barrel, and tests; zero-importer names re-checked for namespace imports (none), in-file use, test-only use, and `git log -S` provenance
- Feature-flag grep: `FEATURE_`, `ENABLE_`, `_ENABLED`, `DISABLE_`, `isEnabled(`, `flags =` across TS + Python
- Cron diff: every unique `vercel.json` cron path checked with `test -f api/cron/<name>.ts`, and every `api/cron/*.ts` checked for a `vercel.json` entry

---

## R2 Findings

### R2-1: Classifier `/multileg-classify` lost its shared-secret gate in the service split  [P2] [confidence: high on code, medium on exploitability] [effort: S]

- Where: `classifier/src/server.py:228-300` (`do_POST` — no auth check anywhere in the handler); `api/_lib/multileg-client.ts:493-495` (`fetch(url, { headers: { 'Content-Type': 'application/json' } })` — no `Authorization`); contrast `sidecar/src/health.py:420-437` and `sidecar/src/takeit_server.py:228-233`, where the identical endpoint requires `Authorization: Bearer <TAKEIT_SIDECAR_SHARED_SECRET>` via `hmac.compare_digest`.
- What: The 2026-05-28 spec (`docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md`) moved the polars cross-join classifier onto its own Railway service to stop it OOM-ing the sidecar. The sidecar twin keeps its bearer gate; the new service has none, and the TS client stopped sending one. Neither the spec nor `classifier/README.md` mentions auth, so this was dropped silently, not decided. Vercel Functions reach Railway over the public internet, so `CLASSIFIER_URL` is a public host. The handler does have body-size (`_MAX_BODY_BYTES`), duplicate-`Content-Length`, and `Transfer-Encoding` hardening — but those only bound *each* request.
- Failure scenario: Anyone who learns the classifier hostname (Railway `*.up.railway.app` naming, a Sentry event `extra`, a log drain) can POST 1 MiB batches of fabricated Full-Tape rows in a loop. Each is a CPU-bound polars cross-join on the memory-capped container that was split out *because* it OOMs; the container restarts, and during the restart window `detect-lottery-fires` / `detect-silent-boom` get 502s — the `multileg.classify.sidecar_unreachable` storm already on file in memory, this time attacker-triggered and during market hours.
- Fix: Port the sidecar gate verbatim into `classifier/src/server.py` `do_POST` (before the body read): `if not hmac.compare_digest(self.headers.get("Authorization",""), f"Bearer {secret}")` → 401. Add `Authorization: Bearer ${process.env.CLASSIFIER_SHARED_SECRET}` in `multileg-client.ts:493`, declare the var in `env.ts`, CLAUDE.md, `.env.example`, `classifier/README.md`. (Reusing `SIDECAR_TAKEIT_SECRET` avoids a new secret but couples two services' rotation.)

### R2-2: Owner `Set-Cookie` strings are hand-built in `callback.ts` while the guest side has builders  [P3] [confidence: high] [effort: S]

- Where: `api/auth/callback.ts:99-122`; builders that already exist for the guest twin: `api/_lib/guest-auth.ts:168-204` (`buildGuestSetCookies`, `buildGuestClearCookies`).
- What: The owner cookie (`sc-owner`, value = `OWNER_SECRET`) and its JS-visible `sc-hint` sibling are assembled inline from string parts. `sc-hint` is a bare literal here and again in `src/utils/auth.ts:29,64` — `OWNER_COOKIE` is a constant, the hint name is not. The two `isLocal` derivations also drift: callback.ts:99 uses `appUrl.includes('localhost')`; guest-key.ts:55 / guest-logout.ts:24 use `appUrl.includes('localhost') || !process.env.VERCEL`. There is no owner clear-cookie builder (there is no owner logout endpoint today, so nothing is broken).
- Failure scenario (edge): local dev with `APP_URL=http://127.0.0.1:3000` — guest cookies omit `Secure` (via `!VERCEL`), owner cookie gets `Secure`, browser drops it over http → owner login loops while guest login works. Not a production risk.
- Fix: Add `OWNER_HINT_COOKIE = 'sc-hint'` and `buildOwnerSetCookies(secret, isLocal)` beside the guest builders (or a generic `buildSessionCookies(name, hintName, value, maxAge, isLocal)` both call), and a single `isLocalRequest()` helper; `callback.ts` collapses to one `setHeader`.

### R2-3: Five hand-copied constant-time compares; `ml/analyze-plots.ts` is a verbatim clone of `cronGuard`'s block  [P3] [confidence: high] [effort: S]

- Where: `api/_lib/cron-helpers.ts:196-208` (cronGuard), `api/_lib/cron-instrumentation.ts:278-286` (isCronAuthenticated — comment says the duplication is deliberate because it must run before the check-in), `api/ml/analyze-plots.ts:261-273` (inline copy; POST endpoint so it can't call `cronGuard`), `api/push/notify.ts:26-38` (`verifySecret` for `INTERNAL_NOTIFY_SECRET`), `api/_lib/auth-helpers.ts:102-104` (`isOwner`).
- What: All five are correct (length-guarded `timingSafeEqual`). But the rule text names the *helpers* as the only place this pattern should live, and `analyze-plots.ts` reproduces the 12-line cronGuard block character-for-character rather than calling anything. The next copy is where the length guard gets forgotten.
- Failure scenario: none today; latent copy-drift.
- Fix: Export `secretEquals(a: string, b: string): boolean` (length guard + `timingSafeEqual`) and `bearerMatches(req, secret)` from `auth-helpers.ts`; call it from `isOwner`, `cronGuard`, `isCronAuthenticated`, `verifySecret`, and `analyze-plots.ts`.

### R2-4: `scripts/entry-time-analysis.ts` invites pasting `OWNER_SECRET` into a tracked file  [P3] [confidence: high] [effort: S]

- Where: `scripts/entry-time-analysis.ts:12` — `const COOKIE = process.env.SC_OWNER_COOKIE || ''; // paste your cookie value here if not using env`.
- What: The `sc-owner` cookie value *is* `OWNER_SECRET` (`api/auth/callback.ts:101`). The comment tells the operator to hard-code it.
- Failure scenario: Owner follows the comment, runs the script, `git add -A` from a concurrent session sweeps it in (memory: "targeted-git-add" is a known hazard here) → `OWNER_SECRET` in git history; rotation then needs a Vercel env change *and* history rewrite.
- Fix: Delete the comment; keep env-only with the existing usage line. Optionally make the script refuse to run if `COOKIE` is a literal (`if (COOKIE && !process.env.SC_OWNER_COOKIE) throw`).

### R2-5: `normalizeVapidKey` hand-rolls base64→base64url  [P3] [confidence: high] [effort: S]

- Where: `api/_lib/push.ts:71-75`.
- What: `key.trim().replace(/\+/g,'-').replace(/\//g,'_')` + strip `=`. Correct RFC 4648 §5 transcode; VAPID signing itself is inside `web-push` (`webpush.setVapidDetails`, line 95). Node 24 has the stdlib form.
- Failure scenario: none; rule-letter violation ("never write custom encoding").
- Fix: `Buffer.from(key.trim(), 'base64').toString('base64url')` (Node ≥15.7; `'base64'` decoding already accepts url-safe input).

---

## R7 Findings

### R7-1: Fourteen env vars read by `api/` are not declared in `env.ts`; twenty-four are missing from the CLAUDE.md table — including the two that login cannot work without  [P2] [confidence: high] [effort: M]

- Where: `api/_lib/env.ts:32-80` (27 declared keys) vs the runtime reads listed in the inventory below; CLAUDE.md "Environment Variables" table (20 names).
- What: The rule requires read + `env.ts` + CLAUDE.md in the same commit. Actual state:
  - Read in `api/` but **absent from `env.ts`** (14): `GUEST_ACCESS_KEYS` (guest-auth.ts:61), `SIDECAR_URL` (archive-sidecar.ts:28, multileg-client.ts:241, fetch-day-ohlc.ts:57), `CLASSIFIER_URL` (multileg-client.ts:232), `SIDECAR_TAKEIT_URL` / `SIDECAR_TAKEIT_SECRET` (takeit-fill-shap.ts:82-83), `BLOB_READ_WRITE_TOKEN` (periscope-chat-image.ts:80, takeit-bundle-loader.ts:81, archive-gexbot.ts:198-234), `GEXBOT_API_KEY` (fetch-gexbot-fast.ts:194, fetch-gexbot-strikes.ts:63), `DATABENTO_API_KEY` (backfill-futures-gaps.ts:202), `DAY_ANALOG_BACKEND` (analyze-context-fetchers.ts:964), `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (push.ts:84-86), `INTERNAL_NOTIFY_SECRET` (push/notify.ts:27), `VERCEL_URL` (ml/trigger-analyze.ts:35).
  - Read at runtime but **absent from the CLAUDE.md table** (24): `OWNER_SECRET`, `APP_URL`, `UPSTASH_REDIS_REST_TOKEN`, `FRED_API_KEY`, `FINNHUB_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_FROM`, `ALERT_PHONE_TO`, `LOG_LEVEL`, `AXIOM_API_KEY`, `AXIOM_DATASET`, plus the 14 above minus the platform-set `VERCEL_URL` and minus `BLOB_READ_WRITE_TOKEN` (which *is* in the table).
  - Declared in `env.ts` but **never read at runtime** (1): `SENTRY_AUTH_TOKEN` — only `vite.config.ts:25` at build time.
  - The `.env.example` header (`:9`) calls `env.ts` "the canonical Zod schema for these vars" — it isn't, for a third of them.
- Failure scenario: `OWNER_SECRET` and `APP_URL` are hard-required by `/api/auth/callback` (`callback.ts:45-51`, `:68-72` → 500 "OWNER_SECRET environment variable must be set" / "APP_URL not configured") yet appear nowhere in the doc table titled "Required env vars". A fresh Vercel project (or a preview env) provisioned from that table cannot complete Schwab login. This has already happened once: memory records "OWNER_SECRET is empty in Vercel prod; owner-only endpoints 401".
- Fix: (1) Add the 14 keys to `env.ts` in new groups (`sidecar`, `push`, `gexbot`, `blob`) and move the three `VAPID_*` reads in `push.ts` onto `requireEnvGroup('vapid')`. (2) Add `OWNER_SECRET`, `APP_URL`, `INTERNAL_NOTIFY_SECRET`, `SIDECAR_URL`, `CLASSIFIER_URL`, `SIDECAR_TAKEIT_*`, `GEXBOT_API_KEY`, `DATABENTO_API_KEY`, `VAPID_*`, Twilio ×4, `FRED_API_KEY`, `FINNHUB_API_KEY`, `LOG_LEVEL`, `AXIOM_*` rows to the CLAUDE.md table (mark optional ones). (3) Move `SENTRY_AUTH_TOKEN` out of `env.ts` into a build-time comment. A vitest that diffs `Object.keys(envSchema.shape)` against a grep of `process.env.` in `api/` would keep this from regressing.

### R7-2: Eighteen dead exports in `api/_lib/constants.ts` from the retired IV-anomaly detector  [P3] [confidence: high] [effort: S]

- Where: `api/_lib/constants.ts` — `VOL_OI_RATIO_THRESHOLD` (:238), `SKEW_DELTA_THRESHOLD` (:251), `Z_SCORE_THRESHOLD` (:258), `ASK_MID_DIV_THRESHOLD` (:272), `IV_SIDE_SKEW_THRESHOLD` (:297), `RESOLVE_FLAT_PNL_THRESHOLD` (:317), `RESOLVE_FAST_PEAK_MINS` (:318), `CATALYST_WINDOW_MINS` (:327), `CATALYST_CORR_THRESHOLD` (:335), `CATALYST_NARRATIVE_CORR_MIN` (:344), `CATALYST_NARRATIVE_LAG_MIN_MINS` (:345), `CATALYST_LARGE_DARK_NOTIONAL` (:352), `REGIME_THRESHOLDS` (:370), `TAPE_WINDOW_MIN` (:380), `VIX_WINDOW_MIN` (:383), `DP_BUCKETS` (:390), `DP_AT_STRIKE_BAND_PTS` (:398); plus `MACRO_WINDOW_DAYS` (:572), whose only use is deriving `MACRO_WINDOW_MS` two lines below.
- What: Zero importers across `api/`, `src/`, `scripts/`, and all tests (verified with `grep -rlw`; no namespace import of the module exists; the only other hits are prose in `docs/superpowers/specs/*` and unrelated same-named Python in `ml/`). `git log -S` shows the sole consumer was `api/_lib/iv-anomaly.ts`, deleted in `227498dd` (2026-04-30, "retire IV-anomaly detector code path"). The section headers "Phase 2 — detection", "Phase 4 — EOD resolution", "Phase F — confluence pills" (lines 241, 300, 355) survived the retirement.
- Fix: Delete the 17 exports and their section headers; inline `MACRO_WINDOW_DAYS` into `MACRO_WINDOW_MS`. Keep `Z_WINDOW_SIZE` (:265, 2 importers) and every `STRIKE_IV_*` / `VEGA_SPIKE_*` export (live in `fetch-strike-iv.ts`, `monitor-vega-spike.ts`).

### R7-3: Nine dead exports in `src/constants/index.ts` from the same retired feature  [P3] [confidence: high] [effort: S]

- Where: `src/constants/index.ts:279-321` — `ANOMALY_SILENCE_MS`, `IV_REGRESSION_THRESHOLD`, `ASK_MID_COMPRESSION_THRESHOLD`, `ASK_MID_COMPRESSION_MIN_ACTIVE_MS`, `IV_REGRESSION_WINDOW_MS`, `ASK_MID_ACCUMULATION_THRESHOLD`, `BID_SIDE_SURGE_RATIO`, `BID_SIDE_SURGE_WINDOW_MS`, `BID_SIDE_MIN_VOL`.
- What: Zero importers, zero test references. Consumers `src/hooks/useIVAnomalies.ts` and `src/components/IVAnomalies/types.ts` were removed in `8adc4744` (2026-04-30, "Phase 7 — remove IV-anomaly stack").
- Fix: Delete the block.

### R7-4: `VANNA_FEATURES_ENABLED = false as const` is a flag nothing reads  [P3] [confidence: high] [effort: S]

- Where: `api/_lib/periscope-analyzer-rules.ts:156`; sole consumer `api/__tests__/periscope-analyzer-rules.test.ts:24,139` (`expect(VANNA_FEATURES_ENABLED).toBe(false)`).
- What: A research conclusion ("vanna features didn't improve F1; revisit on a vol-shock day") encoded as an exported constant that gates nothing. A test asserting a constant equals its literal is a tautology.
- Fix: Delete the export and the test line; keep the six-line rationale as a plain comment (or move it to the periscope-analyzer spec).

### R7-5: `.env.example` carries three orphan vars, one wrong route, and one wrong value set  [P3] [confidence: high] [effort: S]

- Where: `.env.example:74` `PERISCOPE_WEBHOOK_SECRET`, `:83` `AUTO_PLAYBOOK_ENABLED`, `:87` `PERISCOPE_URL`; `:76` "Gates /api/internal-notify"; `:107-108` `DAY_ANALOG_BACKEND` = `'pgvector' | 'in_memory'`; Railway reminder `:172` `AUTH_TOKEN` (ml-sweep).
- What: The first three belonged to the Claude auto-playbook + Periscope-scraper stack retired in `f52db025` (2026-05-26). `env.ts` was cleaned in that commit; `.env.example` was not. `INTERNAL_NOTIFY_SECRET` actually gates `/api/push/notify` (`api/push/notify.ts:1-7`); `/api/internal-notify.ts` does not exist. `DAY_ANALOG_BACKEND` is read as `'text'` (default) | `'features'` (`analyze-context-fetchers.ts:964,982`); the documented values would silently fall through to `'text'`. `ml-sweep` is not in this repo. Also **missing** from `.env.example`: `CLASSIFIER_URL`, `TWILIO_*` ×3, `ALERT_PHONE_TO`, `VITE_VAPID_PUBLIC_KEY`, `VITE_SENTRY_DSN`.
- Fix: Remove the three orphans and the `AUTH_TOKEN` line; correct the route and the value set; add the six missing names.

### R7-6: Four scripts target retired services and are the only readers of two orphan env vars  [P3] [confidence: high] [effort: S]

- Where: `scripts/backfill-periscope-playbook.mjs:153,214,386` (POSTs `Bearer $PERISCOPE_WEBHOOK_SECRET` to `/api/periscope-auto-playbook`, a route deleted in `f52db025`); `scripts/periscope-probe.mjs:57`, `scripts/periscope-controls-probe.mjs:29`, `scripts/periscope-datepicker-test.mjs:37` (Playwright probes of the retired scraper, keyed on `PERISCOPE_URL`).
- What: The backfill script fails with 404 on first request; the probes target a service that no longer exists. R7 says "remove env vars that nothing reads" — the only readers are dead.
- Fix: Delete the four scripts (git history keeps them), then R7-5 removes their vars.

### R7-7: Two obvious single-caller constants in `constants.ts`  [P3] [confidence: medium] [effort: S]

- Where: `api/_lib/constants.ts` — `STRIKE_IV_TICKER_CONCURRENCY` and `STRIKE_IV_OTM_RANGE_PCT_HIGH_LIQ_NAME`, each imported only by `api/cron/fetch-strike-iv.ts` and used once/twice.
- What: Per R7 these belong next to their use with a comment. Listed sparingly: the other single-file constants (`SESSION_*`, `MARKET_MINUTES`, `GAMMA_*`) are deliberately centralized domain values or nightly-tuned weights — see "Rule tweaks", do not inline those.
- Fix: Move the two into `fetch-strike-iv.ts` as `const` with the existing doc comments.

---

## Env var inventory

Columns: **read in code (where)** · **env.ts** · **CLAUDE.md table** · **.env.example** · **verdict**. "prose" = mentioned in CLAUDE.md outside the table. "—" = not applicable (not a Vercel-runtime var).

### Vercel runtime (`api/`)

| Var | Read in code (where) | env.ts | CLAUDE.md table | .env.example | Verdict |
| --- | --- | :-: | :-: | :-: | --- |
| `DATABASE_URL` | `db.ts:39`; 115 script reads; sidecar/uw-stream Settings | Y | Y | Y | OK |
| `KV_REST_API_URL` | `redis.ts:29` (group); `uw-concurrency.ts:73`; `uw-rate-limit.ts:38` (IN-FLIGHT) | Y | Y | Y | OK |
| `KV_REST_API_TOKEN` | `redis.ts:29` (group) | Y | Y | Y | OK |
| `UPSTASH_REDIS_REST_URL` | fallback in the three files above | Y | prose | Y | OK (alias) |
| `UPSTASH_REDIS_REST_TOKEN` | `redis.ts:29` (group fallback) | Y | N | Y | undocumented alias |
| `OWNER_SECRET` | `auth-helpers.ts:90`; `auth/callback.ts:45` | Y | **N** | Y | **UNDOCUMENTED — login-required** (R7-1) |
| `CRON_SECRET` | `cron-helpers.ts:196`; `cron-instrumentation.ts:279`; `ml/analyze-plots.ts:261`; `ml/trigger-analyze.ts:28`; `journal/backfill-features.ts:34`; CI | Y | Y | Y | OK |
| `GUEST_ACCESS_KEYS` | `guest-auth.ts:61` | **N** | Y | Y | not in env.ts (R7-1) |
| `SCHWAB_CLIENT_ID` / `_SECRET` | `schwab.ts:69` (group); `scripts/backfill-market-internals.mjs:38` | Y | Y | Y | OK |
| `APP_URL` | `auth/init.ts:27`; `callback.ts:68`; `guest-key.ts:54`; `guest-logout.ts:23` | Y | **N** | Y | **UNDOCUMENTED — login-required** (R7-1) |
| `ANTHROPIC_API_KEY` | `analyze.ts:129` (requireEnv); `ml/analyze-plots.ts:275`; SDK default | Y | Y | Y | OK |
| `OPENAI_API_KEY` | `embeddings.ts:26`; 2 scripts | Y | Y | Y | OK |
| `UW_API_KEY` | `cron-helpers.ts:220` + every UW cron; uw-stream Settings | Y | Y | Y | OK |
| `UW_PER_MINUTE_CAP` | `uw-rate-limit.ts` **(IN-FLIGHT)** | IN-FLIGHT | IN-FLIGHT | — | note only — other session owns declaration + docs |
| `FRED_API_KEY` | `events.ts:492` | Y | N | Y | undocumented in table |
| `FINNHUB_API_KEY` | `events.ts:500` | Y | N | Y | undocumented in table |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_FROM` / `ALERT_PHONE_TO` | `alerts.ts:63-66` | Y | N | **N** | undocumented in table and .env.example |
| `SENTRY_DSN` | `sentry.ts:12` (optionalEnv; IN-FLIGHT file); `cron-instrumentation.ts:78`; `vite.config.ts:93`; 3 Python services | Y | Y | Y | OK |
| `SENTRY_AUTH_TOKEN` | `vite.config.ts:25` only (build) | Y | Y | Y | declared in runtime schema, never read at runtime (R7-1) |
| `LOG_LEVEL` | `logger.ts:12` (optionalEnv); uw-stream + sidecar Settings | Y | N | Y | undocumented in table |
| `AXIOM_API_KEY` / `AXIOM_DATASET` | `axiom.ts:26,45` (optionalEnv) | Y | N | Y | undocumented in table |
| `VERCEL` | `auth-helpers.ts:46,92`; `guest-auth.ts:87`; `guest-key.ts:55`; `guest-logout.ts:24` | Y | N | comment | platform — OK |
| `VERCEL_ENV` | `sentry.ts:13,16` (IN-FLIGHT); `cron-instrumentation.ts:218` | Y | N | comment | platform — OK |
| `NODE_ENV` | `sentry.ts:15` (IN-FLIGHT); `vite.config.ts:26` | Y | N | comment | platform — OK |
| `VERCEL_URL` | `ml/trigger-analyze.ts:35`; CI secret | N | N | N | platform-set — OK, undeclared |
| `VITEST` | `cron-helpers.ts:249` | N | N | N | runner-set — OK |
| `SIDECAR_URL` | `archive-sidecar.ts:28`; `multileg-client.ts:241`; `cron/fetch-day-ohlc.ts:57`; 3 scripts | **N** | **N** | Y | not in env.ts / table (R7-1) |
| `CLASSIFIER_URL` | `multileg-client.ts:232` | **N** | **N** | **N** | not in env.ts / table / .env.example (R7-1); see R2-1 |
| `SIDECAR_TAKEIT_URL` / `SIDECAR_TAKEIT_SECRET` | `cron/takeit-fill-shap.ts:82-83` | **N** | **N** | Y | not in env.ts / table; sidecar-side name is `TAKEIT_SIDECAR_SHARED_SECRET` (two names, one secret) |
| `BLOB_READ_WRITE_TOKEN` | `periscope-chat-image.ts:80`; `takeit-bundle-loader.ts:81`; `cron/archive-gexbot.ts:198-234`; `@vercel/blob` default; sidecar; 4 scripts; CI | **N** | Y | Y | not in env.ts (R7-1) |
| `GEXBOT_API_KEY` | `cron/fetch-gexbot-fast.ts:194`; `cron/fetch-gexbot-strikes.ts:63`; `scripts/_probe-gexbot-live-endpoints.ts:15` | **N** | **N** | Y | not in env.ts / table (R7-1) |
| `DATABENTO_API_KEY` | `cron/backfill-futures-gaps.ts:202`; `scripts/backfill-futures.ts:85`; sidecar Settings | **N** | prose (Deployment §) | Y | not in env.ts / table (R7-1) |
| `DAY_ANALOG_BACKEND` | `analyze-context-fetchers.ts:964` (single call site) | **N** | **N** | Y (wrong values) | not in env.ts / table; see Rule tweaks |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `push.ts:84-86` | **N** | **N** | Y | not in env.ts / table (R7-1) |
| `INTERNAL_NOTIFY_SECRET` | `push/notify.ts:27`; uw-stream Settings | **N** | **N** | Y (wrong route) | not in env.ts / table (R7-1) |
| `POSTGRES_URL` / `POSTGRES_PRISMA_URL` / `POSTGRES_URL_NON_POOLING` / `NEON_DATABASE_URL` | `journal/status.ts:110-116` — presence probe, names only | N | N | N | diagnostic, not config — OK |

### Frontend / build (`src/`, `vite.config.ts`)

| Var | Read in code (where) | env.ts | CLAUDE.md table | .env.example | Verdict |
| --- | --- | :-: | :-: | :-: | --- |
| `VITE_VAPID_PUBLIC_KEY` | `src/hooks/usePushSubscription.ts:138` | — | N | **N** | undocumented; must equal `VAPID_PUBLIC_KEY` — two names for one value |
| `VITE_SENTRY_DSN` | `src/main.tsx:54`; `vite.config.ts:92` | — | N | **N** | undocumented |
| `VITE_API_TARGET` | `vite.config.ts:126` | — | N | N | dev-only knob — OK |
| `SENTRY_ORG` / `SENTRY_PROJECT` | `vite.config.ts:23-24` | N | N | Y | build-only — OK |
| `VERCEL_GIT_COMMIT_SHA` | `vite.config.ts:100`; `scripts/write-build-info.mjs:21` | N | N | N | platform — OK |
| `ANALYZE`, `PORT` | `vite.config.ts:9,122` | — | — | — | dev knobs — OK |
| `CI` | `playwright.config.ts:6-25` | — | — | — | CI-set — OK |
| `import.meta.env.PROD` / `.DEV` | `main.tsx`, `utils/auth.ts:28` | — | — | — | Vite built-ins — OK |

### Scripts-only (`scripts/`)

| Var | Read in code (where) | env.ts | CLAUDE.md table | .env.example | Verdict |
| --- | --- | :-: | :-: | :-: | --- |
| `DATABASE_URL_UNPOOLED` | 10 replay/backfill scripts (`?? DATABASE_URL`) | — | N | Y | OK (scripts + Railway) |
| `PERISCOPE_WEBHOOK_SECRET` | `backfill-periscope-playbook.mjs:153` — dead script (R7-6) | N (removed `f52db025`) | N | Y | **ORPHAN** (R7-5) |
| `PERISCOPE_URL` | 3 scraper probe scripts — retired service (R7-6) | N | N | Y | **ORPHAN** (R7-5) |
| `AUTO_PLAYBOOK_ENABLED` | nothing | N (removed `f52db025`) | N | Y | **ORPHAN** (R7-5) |
| `SC_OWNER_COOKIE` | `entry-time-analysis.ts:12` | — | — | N | script-only; see R2-4 |
| `RAILWAY_API_TOKEN` / `RAILWAY_TOKEN` / `RAILWAY_CLASSIFIER_SERVICE_ID` / `RAILWAY_CLASSIFIER_ENVIRONMENT_ID` / `CLASSIFIER_MEMORY_GB` / `CLASSIFIER_MEMORY_BYTES` | `set-classifier-memory-limit.mjs:88-119` | — | — | N | ops script CLI — OK |
| `DRY_RUN`, `BYPASS_RESUME`, `BACKFILL_START/END/DAYS`, `TICKERS`, `LIMIT`, `CONCURRENCY`, `CROSS_DAY_CONCURRENCY`, `BATCH_SIZE`, `FEED`, `DAYS`, `SINCE`, `QQQ_TO_NDX_RATIO`, `WITHIN_DAY_DELAY_MS`, `PATH_OVERRIDE`, `ARCHIVE_SRC`, `P14_CSV`/`P26_CSV`/`P27_CSV` | backfill script CLI knobs | — | — | N | not config — OK |

### Railway — sidecar (`sidecar/src`)

| Var | Read in code (where) | CLAUDE.md table | sidecar/README | .env.example reminder | Verdict |
| --- | --- | :-: | :-: | :-: | --- |
| `DATABENTO_API_KEY`, `DATABASE_URL` | `config.py:12,15` (pydantic) | prose / Y | Y | Y | OK |
| `THETA_EMAIL` / `THETA_PASSWORD` | `theta_launcher.py:98-99` | Y | Y | Y | OK |
| `ARCHIVE_MANIFEST_URL` / `ARCHIVE_SEED_TOKEN` / `ARCHIVE_ROOT` | `main.py:160`; `health.py:325`; archive modules | Y | Y | Y | OK |
| `BLOB_READ_WRITE_TOKEN` | `archive_seeder.py` | Y | Y | Y | OK |
| `RAILWAY_RUN_UID` | not read by repo code — consumed by the Railway platform | Y | Y | Y | OK (platform) |
| `TAKEIT_SIDECAR_SHARED_SECRET` | `health.py:420`; `takeit_server.py:228` | N | **N** | N | undocumented; Vercel-side twin is `SIDECAR_TAKEIT_SECRET` |
| `TAKEIT_SERVER_ENABLED` | `takeit_server.py:192` | N | **N** | N | kill switch, undocumented |
| `TAKEIT_MAX_BODY_BYTES` | `health.py:40` | N | **N** | N | knob, undocumented |
| `ARCHIVE_QUERY_CONCURRENCY` | `archive_query.py:64` | N | **N** | N | knob, undocumented |
| `THETA_ROOTS` / `THETA_BACKFILL_DAYS` | `config.py:21-22` | N | **N** | N | knobs, undocumented |
| `THETA_JAR_PATH` / `THETA_DATA_DIR` | `theta_launcher.py:43-44` | N | N | N | test/local overrides — OK |
| `SENTRY_DSN`, `PORT`, `LOG_LEVEL`, `RAILWAY_ENVIRONMENT`, `RAILWAY_DEPLOYMENT_ID` | various | — | Y / platform | — | OK |

### Railway — uw-stream (`uw-stream/src/config.py` pydantic `Settings`)

| Var group | Read in code | uw-stream/README | Verdict |
| --- | --- | :-: | --- |
| `DATABASE_URL`, `UW_API_KEY`, `SENTRY_DSN`, `PORT`, `LOG_LEVEL`, `WS_CHANNELS`, `WS_QUEUE_SIZE`, `WS_BATCH_SIZE`, `WS_BATCH_INTERVAL_MS`, `WS_BACKPRESSURE_POLICY`, `WS_LOG_SAMPLE_RATE`, `WS_LEASE_ENABLED`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `WS_LEASE_TTL_MS`, `WS_LEASE_RENEW_MS`, `WS_LEASE_ACQUIRE_TIMEOUT_S`, `WS_LEASE_KEY` | `config.py:90-201` | Y (18 rows) | OK |
| `WS_MAX_CHANNELS_PER_CONN`, `WS_RECEIVE_QUEUE_SIZE` (`main.py:52`), `INTERVAL_BA_ENABLED`, `INTERVAL_BA_RATIO_THRESHOLD`, `INTERVAL_BA_PREMIUM_FLOOR`, `INTERVAL_BA_WINDOW_SEC`, `INTERVAL_BA_MULTI_LEG_SHARE_MAX`, `INTERVAL_BA_TICKERS_CSV`, `INTERVAL_BA_PUSH_CONFLUENCE_ONLY`, `VERCEL_NOTIFY_URL`, `INTERNAL_NOTIFY_SECRET`, `INTERNAL_METRICS_TOKEN` | `config.py:106-184`, `main.py:52` | **N** (12) | undocumented in service README |
| `RAILWAY_ENVIRONMENT`, `RAILWAY_DEPLOYMENT_ID` | `sentry_setup.py` | — | platform — OK |

### Railway — classifier

`SENTRY_DSN`, `PORT` (README Y), `RAILWAY_ENVIRONMENT`, `RAILWAY_DEPLOYMENT_ID` (platform). **No auth secret read at all** — see R2-1.

### CI-only (`.github/workflows`)

`NEON_API_KEY` (neon_workflow.yml), `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `VERCEL_URL`, `VERCEL_BYPASS_SECRET` (ml-pipeline.yml:104-110, all via headers), `GITHUB_TOKEN`. Not documented anywhere in-repo beyond the workflow files; acceptable for CI secrets.

### `.env.example`-only

`AUTH_TOKEN` (ml-sweep reminder, `:172`) — no ml-sweep service in this repo.

### Inventory verdict counts

- Fully consistent (read + declared + documented, or platform/dev-only where declaration is n/a): **≈60 names**
- Read in `api/` but not in `env.ts`: **14**
- Read at runtime but not in the CLAUDE.md table: **24** (2 of them login-blocking: `OWNER_SECRET`, `APP_URL`)
- Declared in `env.ts` but not read at runtime: **1** (`SENTRY_AUTH_TOKEN`)
- Documented (`.env.example`) but read by nothing live: **4** (`PERISCOPE_WEBHOOK_SECRET`, `AUTO_PLAYBOOK_ENABLED`, `PERISCOPE_URL`, `AUTH_TOKEN`)
- CLAUDE.md table rows that nothing reads: **0**
- Railway-side vars missing from their service README: sidecar **7**, uw-stream **12**
- Cron registry: **77/77** `vercel.json` paths ↔ `api/cron/*.ts` handlers, both directions; `/api/health` cron ↔ `api/health.ts`. No dead jobs. (CLAUDE.md says "35 scheduled jobs" — stale; it is 77 paths / 83 schedule entries.)

---

## Already good — compliant patterns worth protecting

- **Constant-work guest-key compare** — `api/_lib/guest-auth.ts:84-115`: both sides copied into fixed 128-byte buffers, `timingSafeEqual` called on *every* configured key, result ANDed with an exact-length check. Stronger than the usual early-return-on-length. Keys bounded to 8–128 bytes at parse time (`:60-78`) so truncation can't produce a false match.
- **Owner compare** — `api/_lib/auth-helpers.ts:102-104`: `a.length === b.length && timingSafeEqual(a, b)`.
- **Cron bearer compares** — `cron-helpers.ts:201-208`, `cron-instrumentation.ts:278-286`, `ml/analyze-plots.ts:266-273`, `push/notify.ts:32-37`: all length-guarded `timingSafeEqual`. `?force=1` relaxes only the time window, never the secret (`cron-helpers.ts:210-217`).
- **OAuth state** — `schwab.ts:463` `randomBytes(32).toString('hex')`, Redis `ex: 600`, consumed single-use with `redis.del` in `callback.ts:59-66`. Proper CSRF binding.
- **Redis refresh lock** — `schwab.ts:146-160` `SET NX EX`; only a lock holder ever calls Schwab (`:254-308`).
- **Python gates all use `hmac.compare_digest`** — `sidecar/src/health.py:325-327` (`ARCHIVE_SEED_TOKEN` via `X-Admin-Token`), `:431-432` and `takeit_server.py:232` (`TAKEIT_SIDECAR_SHARED_SECRET`), `uw-stream/src/health.py:124-125` (`INTERNAL_METRICS_TOKEN`). Sidecar's auth check runs *before* the heavy `import multileg_routes` and before the body read (`health.py:416-419` comment).
- **UW key-in-URL scrubbing** — UW forces `wss://…/socket?token=<key>`; `uw-stream/src/logger_setup.py:33-42` `scrub_log_tokens` and `sentry_setup.py:29-43` `_before_send` share one regex so the two redaction paths can't drift.
- **No secret rides a query string in TS** — GexBot: `Authorization` header (`gexbot-client.ts:129-154`); Databento: Basic header (`backfill-futures-gaps.ts:102-106`); Twilio: Basic header (`alerts.ts:73-80`); Blob: Bearer (`takeit-bundle-loader.ts:80-84`); sidecar: Bearer (`takeit-fill-shap.ts:152-157`); uw-stream→Vercel: `x-internal-notify-secret` header (`notify.py:44,157`); CI→Vercel: headers (`ml-pipeline.yml:108-110`). FRED's `api_key=` query param is FRED's only mode, and the error log (`events.ts:~345`) logs `{releaseId, status}`, never the URL.
- **Auth-failure logs never carry the credential** — `auth-helpers.ts:123-131` (reason/path/referer/UA only), `guest-auth.ts:70-73` (byte length only), `callback.ts:81-88` (Schwab error message captured server-side; opaque text returned to client).
- **Hashing labeled by purpose** — `panel-prefs.ts:38-41` sha256(guest key) as a storage identity, with the rationale in the header comment; `analyze.ts:204-207` 12-char sha256 prompt hash (cache label); `gexbot-parquet.ts:84` sha256 (integrity). None are security controls, none pretend to be.
- **`Math.random()` only for jitter/sampling** — `schwab-fetch.ts:101`, `cron-helpers.ts:250`, `uw-fetch.ts:60-63` (IN-FLIGHT), `uw-concurrency.ts:158`, `useAlertPolling.ts:202`, `useMarketData.fetchers.ts:66`, three backfill scripts. `randomUUID` for Blob path uniqueness (`periscope-blob.ts:78`) and check-in ids (`cron-instrumentation.ts:206`).
- **djb2 `hashToken`** — `LotteryFinder/index.tsx:364-370`, `SilentBoom/index.tsx:447-453`: a delimiter-free localStorage key discriminator, documented as such. Not crypto; would misfire on a literal reading of R2 (see Rule tweaks). (Two identical copies — a hygiene nit outside these rules.)
- **`urlBase64ToUint8Array`** — `usePushSubscription.ts:47-56`: RFC 8292 boilerplate; browsers have no stdlib equivalent yet.
- **Theta creds file** — `theta_launcher.py:186-210`: plaintext forced by the third-party jar; 0700 dir + 0600 file, container-local, password never logged (`:210` prints path + email only). Nit: `write_text` precedes `chmod`, but the 0700 parent closes the window.
- **VAPID signing** stays inside `web-push` (`push.ts:20,95`); nothing hand-signs ES256.
- **`SESSION HOURS — single source of truth`** block (`constants.ts:38-80`) and `MARKET_MINUTES` — deliberately centralized market-hours values; the right call even with one importer each.
- **Operational kill switches with a written rationale** — `INTERVAL_BA_ENABLED` (`uw-stream/config.py:130-135`, defaults off for a soak), `WS_LEASE_ENABLED` (`:191-195`, incident bypass, with a validator that refuses `true` without KV creds at `:291-306`), `TAKEIT_SERVER_ENABLED` (`takeit_server.py:16,192`).

---

## Rule tweaks — where R2 / R7 as written would misfire here

**R2**

1. *"Never write custom … hashing"* catches non-cryptographic hashes used as cache/storage keys (djb2 in LotteryFinder/SilentBoom). Suggested wording: "Never write custom hashing **for integrity, identity, or authentication**. Non-cryptographic hashes used purely as cache or storage-key discriminators are fine but must say so in a comment and must not be reused for anything security-relevant."
2. *"Never write custom encoding"* catches RFC 4648 base64⇄base64url transcoding (`push.ts:71-75`, `usePushSubscription.ts:47-56`). Suggested carve-out: "Use `Buffer`'s `'base64url'` on Node; in the browser the RFC 8292 `urlBase64ToUint8Array` boilerplate is acceptable."
3. The rule names three helper files as the only place secret compares should live, but the repo has two legitimate non-`cronGuard` bearer checks (`isCronAuthenticated`, which must run before Sentry check-in; `analyze-plots.ts`, a POST). Suggested wording: "Secret comparison goes through `secretEquals()` / `bearerMatches()` in `auth-helpers.ts`; a handler may call those directly when `cronGuard`/`guardOwnerEndpoint` don't fit, but must not re-implement them." (Pairs with R2-3.)
4. Add to R2: "A service split must carry its auth gate with it — an endpoint moved between services keeps the same shared-secret check on both ends." (Would have caught R2-1.)

**R7**

5. *"Don't introduce an env var for a value with one call site"* would flag legitimate operational knobs that exist precisely so they can change without a deploy. Verified single-call-site knobs with a real operational reason: `DAY_ANALOG_BACKEND` (A/B between two shipped analog backends), `UW_PER_MINUTE_CAP` (IN-FLIGHT; rate cap that UW changed under us in 2026-08), `WS_RECEIVE_QUEUE_SIZE`, `ARCHIVE_QUERY_CONCURRENCY`, `TAKEIT_MAX_BODY_BYTES`, `INTERVAL_BA_ENABLED`, `WS_LEASE_ENABLED`, `TAKEIT_SERVER_ENABLED`, `INTERNAL_METRICS_TOKEN`, `THETA_JAR_PATH`/`THETA_DATA_DIR` (test overrides). Suggested wording: "…for a value with one call site **unless it is an operational knob (rate cap, timeout, concurrency, queue size, kill switch) that must be changeable without a deploy — and then the read site's comment must say why**."
6. *"constants.ts entry for a value with one call site"* would flag deliberately centralized domain constants (`SESSION_OPEN_MIN_CT`, `SESSION_CLOSE_MIN_CT`, `SESSION_OPEN_HOUR_UTC`, `MARKET_MINUTES`) whose whole point is being the single place market hours are defined, and nightly-retrained weights (`GAMMA_HIGH_BONUS_*`) that a job edits in place. Suggested carve-out: "Domain constants that define the same physical fact for the whole codebase (market hours, contract multipliers) live in `constants.ts` regardless of importer count."
7. R7's documentation clause names `env.ts` + CLAUDE.md, but this repo has a third surface — `.env.example` — which is the one that actually rotted (R7-5), and the Railway services carry their own README tables. Suggested wording: "…declared in `api/_lib/env.ts`, documented in the CLAUDE.md env table **and `.env.example`**; Railway-only vars are documented in the owning service's README instead of `env.ts`."
8. Add a mechanical backstop to R7: a vitest that greps `process.env.[A-Z_]+` under `api/` and asserts each name is a key of `envSchema.shape` (allow-list for platform vars `VERCEL*`, `NODE_ENV`, `VITEST`, `CI`). Retirement commits (`227498dd`, `8adc4744`, `f52db025`) each left config behind; a test is cheaper than the next audit.
