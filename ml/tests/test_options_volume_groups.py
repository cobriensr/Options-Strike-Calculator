"""The options-volume feature groups: what a morning model may read.

The ML models predict at 10:00 CT. The same-day options-volume totals
(volume, premium, ask/bid, the volume PCR, the premium ratio and the two
vs-avg30 ratios) are end-of-day figures, so a model that reads them looks
ahead. Owner decision (i), 2026-11-26: a morning model reads

  - today's open interest (`opt_call_oi`, `opt_put_oi`, `opt_oi_pcr`), which
    UW reports as of the day's open, and
  - the previous trading day's other 12 figures (`prev_day_opt_*`).

`OPTIONS_VOLUME_FEATURES` is that group. `OPTIONS_VOLUME_EOD_FEATURES` is the
12 same-day columns that leak. Spec: docs/superpowers/specs/
2026-11-26-options-volume-prev-day-design.md, phase 3a.

The leak tests read the feature lists the two models build and the columns
they select from a frame, not a copy of either, so a new feature list that
pulls an end-of-day column in fails here whatever name it goes by.
"""

import matplotlib
import matplotlib.axes
import numpy as np
import pandas as pd
import pytest

import clustering
import phase2_early
from utils import OPTIONS_VOLUME_EOD_FEATURES, OPTIONS_VOLUME_FEATURES

matplotlib.use("Agg")

# The decided groups, written out: a change to either list is a decision.
SAME_DAY_OPEN_INTEREST = ["opt_call_oi", "opt_put_oi", "opt_oi_pcr"]

PREV_DAY_SUFFIXES = [
    "call_volume",
    "put_volume",
    "call_premium",
    "put_premium",
    "bullish_premium",
    "bearish_premium",
    "call_vol_ask",
    "put_vol_bid",
    "vol_pcr",
    "premium_ratio",
    "call_vol_vs_avg30",
    "put_vol_vs_avg30",
]

# The previous day's open interest is not a feature: the same-day open
# interest is known at the open, so the previous day's adds nothing.
PREV_DAY_OPEN_INTEREST = [
    "prev_day_opt_call_oi",
    "prev_day_opt_put_oi",
    "prev_day_opt_oi_pcr",
]

MODEL_FEATURES = {
    "phase2_early": phase2_early.ALL_NUMERIC_FEATURES,
    "clustering": clustering.ALL_NUMERIC_FEATURES,
}


# ── The groups ──────────────────────────────────────────────────────────────


def test_morning_safe_group_is_same_day_open_interest_and_the_previous_days_twelve():
    expected = SAME_DAY_OPEN_INTEREST + [f"prev_day_opt_{s}" for s in PREV_DAY_SUFFIXES]

    assert OPTIONS_VOLUME_FEATURES == expected
    assert len(OPTIONS_VOLUME_FEATURES) == 15


def test_eod_group_is_the_twelve_same_day_columns_that_leak():
    expected = [f"opt_{s}" for s in PREV_DAY_SUFFIXES]

    assert OPTIONS_VOLUME_EOD_FEATURES == expected
    assert len(OPTIONS_VOLUME_EOD_FEATURES) == 12


def test_the_groups_do_not_overlap_and_have_no_repeats():
    assert set(OPTIONS_VOLUME_FEATURES).isdisjoint(OPTIONS_VOLUME_EOD_FEATURES)
    assert len(set(OPTIONS_VOLUME_FEATURES)) == len(OPTIONS_VOLUME_FEATURES)
    assert len(set(OPTIONS_VOLUME_EOD_FEATURES)) == len(OPTIONS_VOLUME_EOD_FEATURES)


def test_every_prev_day_column_in_the_morning_group_has_an_eod_twin():
    twins = {
        "opt_" + c.removeprefix("prev_day_opt_")
        for c in OPTIONS_VOLUME_FEATURES
        if c.startswith("prev_day_opt_")
    }

    assert twins == set(OPTIONS_VOLUME_EOD_FEATURES)


def test_same_day_open_interest_is_morning_safe_and_not_end_of_day():
    for column in SAME_DAY_OPEN_INTEREST:
        assert column in OPTIONS_VOLUME_FEATURES
        assert column not in OPTIONS_VOLUME_EOD_FEATURES


def test_the_previous_days_open_interest_is_in_neither_group():
    for column in PREV_DAY_OPEN_INTEREST:
        assert column not in OPTIONS_VOLUME_FEATURES
        assert column not in OPTIONS_VOLUME_EOD_FEATURES


# ── No end-of-day column reaches a model's feature list ─────────────────────


@pytest.mark.parametrize("model", MODEL_FEATURES)
def test_no_eod_column_is_in_the_models_feature_list(model):
    features = MODEL_FEATURES[model]

    leaked = [f for f in features if f in OPTIONS_VOLUME_EOD_FEATURES]

    assert leaked == []


@pytest.mark.parametrize("model", MODEL_FEATURES)
def test_the_only_same_day_options_volume_columns_are_open_interest(model):
    """A leaking name that is in no list (a new group, a typo) still fails."""
    same_day = [f for f in MODEL_FEATURES[model] if f.startswith("opt_")]

    assert sorted(same_day) == sorted(SAME_DAY_OPEN_INTEREST)


