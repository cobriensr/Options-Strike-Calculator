"""
Extract SPX close predictions from TRACE Delta Pressure heatmap screenshots.

Usage:
    ml/.venv/bin/python ml/trace/extract_predictions.py

Place screenshots in ml/trace/images/ using Shottr's default naming:
    SCR-YYYYMMDD-xxxx.png  (e.g. SCR-20260411-twzd.png)

Manual YYYY-MM-DD.png names are also accepted.

Optional: add a Charm Pressure screenshot for the same date to improve
within-zone accuracy:
    charm-YYYYMMDD.png  (e.g. charm-20260411.png)

When both images are present, they are sent together in one API call.
Charm Pressure tells Claude WHERE within the equilibrium zone price will pin.
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
_CHARM_RE = re.compile(r"^charm-(\d{4})(\d{2})(\d{2})$")


def _parse_date(path: Path) -> str | None:
    """Extract YYYY-MM-DD from a Shottr (SCR-YYYYMMDD-*.png) or manual (YYYY-MM-DD.png) filename."""
    stem = path.stem
    m = _SHOTTR_RE.match(stem)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if _MANUAL_RE.match(stem):
        return stem
    return None


def _parse_charm_date(path: Path) -> str | None:
    """Extract YYYY-MM-DD from a charm-YYYYMMDD.png filename."""
    m = _CHARM_RE.match(path.stem)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


# ── Single-image prompt (Delta Pressure only) ────────────────────────────────

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


# ── Two-image prompt (Delta Pressure + Charm Pressure) ───────────────────────

TWO_IMAGE_PROMPT = """\
You are given two TRACE heatmap screenshots from SpotGamma, both captured at
approximately 8:30 AM CT on the same SPX trading day.

IMAGE 1 — DELTA PRESSURE (Market Maker mode):
Shows where market-maker delta hedging pressure is concentrated RIGHT NOW.
- LEFT Y-axis ONLY: SPX price levels in whole numbers. Use ONLY this axis.
- RIGHT Y-axis: HIRO values. IGNORE completely.
- WHITE DASHED HORIZONTAL LINE: SpotGamma reference at the opening price. IGNORE.
- X-axis: time from ~7:00 AM to 3:00 PM CT
- SATURATED BLUE zone (lower): MMs must BUY to hedge — buying support floor.
- SATURATED RED zone (upper): MMs must SELL to hedge — selling resistance ceiling.
- GRADIENT TRANSITION ZONE: the band where color shifts smoothly from blue to red.
  This is the zero-delta equilibrium — the TARGET ZONE for EOD pinning.
- Green/red candlesticks: actual SPX price, visible only in the first ~1.5 hours.

IMAGE 2 — CHARM PRESSURE:
Shows how time decay (charm = dDelta/dTime) will shift MM delta positions through the day.
- SATURATED BLUE areas: charm creates net BUYING pressure as the day progresses.
- SATURATED RED areas: charm creates net SELLING pressure as the day progresses.
- This tells you WHERE WITHIN the equilibrium zone price will ultimately pin.

READING STEPS:

Step 1 — From IMAGE 1, go to the ABSOLUTE RIGHT EDGE (3:00 PM column):
  Scan from bottom to top:
  a. POINT A — top of saturated blue: where vivid blue first starts to fade. This is
     the FLOOR of the gradient transition zone. Use Y-axis bracketing to interpolate.
  b. POINT B — bottom of saturated red: where vivid red/pink first appears. This is
     the CEILING of the gradient transition zone. Use Y-axis bracketing to interpolate.
  Y-axis bracketing: find the two labels immediately above and below the feature,
  estimate the fraction between them, compute: lower + fraction × (upper − lower).

Step 2 — From IMAGE 2, go to the ABSOLUTE RIGHT EDGE (3:00 PM column):
  Look ONLY at the price range spanning Point A to Point B (the zone from Step 1).
  Classify the dominant color in that price range:
  - Predominantly RED (≥ 60% red): charm is driving SELLING → price pins near Point A.
  - Predominantly BLUE (≥ 60% blue): charm is driving BUYING → price pins near Point B.
  - Mixed / roughly equal: no dominant drift → price pins near the midpoint.

Step 3 — Calculate predicted_close based on charm_bias:
  - charm_bias = "red":   predicted_close = Point A
  - charm_bias = "blue":  predicted_close = Point B
  - charm_bias = "mixed": predicted_close = (Point A + Point B) / 2
  Do NOT round to the nearest 10.

Step 4 — Read current_price from IMAGE 1:
  The price label near the candlestick cluster at ~8:30 AM.

Return ONLY a JSON object (no markdown fences, no explanation):
{
    "current_price": <number: SPX price at open>,
    "point_a": <number: top of saturated blue at 3 PM — floor of transition zone>,
    "point_b": <number: bottom of saturated red at 3 PM — ceiling of transition zone>,
    "charm_bias": "<red|blue|mixed>",
    "predicted_close": <number: per charm_bias rule above>,
    "confidence": "<high|medium|low>",
    "notes": "<Point A, Point B, transition width, charm color in zone, final prediction>"
}

