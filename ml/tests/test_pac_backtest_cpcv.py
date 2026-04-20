"""Tests for `pac_backtest.cpcv` — CPCV splitter + trade purge."""

from __future__ import annotations

from math import comb

import numpy as np
import pytest

from pac_backtest.cpcv import (
    apply_trade_purge,
    cpcv_splits,
    n_cpcv_paths,
)


class TestNCpcvPaths:
    def test_six_two_is_fifteen(self):
        assert n_cpcv_paths(6, 2) == 15

    def test_matches_math_comb(self):
        for n in range(2, 10):
            for k in range(1, n):
                assert n_cpcv_paths(n, k) == comb(n, k)


class TestCpcvSplits:
    def test_produces_correct_number_of_paths(self):
        splits = cpcv_splits(n_samples=600, n_groups=6, k_test_groups=2)
        assert len(splits) == 15

    def test_each_split_has_train_and_test(self):
        splits = cpcv_splits(n_samples=600)
        for train, test in splits:
            assert isinstance(train, np.ndarray)
            assert isinstance(test, np.ndarray)
            assert len(train) > 0
            assert len(test) > 0

    def test_train_test_disjoint(self):
        """No bar appears in both train and test."""
        splits = cpcv_splits(n_samples=600, n_groups=6, k_test_groups=2)
        for train, test in splits:
            overlap = set(train) & set(test)
            assert not overlap, f"Train/test overlap: {overlap}"

    def test_test_size_with_k_two(self):
        """With n=6, k=2, each test set should be ~2/6 of total bars."""
        splits = cpcv_splits(n_samples=600, n_groups=6, k_test_groups=2)
        for _train, test in splits:
            # 2/6 * 600 = 200; allow ±1 for remainder rounding
            assert 198 <= len(test) <= 202

    def test_embargo_shrinks_training_set(self):
        """Training set should be smaller with embargo than without."""
        no_embargo = cpcv_splits(n_samples=600, embargo_bars=0)
        with_embargo = cpcv_splits(n_samples=600, embargo_bars=50)
        # Same number of splits
        assert len(no_embargo) == len(with_embargo)
        # Training sets are smaller (or equal) with embargo
        for (ne_train, _), (we_train, _) in zip(no_embargo, with_embargo):
            assert len(we_train) <= len(ne_train)

    def test_embargo_excludes_bars_adjacent_to_test(self):
        """Bars immediately before/after each test group should be excluded."""
        splits = cpcv_splits(
            n_samples=600, n_groups=6, k_test_groups=1, embargo_bars=10
        )
        for train, test in splits:
            # Bars within embargo range of any test bar should NOT be in train
            train_set = set(train.tolist())
            for t in test:
                for offset in range(1, 11):
                    assert (t - offset) not in train_set or (t - offset) < 0
                    assert (t + offset) not in train_set or (t + offset) >= 600

    def test_invalid_n_groups(self):
        with pytest.raises(ValueError, match="n_groups"):
            cpcv_splits(n_samples=100, n_groups=1)

    def test_n_groups_exceeds_samples(self):
        with pytest.raises(ValueError, match="exceeds n_samples"):
            cpcv_splits(n_samples=3, n_groups=10)

    def test_small_sample_still_works(self):
        """Minimum usable config: n=6 groups, 60 samples."""
        splits = cpcv_splits(n_samples=60, n_groups=6, k_test_groups=2)
        assert len(splits) == 15
        for train, test in splits:
            assert len(train) + len(test) <= 60


class TestApplyTradePurge:
    def test_no_purge_when_no_overlap(self):
        """Trade exits outside the test window leave training indices intact."""
        train = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        test = np.array([20, 21, 22])  # nothing exits into test
        entries = np.array([0, 3])  # trade entries at bars 0 and 3
        exits = np.array([5, 10])  # exits at 5 and 10 — neither in test
        purged = apply_trade_purge(train, test, entries, exits)
        assert len(purged) == len(train)

    def test_purges_entries_whose_exit_hits_test_set(self):
        """A trade entering bar 3 that exits at bar 20 (in test) must drop bar 3."""
        train = np.array([0, 1, 2, 3, 4, 5])
        test = np.array([20, 21, 22])
        entries = np.array([3])
        exits = np.array([20])  # lands in test
        purged = apply_trade_purge(train, test, entries, exits)
        assert 3 not in set(purged.tolist())
        assert len(purged) == len(train) - 1

    def test_preserves_training_indices_not_associated_with_leaky_trades(self):
        train = np.array([0, 1, 2, 3, 4, 5])
        test = np.array([20, 21])
        entries = np.array([3])
        exits = np.array([20])
        purged = apply_trade_purge(train, test, entries, exits)
        assert list(purged) == [0, 1, 2, 4, 5]

    def test_mismatched_entry_exit_lengths_raises(self):
        with pytest.raises(ValueError, match="length"):
            apply_trade_purge(
                np.array([0, 1]),
                np.array([5]),
                np.array([0]),
                np.array([5, 10]),
            )

    def test_empty_trade_list_no_op(self):
        train = np.array([0, 1, 2, 3])
        test = np.array([10])
        purged = apply_trade_purge(
            train, test, np.array([]), np.array([])
        )
        np.testing.assert_array_equal(purged, train)
