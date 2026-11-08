"""The two stores the post-landing steps work against: Neon and the R2 tape lake.

Logs and errors carry class names only, never an exception's text: a psycopg2 message
can carry the Neon host (main.py states the rule). `connect_db` logs nothing itself,
and its retry lines name the exception class alone.
"""

from __future__ import annotations

import re
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

from _pipeline_retry import connect_with_retry
from _tape_reader import TapeReader

from config import Settings
from constants import DB_CONNECT_TIMEOUT_SECONDS, DB_STATEMENT_TIMEOUT_MS

if TYPE_CHECKING:
    from psycopg2.extensions import connection

# "-pooler" ending the first host label of a postgres URL, a label that runs to the first
# ".", ":", "/", "?" or "#". The user-info group is possessive (`?+`): once an "@" has
# closed it the match never retries without it, so a user name ending in "-pooler" is not
# taken for a host label.
_POOLED_FIRST_LABEL = re.compile(
    r"^(postgres(?:ql)?://(?:[^/?#]*@)?+[^.:/?#]*?)-pooler(?=[.:/?#]|$)", re.IGNORECASE
)


def direct_dsn(url: str) -> str:
    """The URL with `-pooler` removed from the end of its first host label.

    Neon's pooler rejects the startup `options` a statement timeout needs, and its
    direct host differs only by that suffix (same credentials). Every other byte is
    kept, so a `-pooler` anywhere else, and any character in the password, survive. It
    is a substitution on the raw string: a urlsplit round trip raises on brackets (with
    the host in its message), drops tabs and drops an empty trailing `?`.
    """
    return _POOLED_FIRST_LABEL.sub(r"\1", url, count=1)


@contextmanager
def connect_db(settings: Settings) -> Iterator[connection]:
    """A direct, autocommit Neon connection that closes on exit, exceptions included.

    A failed connect propagates unchanged once the retries run out: no log line here
    holds its text.
    """
    conn = connect_with_retry(
        direct_dsn(settings.database_url.get_secret_value()),
        error_detail=False,
        connect_timeout=DB_CONNECT_TIMEOUT_SECONDS,
        application_name="nightly",
        options=f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}",
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )
    try:
        conn.autocommit = True
        yield conn
    finally:
        conn.close()


def open_reader(settings: Settings, cache_dir: Path) -> TapeReader:
    """A tape reader over an empty `cache_dir`, which is created if it is missing.

    The directory belongs to this reader alone (its partial-file names are fixed per
    day), so whatever a run left in it is removed first.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    for entry in cache_dir.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    return TapeReader(
        endpoint_url=settings.r2_endpoint_url,
        access_key_id=settings.r2_access_key_id.get_secret_value(),
        secret_access_key=settings.r2_secret_access_key.get_secret_value(),
        bucket=settings.r2_bucket_fulltape,
        cache_dir=cache_dir,
    )
