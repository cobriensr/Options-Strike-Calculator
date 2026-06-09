"""Tests for takeit_server internals — bundle loading + SHAP explainer cache.

Complements test_takeit_routes.py (which exercises HealthHandler dispatch).
This file targets the bug pair caught on 2026-05-21:

  1. `_fetch_blob` was hitting Vercel private Blob URLs without the
     `Authorization: Bearer <BLOB_READ_WRITE_TOKEN>` header, producing
     recurring `HTTPError 403` and forcing repeated cold-start retries.

  2. `shap.TreeExplainer(model)` was rebuilt on every request inside
     `_explain_rows`, blowing the Railway edge-proxy timeout under
     500-row batches and surfacing as `takeit.shap_fill.sidecar_non_2xx`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import takeit_server  # noqa: E402


# ── _fetch_blob ────────────────────────────────────────────────────────


def test_fetch_blob_sends_authorization_bearer_header() -> None:
    """Regression for the 403-on-cold-start bug: private Blob URLs require
    `Authorization: Bearer <token>`. Earlier code passed no header and
    relied on the URL being public."""
    captured: dict[str, object] = {}

    class _FakeResp:
        def read(self) -> bytes:
            return b'{"ok": true}'

        def __enter__(self) -> "_FakeResp":
            return self

        def __exit__(self, *_a: object) -> None:
            # No-op: the fake response holds no resources to release.
            return None

    def _capture_urlopen(req: object, **_kwargs: object) -> _FakeResp:
        captured["headers"] = dict(req.headers)  # type: ignore[attr-defined]
        captured["url"] = req.full_url  # type: ignore[attr-defined]
        return _FakeResp()

    with patch("urllib.request.urlopen", side_effect=_capture_urlopen):
        out = takeit_server._fetch_blob(
            "https://tg5dfikouypvrgdk.private.blob.vercel-storage.com/takeit/latest.json",
            "vercel_blob_rw_test_token_xxx",
        )

    assert out == b'{"ok": true}'
    # urllib normalizes header names to capitalized form.
    assert (
        captured["headers"].get("Authorization")  # type: ignore[union-attr]
        == "Bearer vercel_blob_rw_test_token_xxx"
    )


# ── _load_bundle caches the TreeExplainer ─────────────────────────────


def test_load_bundle_attaches_tree_explainer_once() -> None:
    """Regression for the per-request TreeExplainer rebuild: the bundle
    must be cached with `bundle['explainer']` populated on first load,
    and the SHAP module's TreeExplainer must be constructed exactly once
    per alert_type."""
    fake_model = object()
    fake_bundle = {"feature_cols": ["a", "b"], "model": fake_model}

    fake_shap = MagicMock()
    fake_explainer = MagicMock(name="TreeExplainer-instance")
    fake_shap.TreeExplainer.return_value = fake_explainer

    # Reset module-level cache so test order doesn't matter.
    takeit_server._bundle_cache.clear()

    with (
        patch.dict("os.environ", {"BLOB_READ_WRITE_TOKEN": "tok"}, clear=False),
        patch.object(
            takeit_server,
            "_list_blob",
            side_effect=[
                [{"pathname": takeit_server.MANIFEST_PATH, "url": "u1"}],
                [{"pathname": "takeit/lottery_joblib_v1.joblib", "url": "u2"}],
            ],
        ),
        patch.object(
            takeit_server,
            "_fetch_blob",
            side_effect=[
                b'{"lottery": "takeit/lottery_classifier_v1.json"}',
                b"<joblib bytes>",
            ],
        ),
        patch.dict(sys.modules, {"joblib": MagicMock(load=lambda _f: fake_bundle)}),
        patch.dict(sys.modules, {"shap": fake_shap}),
    ):
        b1 = takeit_server._load_bundle("lottery")
        b2 = takeit_server._load_bundle("lottery")

    assert b1 is b2  # cached
    assert b1["explainer"] is fake_explainer
    # Constructed exactly once across two _load_bundle calls.
    assert fake_shap.TreeExplainer.call_count == 1
    fake_shap.TreeExplainer.assert_called_once_with(fake_model)


def test_explain_rows_uses_cached_explainer_not_module_global() -> None:
    """`_explain_rows` must read the explainer off the cached bundle and
    must NOT call shap.TreeExplainer again — that was the per-request
    rebuild blowing the Railway proxy timeout."""
    import numpy as np

    fake_explainer = MagicMock(name="cached-explainer")
    fake_explainer.shap_values.return_value = np.array([[0.4, -0.2]])
    cached_bundle = {
        "feature_cols": ["f1", "f2"],
        "model": object(),
        "explainer": fake_explainer,
    }

    fake_shap = MagicMock()

    # Patch `_load_bundle` directly — we want to assert the contract that
    # `_explain_rows` consumes a pre-built explainer off the bundle, not
    # exercise the bundle loader (covered by the test above).
    with (
        patch.object(takeit_server, "_load_bundle", return_value=cached_bundle),
        patch.dict(sys.modules, {"shap": fake_shap}),
    ):
        out = takeit_server._explain_rows(
            "lottery", [{"alert_id": 7, "features": {"f1": 1.0, "f2": 0.0}}]
        )

    # Cached explainer used, no new construction.
    fake_explainer.shap_values.assert_called_once()
    fake_shap.TreeExplainer.assert_not_called()
    assert out[0]["alert_id"] == 7


# ── _list_blob ─────────────────────────────────────────────────────────


def test_list_blob_sends_bearer_and_returns_blobs_array() -> None:
    """`_list_blob` calls the Vercel Blob list API with the prefix + limit
    query params and the bearer token, and returns the `blobs` array."""
    captured: dict[str, object] = {}

    class _FakeResp:
        def read(self) -> bytes:
            return json.dumps(
                {"blobs": [{"pathname": "takeit/latest.json", "url": "u1"}]}
            ).encode()

        def __enter__(self) -> "_FakeResp":
            return self

        def __exit__(self, *_a: object) -> None:
            return None

    def _capture_urlopen(req: object, **_kwargs: object) -> _FakeResp:
        captured["headers"] = dict(req.headers)  # type: ignore[attr-defined]
        captured["url"] = req.full_url  # type: ignore[attr-defined]
        return _FakeResp()

    with patch("urllib.request.urlopen", side_effect=_capture_urlopen):
        blobs = takeit_server._list_blob("takeit/latest.json", "tok-123")

    assert blobs == [{"pathname": "takeit/latest.json", "url": "u1"}]
    assert captured["headers"].get("Authorization") == "Bearer tok-123"  # type: ignore[union-attr]
    url = captured["url"]
    assert isinstance(url, str)
    assert url.startswith("https://blob.vercel-storage.com/?")
    assert "prefix=takeit" in url
    assert "limit=100" in url


# ── _load_bundle error paths ───────────────────────────────────────────


def test_load_bundle_raises_when_manifest_entry_missing() -> None:
    """If the manifest blob list contains no entry whose pathname matches
    MANIFEST_PATH, `_load_bundle` raises RuntimeError (line 93)."""
    takeit_server._bundle_cache.clear()
    with (
        patch.dict("os.environ", {"BLOB_READ_WRITE_TOKEN": "tok"}, clear=False),
        patch.object(
            takeit_server,
            "_list_blob",
            return_value=[{"pathname": "takeit/something-else.json", "url": "x"}],
        ),
        patch.dict(sys.modules, {"joblib": MagicMock()}),
    ):
        with pytest.raises(RuntimeError, match="manifest not found"):
            takeit_server._load_bundle("lottery")


def test_load_bundle_raises_when_joblib_entry_missing() -> None:
    """If the joblib blob list has no matching pathname, `_load_bundle`
    raises a RuntimeError describing the missing bundle (line 107)."""
    takeit_server._bundle_cache.clear()
    with (
        patch.dict("os.environ", {"BLOB_READ_WRITE_TOKEN": "tok"}, clear=False),
        patch.object(
            takeit_server,
            "_list_blob",
            side_effect=[
                [{"pathname": takeit_server.MANIFEST_PATH, "url": "u1"}],
                [{"pathname": "takeit/unrelated.joblib", "url": "u2"}],
            ],
        ),
        patch.object(
            takeit_server,
            "_fetch_blob",
            return_value=b'{"lottery": "takeit/lottery_classifier_v1.json"}',
        ),
        patch.dict(sys.modules, {"joblib": MagicMock()}),
    ):
        with pytest.raises(RuntimeError, match="joblib bundle missing"):
            takeit_server._load_bundle("lottery")


# ── _json_safe ─────────────────────────────────────────────────────────


def test_json_safe_passes_through_none() -> None:
    assert takeit_server._json_safe(None) is None


def test_json_safe_coerces_non_finite_floats_to_none() -> None:
    assert takeit_server._json_safe(float("nan")) is None
    assert takeit_server._json_safe(float("inf")) is None
    assert takeit_server._json_safe(float("-inf")) is None


def test_json_safe_returns_finite_values_unchanged() -> None:
    assert takeit_server._json_safe(3.5) == pytest.approx(3.5)
    assert takeit_server._json_safe(0) == 0


# ── is_enabled ─────────────────────────────────────────────────────────


def test_is_enabled_false_when_flag_unset() -> None:
    """Default-off: without TAKEIT_SERVER_ENABLED=1 the gate is closed and
    the dep probe is never attempted."""
    with patch.dict("os.environ", {"TAKEIT_SERVER_ENABLED": "0"}, clear=False):
        assert takeit_server.is_enabled() is False


def test_is_enabled_false_when_dep_missing() -> None:
    """A missing ML dep makes the import probe raise ImportError → gate
    returns False and logs a warning naming the dep."""
    real_import = __import__

    def _fake_import(name: str, *args: object, **kwargs: object):
        if name == "shap":
            raise ImportError("No module named 'shap'", name="shap")
        return real_import(name, *args, **kwargs)

    with (
        patch.dict(
            "os.environ",
            {
                "TAKEIT_SERVER_ENABLED": "1",
                "TAKEIT_SIDECAR_SHARED_SECRET": "s",
            },
            clear=False,
        ),
        patch("builtins.__import__", side_effect=_fake_import),
    ):
        assert takeit_server.is_enabled() is False


def test_is_enabled_false_when_shared_secret_missing() -> None:
    """Deps present but TAKEIT_SIDECAR_SHARED_SECRET empty → gate closed."""
    with (
        patch.dict(
            "os.environ",
            {"TAKEIT_SERVER_ENABLED": "1", "TAKEIT_SIDECAR_SHARED_SECRET": ""},
            clear=False,
        ),
        patch.dict(
            sys.modules,
            {
                "joblib": MagicMock(),
                "numpy": MagicMock(),
                "pandas": MagicMock(),
                "shap": MagicMock(),
                "xgboost": MagicMock(),
            },
        ),
    ):
        assert takeit_server.is_enabled() is False


def test_is_enabled_true_when_flag_deps_and_secret_present() -> None:
    """All three conditions met → gate open."""
    with (
        patch.dict(
            "os.environ",
            {"TAKEIT_SERVER_ENABLED": "1", "TAKEIT_SIDECAR_SHARED_SECRET": "s"},
            clear=False,
        ),
        patch.dict(
            sys.modules,
            {
                "joblib": MagicMock(),
                "numpy": MagicMock(),
                "pandas": MagicMock(),
                "shap": MagicMock(),
                "xgboost": MagicMock(),
            },
        ),
    ):
        assert takeit_server.is_enabled() is True


# ── handle_explain_payload ─────────────────────────────────────────────


def _bearer(secret: str) -> str:
    return f"Bearer {secret}"


def test_handle_explain_503_when_secret_not_configured() -> None:
    with patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": ""}, clear=False):
        status, body = takeit_server.handle_explain_payload(b"{}", _bearer("x"))
    assert status == 503
    assert "TAKEIT_SIDECAR_SHARED_SECRET" in body["error"]


def test_handle_explain_401_on_bad_bearer() -> None:
    with patch.dict(
        "os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "right"}, clear=False
    ):
        status, body = takeit_server.handle_explain_payload(b"{}", _bearer("wrong"))
    assert status == 401
    assert body == {"error": "unauthorized"}


def test_handle_explain_400_on_invalid_json() -> None:
    with patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False):
        status, body = takeit_server.handle_explain_payload(b"not json{", _bearer("s"))
    assert status == 400
    assert "valid JSON" in body["error"]


def test_handle_explain_400_on_bad_alert_type() -> None:
    with patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False):
        status, body = takeit_server.handle_explain_payload(
            json.dumps({"alert_type": "bogus", "rows": []}).encode(), _bearer("s")
        )
    assert status == 400
    assert "lottery|silentboom" in body["error"]


def test_handle_explain_400_when_rows_not_a_list() -> None:
    with patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False):
        status, body = takeit_server.handle_explain_payload(
            json.dumps({"alert_type": "lottery", "rows": {"a": 1}}).encode(),
            _bearer("s"),
        )
    assert status == 400
    assert "rows must be a list" in body["error"]


def test_handle_explain_200_empty_results_when_no_rows() -> None:
    """An empty/absent rows list short-circuits to 200 with empty results,
    never invoking the (expensive) SHAP path."""
    with (
        patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False),
        patch.object(takeit_server, "_explain_rows") as mock_explain,
    ):
        status, body = takeit_server.handle_explain_payload(
            json.dumps({"alert_type": "silentboom", "rows": []}).encode(),
            _bearer("s"),
        )
    assert status == 200
    assert body == {"results": []}
    mock_explain.assert_not_called()


def test_handle_explain_200_forwards_explain_results() -> None:
    """Happy path: valid auth + rows → 200 wrapping `_explain_rows` output."""
    rows = [{"alert_id": 9, "features": {"f1": 1.0}}]
    explained = [{"alert_id": 9, "top_positive": [], "top_negative": []}]
    with (
        patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False),
        patch.object(takeit_server, "_explain_rows", return_value=explained) as m,
    ):
        status, body = takeit_server.handle_explain_payload(
            json.dumps({"alert_type": "lottery", "rows": rows}).encode(),
            _bearer("s"),
        )
    assert status == 200
    assert body == {"results": explained}
    m.assert_called_once_with("lottery", rows)


def test_handle_explain_503_on_runtime_error() -> None:
    """A RuntimeError from `_explain_rows` (bundle/model unreachable) maps to
    a 503 with the error message forwarded."""
    with (
        patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False),
        patch.object(
            takeit_server,
            "_explain_rows",
            side_effect=RuntimeError("bundle gone"),
        ),
    ):
        status, body = takeit_server.handle_explain_payload(
            json.dumps(
                {"alert_type": "lottery", "rows": [{"alert_id": 1, "features": {}}]}
            ).encode(),
            _bearer("s"),
        )
    assert status == 503
    assert body == {"error": "bundle gone"}


def test_handle_explain_500_on_unexpected_error() -> None:
    """Any non-RuntimeError exception maps to a 500."""
    with (
        patch.dict("os.environ", {"TAKEIT_SIDECAR_SHARED_SECRET": "s"}, clear=False),
        patch.object(takeit_server, "_explain_rows", side_effect=ValueError("boom")),
    ):
        status, body = takeit_server.handle_explain_payload(
            json.dumps(
                {"alert_type": "lottery", "rows": [{"alert_id": 1, "features": {}}]}
            ).encode(),
            _bearer("s"),
        )
    assert status == 500
    assert body == {"error": "boom"}


# ── start_in_thread (backward-compat no-op) ────────────────────────────


def test_start_in_thread_is_a_noop_returning_none() -> None:
    """Legacy entrypoint now returns None — routes live on the health
    server, so no separate thread is spawned."""
    assert takeit_server.start_in_thread() is None
