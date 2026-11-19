"""The four Neon-only research reports read the ACTIVE lottery weights from the store.

feature_audit.py, daily_tracker.py, mine_outcome_patterns.py and
score_lineage_audit.py used to read the frozen `ml/output/*.json` weights (and
feature_audit a hard-coded 13/10). Phase 3's D8: each reads the active pointer
through `_report_weights.load_active_weights` instead, the one place that holds
the read-or-fail contract. What is pinned here:

* the cutoffs and weights each report uses are the active version's, not the
  seed's: feature_audit's feed cutoffs (qas), the tracker's bare cutoffs, and the
  boundaries and weights that mining's feature tuples and lineage's components
  are built from;
* each report's output names the active version (and, for feature_audit,
  `model_version` and `trained_through`);
* mining and lineage select `SINGLE_LEG_FILTER`, not `inferred_structure`;
* a weights read that fails (`WeightsInvalid`, no active pointer, a DB error)
  ends the report with `ActiveWeightsError` before any fire is read or any file
  is written, and never falls back to the frozen JSON. Run as a script (the way
  the nightly runs it) the last stderr line names that class and holds neither
  the DB error's text nor a chained traceback.

Neon is faked at the module boundary (`psycopg2.connect`, the pandas readers and
`_report_weights.load_pointer`, where all four reports' read lives); no test
reaches a database. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_report_weights.py
"""

from __future__ import annotations

import builtins
import copy
import csv
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from types import ModuleType
from typing import Any

import pandas as pd
import psycopg2
import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import _report_weights as report_weights  # noqa: E402
import daily_tracker  # noqa: E402
import feature_audit  # noqa: E402
import mine_outcome_patterns as mining  # noqa: E402
import score_lineage_audit as lineage  # noqa: E402
from lottery_scoring import SINGLE_LEG_FILTER  # noqa: E402  (_report_weights put ml/src on sys.path)
from lottery_weights import WeightsInvalid, validate_weights  # noqa: E402

SESSION = date(2026, 11, 4)
MONDAY = date(2026, 11, 2)
VERSION = 'refit-2026-11-01'

# An active weights object that is not the seed's, on every number the four
# reports read: the bare cutoffs (12/8), the feed cutoffs (16/12), the quintile
# boundaries and weights, and the ticker weights.
ACTIVE = {
    'schema_version': 1,
    'model_version': 'rescore-v9-test',
    'trained_through': '2026-10-30',
    'features': {
        'ticker_weights': {'AAA': 5, 'BBB': -3},
        'tod_weights': {'AM_open': 4, 'MID': 0, 'LUNCH': -2, 'PM': -4},
        'tod_weights_dow_overrides': {},
        'dte_weights': {'0': 3, '1': 1, '2': -1, '3': -2},
        'vol_oi_quintile_weights': [-2, -1, 0, 2, 4],
        'vol_oi_quintile_boundaries': [1.0, 2.0, 3.0, 4.0],
        'gamma_quintile_weights': [-1, 0, 1, 2, 3],
        'gamma_quintile_boundaries': [0.01, 0.02, 0.03, 0.04],
        'ask_pct_quintile_weights': [-1, 0, 1, 5, 2],
        'ask_pct_quintile_boundaries': [0.5, 0.6, 0.7, 0.8],
        'option_type_weights': {'C': 2, 'P': -2},
        'composite_bonuses': [],
    },
    'cutoffs': {'t1': 12, 't2': 8},
    'feed_cutoffs': {'tier1_min_score': 16, 'tier2_min_score': 12},
}


def _older_weights() -> dict[str, Any]:
    """What a report that kept reading another version would score with: every
    boundary out of reach of the test fires, the ticker weights swapped, the
    feed cutoffs the seed's 13/10."""
    old = copy.deepcopy(ACTIVE)
    features = old['features']
    features['ticker_weights'] = {'AAA': -3, 'BBB': 5}
    features['vol_oi_quintile_boundaries'] = [10.0, 20.0, 30.0, 40.0]
    features['gamma_quintile_boundaries'] = [0.1, 0.2, 0.3, 0.4]
    features['ask_pct_quintile_boundaries'] = [1.0, 2.0, 3.0, 4.0]
    old['cutoffs'] = {'t1': 18, 't2': 12}
    old['feed_cutoffs'] = {'tier1_min_score': 13, 'tier2_min_score': 10}
    return old


