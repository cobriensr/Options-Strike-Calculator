# Lottery Finder — Pipeline State Log

Append-only log of every PIPELINE.md run. Each entry records the
validation numbers + verdict so we can detect regime drift across
appends without re-running the whole stack.

**Read PIPELINE.md** for what to run and when.
**Schema for each entry** (copy when adding a new day):

```markdown
## YYYY-MM-DD (added day YYYY-MM-DD)

- p28 cheap-call-PM lottery rate: X.X% (vs Y.Y% baseline, Z.Zx lift)
- p29 LOO act30_trail10 profitable days: X / Y (Z%)
- p29 bootstrap % > $0 (act30_trail10): X.X%
- Verdict: PASS / FAIL
- Notes: any context — outlier days, broker outage, parquet
  irregularities, etc.
- Run by: <agent name or "user">
```

---

## 2026-05-02 (initial 15-day backtest seed — no day appended)

- Parquet window: 2026-04-13 → 2026-05-01 (15 trading days)
- Total v4 fires (p14): 179,890
- Mode A + Mode B fires (p26): 51,290
  - Mode A (0DTE intraday): 17,934
  - Mode B (DTE 1-3 trend): 32,885
- RE-LOAD-tagged: 662
- cheap-call-PM-tagged: 1,559
- p28 cheap-call-PM lottery rate: 18.9% (vs ~9.1% RE-LOAD baseline, 2.1× lift)
- p29 LOO act30_trail10 profitable days: 6 / 12 (50%)
- p29 bootstrap % > $0 (act30_trail10): not yet computed at seed
- Top-3/day cherry-pick total $ over 15 days, act30_trail10: +$672
  (88% from 2026-04-21 alone — concentration concern documented)
- Verdict: **PASS** (seeds the production rule)
- Notes:
  - 2026-04-21 is the dominant outlier day; without it, only
    `act30_trail10` is barely positive. Edge concentration is
    explicitly noted in the spec and surfaced in the UI subtitle.
  - Macro-augmented selection rules (p30/p31) all UNDERPERFORMED the
    cheap-call-PM-only baseline; macro is shipped as display-only
    badges, not as filter chips.
  - 50,819 fires loaded into `lottery_finder_fires` via
    `scripts/backfill-lottery-fires.mjs` (471 dropped for malformed
    timestamps from chains with insufficient ticks).
- Run by: user (manual, sourced from
  `docs/superpowers/specs/lottery-finder-2026-05-02.md` v0.2 analysis)
