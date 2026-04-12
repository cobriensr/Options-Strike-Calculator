"""
Extract SPX close predictions from TRACE Delta Pressure heatmap screenshots.

Usage:
    ml/.venv/bin/python ml/trace/extract_predictions.py

Place screenshots in ml/trace/images/ using Shottr's default naming:
    SCR-YYYYMMDD-xxxx.png  (e.g. SCR-20260411-twzd.png)

Manual YYYY-MM-DD.png names are also accepted.
Outputs: ml/trace/results/predictions.csv

Requires ANTHROPIC_API_KEY in environment or ml/.env file.
"""

import base64
import json
import os
import re
import sys
import time
from pathlib import Path

import pandas as pd

# Load .env from ml/ directory if present
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    with _env_path.open() as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                os.environ.setdefault(_key.strip(), _val.strip().strip('"').strip("'"))

try:
    import anthropic
except ImportError:
    print("Error: anthropic not installed. Run: ml/.venv/bin/pip install anthropic")
    sys.exit(1)

IMAGES_DIR = Path(__file__).parent / "images"
RESULTS_DIR = Path(__file__).parent / "results"

_SUFFIX_TO_MEDIA_TYPE = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

_SHOTTR_RE = re.compile(r"^SCR-(\d{4})(\d{2})(\d{2})-")
_MANUAL_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _parse_date(path: Path) -> str | None:
    """Extract YYYY-MM-DD from a Shottr (SCR-YYYYMMDD-*.png) or manual (YYYY-MM-DD.png) filename."""
    stem = path.stem
    m = _SHOTTR_RE.match(stem)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if _MANUAL_RE.match(stem):
        return stem
    return None

EXTRACTION_PROMPT = """\
This is a TRACE Delta Pressure heatmap (Market Maker mode) captured at \
approximately 8:30 AM CT on an SPX trading day.

Chart layout:
- LEFT Y-axis ONLY: SPX price levels in whole numbers (e.g. 6820, 6840, 6860, 6880).
  Use ONLY the left Y-axis for all price readings. Ignore everything on the right side.
- RIGHT Y-axis: shows HIRO indicator values (200M, 100M, 0, -200M, etc.). IGNORE completely.
  These are not price levels.
- BLUE/PURPLE LINE running across the chart: this is the HIRO indicator line. IGNORE it
  entirely. It is not a price level and not the equilibrium channel.
- WHITE DASHED HORIZONTAL LINE: SpotGamma draws a thin white dashed line spanning the full
  chart width at the opening/reference price level. IGNORE it completely. It is NOT the
  equilibrium channel. The equilibrium channel is a curved or sloping band that moves through
  time — it is never a flat horizontal line spanning the full chart width.
- X-axis (bottom): time from ~7:00 AM to 3:00 PM CT
- Red zones: selling/resistance pressure (above equilibrium)
- Blue/purple zones: buying/support pressure (below equilibrium)
- BLACK equilibrium channel: the void-black band running between the red and blue zones.
  This is NOT a contour line. It is a continuous dark gap — like a river of black space —
  running between the two color gradients. The white/grey curves are contour boundaries;
  ignore them. The black channel is the space between those curves where neither red nor
  blue pressure exists.
- Green/red candlesticks: the actual SPX price action, visible in the left portion.
  Use these (and any price label shown near the open) to read the current price at open.

CRITICAL READING STEPS:

Step 1 — Find the current price at open:
  Read the price label shown on or near the candlestick cluster at capture time (~8:30 AM).

Step 2 — Identify the BLACK channel:
  Find the continuous void/black band between the red and blue gradients. It may curve,
  slope up or down, or widen/narrow across the chart. It can end up significantly higher
  OR lower than the open price by 3 PM — do not anchor to the open price.
  If there is no sharp black void (the gradient transitions smoothly from red to blue),
  find the midpoint of the transition zone — where neither color clearly dominates.

Step 3 — Go to the ABSOLUTE RIGHT EDGE of the chart (3:00 PM):
  Move all the way to the rightmost data column. This is where the time axis ends at 3 PM,
  NOT at 2:30 PM or 2:45 PM. The very last vertical slice of chart data.

Step 4 — Read the Y-axis precisely using bracketing:
  At the 3 PM position, find the CENTER of the black channel.
  a. Identify the two Y-axis price labels immediately ABOVE and BELOW the channel center.
  b. Estimate what fraction of the way between those two labels the center sits.
  c. Calculate: lower_label + fraction × (upper_label - lower_label)
  Example: channel center sits 40% of the way from 6840 to 6860 → report 6848.
  Do NOT round to the nearest 10. Report the interpolated value.

Return ONLY a JSON object (no markdown fences, no explanation):
{
    "current_price": <number: SPX price at market open>,
    "predicted_close": <number: interpolated Y-axis value at CENTER of black channel at 3 PM>,
    "confidence": "<high|medium|low>",
    "notes": "<describe: where the channel sits at 3 PM, what Y-axis labels bracket it, \
and estimated fraction>"
}

Confidence guide:
- high: channel is narrow (< 5 pts wide) and clearly defined at the 3 PM edge
- medium: channel is 5-15 pts wide or shifts direction in the final hour
- low: channel is very wide (> 15 pts), diffuse, or impossible to trace to 3 PM\
"""