OLDER = _older_weights()

TRACKER_HEADER = (
    'date,run_at,n_fires_today,n_fires_total_window,days_in_window,'
    't1_today,t2_today,t3_today,flow_inv_n,flow_inv_mean_pct,flow_inv_sharpe,'
    't2plus_n,t2plus_mean_pct,t2plus_sharpe,modeB_n,modeB_mean_pct,modeB_sharpe,'
    'top1_ticker,top1_n,top1_rate,top2_ticker,top2_n,top2_rate,'
    'top3_ticker,top3_n,top3_rate'
)


def test_the_fixture_weights_are_real_store_weights() -> None:
    """The reports are tested with weights the store would accept, not a stub
    shaped to whatever the code happens to read."""
    validate_weights(ACTIVE)
    validate_weights(OLDER)


# ── fires, one frame per report ───────────────────────────────


def _fires(scores: list[float | None]) -> pd.DataFrame:
    """Fires shaped like the audit's SELECT, one per score: no round-trip
    deduct and inversion quintile 3 (no bonus), so qas is the score."""
    n = len(scores)
    return pd.DataFrame(
        {
            'ticker': ['AAA'] * n,
            'mode': ['A_intraday_0DTE'] * n,
            'tod': ['AM_open'] * n,
            'option_type': ['C'] * n,
            'dte': [0] * n,
            'score': scores,
            'alert_seq': [1.0] * n,
            'reload_tagged': [False] * n,
            'cheap_call_pm_tagged': [False] * n,
            'direction_gated': [False] * n,
            'date': [SESSION] * n,
            'round_trip_score_deduct': [0] * n,
            'inversion_quintile': [3] * n,
            'flow_inv': [10.0 * (i + 1) for i in range(n)],
        }
    )


def audit_frame() -> pd.DataFrame:
    # qas 17, 14, 11: T1, T2 and T3 under 16/12, and T1, T1, T2 under 13/10.
    return _fires([17.0, 14.0, 11.0])


def tracker_frame(scores: list[float]) -> pd.DataFrame:
    n = len(scores)
    return pd.DataFrame(
        {
            'date': [SESSION] * n,
            'mode': ['A_intraday_0DTE'] * n,
            'score': scores,
            'peak': [60.0] * n,
            'flow_inv': [5.0] * n,
            'ticker': ['AAA'] * n,
        }
    )


def mining_frame() -> pd.DataFrame:
    """A winner on AAA and a loser on BBB (the columns both FETCH_QUERYs select,
    plus `score` and `date` for lineage). Under ACTIVE's boundaries the winner's
    three quintile features land in bucket 3 and the loser's in bucket 0; under
    OLDER's they all land in 0."""
    return pd.DataFrame(
        {
            'id': [1, 2],
            'date': [MONDAY, MONDAY],
            'underlying_symbol': ['AAA', 'BBB'],
            'option_type': ['C', 'C'],
            'tod': ['AM_open', 'AM_open'],
            'dte': [0, 0],
            'trigger_vol_to_oi_window': [3.5, 0.5],
            'gamma_at_trigger': [0.035, 0.005],
            'trigger_ask_pct': [0.75, 0.45],
            'realized_flow_inversion_pct': [60.0, -60.0],
            'realized_eod_pct': [55.0, -70.0],
            'peak_ceiling_pct': [90.0, 5.0],
            'cum_ncp_at_fire': [2.0, 2.0],
            'cum_npp_at_fire': [1.0, 1.0],
            'score': [9, 1],
        }
    )


# ── the fakes, at the module boundary ─────────────────────────


