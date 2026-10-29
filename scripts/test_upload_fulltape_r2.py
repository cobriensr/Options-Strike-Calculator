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
from boto3.exceptions import S3UploadFailedError
from botocore.exceptions import ClientError, HTTPClientError

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
        self.list_error: Exception | None = None
        self.uploads: list[dict[str, Any]] = []

    def list_objects_v2(self, **_kwargs: Any) -> dict[str, Any]:
        if self.list_error is not None:
            raise self.list_error
        return {"IsTruncated": False}

    def upload_file(self, **kwargs: Any) -> None:
        self.uploads.append(kwargs)
        outcome = self.behaviours.get(Path(kwargs["Filename"]).name)
        if outcome is not None:
            raise outcome


@pytest.fixture
def run_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Return (main, files, client): two local files ready to upload."""
    # main() installs a global warnings filter; restore it afterwards.
    with warnings.catch_warnings():
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
        yield module.main, files, client


def test_main_turns_insecure_request_warnings_into_errors(run_main) -> None:
    main, files, client = run_main

    assert main() == 0
    # The first matching filter wins, so check the one main() installed.
    category = urllib3.exceptions.InsecureRequestWarning
    first = next(f for f in warnings.filters if f[2] is category)
    assert first[0] == "error"

    assert [Path(u["Filename"]).name for u in client.uploads] == [f.name for f in files]


def test_unverified_tls_aborts_the_run_without_touching_later_files(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.behaviours[files[0].name] = HTTPClientError(
        error=urllib3.exceptions.InsecureRequestWarning("x")
    )

    code = main()

    assert code == 4
    assert [Path(u["Filename"]).name for u in client.uploads] == [files[0].name]
    err = capsys.readouterr().err
    assert files[0].name in err
    assert "TLS verification was skipped" in err


def test_other_transport_errors_are_recorded_and_the_run_continues(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.behaviours[files[0].name] = HTTPClientError(error=OSError("reset"))

    code = main()

    assert code == 3
    assert [Path(u["Filename"]).name for u in client.uploads] == [f.name for f in files]
    err = capsys.readouterr().err
    assert "reset" in err
    assert "TLS verification" not in err


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


def test_s3_upload_failed_error_is_recorded_and_the_run_continues(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.behaviours[files[0].name] = S3UploadFailedError(
        f"Failed to upload {files[0].name}: AccessDenied"
    )

    code = main()

    assert code == 3
    assert [Path(u["Filename"]).name for u in client.uploads] == [f.name for f in files]
    assert "AccessDenied" in capsys.readouterr().err


def test_unverified_tls_while_listing_aborts_before_any_upload(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, _files, client = run_main
    client.list_error = HTTPClientError(
        error=urllib3.exceptions.InsecureRequestWarning("x")
    )

    code = main()

    assert code == 4
    assert client.uploads == []
    err = capsys.readouterr().err
    assert "Listing the remote bucket" in err
    assert "TLS verification was skipped" in err
