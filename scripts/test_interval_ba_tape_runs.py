"""scripts/interval_ba_tape_runs.py: the shared machinery's pieces with no database or tape.

The end-to-end tests of the tool, including the driver, the backup and the windows, are in
scripts/test_interval_ba_tape.py. Run from the repo root with ml/.venv:

    ml/.venv/Scripts/python -m pytest scripts/test_interval_ba_tape_runs.py -q
"""

from __future__ import annotations

from pathlib import Path

import interval_ba_tape_runs as runs
import psycopg2
import pytest

_DIRECT = "postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require"


@pytest.mark.parametrize(
    ("url", "direct"),
    [
        (
            "postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
            _DIRECT,
        ),
        (
            "postgres://u:p@ep-x-pooler.c-2.us-east-2.aws.neon.tech:5432/db",
            "postgres://u:p@ep-x.c-2.us-east-2.aws.neon.tech:5432/db",
        ),
        ("POSTGRESQL://u:p@EP-X-POOLER.neon.tech/db", "POSTGRESQL://u:p@EP-X.neon.tech/db"),
        # Already direct.
        (_DIRECT, _DIRECT),
        # A user name ending in -pooler is not a host label.
        (
            "postgresql://svc-pooler:p@ep-a.neon.tech/db",
            "postgresql://svc-pooler:p@ep-a.neon.tech/db",
        ),
        # -pooler past the host, and in the password, is kept.
        (
            "postgresql://u:p%40ss-pooler@ep-a-pooler.neon.tech/db-pooler?application_name=x-pooler",
            "postgresql://u:p%40ss-pooler@ep-a.neon.tech/db-pooler?application_name=x-pooler",
        ),
        # Only the first host label.
        (
            "postgresql://u:p@ep-a.region-pooler.neon.tech/db",
            "postgresql://u:p@ep-a.region-pooler.neon.tech/db",
        ),
    ],
)
def test_direct_dsn_drops_the_pooler_suffix_of_the_first_host_label_only(url: str, direct: str):
    assert runs.direct_dsn(url) == direct


def test_output_hides_the_pooled_and_the_direct_host(capsys: pytest.CaptureFixture[str]):
    out = runs.Output()
    out.hide(
        {
            "DATABASE_URL": "postgresql://user1:pw-secret@ep-cool-123-pooler.example.neon.tech/db",
            "R2_ENDPOINT_URL": "https://0123abcd.r2.cloudflarestorage.com",
        }
    )

    out.say(
        "pooled ep-cool-123-pooler.example.neon.tech, direct ep-cool-123.example.neon.tech,"
        " endpoint id ep-cool-123, account 0123abcd, password pw-secret, user user1"
    )

    text = capsys.readouterr().out
    for secret in ("ep-cool-123", "0123abcd", "pw-secret", "user1", "example.neon.tech"):
        assert secret not in text
    assert text.count("<redacted>") == 6


def test_code_blobs_cover_every_file_of_the_tool():
    blobs = runs.code_blobs()

    assert set(blobs["tool_blobs"]) == set(runs.TOOL_FILES)
    for name, path in runs.TOOL_FILES.items():
        assert path.is_file() and path.as_posix().endswith(name)
    # A new file of the tool beside these is hashed only once it is listed.
    beside = {path.name for path in Path(runs.__file__).parent.glob("interval_ba_tape*.py")}
    assert beside == {Path(name).name for name in runs.TOOL_FILES}
    assert blobs["module_blob"] == runs.blob_hash(runs.MODULE_PATH)


def test_blob_hash_is_gits(tmp_path: Path):
    path = tmp_path / "hello.txt"
    path.write_bytes(b"hello\n")

    # `git hash-object` of "hello\n".
    assert runs.blob_hash(path) == "ce013625030ba8dba906f756967f9e9ca394464a"


class _Conn:
    def __init__(self, *, rollback_fails: bool = False) -> None:
        self.rollbacks = 0
        self._fails = rollback_fails

    def rollback(self) -> None:
        self.rollbacks += 1
        if self._fails:
            raise psycopg2.InterfaceError("connection already closed")


def test_rolled_back_ends_the_transaction_and_never_hides_the_error_that_got_there():
    conn = _Conn()
    with runs.rolled_back(conn):
        pass
    assert conn.rollbacks == 1

    dead = _Conn(rollback_fails=True)
    with pytest.raises(ValueError, match="the first error"), runs.rolled_back(dead):
        raise ValueError("the first error")
    assert dead.rollbacks == 1