class FakeCursor:
    def execute(self, _sql: str, _params: Any = None) -> None:
        pass

    def fetchone(self) -> tuple[date]:
        return (SESSION,)


class FakeConnection:
    def __init__(self) -> None:
        self.closed = False

    def cursor(self) -> FakeCursor:
        return FakeCursor()

    def close(self) -> None:
        self.closed = True


@dataclass(frozen=True)
class Kit:
    """What differs between the four reports, for the tests that run on all."""

    module: ModuleType
    tag: str  # the `[tag]` of the weights read's failure message
    output: str  # the file the run writes, under `out/`
    uses_out_dir: bool  # False: the tracker takes --csv, not --out-dir
    windowed: bool  # True: takes --as-of (mining, lineage)

    def args(self, tmp: Path) -> list[str]:
        out = tmp / 'out'
        if not self.uses_out_dir:
            return ['--csv', str(out / self.output)]
        as_of = ['--as-of', SESSION.isoformat()] if self.windowed else []
        return [*as_of, '--out-dir', str(out)]

    def written(self, tmp: Path) -> Path:
        return tmp / 'out' / self.output

    def frame(self) -> pd.DataFrame:
        return {
            feature_audit: audit_frame,
            daily_tracker: lambda: tracker_frame([12.0, 8.0, 7.0]),
            mining: mining_frame,
            lineage: mining_frame,
        }[self.module]()


AUDIT = Kit(feature_audit, 'audit', 'lottery-feature-audit-2026-11-04.md', True, False)
TRACKER = Kit(daily_tracker, 'track', 'lottery-tracking.csv', False, False)
MINING = Kit(mining, 'mining', 'lottery-composite-candidates-2026-11-04.md', True, True)
LINEAGE = Kit(lineage, 'lineage', 'lottery-score-lineage-2026-11-04.md', True, True)
KITS = [
    pytest.param(AUDIT, id='feature_audit'),
    pytest.param(TRACKER, id='daily_tracker'),
    pytest.param(MINING, id='mine_outcome_patterns'),
    pytest.param(LINEAGE, id='score_lineage_audit'),
]


