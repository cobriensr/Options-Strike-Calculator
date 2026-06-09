import exit_engine.config as cfg


def test_mode_literals_match_source():
    assert cfg.MODE_INTRADAY == "A_intraday_0DTE"
    assert cfg.MODE_MULTIDAY == "B_multi_day_DTE1_3"
    assert set(cfg.IN_UNIVERSE_MODES) == {cfg.MODE_INTRADAY, cfg.MODE_MULTIDAY}


def test_theta_default_is_forward_from_here():
    # θ = +15% forward move on the CURRENT mark (not pp-from-entry)
    assert cfg.THETA_FORWARD_DEFAULT == 0.15


def test_parquet_dir_points_at_full_tape():
    assert cfg.PARQUET_DIR.name == "Bot-Eod-parquet"


def test_walkforward_and_session_constants():
    assert cfg.N_TRAIN_DAYS == 20
    assert cfg.TEST_BLOCK_DAYS == 5
    assert cfg.EOD_CT_HOUR == 15
    assert cfg.SESSION_MINUTES == 390
