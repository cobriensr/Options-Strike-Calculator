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
    """Stands in for the boto3 S3 client; records uploads, heads and deletes."""

    def __init__(self, behaviours: dict[str, Exception | None] | None = None) -> None:
        self.behaviours = behaviours or {}
        self.list_error: Exception | None = None
        self.uploads: list[dict[str, Any]] = []
        # Key -> ContentLength that R2 reports for it.
        self.objects: dict[str, int] = {}
        # File name -> size R2 stores instead of the local size.
        self.stored_sizes: dict[str, int] = {}
        # File names whose upload returns but never shows up in the bucket.
        self.lost: set[str] = set()
        self.head_errors: dict[str, Exception] = {}
        self.delete_error: Exception | None = None
        self.heads: list[str] = []
        self.deleted: list[str] = []

    def list_objects_v2(self, **_kwargs: Any) -> dict[str, Any]:
        if self.list_error is not None:
            raise self.list_error
        return {"IsTruncated": False}

    def upload_file(self, **kwargs: Any) -> None:
        self.uploads.append(kwargs)
        path = Path(kwargs["Filename"])
        outcome = self.behaviours.get(path.name)
        if outcome is not None:
            raise outcome
        if path.name not in self.lost:
            size = self.stored_sizes.get(path.name, path.stat().st_size)
            self.objects[kwargs["Key"]] = size

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.heads.append(Key)
        if Key in self.head_errors:
            raise self.head_errors[Key]
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {"ContentLength": self.objects[Key]}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        if self.delete_error is not None:
            raise self.delete_error
        self.deleted.append(Key)
        self.objects.pop(Key, None)


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


def _key(path: Path) -> str:
    return f"fulltape/{path.name}"


def test_each_upload_is_head_checked_after_it_lands(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main

    assert main() == 0

    assert client.heads == [_key(f) for f in files]
    assert client.deleted == []
    assert "Upload complete: 2/2 files" in capsys.readouterr().out


def test_size_mismatch_fails_the_day_deletes_the_key_and_keeps_going(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.stored_sizes[files[0].name] = 3

    code = main()

    assert code == 3
    # The unverified key is removed so the nightly planner never counts the day as landed.
    assert client.deleted == [_key(files[0])]
    assert _key(files[0]) not in client.objects
    assert client.heads == [_key(f) for f in files]
    out, err = capsys.readouterr()
    assert f"{_key(files[0])}: uploaded 7 bytes but R2 reports 3" in err
    assert "Upload complete: 1/2 files" in out


def test_missing_object_after_upload_fails_the_day(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.lost.add(files[0].name)

    code = main()

    assert code == 3
    assert client.deleted == [_key(files[0])]
    out, err = capsys.readouterr()
    assert f"{_key(files[0])}: could not verify 7 uploaded bytes" in err
    assert "Not Found" in err
    assert "Upload complete: 1/2 files" in out


def test_failed_delete_after_a_mismatch_says_the_key_may_remain(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.stored_sizes[files[0].name] = 3
    client.delete_error = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "denied"}}, "DeleteObject"
    )

    code = main()

    assert code == 3
    assert client.deleted == []
    err = capsys.readouterr().err
    assert "could not delete it; the key may remain" in err
    assert "AccessDenied" in err


def test_unverified_tls_on_the_head_check_aborts_the_run(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.head_errors[_key(files[0])] = HTTPClientError(
        error=urllib3.exceptions.InsecureRequestWarning("x")
    )

    code = main()

    assert code == 4
    assert [Path(u["Filename"]).name for u in client.uploads] == [files[0].name]
    assert client.deleted == [_key(files[0])]
    err = capsys.readouterr().err
    assert files[0].name in err
    assert "TLS verification was skipped" in err


def test_unverified_tls_on_the_delete_after_a_mismatch_aborts_the_run(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.stored_sizes[files[0].name] = 3
    client.delete_error = HTTPClientError(
        error=urllib3.exceptions.InsecureRequestWarning("x")
    )

    code = main()

    assert code == 4
    assert [Path(u["Filename"]).name for u in client.uploads] == [files[0].name]
    err = capsys.readouterr().err
    assert "TLS verification was skipped" in err
    assert "could not delete it; the key may remain" in err


def test_unverified_tls_on_the_head_aborts_even_when_the_delete_fails_otherwise(
    run_main, capsys: pytest.CaptureFixture[str]
) -> None:
    main, files, client = run_main
    client.head_errors[_key(files[0])] = HTTPClientError(
        error=urllib3.exceptions.InsecureRequestWarning("x")
    )
    client.delete_error = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "denied"}}, "DeleteObject"
    )

    code = main()

    assert code == 4
    assert [Path(u["Filename"]).name for u in client.uploads] == [files[0].name]
    err = capsys.readouterr().err
    assert "TLS verification was skipped" in err
    assert "could not delete it; the key may remain" in err
    assert "AccessDenied" in err
