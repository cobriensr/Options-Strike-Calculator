"""Take-It SHAP explainer — handler functions co-resident with the sidecar.

Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md

Phase 3d: the Vercel cron api/cron/takeit-fill-shap.ts POSTs batches of
feature rows here; we run shap.TreeExplainer against the joblib bundle
(downloaded from Vercel Blob on first request, then cached in memory) and
return the top-K positive + top-K negative contributors per row.

Architecturally: this module exposes pure handler functions
(`handle_explain_payload`, `handle_health_payload`) that the sidecar's
existing health-server HealthHandler dispatches to. We don't run our own
HTTP server — Railway only forwards one public port (8080, the health
server), so co-resident routes on that handler is the practical path.

Required env vars when enabled (via TAKEIT_SERVER_ENABLED=1):
    - BLOB_READ_WRITE_TOKEN          read access to the takeit/ namespace
    - TAKEIT_SIDECAR_SHARED_SECRET   bearer token the cron sends

Endpoint (wired in sidecar/src/health.py):
    POST /takeit/explain
    Headers: Authorization: Bearer <TAKEIT_SIDECAR_SHARED_SECRET>
    Body: {
      "alert_type": "lottery" | "silentboom",
      "rows": [{
        "alert_id": <int>,
        "features": { <feature_name>: <number | null>, ... }
      }, ...]
    }
    → 200: { "results": [...] }
    → 401: bad/missing bearer
    → 503: bundle unreachable
"""

from __future__ import annotations

import io
import json
import logging
import os
import threading
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

# Lazy import — heavy ML deps only loaded when the server is enabled.
_bundle_cache: dict[str, Any] = {}
_bundle_lock = threading.Lock()

MANIFEST_PATH = "takeit/latest.json"
TOP_K = 3


def _list_blob(prefix: str, token: str) -> list[dict]:
    """Call the Vercel Blob list API to resolve a private blob path."""
    url = f"https://blob.vercel-storage.com/?{urllib.parse.urlencode({'prefix': prefix, 'limit': 100})}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 (trusted)
        return json.loads(resp.read())["blobs"]


def _fetch_blob(url: str) -> bytes:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (trusted)
        return resp.read()


def _load_bundle(alert_type: str) -> dict:
    """Resolve the manifest's current version for `alert_type`, then download
    and joblib.load() the bundle. Cached per-alert_type in-process."""
    import joblib  # noqa: PLC0415

    with _bundle_lock:
        if alert_type in _bundle_cache:
            return _bundle_cache[alert_type]

        token = os.environ["BLOB_READ_WRITE_TOKEN"]
        # Manifest → versioned bundle path → blob URL.
        manifest_blobs = _list_blob(MANIFEST_PATH, token)
        manifest_entry = next(
            (b for b in manifest_blobs if b["pathname"] == MANIFEST_PATH), None
        )
        if not manifest_entry:
            raise RuntimeError(f"manifest not found at {MANIFEST_PATH}")
        manifest = json.loads(_fetch_blob(manifest_entry["url"]).decode("utf-8"))
        target_path = manifest[alert_type]
        # The Blob does store the JSON form, but for SHAP we need the joblib
        # (which contains the XGBClassifier + IsotonicRegression objects).
        # Convention: the joblib lives alongside the JSON at the same prefix.
        joblib_path = target_path.replace("_classifier_v", "_joblib_v").replace(
            ".json", ".joblib"
        )
        joblib_blobs = _list_blob(joblib_path, token)
        joblib_entry = next(
            (b for b in joblib_blobs if b["pathname"] == joblib_path), None
        )
        if not joblib_entry:
            raise RuntimeError(
                f"joblib bundle missing at {joblib_path}. Upload it alongside "
                f"the JSON via scripts/upload_takeit_bundles.mjs (TODO: extend "
                f"to upload the joblib too)."
            )
        joblib_bytes = _fetch_blob(joblib_entry["url"])
        bundle = joblib.load(io.BytesIO(joblib_bytes))
        _bundle_cache[alert_type] = bundle
        return bundle