Confidence guide:
- high: transition zone ≤ 10 pts AND charm color clearly dominates (≥ 60% one color)
- medium: transition zone 10–25 pts OR charm color is somewhat ambiguous
- low: transition zone > 25 pts OR charm colors blend without clear dominance\
"""


def _load_image_b64(path: Path) -> tuple[str, str]:
    """Return (base64_data, media_type) for the given image path."""
    media_type = _SUFFIX_TO_MEDIA_TYPE.get(path.suffix.lower(), "image/png")
    b64 = base64.standard_b64encode(path.read_bytes()).decode("utf-8")
    return b64, media_type


def _image_block(path: Path) -> dict:
    """Build a Claude API image content block from a local file."""
    b64, media_type = _load_image_b64(path)
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": b64},
    }


def extract_prediction(
    client: "anthropic.Anthropic",
    image_path: Path,
    date: str,
    charm_path: Path | None = None,
) -> dict | None:
    """Call Claude Vision to extract open price and predicted close from screenshots.

    When charm_path is provided, both Delta Pressure and Charm Pressure images are
    sent together so Claude can bias the within-zone pin level using charm drift.
    """
    if charm_path is not None:
        content = [
            _image_block(image_path),   # Image 1: Delta Pressure
            _image_block(charm_path),   # Image 2: Charm Pressure
            {"type": "text", "text": TWO_IMAGE_PROMPT},
        ]
        required = {"current_price", "point_a", "point_b", "charm_bias", "predicted_close", "confidence"}
    else:
        content = [
            _image_block(image_path),
            {"type": "text", "text": EXTRACTION_PROMPT},
        ]
        required = {"current_price", "predicted_close", "confidence"}

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "max"},
            messages=[{"role": "user", "content": content}],
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

    if not required.issubset(data.keys()):
        print(f"  ✗ Missing fields for {image_path.name}: got {set(data.keys())}")
        return None

    result: dict = {
        "date": date,
        "current_price": float(data["current_price"]),
        "predicted_close": float(data["predicted_close"]),
        "confidence": str(data["confidence"]).lower(),
        "notes": str(data.get("notes", "")),
    }
    if charm_path is not None:
        result["charm_bias"] = str(data["charm_bias"]).lower()
        result["point_a"] = float(data["point_a"])
        result["point_b"] = float(data["point_b"])
    return result


def main() -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    # Collect delta and charm images separately
    delta_images: dict[str, Path] = {}
    charm_images: dict[str, Path] = {}

    for p in IMAGES_DIR.iterdir():
        if p.suffix.lower() not in _SUFFIX_TO_MEDIA_TYPE:
            continue
        charm_date = _parse_charm_date(p)
        if charm_date is not None:
            charm_images[charm_date] = p
            continue
        delta_date = _parse_date(p)
        if delta_date is None:
            print(f"  ✗ Skipping {p.name}: unrecognized filename format")
            continue
        delta_images[delta_date] = p

    # Build candidate list sorted by date
    all_dates = sorted(delta_images)
    images: list[tuple[str, Path, Path | None]] = [
        (date, delta_images[date], charm_images.get(date))
        for date in all_dates
    ]

    if not images:
        print(f"No delta pressure images found in {IMAGES_DIR}")
        print("Add Shottr screenshots (SCR-YYYYMMDD-*.png) and re-run.")
        sys.exit(0)

    # Incremental: skip already-processed dates, but re-process if a charm image is
    # now available for a date that was previously processed without one.
    output_path = RESULTS_DIR / "predictions.csv"
    if output_path.exists():
        existing = pd.read_csv(output_path)
        processed = set(existing["date"].astype(str))
        # Dates eligible for charm upgrade: processed without charm, now have charm image
        if "charm_bias" in existing.columns:
            no_charm = set(existing[existing["charm_bias"].isna()]["date"].astype(str))
        else:
            no_charm = processed.copy()
        charm_upgrades = {d for d in no_charm if d in charm_images}
    else:
        existing = pd.DataFrame()
        processed = set()
        charm_upgrades = set()

    to_process = [
        (date, img, charm)
        for date, img, charm in images
        if date not in processed or date in charm_upgrades
    ]

    new_count = sum(1 for d, _, _ in to_process if d not in processed)
    upgrade_count = sum(1 for d, _, _ in to_process if d in charm_upgrades)
    charm_count = sum(1 for _, _, c in to_process if c is not None)
    print(
        f"Found {len(images)} delta images ({len(charm_images)} with charm). "
        f"{len(processed)} already processed. "
        f"To process: {new_count} new + {upgrade_count} charm upgrades "
        f"({charm_count} will use two-image mode)."
    )

    if not to_process:
        print("All images already processed. Nothing to do.")
        return

    client = anthropic.Anthropic()
    new_rows: list[dict] = []

    for i, (date, img_path, charm_path) in enumerate(to_process, 1):
        mode = "delta+charm" if charm_path else "delta only"
        print(f"[{i}/{len(to_process)}] {img_path.name} ({date}) [{mode}] ... ", end="", flush=True)
        result = extract_prediction(client, img_path, date, charm_path)

        if result:
            new_rows.append(result)
            direction = (
                "▲ BULLISH" if result["predicted_close"] > result["current_price"]
                else "▼ BEARISH"
            )
            charm_str = f"  charm={result['charm_bias']}" if result.get("charm_bias") else ""
            print(
                f"✓  open={result['current_price']:.0f}  "
                f"predicted={result['predicted_close']:.0f}  "
                f"{direction}  conf={result['confidence']}{charm_str}"
            )
            if result["notes"]:
                print(f"     → {result['notes']}")
        else:
            print("skipped")

        if i < len(to_process):
            time.sleep(1.5)  # avoid rate limits

    if new_rows:
        new_df = pd.DataFrame(new_rows)
        # Replace rows for re-processed dates (charm upgrades), append new ones
        if not existing.empty:
            replaced_dates = set(new_df["date"])
            existing_kept = existing[~existing["date"].isin(replaced_dates)]
            combined = pd.concat([existing_kept, new_df], ignore_index=True)
        else:
            combined = new_df
        combined = combined.sort_values("date").reset_index(drop=True)
        combined.to_csv(output_path, index=False)
        print(f"\nSaved {len(new_rows)} predictions → {output_path}")
        print(f"Total in file: {len(combined)} rows")
    else:
        print("\nNo new predictions extracted.")


if __name__ == "__main__":
    main()