class Harness:
    """One report's `main`, with Neon, the env file and the weights read faked."""

    def __init__(self, kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.kit = kit
        self.tmp = tmp_path
        self.version = VERSION
        self.weights: dict[str, Any] = ACTIVE
        self.failure: BaseException | None = None
        self.frame = kit.frame()
        self.events: list[str] = []
        self.pointer_conns: list[object] = []
        self.conns: list[FakeConnection] = []
        self.reads: list[tuple[str, Any]] = []
        monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
        monkeypatch.delenv('DATABASE_URL_UNPOOLED', raising=False)
        monkeypatch.setattr(kit.module, 'ENV_FILE', tmp_path / 'no-such.env')
        monkeypatch.setattr(psycopg2, 'connect', self._connect)
        # All four reports read through _report_weights.
        monkeypatch.setattr(report_weights, 'load_pointer', self._load_pointer)
        for reader in ('read_sql', 'read_sql_query'):
            monkeypatch.setattr(pd, reader, self._read)

    def _connect(self, *_args: object, **_kwargs: object) -> FakeConnection:
        self.events.append('connect')
        conn = FakeConnection()
        self.conns.append(conn)
        return conn

    def _load_pointer(self, conn: object, name: str) -> tuple[str, dict[str, Any]]:
        self.events.append(f'pointer:{name}')
        self.pointer_conns.append(conn)
        if self.failure is not None:
            raise self.failure
        return self.version, self.weights

    def _read(self, sql: str, _conn: object, params: Any = None, **_kwargs: object) -> pd.DataFrame:
        self.events.append('read')
        self.reads.append((sql, params))
        return self.frame.copy()

    def run(self) -> str:
        """Run the report; return what it wrote (its CSV or Markdown)."""
        self.kit.module.main(self.kit.args(self.tmp))
        return self.kit.written(self.tmp).read_text(encoding='utf-8')


# ── the shared reader ─────────────────────────────────────────


@pytest.mark.parametrize('kit', KITS)
def test_every_report_reads_the_active_pointer_first_on_its_own_connection(
    kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(kit, tmp_path, monkeypatch)

    harness.run()

    assert harness.events[:2] == ['connect', 'pointer:active']
    assert 'read' in harness.events[2:]
    assert harness.events.count('connect') == 1
    assert harness.pointer_conns == harness.conns


@pytest.mark.parametrize('kit', KITS)
def test_every_report_uses_the_shared_reader_and_keeps_no_copy(kit: Kit) -> None:
    module = kit.module
    assert module.load_active_weights is report_weights.load_active_weights
    source = Path(module.__file__).read_text(encoding='utf-8')
    assert 'load_pointer' not in source
    assert 'def load_weights' not in source
    assert not hasattr(module, 'load_weights')


@pytest.mark.parametrize('kit', KITS)
def test_no_report_reads_the_frozen_weights_json(kit: Kit) -> None:
    source = Path(kit.module.__file__).read_text(encoding='utf-8')

    assert 'lottery_score_weights.json' not in source
    for name in ('WEIGHTS_JSON', 'WEIGHTS_PATH', 'weights_path', 'TIER1_CUTOFF', 'TIER2_CUTOFF'):
        assert name not in source, name
        assert not hasattr(kit.module, name), name


# ── feature_audit ─────────────────────────────────────────────


def test_feature_audit_splits_tiers_with_the_active_feed_cutoffs() -> None:
    frame = audit_frame()

    active = feature_audit.add_feed_tiers(frame, report_weights.FeedCutoffs.from_weights(ACTIVE))
    seed = feature_audit.add_feed_tiers(frame, report_weights.FeedCutoffs.from_weights(OLDER))

    assert active['qas'].tolist() == [17.0, 14.0, 11.0]
    # 16/12: 17 is T1, 14 is T2 and 11 is T3 (13/10 would call 14 T1 and 11 T2).
    assert active['tier'].tolist() == ['T1', 'T2', 'T3']
    assert seed['tier'].tolist() == ['T1', 'T1', 'T2']
    assert active['tier_eligible'].tolist() == [True, True, True]
    assert not hasattr(feature_audit, 'TIER1_CUTOFF')
    assert not hasattr(feature_audit, 'TIER2_CUTOFF')


def test_feature_audit_tiers_the_fires_the_feed_forces_to_tier_3() -> None:
    frame = _fires([20.0, 20.0, 20.0, None])
    frame['direction_gated'] = [True, False, False, False]
    frame['inversion_quintile'] = [3, 1, 2, 3]

    tiered = feature_audit.add_feed_tiers(
        frame, report_weights.FeedCutoffs.from_weights(ACTIVE)
    )

    # Direction-gated, quintile 1, quintile 2 and a NULL score: qas 20 or not,
    # all tier 3 and out of the traded Tier 2+ population.
    assert tiered['tier'].tolist() == ['T3', 'T3', 'T3', 'T3']
    assert tiered['tier_eligible'].tolist() == [False, False, False, False]


def test_feature_audit_report_counts_tier_2_plus_with_the_active_cutoffs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(AUDIT, tmp_path, monkeypatch)

    report = harness.run()

    # Under 16/12 two of the three fires are Tier 2+; under 13/10 all three would be.
    match = re.search(r'^    Tier 2\+\s{2,}n=\s*([\d,]+)', report, re.MULTILINE)
    assert match is not None
    assert match.group(1) == '2'
    assert re.search(r'^    all fires\s+n=\s*3', report, re.MULTILINE)
    assert 'cutoffs t2=12/t1=16' in report


def test_feature_audit_header_names_the_active_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(AUDIT, tmp_path, monkeypatch)

    report = harness.run()

    regime = report.split('## Scoring regime', 1)[1].split('## Baselines', 1)[0]
    assert f'Active lottery weights: {VERSION}' in regime
    assert f'(feed cutoffs of version {VERSION})' in regime
    assert 'T1 = qas ≥ 16, T2 = qas ≥ 12' in regime
    assert re.search(r'model_version\s*: rescore-v9-test', regime)
    assert re.search(r'trained_through\s*: 2026-10-30', regime)
    assert report_weights.LOOK_AHEAD_NOTE in regime
    # What the frozen JSON's header carried and a store weights object has not.
    assert 'trained_at' not in regime
    assert 'train sample' not in regime
    assert 'qas>=13' not in regime


def test_feature_audit_selects_the_columns_the_feed_tier_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(AUDIT, tmp_path, monkeypatch)

    harness.run()

    (sql,) = [' '.join(s.split()) for s, _ in harness.reads]
    selected = sql.split(' FROM ')[0]
    for column in ('score', 'round_trip_score_deduct', 'direction_gated', 'inversion_quintile'):
        assert column in selected, column
    assert 'LEFT JOIN lottery_ticker_stats' in sql
    assert 'combined_score' not in sql  # the feed does not tier on it


# ── daily_tracker ─────────────────────────────────────────────


def test_tracker_classifies_with_the_active_bare_cutoffs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    harness = Harness(TRACKER, tmp_path, monkeypatch)

    harness.run()

    out = capsys.readouterr().out
    csv_path = harness.kit.written(tmp_path)
    with csv_path.open(newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    (row,) = rows
    # cutoffs 12/8 on scores 12, 8 and 7. The feed cutoffs (16/12) would give
    # T1=0, and the seed's bare 18/12 or a 10/6 JSON would too.
    assert (row['t1_today'], row['t2_today'], row['t3_today']) == ('1', '1', '1')
    assert row['n_fires_today'] == '3'
    assert VERSION in out
    assert csv_path.read_text(encoding='utf-8').splitlines()[0] == TRACKER_HEADER


def test_tracker_header_is_the_old_one() -> None:
    assert ','.join(daily_tracker.COLUMNS) == TRACKER_HEADER


def test_tracker_treats_a_null_score_as_tier_3(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(TRACKER, tmp_path, monkeypatch)
    harness.frame = tracker_frame([12.0, float('nan')])

    harness.run()

    with harness.kit.written(tmp_path).open(newline='', encoding='utf-8') as f:
        (row,) = list(csv.DictReader(f))
    assert (row['t1_today'], row['t2_today'], row['t3_today']) == ('1', '0', '1')


# ── mine_outcome_patterns and score_lineage_audit ─────────────


def test_mining_and_lineage_select_the_single_leg_population() -> None:
    for module in (mining, lineage):
        query = module.FETCH_QUERY
        assert SINGLE_LEG_FILTER == "anchor_leg_kind = 'single'"
        assert SINGLE_LEG_FILTER in query, module.__name__
        assert 'inferred_structure' not in query, module.__name__


@pytest.mark.parametrize('kit', [MINING, LINEAGE], ids=['mining', 'lineage'])
def test_mining_and_lineage_send_the_single_leg_query(
    kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(kit, tmp_path, monkeypatch)

    harness.run()

    ((sql, params),) = harness.reads
    assert sql == kit.module.FETCH_QUERY
    assert "AND anchor_leg_kind = 'single'" in sql
    assert 'inferred_structure' not in sql
    assert params == {'as_of': SESSION}


def test_mining_scores_features_with_the_active_boundaries() -> None:
    raw = mining_frame()
    raw['outcome_pct'] = raw['realized_flow_inversion_pct']

    active = mining.build_feature_tuples(raw, ACTIVE)
    older = mining.build_feature_tuples(raw, OLDER)

    columns = ['vol_oi_q', 'gamma_q', 'ask_pct_q']
    assert active[columns].values.tolist() == [['3', '3', '3'], ['0', '0', '0']]
    assert older[columns].values.tolist() == [['0', '0', '0'], ['0', '0', '0']]


def test_lineage_components_follow_the_active_weights() -> None:
    raw = mining_frame()
    raw['outcome_pct'] = raw['realized_flow_inversion_pct']
    raw['day_of_week'] = 0  # Monday

    def gaps(weights: dict[str, Any]) -> dict[str, float]:
        table, _ = lineage.run_attribution(raw, weights)
        return table.set_index('component')['gap'].to_dict()

    # The winner (AAA) minus the loser (BBB), component by component.
    assert gaps(ACTIVE) == {
        'ticker': 8.0,
        'vol_oi_q': 4.0,
        'gamma_q': 3.0,
        'ask_pct_q': 6.0,
        'tod': 0.0,
        'dte': 0.0,
        'option_type': 0.0,
    }
    assert gaps(OLDER) == {
        'ticker': -8.0,
        'vol_oi_q': 0.0,
        'gamma_q': 0.0,
        'ask_pct_q': 0.0,
        'tod': 0.0,
        'dte': 0.0,
        'option_type': 0.0,
    }


def test_mining_and_lineage_score_with_the_active_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`main` hands the store's weights, not another set, to the scorers."""
    seen: dict[str, Any] = {}
    real_tuples = mining.build_feature_tuples
    real_attribution = lineage.run_attribution

    def tuples(df: pd.DataFrame, weights: Any) -> pd.DataFrame:
        seen['mining'] = weights
        seen['tuples'] = real_tuples(df, weights)
        return seen['tuples']

    def attribution(df: pd.DataFrame, weights: Any) -> tuple[pd.DataFrame, pd.DataFrame]:
        seen['lineage'] = weights
        table, flagged = real_attribution(df, weights)
        seen['table'] = table
        return table, flagged

    monkeypatch.setattr(mining, 'build_feature_tuples', tuples)
    monkeypatch.setattr(lineage, 'run_attribution', attribution)

    Harness(MINING, tmp_path / 'mining', monkeypatch).run()
    Harness(LINEAGE, tmp_path / 'lineage', monkeypatch).run()

    assert seen['mining'] is ACTIVE
    assert seen['lineage'] is ACTIVE
    assert seen['tuples'][['vol_oi_q', 'gamma_q', 'ask_pct_q']].values.tolist() == [
        ['3', '3', '3'],
        ['0', '0', '0'],
    ]
    assert seen['table'].set_index('component').loc['ticker', 'gap'] == 8.0


@pytest.mark.parametrize('kit', [MINING, LINEAGE], ids=['mining', 'lineage'])
def test_mining_and_lineage_headers_name_the_active_weights(
    kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(kit, tmp_path, monkeypatch)

    report = harness.run()

    header = report.split('\n## ', 1)[0]
    assert f'Active lottery weights: {VERSION} (model_version rescore-v9-test)' in header
    assert 'aligned single-leg' in header
    assert 'non-structure' not in header


@pytest.mark.parametrize('kit', [MINING, LINEAGE], ids=['mining', 'lineage'])
def test_mining_and_lineage_close_the_connection(
    kit: Kit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(kit, tmp_path, monkeypatch)

    harness.run()

    assert [c.closed for c in harness.conns] == [True]


# ── a failed read ends the report ─────────────────────────────

FAILURES = [
    pytest.param(
        LookupError('lottery_score_pointers has no row named active'),
        id='no-active-pointer',
    ),
    pytest.param(WeightsInvalid('features.dte_weights', 'range'), id='invalid-weights'),
    pytest.param(
        psycopg2.OperationalError('host=db.example password=hunter2'), id='db-error'
    ),
]


@pytest.fixture
def json_opens(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every open of a weights JSON, by any route a script could take."""
    opened: list[str] = []
    real_open = builtins.open
    real_path_open = Path.open
    real_read_text = Path.read_text

    def note(path: object) -> None:
        if 'lottery_score_weights' in str(path):
            opened.append(str(path))

    def spy_open(file: Any, *args: Any, **kwargs: Any) -> Any:
        note(file)
        return real_open(file, *args, **kwargs)

    def spy_path_open(self: Path, *args: Any, **kwargs: Any) -> Any:
        note(self)
        return real_path_open(self, *args, **kwargs)

    def spy_read_text(self: Path, *args: Any, **kwargs: Any) -> str:
        note(self)
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(builtins, 'open', spy_open)
    monkeypatch.setattr(Path, 'open', spy_path_open)
    monkeypatch.setattr(Path, 'read_text', spy_read_text)
    return opened


@pytest.mark.parametrize('failure', FAILURES)
@pytest.mark.parametrize('kit', KITS)
def test_invalid_active_weights_fail_the_report_without_a_fallback(
    kit: Kit,
    failure: Exception,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    json_opens: list[str],
) -> None:
    harness = Harness(kit, tmp_path, monkeypatch)
    harness.failure = failure

    with pytest.raises(report_weights.ActiveWeightsError) as exc:
        harness.run()

    message = str(exc.value)
    assert message.startswith(f'[{kit.tag}] cannot read the active lottery weights (')
    assert message.endswith('no report written')
    assert type(failure).__name__ in message
    assert 'hunter2' not in message  # a DB error's text can hold the DSN
    # The read was the first thing asked of the database after the connection...
    assert harness.events == ['connect', 'pointer:active']
    # ...nothing was written, anywhere, and the frozen JSON was never opened.
    assert list(tmp_path.rglob('*')) == []
    assert json_opens == []


# Runs a report script as `__main__` the way the nightly does (a subprocess), with
# the connection and the weights read faked inside it: the read fails with a DB
# error whose text holds a password.
FAILING_READ_DRIVER = """
import runpy, sys
sys.path.insert(0, sys.argv[1])
import psycopg2
import _report_weights


class _Conn:
    def close(self):
        pass


psycopg2.connect = lambda *_a, **_k: _Conn()


def _fail(_conn, _name):
    raise psycopg2.OperationalError('host=db.example password=hunter2')


_report_weights.load_pointer = _fail
script = sys.argv[2]
sys.argv = [script, *sys.argv[3:]]
runpy.run_path(script, run_name='__main__')
"""


@pytest.mark.parametrize(
    ('script', 'tag'),
    [
        pytest.param('feature_audit.py', 'audit', id='feature_audit'),
        pytest.param('daily_tracker.py', 'track', id='daily_tracker'),
        pytest.param('mine_outcome_patterns.py', 'mining', id='mine_outcome_patterns'),
        pytest.param('score_lineage_audit.py', 'lineage', id='score_lineage_audit'),
    ],
)
def test_a_failed_weights_read_ends_the_script_with_a_named_error_and_no_dsn(
    script: str, tag: str, tmp_path: Path
) -> None:
    """The nightly runs these as subprocesses and reports the exception class
    from the traceback's last line: it must name ActiveWeightsError, and the
    DB error behind it (and its text) must not be in the traceback."""
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
    env['PYTHONUTF8'] = '1'
    env['DATABASE_URL'] = 'postgresql://test/none'
    env['DATABASE_URL_UNPOOLED'] = 'postgresql://test/none'
    out = tmp_path / 'out'
    destination = (
        ['--csv', str(out / 'lottery-tracking.csv')]
        if script == 'daily_tracker.py'
        else ['--out-dir', str(out)]
    )
    as_of = ['--as-of', SESSION.isoformat()] if script in (
        'mine_outcome_patterns.py',
        'score_lineage_audit.py',
    ) else []

    done = subprocess.run(
        [
            sys.executable,
            '-c',
            FAILING_READ_DRIVER,
            str(SCRIPTS),
            str(SCRIPTS / script),
            *as_of,
            *destination,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        timeout=120,
        check=False,
    )

    assert done.returncode == 1, done.stderr
    last_line = done.stderr.rstrip().splitlines()[-1]
    assert last_line.startswith(
        f'_report_weights.ActiveWeightsError: [{tag}] cannot read the active lottery weights '
        '(OperationalError); no report written'
    )
    for text in ('hunter2', 'During handling of the above exception', 'direct cause'):
        assert text not in done.stderr, text
    assert not out.exists()
