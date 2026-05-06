# Capture conventions — Periscope

This file is loaded on demand by the `periscope` skill. Capture conventions for studying or building features off Periscope screenshots.

## Cadence

Quartet at **08:30 / 12:00 / 14:30 / 15:00 CT**. The 15:00 capture is for post-hoc verification of where SPX actually settled vs. the predicted cap and drift.

## Frame

Same expiry (0DTE), same strike range (centered on spot ± a fixed dollar band, e.g. ±$100), same timeframe granularity, same theme, same panel configuration.

## Metadata sidecar

Date, capture time, SPX spot at capture, EoD close (later), nearest 25-pt strike, day-type (FOMC / CPI / OpEx / quiet), realized regime (post-hoc), `net_charm_flow` (signed sum of charm bars across visible strikes), nearest dominant +γ strikes above and below spot, **and the straddle breakeven prices** (read from the cone or breakeven lines if shown).

## Useful features to engineer

- `net_charm_flow` — signed sum of charm bars across visible strikes; charm-magnitude-weighted "Buy − Sell" tally.
- `nearest_pos_gamma_above`, `nearest_pos_gamma_below` — strike + magnitude of the closest green Gamma bar above / below spot. Stop and target candidates.
- `nearest_neg_gamma_strike` — closest red Gamma bar; acceleration-zone awareness.
- `dominant_position_strike` — strike of the largest Positions bar; usually the day's gravitational center.
- `gamma_sign_at_spot` — sign of the Gamma bar at the strike nearest spot. Defines regime.
- `orange_bar_count` — number of orange bars in the capture; high = positioning is in flux, low conviction in structural levels.
- `cone_breach_flag` — whether SPX has exceeded the upper or lower straddle breakeven at capture time.
- `vanna_exposure_above`, `vanna_exposure_below` — sum of |Vanna| above/below spot (when 4-panel view is in use).
- `dot_to_bar_delta` — change between current bar and prior-slice dot, per panel; momentum in dealer positioning.
