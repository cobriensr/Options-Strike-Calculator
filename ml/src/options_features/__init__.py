"""Per-bar options-derived features (E1.2 of the PAC backtester spec).

This package produces a per-bar DataFrame that joins onto PAC engine output
on `(ts_event,)` to enrich the backtest sweep with regime-aware filters.
Two data sources feed into it:

- **Daily volatility regime** (this phase, E1.2a): VIX, VIX9D, VIX1D, VVIX
  daily closes from yfinance, plus the VIX/VIX9D ratio as a term-structure
  signal. Also event-day flags (monthly OPEX, FOMC) computed from static
  calendars. All features are daily scalars forward-filled to 1m bars.

- **Intraday options signatures** (next phase, E1.2b, deferred):
  ATM 0DTE straddle IV, straddle-cone position, max-pain distance.
  These require options chain historical data — SPX via Theta Data,
  ES via Databento historical. Planned for a follow-up branch.

See `docs/superpowers/specs/pac-backtester-2026-04-18.md` (v6) E1.2 for
the full v1 feature list; this package ships the subset that requires no
new data pull.
"""
