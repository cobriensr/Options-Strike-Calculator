"""Tests for `pac_backtest.acceptance` — YAML loader + validator."""

from __future__ import annotations

import pytest
import yaml

from pac_backtest.acceptance import (
    AcceptanceConfig,
    Thresholds,
    load_acceptance,
)


class TestLoadAcceptance:
    def test_default_file_loads(self):
        """The checked-in acceptance.yml must load cleanly."""
        cfg = load_acceptance()
        assert isinstance(cfg, AcceptanceConfig)
        assert cfg.version >= 3

    def test_markets_are_strings(self):
        cfg = load_acceptance()
        assert "NQ" in cfg.markets
        assert "ES" in cfg.markets
        assert all(isinstance(m, str) for m in cfg.markets)

    def test_thresholds_populated(self):
        cfg = load_acceptance()
        t = cfg.thresholds
        assert isinstance(t, Thresholds)
        assert 0 <= t.pbo_max <= 1
        assert 0 < t.max_drawdown_pct <= 1
        assert t.min_trades_per_fold >= 1
        assert t.profit_factor_min > 0

    def test_cross_market_gate_is_strict(self):
        """The checked-in config must require pass on all markets."""
        cfg = load_acceptance()
        assert cfg.require_pass_on_all_markets is True

    def test_fill_model_includes_nq_es_mnq_mes(self):
        cfg = load_acceptance()
        comm = cfg.fill_model.commission_per_rt
        for sym in ("NQ", "ES", "MNQ", "MES"):
            assert sym in comm, f"Missing {sym} commission"

    def test_commit_hash_is_nullable(self):
        """commit_hash_when_locked starts null; sweep orchestrator stamps it."""
        cfg = load_acceptance()
        assert cfg.commit_hash_when_locked is None or isinstance(
            cfg.commit_hash_when_locked, str
        )


class TestValidation:
    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_acceptance(tmp_path / "nonexistent.yml")

    def test_missing_top_key_raises(self, tmp_path):
        bad = tmp_path / "bad.yml"
        bad.write_text("version: 1\n")  # missing everything else
        with pytest.raises(ValueError, match="missing required keys"):
            load_acceptance(bad)

    def test_invalid_pbo_max_raises(self, tmp_path):
        """pbo_max out of [0, 1] must be caught."""
        valid = load_acceptance()
        raw = dict(valid.raw)  # shallow copy
        raw["thresholds"] = dict(raw["thresholds"])
        raw["thresholds"]["pbo_max"] = 1.5
        bad = tmp_path / "bad_pbo.yml"
        bad.write_text(yaml.dump(raw))
        with pytest.raises(ValueError, match="pbo_max"):
            load_acceptance(bad)

    def test_invalid_max_drawdown_raises(self, tmp_path):
        valid = load_acceptance()
        raw = dict(valid.raw)
        raw["thresholds"] = dict(raw["thresholds"])
        raw["thresholds"]["max_drawdown_pct"] = 0  # must be > 0
        bad = tmp_path / "bad_dd.yml"
        bad.write_text(yaml.dump(raw))
        with pytest.raises(ValueError, match="max_drawdown_pct"):
            load_acceptance(bad)

    def test_negative_profit_factor_min_raises(self, tmp_path):
        valid = load_acceptance()
        raw = dict(valid.raw)
        raw["thresholds"] = dict(raw["thresholds"])
        raw["thresholds"]["profit_factor_min"] = -0.5
        bad = tmp_path / "bad_pf.yml"
        bad.write_text(yaml.dump(raw))
        with pytest.raises(ValueError, match="profit_factor_min"):
            load_acceptance(bad)


class TestSweepMethodology:
    def test_cpcv_settings_reasonable(self):
        cfg = load_acceptance()
        s = cfg.sweep
        # 6-groups / 2-test = 15 CPCV paths per Lopez de Prado floor
        assert s.cpcv_n_groups >= 6
        assert s.cpcv_k_test_groups >= 2
        assert s.cpcv_k_test_groups < s.cpcv_n_groups
        # Embargo ≥ 2x typical trade duration for 1m RTH futures
        assert s.embargo_bars >= 60
        # Optuna config valid
        assert s.optuna_trials_per_fold > 0
        assert s.optuna_sampler in {"TPE", "Random", "CmaEs"}
