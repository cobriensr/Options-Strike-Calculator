"""Regression: does our PAC engine produce structure events that align
with the user's manually-journaled entries on 2026-04-17?

Important semantic note discovered while writing this test:

    The user's `Market Structure` column in the journal CSV uses
    "CHoCH+" as a broad label for "supported structure break" — NOT
    the strict reversal-only definition that `smc.bos_choch()` uses.
    This matches the v5 plan amendment: "It does not have to be
    reversal specific, just finding settings and entries that work
    using that indicator system."

    Concretely: on 2026-04-17, the user labeled 11 entries "CHoCH+"
    but smc at swing_length=5 emits CHoCH on only ~4 of their
    timestamps. The remaining ~7 have BOS (continuation breaks) or
    OB mitigations nearby — also legitimate structure events, just
    not CHoCH by smc's strict definition.

Test strategy, given that finding:

1. **Recall check (asserted)**: every journaled entry must have SOME
   structure event (CHoCH, BOS, or HH/LL pivot with an active OB) within
   a 30-minute window preceding the entry. This verifies our engine is
   not silently missing signals on the one day we have ground truth for.

2. **Diagnostic report (printed, not asserted)**: print a mapping of each
   journaled entry to the nearest structure events. Useful for manual
   review of the semantic gap between journal labels and smc classification.
   The "real" label-precision validation happens later in E1.1v via
   LuxAlgo TradingView screenshot parity — not feasible to automate here.
"""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import pytest

_ARCHIVE_ROOT = Path(__file__).resolve().parents[1] / "data" / "archive"
_ARCHIVE_MISSING = not (_ARCHIVE_ROOT / "ohlcv_1m").exists()

pytestmark = pytest.mark.skipif(
    _ARCHIVE_MISSING,
    reason=f"Archive not present at {_ARCHIVE_ROOT}; skipping regression.",
)


# (entry_ts_utc, direction_sign, label from journal CSV)
JOURNAL_ENTRIES: list[tuple[str, int, str]] = [
    ("2026-04-17 13:51:00+00:00", +1, "CHoCH+"),
    ("2026-04-17 14:23:00+00:00", -1, "CHoCH+"),
    ("2026-04-17 14:31:00+00:00", +1, "CHoCH+"),
    ("2026-04-17 15:58:00+00:00", -1, "CHoCH+"),
    ("2026-04-17 16:08:00+00:00", +1, "CHoCH"),
    ("2026-04-17 16:17:00+00:00", -1, "CHoCH+"),
    ("2026-04-17 16:24:00+00:00", +1, "CHoCH+"),
    ("2026-04-17 16:56:00+00:00", -1, "CHoCH+"),
    ("2026-04-17 17:37:00+00:00", +1, "CHoCH+"),
    ("2026-04-17 17:58:00+00:00", -1, "CHoCH+"),
    ("2026-04-17 18:25:00+00:00", +1, "CHoCH"),
    ("2026-04-17 18:52:00+00:00", -1, "CHoCH+"),
    ("2026-04-17 19:32:00+00:00", +1, "CHoCH+"),
]

LOOKBACK_MIN = 30


@pytest.fixture(scope="module")
def enriched_2026_04_17() -> pd.DataFrame:
    os.environ.setdefault("SMC_CREDIT", "0")
    from pac.archive_loader import load_bars, reset_connection_for_tests
    from pac.engine import PACEngine, PACParams

    reset_connection_for_tests()
    df = load_bars("NQ", "2026-04-17", "2026-04-18")
    return PACEngine(PACParams(swing_length=5)).batch_state(df)


def _nearby_events(
    enriched: pd.DataFrame,
    entry_ts: pd.Timestamp,
    lookback_min: int,
) -> list[tuple[pd.Timestamp, str]]:
    """All structure events (CHoCH, BOS, OB) within the lookback window."""
    start = entry_ts - pd.Timedelta(minutes=lookback_min)
    window = enriched[
        (enriched["ts_event"] >= start) & (enriched["ts_event"] <= entry_ts)
    ]
    events: list[tuple[pd.Timestamp, str]] = []
    for _, r in window.iterrows():
        if pd.notna(r["CHOCH"]) and r["CHOCH"] != 0:
            tag = "CHoCH+" if r["CHOCHPlus"] != 0 else "CHoCH"
            direction = "up" if r["CHOCH"] == 1 else "dn"
            events.append((r["ts_event"], f"{tag}_{direction}"))
        if pd.notna(r["BOS"]) and r["BOS"] != 0:
            direction = "up" if r["BOS"] == 1 else "dn"
            events.append((r["ts_event"], f"BOS_{direction}"))
        if pd.notna(r["OB"]) and r["OB"] != 0:
            direction = "bull" if r["OB"] == 1 else "bear"
            events.append((r["ts_event"], f"OB_{direction}"))
    return events


