"""PAC backtest harness (E1.3 of the PAC backtester spec).

Takes PAC-enriched bar DataFrames (from `pac.engine.PACEngine.batch_state`)
and runs event-driven simulations that produce per-trade P&L with
configurable entry/exit/stop logic.

Phase 1 (this module's current scope): core event-driven loop in pure
Python, bar-close fill model with slippage, trade-level P&L with MAE/MFE,
standard metrics (WR, expectancy, profit factor, Sharpe, Sortino, max DD).

Phase 2 (deferred):
- numba `@njit` optimization of the inner loop once logic stabilizes
- Deflated Sharpe Ratio with effective-trial estimation
- L1 tick fill refinement using TBBO archive (Phase 4a data)
- Options-feature snapshots at trade entry (requires E1.2a overlay wire-in)

Spec: docs/superpowers/specs/pac-backtester-2026-04-18.md (v6), E1.3.
"""
