import pandas as pd

import exit_engine.path_reconstruction as pr


def _trades(rows):
    return pd.DataFrame(
        rows,
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})


def test_minute_path_drops_canceled_and_computes_mid():
    t = _trades([
        ("2026-04-13T14:30:10Z", "X", 1.0, 1.2, 1.1, False),
        ("2026-04-13T14:30:50Z", "X", 1.2, 1.4, 1.3, False),   # same minute -> last wins
        ("2026-04-13T14:31:10Z", "X", 5.0, 5.0, 5.0, "t"),      # canceled -> dropped
        ("2026-04-13T14:32:10Z", "X", 2.0, 2.4, 2.2, False),
    ])
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-04-13T14:30:00Z"), entry_price=1.0)
    assert list(path["mid"]) == [1.3, 2.2]           # 14:30 last mid, 14:32 mid; 14:31 canceled gone
    assert list(path["minutes_since_entry"]) == [0.0, 2.0]
    assert path["spread"].iloc[1] == 0.4


def test_assemble_multiday_concats_sessions_in_order():
    day1 = _trades([("2026-04-13T19:00:10Z", "X", 1.0, 1.2, 1.1, False)])
    day2 = _trades([("2026-04-14T14:30:10Z", "X", 3.0, 3.2, 3.1, False)])
    path = pr.assemble_multiday_path(
        [day1, day2], entry_ts=pd.Timestamp("2026-04-13T19:00:00Z"), entry_price=1.0
    )
    assert len(path) == 2
    assert path["minutes_since_entry"].is_monotonic_increasing
    assert path["mid"].iloc[-1] == 3.1