def _load_image_b64(path: Path) -> tuple[str, str]:
    """Return (base64_data, media_type) for the given image path."""
    media_type = _SUFFIX_TO_MEDIA_TYPE.get(path.suffix.lower(), "image/png")
    b64 = base64.standard_b64encode(path.read_bytes()).decode("utf-8")
    return b64, media_type


def extract_prediction(
    client: "anthropic.Anthropic", image_path: Path, date: str
) -> dict | None:
    """Call Claude Vision to extract open price and predicted close from a screenshot."""
    b64, media_type = _load_image_b64(image_path)

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=512,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": EXTRACTION_PROMPT},
                    ],
                }
            ],
        )
    except anthropic.APIError as e:
        print(f"  ✗ API error for {image_path.name}: {e}")
        return None

    # Find text block (skip thinking blocks if present)
    text = ""
    for block in response.content:
        if block.type == "text":
            text = block.text.strip()
            break

    if not text:
        print(f"  ✗ No text in response for {image_path.name}")
        return None

    # Strip markdown code fences if Claude wrapped the JSON
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"  ✗ JSON parse error for {image_path.name}: {e}")
        print(f"    Raw response: {text[:300]}")
        return None

    required = {"current_price", "predicted_close", "confidence"}
    if not required.issubset(data.keys()):
        print(f"  ✗ Missing fields for {image_path.name}: got {set(data.keys())}")
        return None

    return {
        "date": date,
        "current_price": float(data["current_price"]),
        "predicted_close": float(data["predicted_close"]),
        "confidence": str(data["confidence"]).lower(),
        "notes": str(data.get("notes", "")),
    }


def main() -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    # Collect images and parse dates; skip unrecognized filenames
    images: list[tuple[Path, str]] = []
    for p in IMAGES_DIR.iterdir():
        if p.suffix.lower() not in _SUFFIX_TO_MEDIA_TYPE:
            continue
        date = _parse_date(p)
        if date is None:
            print(f"  ✗ Skipping {p.name}: unrecognized filename format")
            continue
        images.append((p, date))
    images.sort(key=lambda x: x[1])

    if not images:
        print(f"No images found in {IMAGES_DIR}")
        print("Add Shottr screenshots (SCR-YYYYMMDD-*.png) and re-run.")
        sys.exit(0)

    # Incremental: skip already-processed dates
    output_path = RESULTS_DIR / "predictions.csv"
    if output_path.exists():
        existing = pd.read_csv(output_path)
        processed = set(existing["date"].astype(str))
    else:
        existing = pd.DataFrame()
        processed = set()

    to_process = [(img, date) for img, date in images if date not in processed]
    print(
        f"Found {len(images)} images, {len(processed)} already processed, "
        f"{len(to_process)} to process."
    )

    if not to_process:
        print("All images already processed. Nothing to do.")
        return

    client = anthropic.Anthropic()
    new_rows: list[dict] = []

    for i, (img_path, date) in enumerate(to_process, 1):
        print(f"[{i}/{len(to_process)}] {img_path.name} ({date}) ... ", end="", flush=True)
        result = extract_prediction(client, img_path, date)

        if result:
            new_rows.append(result)
            direction = (
                "▲ BULLISH" if result["predicted_close"] > result["current_price"]
                else "▼ BEARISH"
            )
            print(
                f"✓  open={result['current_price']:.0f}  "
                f"predicted={result['predicted_close']:.0f}  "
                f"{direction}  conf={result['confidence']}"
            )
            if result["notes"]:
                print(f"     → {result['notes']}")
        else:
            print("skipped")

        if i < len(to_process):
            time.sleep(1.5)  # avoid rate limits

    if new_rows:
        new_df = pd.DataFrame(new_rows)
        combined = (
            pd.concat([existing, new_df], ignore_index=True)
            if not existing.empty
            else new_df
        )
        combined = combined.sort_values("date").reset_index(drop=True)
        combined.to_csv(output_path, index=False)
        print(f"\nSaved {len(new_rows)} new predictions → {output_path}")
        print(f"Total in file: {len(combined)} rows")
    else:
        print("\nNo new predictions extracted.")


if __name__ == "__main__":
    main()
