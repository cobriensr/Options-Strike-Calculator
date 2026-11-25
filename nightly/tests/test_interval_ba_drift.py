"""The tape replay's detector constants against uw-stream's live detector.

nightly/src/interval_ba_replay.py copies today's live rule. This reads the three uw-stream files
that define it as text (no import from uw-stream, which has its own dependencies) and fails when
one of them changes a value the replay holds:

- uw-stream/src/config.py: the defaults of the ratio, the premium floor, the bucket window and
  the multi-leg share;
- uw-stream/src/handlers/interval_ba.py: the multi-leg codes, the confluence window and the
  comparisons that decide a fire and the top trade;
- uw-stream/src/handlers/recent_fires.py: the confluence window test, backward only and
  inclusive at both ends, on other tickers with the same option type.

The `nightly` paths filter in .github/workflows/ci.yml lists these three files, so a change to
one runs this test.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import interval_ba_replay as replay

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG = REPO_ROOT / "uw-stream" / "src" / "config.py"
HANDLER = REPO_ROOT / "uw-stream" / "src" / "handlers" / "interval_ba.py"
RECENT_FIRES = REPO_ROOT / "uw-stream" / "src" / "handlers" / "recent_fires.py"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _setting_default(name: str) -> str:
    """The literal default of a `Settings` field, underscores dropped (250_000 -> 250000)."""
    match = re.search(
        rf"^\s+{name}\s*:\s*\w+\s*=\s*([0-9][0-9_.]*)\s*$", _text(CONFIG), re.MULTILINE
    )
    assert match, f"no literal default for {name} in uw-stream/src/config.py"
    return match.group(1).replace("_", "")


def _function_body(text: str, name: str) -> str:
    """The source of a top-level function, up to the next top-level def or class."""
    match = re.search(rf"^def {name}\(.*?(?=^(?:def|class)\s|\Z)", text, re.MULTILINE | re.DOTALL)
    assert match, f"no top-level function {name}"
    return match.group(0)


def test_ratio_threshold_matches_uw_stream():
    assert Decimal(_setting_default("interval_ba_ratio_threshold")) == replay.RATIO_THRESHOLD


def test_premium_floor_matches_uw_stream():
    assert int(_setting_default("interval_ba_premium_floor")) == replay.PREMIUM_FLOOR_DOLLARS


def test_window_matches_uw_stream():
    assert int(_setting_default("interval_ba_window_sec")) == replay.WINDOW_SEC


def test_multi_leg_share_matches_uw_stream():
    assert (
        Decimal(_setting_default("interval_ba_multi_leg_share_max")) == replay.MULTI_LEG_SHARE_MAX
    )


def test_multi_leg_codes_match_uw_stream():
    match = re.search(
        r"^_MULTI_LEG_CODES\b[^=\n]*=\s*frozenset\(\s*\{(?P<body>[^}]*)\}",
        _text(HANDLER),
        re.MULTILINE,
    )
    assert match, "no _MULTI_LEG_CODES frozenset literal in uw-stream's interval_ba.py"
    codes = re.findall(r"""["']([^"']+)["']""", match.group("body"))

    assert len(codes) == len(set(codes))
    assert frozenset(codes) == replay.MULTI_LEG_CODES


def test_confluence_window_matches_uw_stream():
    match = re.search(r"^_CONFLUENCE_WINDOW_SEC\s*=\s*(\d+)\s*$", _text(HANDLER), re.MULTILINE)
    assert match, "no _CONFLUENCE_WINDOW_SEC literal in uw-stream's interval_ba.py"

    assert int(match.group(1)) == replay.CONFLUENCE_WINDOW_SEC


def test_fire_comparisons_match_uw_stream():
    # The replay fires on total >= floor, ask/total >= ratio and multi-leg/total < share, and
    # keeps the earliest of equal top prints. These are the live lines that say so.
    handler = _text(HANDLER)
    aggregate = _function_body(handler, "_aggregate")

    assert re.search(
        r"if total_premium <= 0 or total_premium < self\._premium_floor:\s*return", handler
    )
    assert re.search(r"if ratio < self\._ratio_threshold:\s*return", handler)
    assert re.search(
        r"if multi_leg_premium / total_premium >= self\._multi_leg_share_max:", handler
    )
    assert re.search(r"if t\.premium > top_premium:", aggregate)


def test_confluence_window_is_backward_and_inclusive_in_uw_stream():
    body = _function_body(_text(RECENT_FIRES), "lookup_confluence")

    assert re.search(r"if other_ticker == ticker:\s*(?:#[^\n]*\s*)*continue", body)
    assert re.search(r"if opt != option_type:\s*(?:#[^\n]*\s*)*continue", body)
    assert re.search(r"delta = \(fired_at - ts\)\.total_seconds\(\)", body)
    assert re.search(r"if delta < 0:\s*(?:#[^\n]*\s*)*continue", body)
    assert re.search(r"if delta <= window_sec:\s*out\.append\(other_ticker\)", body)


def test_replay_confluence_is_backward_and_inclusive():
    # The same window in the replay: 0 and 90 s back are in, 90.001 s back and ahead are out.
    t0 = datetime(2026, 11, 17, 14, 31, tzinfo=UTC)
    window = timedelta(seconds=replay.CONFLUENCE_WINDOW_SEC)
    fires = [
        (t0, "QQQ", "C"),
        (t0 + window, "SPY", "C"),
        (t0 + window + timedelta(milliseconds=1), "SPXW", "C"),
        (t0 + window + timedelta(milliseconds=1), "QQQ", "P"),
    ]

    assert replay._confluence(fires) == [(), ("QQQ",), ("SPY",), ()]
