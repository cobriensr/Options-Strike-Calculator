"""
Unit tests for ml/trace/extract_predictions.py.

All Anthropic API calls and filesystem reads are mocked so tests run offline
without consuming API credits.
"""

import base64
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import extract_predictions as ep
import pandas as pd
import pytest

# ── helpers ───────────────────────────────────────────────────────────────────


def _make_response(payload: dict | str) -> MagicMock:
    """Build a mock Anthropic response with a single text block."""
    text = json.dumps(payload) if isinstance(payload, dict) else payload
    block = MagicMock()
    block.type = "text"
    block.text = text
    response = MagicMock()
    response.content = [block]
    return response


def _make_image(tmp_path: Path, name: str = "2026-01-06.png") -> Path:
    """Write a 1x1 white PNG to tmp_path and return its path."""
    import struct
    import zlib

    def _png_bytes() -> bytes:
        # Minimal valid 1x1 white PNG
        sig = b"\x89PNG\r\n\x1a\n"
        ihdr_data = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
        ihdr = _chunk(b"IHDR", ihdr_data)
        idat = _chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff"))
        iend = _chunk(b"IEND", b"")
        return sig + ihdr + idat + iend

    def _chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    path = tmp_path / name
    path.write_bytes(_png_bytes())
    return path


# ── _parse_date ───────────────────────────────────────────────────────────────


def test_parse_date_shottr_format(tmp_path):
    """Parses YYYY-MM-DD from Shottr SCR-YYYYMMDD-xxxx.png filenames."""
    p = tmp_path / "SCR-20260411-twzd.png"
    assert ep._parse_date(p) == "2026-04-11"


def test_parse_date_manual_format(tmp_path):
    """Parses YYYY-MM-DD from manual YYYY-MM-DD.png filenames."""
    p = tmp_path / "2026-01-06.png"
    assert ep._parse_date(p) == "2026-01-06"


def test_parse_date_returns_none_for_unknown(tmp_path):
    """Returns None for unrecognized filename patterns."""
    p = tmp_path / "screenshot.png"
    assert ep._parse_date(p) is None


def test_parse_date_shottr_various_suffixes(tmp_path):
    """Shottr parser works regardless of file suffix."""
    p = tmp_path / "SCR-20260101-abcd.jpg"
    assert ep._parse_date(p) == "2026-01-01"


# ── _load_image_b64 ───────────────────────────────────────────────────────────


def test_load_image_b64_returns_valid_base64(tmp_path):
    """_load_image_b64 returns decodable base64 and correct media type."""
    img = _make_image(tmp_path, "2026-01-06.png")
    b64, media_type = ep._load_image_b64(img)

    assert media_type == "image/png"
    decoded = base64.standard_b64decode(b64)
    assert decoded == img.read_bytes()


def test_load_image_b64_jpeg_media_type(tmp_path):
    """_load_image_b64 returns image/jpeg for .jpg files."""
    img = tmp_path / "2026-01-06.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 10)  # minimal JPEG header
    _, media_type = ep._load_image_b64(img)
    assert media_type == "image/jpeg"


# ── extract_prediction ────────────────────────────────────────────────────────


def test_extract_prediction_success(tmp_path):
    """Returns parsed dict when API returns valid JSON."""
    img = _make_image(tmp_path, "2026-01-06.png")
    payload = {
        "current_price": 5800,
        "predicted_close": 5790,
        "confidence": "high",
        "notes": "Band narrow and clear.",
    }
    client = MagicMock()
    client.messages.create.return_value = _make_response(payload)

    result = ep.extract_prediction(client, img, "2026-01-06")

    assert result is not None
    assert result["date"] == "2026-01-06"
    assert result["current_price"] == pytest.approx(5800.0)
    assert result["predicted_close"] == pytest.approx(5790.0)
    assert result["confidence"] == "high"
    assert result["notes"] == "Band narrow and clear."


def test_extract_prediction_strips_markdown_fences(tmp_path):
    """Handles response wrapped in ```json ... ``` code fences."""
    img = _make_image(tmp_path, "2026-01-07.png")
    payload = {
        "current_price": 5820,
        "predicted_close": 5830,
        "confidence": "medium",
        "notes": "",
    }
    fenced = f"```json\n{json.dumps(payload)}\n```"

    client = MagicMock()
    client.messages.create.return_value = _make_response(fenced)

    result = ep.extract_prediction(client, img, "2026-01-07")

    assert result is not None
    assert result["predicted_close"] == pytest.approx(5830.0)


