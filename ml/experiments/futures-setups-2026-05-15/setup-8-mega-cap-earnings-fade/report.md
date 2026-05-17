# Setup: `mega-cap-earnings-fade`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T21:35:24Z

**No signals fired in the test window.**

Either the rule's thresholds are too strict for the current regime,
or required data (e.g., earnings calendar, dealer gamma history) is
missing for this period. See `results.json` for `data_unavailable`
flags if applicable.

## Notes

**Status: data_unavailable.** Per spec open question #1 default, an earnings calendar (UW endpoint or manual seed) is needed to identify mega-cap earnings days. No feed was wired in this pass, so 0 signals fire even when NQ gaps occur — we can't verify the earnings filter.

**Mega-cap universe**: AAPL, MSFT, NVDA, GOOG/GOOGL, META, AMZN, TSLA. Reporting _after_ market close (post-3:00 PM CT) qualifies as 'overnight' for the NEXT day's RTH open.

**Implementation present**: prepare() loads `earnings_dates` from an optional CSV path (none committed). The evaluator fires correctly when given a synthetic earnings flag in unit tests; production needs either (a) UW earnings-calendar pull, (b) one-shot CSV seed of historical earnings dates, or (c) Polygon/Benzinga API.
