"""PAC (Price Action Concepts) engine.

Extends `joshyattridge/smart-money-concepts` with:
- **CHoCH+** (supported change-of-character): a CHoCH promoted to CHoCH+
  when a prior failed HH (in an uptrend) or failed LL (in a downtrend)
  occurred within N bars before the CHoCH event. Absent from the open-source
  library — defined by LuxAlgo's paid Price Action Concepts® indicator.
- **Volumetric Order Blocks**: per-OB volume accumulation with `OB_volume`,
  `OB_pct_share` (fraction of total displayed OB volume), and z-score columns
  (`OB_z_top`, `OB_z_bot`, `OB_z_mid`) computed against the session VWAP ± 1σ.

Data access is via `archive_loader`, which wraps the DuckDB-over-parquet
pattern from `sidecar/src/archive_query.py` (year-partitioned globs,
thread-local singleton connection, UTC TimeZone, front-month-by-volume
contract selection).

Upstream `smartmoneyconcepts` emits a credit print on import; we suppress
via `SMC_CREDIT=0` before importing.
"""

from __future__ import annotations

import os

# Suppress the upstream credit nag on import. Set BEFORE `import smartmoneyconcepts`.
os.environ.setdefault("SMC_CREDIT", "0")
