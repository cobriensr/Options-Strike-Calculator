"""Unit tests for scripts/upload-fulltape-to-r2.py.

Run:

    ml/.venv/Scripts/python -m pytest scripts/test_upload_fulltape_r2.py -q
"""

from __future__ import annotations

import importlib.util
import warnings
from pathlib import Path
from typing import Any

import pytest
import urllib3
from botocore.exceptions import ClientError

SCRIPT = Path(__file__).resolve().parent / "upload-fulltape-to-r2.py"


def _load_module() -> Any:
    # The filename has hyphens, so it can't be imported by name.
    spec = importlib.util.spec_from_file_location("upload_fulltape_to_r2", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeClient:
    """Stands in for the boto3 S3 client; records every upload_file call."""

    def __init__(self, behaviours: dict[str, Exception | None] | None = None) -> None:
        self.behaviours = behaviours or {}
        self.uploads: list[dict[str, Any]] = []

    def list_objects_v2(self, **_kwargs: Any) -> dict[str, Any]:
        return {"IsTruncated": False}

    def upload_file(self, **kwargs: Any) -> None:
        self.uploads.append(kwargs)
        outcome = self.behaviours.get(Path(kwargs["Filename"]).name)
        if isinstance(outcome, urllib3.exceptions.InsecureRequestWarning):
            warnings.warn(outcome, stacklevel=2)
        elif outcome is not None:
            raise outcome


@pytest.fixture
def run_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Return (main, files, client): two local files ready to upload."""
    module = _load_module()
    files = [tmp_path / f"2026-10-0{n}-fulltape.parquet" for n in (1, 2)]
    for f in files:
        f.write_bytes(b"parquet")
    client = FakeClient()
    monkeypatch.setattr(module, "load_env_local", lambda: None)
    monkeypatch.setattr(module, "make_client", lambda: client)
    monkeypatch.setenv("R2_BUCKET_FULLTAPE", "test-bucket")
    monkeypatch.setenv("INPUT_DIR", str(tmp_path))
    monkeypatch.setattr("sys.argv", ["upload-fulltape-to-r2.py"])
    return module.main, files, client


def test_upload_passes_a_serial_transfer_config(run_main) -> None:
    main, files, client = run_main

    assert main() == 0

    assert [Path(u["Filename"]).name for u in client.uploads] == [f.name for f in files]
    for upload in client.uploads:
        assert upload["Config"].use_threads is False


def test_unverified_tls_aborts_the_run_without_touching_later_files(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.behaviours[files[0].name] = urllib3.exceptions.InsecureRequestWarning("x")

    code = main()

    assert code != 0
    assert [Path(u["Filename"]).name for u in client.uploads] == [files[0].name]
    err = capsys.readouterr().err
    assert files[0].name in err
    assert "TLS verification was skipped" in err


def test_client_error_is_recorded_and_the_run_continues(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.behaviours[files[0].name] = ClientError(
        {"Error": {"Code": "SlowDown", "Message": "throttled"}}, "PutObject"
    )

    code = main()

    assert code == 3
    assert [Path(u["Filename"]).name for u in client.uploads] == [f.name for f in files]
    err = capsys.readouterr().err
    assert "SlowDown" in err
    assert "TLS verification" not in err