@pytest.mark.parametrize("model", MODEL_FEATURES)
def test_the_model_reads_the_whole_morning_safe_group(model):
    features = MODEL_FEATURES[model]

    assert [f for f in OPTIONS_VOLUME_FEATURES if f not in features] == []
    # Once each: a group spliced into the list twice would double-weight it.
    assert all(features.count(f) == 1 for f in OPTIONS_VOLUME_FEATURES)


def _frame_with_every_options_volume_column(
    feature_list: list[str], n: int = 40
) -> pd.DataFrame:
    """A frame holding the model's features and every options-volume column."""
    rng = np.random.default_rng(7)
    names = list(
        dict.fromkeys(
            feature_list
            + OPTIONS_VOLUME_FEATURES
            + OPTIONS_VOLUME_EOD_FEATURES
            + PREV_DAY_OPEN_INTEREST
        )
    )
    frame = pd.DataFrame(
        {name: rng.standard_normal(n) for name in names},
        index=pd.date_range("2026-01-02", periods=n, freq="B", name="date"),
    )
    frame["charm_pattern"] = "mixed"
    frame["regime_zone"] = "normal"
    return frame


def test_phase2_prepare_features_selects_no_eod_column_from_a_full_frame():
    frame = _frame_with_every_options_volume_column(phase2_early.ALL_NUMERIC_FEATURES)

    X, numeric_cols, _ = phase2_early.prepare_features(frame)

    assert set(numeric_cols).isdisjoint(OPTIONS_VOLUME_EOD_FEATURES)
    assert set(X.columns).isdisjoint(OPTIONS_VOLUME_EOD_FEATURES)
    assert set(OPTIONS_VOLUME_FEATURES) <= set(numeric_cols)
    assert set(PREV_DAY_OPEN_INTEREST).isdisjoint(X.columns)


def test_clustering_preprocess_selects_no_eod_column_from_a_full_frame():
    frame = _frame_with_every_options_volume_column(clustering.ALL_NUMERIC_FEATURES)

    _, _, df_feat = clustering.preprocess(frame)

    assert set(df_feat.columns).isdisjoint(OPTIONS_VOLUME_EOD_FEATURES)
    assert set(OPTIONS_VOLUME_FEATURES) <= set(df_feat.columns)
    assert set(PREV_DAY_OPEN_INTEREST).isdisjoint(df_feat.columns)


# ── The clustering name reads ───────────────────────────────────────────────


def _profile_frame(**columns: float) -> pd.DataFrame:
    """Twelve days in two clusters, each given column held at one value."""
    n = 12
    dates = pd.date_range("2026-01-05", periods=n, freq="B")
    frame = pd.DataFrame(
        {
            "vix": np.linspace(14, 25, n),
            "day_of_week": [d.weekday() for d in dates],
        },
        index=dates,
    )
    for name, value in columns.items():
        frame[name] = value
    return frame


def test_cluster_profile_describes_a_cluster_with_the_previous_days_pcr(capsys):
    frame = _profile_frame(prev_day_opt_vol_pcr=1.25, opt_vol_pcr=9.0)
    labels = np.array([0] * 6 + [1] * 6)

    clustering.characterize_clusters(frame, labels, 2, "K-Means")

    out = capsys.readouterr().out
    assert out.count("Options PCR (prev day): 1.25 avg") == 2
    assert "9.00" not in out


def test_cluster_profile_prints_no_pcr_from_the_same_days_column_alone(capsys):
    frame = _profile_frame(opt_vol_pcr=9.0)
    labels = np.array([0] * 6 + [1] * 6)

    clustering.characterize_clusters(frame, labels, 2, "K-Means")

    out = capsys.readouterr().out
    assert "Options PCR" not in out
    assert "9.00" not in out


def test_cluster_heatmap_reads_the_previous_days_pcr_and_no_eod_column(
    monkeypatch, tmp_path
):
    # save_plots writes under ML_ROOT/plots, which is tracked in git.
    monkeypatch.setattr(clustering, "ML_ROOT", tmp_path)
    labels_seen: list[list[str]] = []
    original = matplotlib.axes.Axes.set_xticklabels

    def spy(self, labels, *args, **kwargs):
        labels_seen.append([str(label) for label in labels])
        return original(self, labels, *args, **kwargs)

    monkeypatch.setattr(matplotlib.axes.Axes, "set_xticklabels", spy)
    rng = np.random.default_rng(3)
    n = 12
    frame = _profile_frame()
    for name in OPTIONS_VOLUME_EOD_FEATURES + ["prev_day_opt_vol_pcr"]:
        frame[name] = rng.uniform(0.5, 2.0, n)
    labels = np.array([0] * 6 + [1] * 6)
    X_pca = rng.standard_normal((n, 2))

    clustering.save_plots(X_pca, labels, 2, frame)

    heatmaps = [seen for seen in labels_seen if "vix" in seen]
    assert len(heatmaps) == 1
    assert "prev_day_opt_vol_pcr" in heatmaps[0]
    assert set(heatmaps[0]).isdisjoint(OPTIONS_VOLUME_EOD_FEATURES)
    assert (tmp_path / "plots" / "clusters_heatmap.png").exists()
