# IV-Anomaly Macro Events (Phase E5) — 2026-04-25
**Sample:** 15,886 alerts; 5 high-impact events in window (FOMC, CPI, PPI, NFP, Retail Sales, GDP, Powell).

**Events in window:**

- 2026-04-14 12:30:00+00:00 — Core PPI year over year
- 2026-04-14 12:30:00+00:00 — PPI year over year
- 2026-04-14 12:30:00+00:00 — Core PPI
- 2026-04-21 12:30:00+00:00 — Retail sales minus autos
- 2026-04-21 12:30:00+00:00 — U.S. retail sales

**Method:** event window = ±30 min of alert_ts.

## In-event window × side

| in_event_window | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 5,042 | 24.1% | -1.0% | $10 |
| False | put | 9,364 | 2.6% | -80.0% | $-113 |

## Outer regime × in_event_window × side

| regime | in_event_window | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | False | call | 2,223 | 17.9% | -30.0% | $-1 |
| chop | False | put | 3,875 | 2.4% | -85.0% | $-92 |
| extreme_down | False | call | 185 | 1.1% | -80.0% | $-87 |
| extreme_down | False | put | 204 | 8.8% | -73.0% | $-110 |
| extreme_up | False | call | 313 | 28.4% | -3.0% | $-17 |
| extreme_up | False | put | 758 | 7.3% | -77.0% | $-40 |
| mild_trend_down | False | call | 151 | 23.8% | -56.0% | $-72 |
| mild_trend_down | False | put | 137 | 7.3% | -60.0% | $-120 |
| mild_trend_up | False | call | 1,604 | 33.7% | 43.0% | $-2 |
| mild_trend_up | False | put | 3,055 | 2.2% | -72.0% | $-125 |
| strong_trend_up | False | call | 566 | 27.0% | 34.0% | $150 |
| strong_trend_up | False | put | 1,335 | 0.4% | -86.0% | $-190 |