def test_every_journal_entry_has_some_nearby_structure_event(enriched_2026_04_17):
    """Recall check — every user entry must have at least one structure
    event (CHoCH, BOS, or OB) in the preceding 30 minutes.

    A zero-result indicates the engine is silently missing signals, which
    would invalidate the whole backtest. A non-zero result with the
    "wrong" specific label (plain vs + or CHoCH vs BOS) is a semantic
    gap question, not a recall failure, and is surfaced via the
    diagnostic test below.
    """
    missing: list[str] = []
    for entry_iso, _direction, _label in JOURNAL_ENTRIES:
        entry_ts = pd.Timestamp(entry_iso)
        events = _nearby_events(enriched_2026_04_17, entry_ts, LOOKBACK_MIN)
        if not events:
            missing.append(entry_iso)
    assert not missing, (
        f"{len(missing)}/{len(JOURNAL_ENTRIES)} journaled entries have NO "
        f"structure event within {LOOKBACK_MIN}-min window — engine is "
        f"missing signals:\n  " + "\n  ".join(missing)
    )


def test_journal_mapping_diagnostic_report(enriched_2026_04_17, capsys):
    """Always-passing diagnostic: print a full mapping of journal entries
    to nearby structure events so the semantic gap is visible at review
    time.

    This test does not assert any thresholds — the purpose is to emit a
    report that the engineer reviews by eye. The real label-precision
    validation happens in E1.1v via LuxAlgo TradingView screenshot
    parity fixtures, which we can't automate without a paid indicator.
    """
    lines = []
    header = f"\n  {'entry_ts':<24s} {'dir':>4s} {'journal':<8s} {'nearby_events_within_30m':<60s}"
    lines.append(header)
    lines.append("  " + "-" * 96)

    choch_match = 0
    any_match = 0
    for entry_iso, direction, journal_label in JOURNAL_ENTRIES:
        entry_ts = pd.Timestamp(entry_iso)
        events = _nearby_events(enriched_2026_04_17, entry_ts, LOOKBACK_MIN)
        # Display only the most recent 3 events for readability
        display = " ".join(
            f"{lbl}[-{int((entry_ts - ts).total_seconds() / 60)}m]"
            for ts, lbl in events[-3:]
        ) or "(nothing)"
        dir_str = "+1" if direction == 1 else "-1"
        lines.append(
            f"  {entry_iso:<24s} {dir_str:>4s} {journal_label:<8s} {display:<60s}"
        )
        if events:
            any_match += 1
            # Count a "choch match" if we find any CHoCH label (plus or plain)
            # with matching direction
            for _, lbl in events:
                if lbl.startswith("CHoCH") and (
                    (direction == 1 and lbl.endswith("_up"))
                    or (direction == -1 and lbl.endswith("_dn"))
                ):
                    choch_match += 1
                    break

    lines.append("")
    lines.append(f"  Recall (any structure event):    {any_match}/{len(JOURNAL_ENTRIES)}")
    lines.append(f"  Strict CHoCH + direction match:  {choch_match}/{len(JOURNAL_ENTRIES)}")
    lines.append(
        "  Gap interpretation: user labels 'CHoCH+' broadly to include BOS continuation breaks\n"
        "  (consistent with v5 plan: 'not reversal-specific'). Strict CHoCH-only match\n"
        "  would exclude continuation setups that the strategy sweep should still test."
    )

    # Emit to stdout so `pytest -s` shows the report
    report = "\n".join(lines)
    print(report)
    # Also attach to the pytest capsys buffer so `-s` isn't strictly needed
    captured = capsys.readouterr()
    assert report  # trivial non-empty assertion
    # Re-print via captured channel so report is visible either way
    print(captured.out)
