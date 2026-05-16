# Cross-Section EDA Re-run — 2026-05-16

Re-validates the 4 findings from the 2026-05-15 EDA on full-data populated
columns. Triggered by the discovery that the original Range Kill / TOP-RANGE
result was dimensionally bugged — see investigation notes in the conversation
log. The other 3 findings used DB-column inputs and should reproduce; this
rerun confirms that.

_LF enriched rows: 626,155 · SB enriched rows: 15,456 · macro events: 67_


### F1 Coarse (LF, correct range_pos)
_Baseline: win50=35.5%, win100=19.2%, N=604,222_

| Stratum | N | win50% | win100% | lift50 | lift100 |
|---|---|---|---|---|---|
| bottom10% | 15,327 | 34.4 | 17.5 | 0.97 | 0.91 |
| low30% | 112,288 | 34.6 | 18.4 | 0.97 | 0.96 |
| mid40% | 332,993 | 35.9 | 19.1 | 1.01 | 1.0 |
| high70% | 121,968 | 35.5 | 19.9 | 1.0 | 1.04 |
| top10% | 21,646 | 36.1 | 21.3 | 1.01 | 1.11 |

### F1 Decile (LF, correct range_pos)
_Baseline: win50=35.5%, win100=19.2%, N=604,222_

| Stratum | N | win50% | win100% | lift50 | lift100 |
|---|---|---|---|---|---|
| D1 | 15,327 | 34.4 | 17.5 | 0.97 | 0.91 |
| D2 | 44,083 | 33.3 | 17.4 | 0.94 | 0.91 |
| D3 | 68,205 | 35.4 | 19.0 | 1.0 | 0.99 |
| D4 | 81,255 | 35.2 | 18.6 | 0.99 | 0.97 |
| D5 | 85,860 | 35.3 | 18.1 | 0.99 | 0.94 |
| D6 | 82,454 | 36.4 | 19.3 | 1.02 | 1.01 |
| D7 | 83,424 | 36.7 | 20.5 | 1.03 | 1.07 |
| D8 | 67,647 | 35.3 | 19.7 | 0.99 | 1.03 |
| D9 | 54,321 | 35.9 | 20.2 | 1.01 | 1.05 |
| D10 | 21,646 | 36.1 | 21.3 | 1.01 | 1.11 |

### F1 Extra: range_pos == 1.0 (new session-high prints)
N=143, win50=55.9%, win100=46.9%

### F1 Coarse (LF, tier 1+2 only)
_Baseline: win50=55.4%, win100=39.2%, N=106,271_

| Stratum | N | win50% | win100% | lift50 | lift100 |
|---|---|---|---|---|---|
| bottom10% | 3,104 | 53.2 | 34.7 | 0.96 | 0.89 |
| low30% | 20,139 | 53.8 | 38.0 | 0.97 | 0.97 |
| mid40% | 55,418 | 55.3 | 38.8 | 1.0 | 0.99 |
| high70% | 21,940 | 56.4 | 41.1 | 1.02 | 1.05 |
| top10% | 5,670 | 58.9 | 43.4 | 1.06 | 1.11 |


### F2 (LF vol_to_oi_window)
_Baseline: win50=35.7%, win100=19.3%, N=626,155_

| Stratum | N | win50% | win100% | lift50 | lift100 |
|---|---|---|---|---|---|
| <0.5 | 496,693 | 34.9 | 18.3 | 0.98 | 0.95 |
| 0.5–1 | 51,963 | 39.3 | 23.1 | 1.1 | 1.19 |
| 1–2 | 31,850 | 38.9 | 23.4 | 1.09 | 1.21 |
| 2–5 | 23,787 | 35.4 | 21.3 | 0.99 | 1.1 |
| ≥5 | 21,862 | 40.1 | 26.1 | 1.12 | 1.35 |


### F3 (SB multi_leg_share)
_Baseline: win50=16.7%, win100=7.9%, N=15,455_

| Stratum | N | win50% | win100% | lift50 | lift100 |
|---|---|---|---|---|---|
| <10% | 10,604 | 18.8 | 9.1 | 1.13 | 1.15 |
| 10–30% | 162 | 34.6 | 21.6 | 2.08 | 2.73 |
| 30–50% | 55 | 25.5 | 18.2 | 1.53 | 2.3 |
| 50–70% | 90 | 23.3 | 11.1 | 1.4 | 1.41 |
| 70–100% | 4,544 | 10.7 | 4.5 | 0.64 | 0.57 |


### F4 (LF hours-to-next macro event)
_Baseline: win50=35.7%, win100=19.3%, N=624,019_

| Stratum | N | win50% | win100% | lift50 | lift100 |
|---|---|---|---|---|---|
| <24h | 190,186 | 32.0 | 16.4 | 0.9 | 0.85 |
| 24–72h | 38,035 | 32.9 | 16.8 | 0.92 | 0.87 |
| 72h–7d | 57,533 | 42.6 | 24.6 | 1.19 | 1.28 |
| 7d–30d | 122,856 | 33.8 | 17.1 | 0.95 | 0.88 |
| >30d | 215,409 | 38.7 | 22.2 | 1.08 | 1.15 |
