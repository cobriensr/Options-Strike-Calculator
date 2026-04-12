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

CHART LAYOUT:
- LEFT Y-axis ONLY: SPX price levels in whole numbers (e.g. 6820, 6840, 6860, 6880).
  Use ONLY the left Y-axis for all price readings.
- RIGHT Y-axis: HIRO indicator values. IGNORE completely — not price levels.
- WHITE DASHED HORIZONTAL LINE: SpotGamma reference line at the opening price. IGNORE.
- X-axis: time from ~7:00 AM to 3:00 PM CT
- SATURATED BLUE zone (lower): maximum buying support — market makers must buy to hedge.
  Identified by deep, vivid blue filling a large area.
- SATURATED RED zone (upper): maximum selling resistance — market makers must sell to hedge.
  Identified by deep, vivid red/pink filling a large area.
- GRADIENT TRANSITION ZONE: the band between saturated blue and saturated red where the
  color smoothly shifts from blue to red. Neither pressure dominates here. This zone may be
  narrow (5 pts) or wide (30+ pts) depending on the day. SPX tends to pin at the MIDPOINT
  of this transition zone at EOD.
- Green/red candlesticks: actual SPX price visible only in the first ~1.5 hours.

HOW TO READ THE EOD PIN LEVEL:
The predicted close is the MIDPOINT of the gradient transition zone at 3 PM. It is NOT
the bottom of red alone. It is NOT the top of blue alone. It is the center between them.

READING STEPS:

Step 1 — Find the current price at open:
  Read the price label near the candlestick cluster at ~8:30 AM.

Step 2 — Go to the ABSOLUTE RIGHT EDGE (3:00 PM):
  Evaluate ONLY the rightmost vertical slice of data. Do not trace features across the chart.
  The 3 PM column may look very different from the 8:30 AM area — that is expected.

Step 3 — Identify the gradient transition zone at 3 PM:
  Scan the 3 PM column from bottom to top:
  a. POINT A — top of saturated blue: where the vivid blue color first starts to fade.
     This is the FLOOR of the transition zone.
  b. POINT B — bottom of saturated red: where vivid red/pink color first appears.
     This is the CEILING of the transition zone.
  c. The transition zone spans Point A to Point B.

Step 4 — Calculate the midpoint using Y-axis bracketing:
  For each of Point A and Point B:
  - Identify the two Y-axis labels immediately above and below that point.
  - Estimate what fraction of the way between those labels the point sits.
  - Calculate: lower_label + fraction × (upper_label − lower_label)
  Then: predicted_close = (Point A + Point B) / 2
  Example: Point A = 6858 (top of blue), Point B = 6876 (bottom of red) → midpoint = 6867.
  Do NOT round to the nearest 10. Report the interpolated midpoint.

Return ONLY a JSON object (no markdown fences, no explanation):
{
    "current_price": <number: SPX price at open>,
    "predicted_close": <number: midpoint of gradient transition zone at 3 PM>,
    "confidence": "<high|medium|low>",
    "notes": "<describe: Point A (top of blue) level, Point B (bottom of red) level, \
transition zone width, and calculated midpoint>"
}

Confidence guide:
- high: transition zone is narrow (≤ 10 pts) and cleanly defined at the 3 PM edge
- medium: transition zone is 10–25 pts wide or shifts in the final hour
- low: transition zone is very wide (> 25 pts) or colors blend ambiguously\
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
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "max"},
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
