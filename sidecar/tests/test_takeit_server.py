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

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

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
        patch.dict(
            "os.environ", {"BLOB_READ_WRITE_TOKEN": "tok"}, clear=False
        ),
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
