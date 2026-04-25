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
| False | call | 4,950 | 24.4% | -0.0% | $11 |
| False | put | 9,173 | 2.4% | -81.0% | $-114 |

## Outer regime × in_event_window × side

| regime | in_event_window | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | False | call | 3,251 | 16.7% | -32.0% | $-35 |
| chop | False | put | 5,535 | 3.7% | -74.0% | $-121 |
| mild_trend_down | False | put | 30 | 0.0% | -66.0% | $-46 |
| mild_trend_up | False | call | 1,660 | 40.2% | 64.0% | $109 |
| mild_trend_up | False | put | 3,573 | 0.5% | -90.0% | $-99 |