def test_extract_prediction_returns_none_on_invalid_json(tmp_path, capsys):
    """Returns None and prints error when response is not valid JSON."""
    img = _make_image(tmp_path, "2026-01-08.png")

    client = MagicMock()
    client.messages.create.return_value = _make_response("not json at all")

    result = ep.extract_prediction(client, img, "2026-01-08")

    assert result is None
    assert "JSON parse error" in capsys.readouterr().out


def test_extract_prediction_returns_none_on_missing_fields(tmp_path, capsys):
    """Returns None when required fields are absent from response."""
    img = _make_image(tmp_path, "2026-01-09.png")
    incomplete = {"current_price": 5800, "notes": "missing predicted_close and confidence"}

    client = MagicMock()
    client.messages.create.return_value = _make_response(incomplete)

    result = ep.extract_prediction(client, img, "2026-01-09")

    assert result is None
    assert "Missing fields" in capsys.readouterr().out


def test_extract_prediction_returns_none_on_api_error(tmp_path, capsys):
    """Returns None and prints error when the Anthropic API raises."""
    import anthropic

    img = _make_image(tmp_path, "2026-01-10.png")

    client = MagicMock()
    client.messages.create.side_effect = anthropic.APIError(
        message="rate limit", request=MagicMock(), body=None
    )

    result = ep.extract_prediction(client, img, "2026-01-10")

    assert result is None
    assert "API error" in capsys.readouterr().out


def test_extract_prediction_returns_none_on_empty_response(tmp_path, capsys):
    """Returns None when response contains no text blocks."""
    img = _make_image(tmp_path, "2026-01-11.png")

    block = MagicMock()
    block.type = "thinking"  # non-text block
    response = MagicMock()
    response.content = [block]

    client = MagicMock()
    client.messages.create.return_value = response

    result = ep.extract_prediction(client, img, "2026-01-11")

    assert result is None
    assert "No text in response" in capsys.readouterr().out


def test_extract_prediction_confidence_lowercased(tmp_path):
    """confidence value is normalized to lowercase."""
    img = _make_image(tmp_path, "2026-01-12.png")
    payload = {
        "current_price": 5800,
        "predicted_close": 5790,
        "confidence": "HIGH",  # uppercase from model
        "notes": "",
    }
    client = MagicMock()
    client.messages.create.return_value = _make_response(payload)

    result = ep.extract_prediction(client, img, "2026-01-12")

    assert result["confidence"] == "high"


def test_extract_prediction_notes_defaults_to_empty(tmp_path):
    """notes field defaults to empty string when absent from response."""
    img = _make_image(tmp_path, "2026-01-13.png")
    payload = {
        "current_price": 5800,
        "predicted_close": 5790,
        "confidence": "low",
        # no "notes" key
    }
    client = MagicMock()
    client.messages.create.return_value = _make_response(payload)

    result = ep.extract_prediction(client, img, "2026-01-13")

    assert result["notes"] == ""


# ── main (incremental processing) ────────────────────────────────────────────


def test_main_skips_already_processed_dates(tmp_path, capsys):
    """main() skips images whose stem is already in predictions.csv."""
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    _make_image(images_dir, "SCR-20260106-twzd.png")

    # Pre-existing predictions — same date as the image
    existing = pd.DataFrame(
        {
            "date": ["2026-01-06"],
            "current_price": [5800.0],
            "predicted_close": [5790.0],
            "confidence": ["high"],
            "notes": [""],
        }
    )
    existing.to_csv(results_dir / "predictions.csv", index=False)

    mock_client = MagicMock()

    with (
        patch.object(ep, "IMAGES_DIR", images_dir),
        patch.object(ep, "RESULTS_DIR", results_dir),
        patch("extract_predictions.anthropic.Anthropic", return_value=mock_client),
    ):
        ep.main()

    # API should NOT have been called since the date was already processed
    mock_client.messages.create.assert_not_called()
    out = capsys.readouterr().out
    assert "All images already processed" in out


def test_main_exits_gracefully_when_no_images(tmp_path, capsys):
    """main() prints a message and returns 0 when images directory is empty."""
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    results_dir = tmp_path / "results"
    results_dir.mkdir()

    with (
        patch.object(ep, "IMAGES_DIR", images_dir),
        patch.object(ep, "RESULTS_DIR", results_dir),
    ):
        with pytest.raises(SystemExit) as exc_info:
            ep.main()

    assert exc_info.value.code == 0
    assert "No images found" in capsys.readouterr().out
