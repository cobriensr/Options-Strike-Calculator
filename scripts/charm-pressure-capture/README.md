# Charm Pressure Capture

Companion artifacts for the study spec at
`docs/superpowers/specs/charm-pressure-pin-study-2026-04-25.md`.

## Files

### Sample construction (run once)

- `generate-candidate-days.mjs` — generates `candidate-days.csv`. Pre-fills
  date, day-of-week, OpEx flags (deterministic), holidays (excluded), and
  best-effort FOMC/CPI/NFP flags from training knowledge.

  ```bash
  node scripts/charm-pressure-capture/generate-candidate-days.mjs
  ```

- `enrich-candidate-days.mjs` — fills SPX OHLC + regime classification
  from `day_embeddings` (with `spx_candles_1m` fallback for dates the
  parquet path hasn't reached). Re-run any time to refresh.

  ```bash
  node --env-file=.env.local scripts/charm-pressure-capture/enrich-candidate-days.mjs
  ```

- `select-study-days.mjs` — marks 100 days `selected=Y` (50
  range_bound + 30 trending + 20 event), evenly spaced across the
  window. Deterministic — same picks on every re-run.

  ```bash
  node scripts/charm-pressure-capture/select-study-days.mjs
  ```

### Capture (Playwright automation)

- `save-storage.ts` — **run once.** Opens TRACE in a visible Chromium
  window; you log in manually (handle SSO/MFA/cookie banners), then
  return to the terminal and press Enter. The script saves your auth
  state to `.trace-storage.json` (gitignored) for `capture.ts` to reuse.

  ```bash
  npx tsx scripts/charm-pressure-capture/save-storage.ts
  ```

- `capture.ts` — automated capture runner. Iterates `selected=Y` rows,
  for each day sets the date picker and the historical time slider to
  08:30 / 11:00 / 14:30 CT, scrapes Stability% + SPX spot from the DOM,
  clicks the camera/download button, saves the resulting PNG to
  `screenshots/<date>/{open,mid,close}.png`, and writes the scraped
  values back into the CSV.

  ```bash
  # Headless (default)
  npx tsx scripts/charm-pressure-capture/capture.ts

  # Headed (helpful for debugging selector issues)
  HEADLESS=0 npx tsx scripts/charm-pressure-capture/capture.ts
  ```

  **First-run selector tuning is required.** TRACE's DOM is
  undocumented, so `capture.ts` ships with best-effort placeholder
  selectors in the `TRACE_SELECTORS` object at the top of the file.
  Run once with `HEADLESS=0` to watch the script interact, identify
  any selectors that fail, inspect the relevant elements in DevTools,
  and update `TRACE_SELECTORS`. Expect 1–2 iterations to lock in.

### Outputs

- `candidate-days.csv` — single source of truth. ~475 rows, 100 marked
  `selected=Y`, columns get progressively filled by enrichment, then
  by the Playwright capture, then manually post-close (pin outcome).

- `selected-days.md` — human-readable list of the 100 picks.

- `screenshots/<YYYY-MM-DD>/{open,mid,close}.png` — produced by
  `capture.ts`. Gitignored.

- `.trace-storage.json` — produced by `save-storage.ts`. Contains
  session cookies; gitignored.

## Capture protocol — non-negotiable

The three capture times match the Stability% valid window
(9:30–3:30 PM ET per SpotGamma's tooltip). **Do not capture at
15:00 CT / 16:00 ET** — Stability% is invalid past 3:30 PM ET.

| Slot  | CT    | ET    | Why                                            |
| ----- | ----- | ----- | ---------------------------------------------- |
| open  | 08:30 | 09:30 | Cash open — earliest valid Stability% reading. |
| mid   | 11:00 | 12:00 | Mid-session evolution.                         |
| close | 14:30 | 15:30 | Last valid Stability% reading before EoD.      |

## Verification step (one-time)

The FOMC, CPI, and NFP flags in `candidate-days.csv` came from training
knowledge; spot-check before relying on them:

- FOMC: <https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm>
- CPI / NFP: <https://www.bls.gov/schedule/news_release/>

Holidays + half-days are deterministic and don't need verification.