def _explain_rows(alert_type: str, rows: list[dict]) -> list[dict]:
    """Compute SHAP top-K per row. Returns the JSON-serializable payload."""
    import numpy as np  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415
    import shap  # noqa: PLC0415

    bundle = _load_bundle(alert_type)
    feature_cols: list[str] = bundle["feature_cols"]
    model = bundle["model"]

    # Build the feature matrix in bundle column order.
    matrix = []
    for r in rows:
        feats = r["features"]
        matrix.append([feats.get(c, np.nan) for c in feature_cols])
    X = pd.DataFrame(matrix, columns=feature_cols).astype(float)

    explainer = shap.TreeExplainer(model)
    shap_values = np.asarray(explainer.shap_values(X))

    out = []
    for i, r in enumerate(rows):
        contribs = shap_values[i]
        order_pos = np.argsort(contribs)[::-1][:TOP_K]
        order_neg = np.argsort(contribs)[:TOP_K]
        feature_values = X.iloc[i].to_numpy()
        pos = [
            {
                "name": feature_cols[j],
                "shap_value": float(contribs[j]),
                "feature_value": _json_safe(feature_values[j]),
            }
            for j in order_pos
            if contribs[j] > 0
        ]
        neg = [
            {
                "name": feature_cols[j],
                "shap_value": float(contribs[j]),
                "feature_value": _json_safe(feature_values[j]),
            }
            for j in order_neg
            if contribs[j] < 0
        ]
        out.append(
            {"alert_id": r["alert_id"], "top_positive": pos, "top_negative": neg}
        )
    return out


def _json_safe(v):
    import math  # noqa: PLC0415

    if v is None:
        return None
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def is_enabled() -> bool:
    """True iff the takeit server is enabled AND all required ML deps are
    importable. Cached on first call so the import-probe overhead is paid once.
    """
    if os.environ.get("TAKEIT_SERVER_ENABLED", "0") != "1":
        return False
    try:
        import joblib  # noqa: F401, PLC0415
        import numpy  # noqa: F401, PLC0415
        import pandas  # noqa: F401, PLC0415
        import shap  # noqa: F401, PLC0415
        import xgboost  # noqa: F401, PLC0415
    except ImportError as e:
        logger.warning(
            "takeit_server: missing dep %s; install xgboost/shap/joblib in sidecar venv",
            e.name,
        )
        return False
    if not os.environ.get("TAKEIT_SIDECAR_SHARED_SECRET", ""):
        logger.warning("takeit_server: TAKEIT_SIDECAR_SHARED_SECRET not set")
        return False
    return True


def handle_health_payload() -> dict:
    """GET /takeit/health body. Always returns 200-shaped JSON; the handler
    in health.py wraps this with HTTP status + headers."""
    return {
        "status": "ok",
        "enabled": is_enabled(),
        "bundles_loaded": sorted(_bundle_cache.keys()),
    }


def handle_explain_payload(
    body_bytes: bytes, auth_header: str
) -> tuple[int, dict]:
    """Parse + dispatch a POST /takeit/explain body. Returns (http_status, body).

    The HealthHandler caller is responsible for writing the response headers
    + body; we just emit the status code and the JSON payload.
    """
    shared_secret = os.environ.get("TAKEIT_SIDECAR_SHARED_SECRET", "")
    if not shared_secret:
        return 503, {"error": "TAKEIT_SIDECAR_SHARED_SECRET not configured"}
    if auth_header != f"Bearer {shared_secret}":
        return 401, {"error": "unauthorized"}

    try:
        payload = json.loads(body_bytes)
    except (ValueError, json.JSONDecodeError):
        return 400, {"error": "body must be valid JSON"}

    alert_type = payload.get("alert_type")
    if alert_type not in ("lottery", "silentboom"):
        return 400, {"error": "alert_type must be lottery|silentboom"}
    rows = payload.get("rows") or []
    if not isinstance(rows, list):
        return 400, {"error": "rows must be a list"}
    if not rows:
        return 200, {"results": []}

    try:
        results = _explain_rows(alert_type, rows)
    except RuntimeError as e:
        logger.exception("takeit explain failed: bundle/model error")
        return 503, {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("takeit explain failed: unexpected")
        return 500, {"error": str(e)}
    return 200, {"results": results}


# Kept for backward compatibility while main.py is being updated; this is
# now a no-op since the takeit routes live on the existing health server
# (port 8080) instead of a separate Flask process. Safe to delete after
# the next deploy.
def start_in_thread() -> threading.Thread | None:
    logger.info(
        "takeit_server.start_in_thread: takeit routes now live on the "
        "health server (port 8080); no separate thread needed"
    )
    return None
