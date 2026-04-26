"""
Build a self-contained HTML scoring tool for the charm-pressure pin study.

Generates `scripts/charm-pressure-capture/scoring/index.html` — a single HTML
file with one card per selected day. Each card shows:
  - day metadata (OHLC, range, event flags, day-of-week)
  - 4 charm captures (open/mid/close/eod) as inline thumbnails
  - 1 gamma close capture (the gamma-override rule needs the magnitude read)
  - 1 delta close capture (for cross-chart context)
  - form fields: direction call, final price estimate, pin type
    (charm-pin / gamma-override / mixed), chart structure
    (stable / flip / unstable / multi-band), confidence (high/med/low),
    free-text notes
  - auto-computed prediction error vs actual close
  - save-to-localStorage on every change
  - "Export CSV" button generates a downloadable scores.csv

Pre-populates with the 12 days walked through during 2026-04-25 walkthrough.

Run with:
    ml/.venv/bin/python scripts/charm-pressure-capture/build_scoring_tool.py
Open with:
    open scripts/charm-pressure-capture/scoring/index.html
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
CSV = ROOT / "scripts/charm-pressure-capture/candidate-days.csv"
SCREENSHOTS = ROOT / "scripts/charm-pressure-capture/screenshots"
GAMMA_SCREENSHOTS = ROOT / "scripts/gamma-capture/screenshots"
DELTA_SCREENSHOTS = ROOT / "scripts/delta-pressure-capture/screenshots"
OUT_DIR = ROOT / "scripts/charm-pressure-capture/scoring"
OUT_HTML = OUT_DIR / "index.html"

# Pre-populated scores from the 2026-04-25 walkthrough session.
# Keys here become the localStorage seed; user can override by re-saving.
PREFILLED: dict[str, dict] = {
    "2025-06-20": {"dir": "short", "est_final": 5970, "pin_type": "charm",
                   "structure": "stable", "confidence": "high",
                   "notes": "Quad-witch, but red dominant, clean read"},
    "2025-10-27": {"dir": "long", "est_final": 6875, "pin_type": "charm",
                   "structure": "stable", "confidence": "high",
                   "notes": "Clean blue dominance, top junction = pin"},
    "2025-07-28": {"dir": "short", "est_final": 6390, "pin_type": "charm",
                   "structure": "stable", "confidence": "high",
                   "notes": "Flow-shift pattern, red realized + blue projected"},
    "2025-01-07": {"dir": "short", "est_final": 5910, "pin_type": "charm",
                   "structure": "stable", "confidence": "high",
                   "notes": "Refined to 5910 by 2:30 from blue pocket entry at 5905"},
    "2026-01-29": {"dir": "short_to_long", "est_final": 6965, "pin_type": "charm",
                   "structure": "flip", "confidence": "high",
                   "notes": "Mid-day flip at 12:40 captured by contour reorientation"},
    "2025-08-11": {"dir": "short", "est_final": 6387, "pin_type": "none",
                   "structure": "unstable", "confidence": "low",
                   "notes": "Flip-flop chart all day, MOC candle at 2:50 killed it"},
    "2025-10-09": {"dir": "short", "est_final": 6722, "pin_type": "charm",
                   "structure": "stable", "confidence": "medium",
                   "notes": "Direction right but pin missed — red flow exhausted before reaching predicted level"},
    "2026-02-05": {"dir": "short", "est_final": 6797, "pin_type": "charm",
                   "structure": "stable", "confidence": "high",
                   "notes": "Dynamic red — multiple rejection wicks at 6840 ceiling"},
    "2025-12-03": {"dir": "long", "est_final": 6870, "pin_type": "gamma",
                   "structure": "stable", "confidence": "medium",
                   "notes": "Charm said 6870, gamma -10B at 6855 + +6B near close = actual pin at 6849"},
    "2025-04-24": {"dir": "long", "est_final": 5477, "pin_type": "gamma",
                   "structure": "stable", "confidence": "high",
                   "notes": "+3.4B gamma at 5480 was 10-15x other levels — gamma override"},
    "2026-04-23": {"dir": "long", "est_final": 7110, "pin_type": "charm",
                   "structure": "flip", "confidence": "high",
                   "notes": "Live-traded; news chaos at 12:00, rode recovery to pin"},
    "2025-03-10": {"dir": "short", "est_final": 5610, "pin_type": "charm",
                   "structure": "stable", "confidence": "high",
                   "notes": "Massive red, clean junction-to-junction read"},
}


def relative_image_path(html_dir: Path, image_path: Path) -> str:
    """Return a path relative to the HTML output directory (since the HTML lives
    in scoring/ and the screenshots are in ../screenshots/)."""
    try:
        return str(image_path.relative_to(html_dir.parent))
    except ValueError:
        return str(image_path)


def find_capture(date: str, slot: str, base: Path) -> Path | None:
    p = base / date / f"{slot}.png"
    return p if p.exists() else None


def build_day_card(row: pd.Series, html_dir: Path) -> str:
    date = row["date"]
    dow = row.get("day_of_week", "")
    spx_open = row.get("spx_open", "")
    spx_high = row.get("spx_high", "")
    spx_low = row.get("spx_low", "")
    spx_close = row.get("spx_close", "")
    range_pct = row.get("realized_range_pct", "")
    is_event = int(float(row.get("is_event", 0) or 0))
    is_opex = (
        int(float(row.get("is_monthly_opex", 0) or 0)) |
        int(float(row.get("is_quarterly_opex", 0) or 0))
    )
    flags = []
    if is_event:
        flags.append("EVENT")
    if is_opex:
        flags.append("OPEX")
    flag_str = " ".join(f'<span class="flag">{f}</span>' for f in flags)

    # Charm 4 captures
    charm_imgs = []
    for slot in ["open", "mid", "close", "eod"]:
        p = find_capture(date, slot, SCREENSHOTS)
        if p:
            rel = relative_image_path(html_dir, p)
            charm_imgs.append(
                f'<a href="{rel}" target="_blank">'
                f'<img src="{rel}" alt="{date} {slot}" title="{slot}"/>'
                f'<div class="cap">{slot}</div></a>'
            )
    charm_html = "\n".join(charm_imgs) or '<div class="missing">No charm captures</div>'

    # Gamma + delta close captures (for the override rule + context)
    side_imgs = []
    gamma_p = find_capture(date, "close", GAMMA_SCREENSHOTS)
    if gamma_p:
        rel = relative_image_path(html_dir, gamma_p)
        side_imgs.append(
            f'<a href="{rel}" target="_blank">'
            f'<img src="{rel}" alt="{date} gamma close"/>'
            f'<div class="cap">gamma</div></a>'
        )
    delta_p = find_capture(date, "close", DELTA_SCREENSHOTS)
    if delta_p:
        rel = relative_image_path(html_dir, delta_p)
        side_imgs.append(
            f'<a href="{rel}" target="_blank">'
            f'<img src="{rel}" alt="{date} delta close"/>'
            f'<div class="cap">delta</div></a>'
        )
    side_html = "\n".join(side_imgs)

    return f"""
<div class="card" data-date="{date}" data-actual-close="{spx_close}">
  <div class="header">
    <div class="title">
      <h3>{date} ({dow})</h3>
      {flag_str}
    </div>
    <div class="ohlc">
      O ${spx_open} · H ${spx_high} · L ${spx_low} · <strong>C ${spx_close}</strong> · range {range_pct}%
    </div>
  </div>

  <div class="captures">
    <div class="charm">
      <div class="caplabel">Charm Pressure (open / mid / close / eod)</div>
      <div class="row">{charm_html}</div>
    </div>
    <div class="side">
      <div class="caplabel">Gamma + Delta @ close</div>
      <div class="row">{side_html}</div>
    </div>
  </div>

  <div class="form">
    <label>Direction:
      <select name="dir">
        <option value="">—</option>
        <option value="long">Long</option>
        <option value="short">Short</option>
        <option value="short_to_long">Short → Long flip</option>
        <option value="long_to_short">Long → Short flip</option>
        <option value="skip">Skip / no-trade</option>
      </select>
    </label>
    <label>Final est: $<input name="est_final" type="number" step="0.01" placeholder="e.g. 6870"/></label>
    <label>Pin type:
      <select name="pin_type">
        <option value="">—</option>
        <option value="charm">Charm pin</option>
        <option value="gamma">Gamma override</option>
        <option value="mixed">Mixed / unclear</option>
        <option value="none">No pin call</option>
      </select>
    </label>
    <label>Chart:
      <select name="structure">
        <option value="">—</option>
        <option value="stable">Stable / clean</option>
        <option value="flip">Mid-day flip (with contour)</option>
        <option value="unstable">Unstable / flip-flop</option>
        <option value="multiband">Multi-band / wide zoom</option>
      </select>
    </label>
    <label>Conf:
      <select name="confidence">
        <option value="">—</option>
        <option value="high">High</option>
        <option value="medium">Med</option>
        <option value="low">Low</option>
      </select>
    </label>
    <label class="notes">Notes: <input name="notes" type="text" placeholder="e.g. red rejection wicks at 6840, MOC reversal..."/></label>
    <div class="error-display"></div>
  </div>
</div>
"""


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(CSV, dtype=str)
    df = df[df["selected"] == "Y"].copy()
    df = df.sort_values("date").reset_index(drop=True)

    cards = "\n".join(build_day_card(row, OUT_DIR) for _, row in df.iterrows())
    prefilled_json = json.dumps(PREFILLED)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Charm Pressure Pin Study — Scoring Tool</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0e1116; color: #e6edf3; }}
  header {{ position: sticky; top: 0; background: #161b22; padding: 1rem 2rem; border-bottom: 1px solid #30363d; z-index: 10; }}
  header h1 {{ margin: 0 0 .5rem; font-size: 1.2rem; }}
  .stats {{ display: flex; gap: 1.5rem; font-size: .9rem; color: #8b949e; }}
  .controls {{ margin-top: .5rem; display: flex; gap: .5rem; flex-wrap: wrap; }}
  .controls button, .controls select {{
    background: #21262d; color: #e6edf3; border: 1px solid #30363d; padding: .4rem .8rem; border-radius: 6px; cursor: pointer; font-size: .85rem;
  }}
  .controls button:hover {{ background: #30363d; }}
  main {{ padding: 1rem 2rem; max-width: 1400px; margin: 0 auto; }}
  .card {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }}
  .card.scored {{ border-color: #3fb950; }}
  .card.unscored {{ border-color: #d29922; }}
  .header {{ display: flex; justify-content: space-between; align-items: baseline; margin-bottom: .75rem; flex-wrap: wrap; gap: .5rem; }}
  .header h3 {{ margin: 0; font-size: 1.05rem; display: inline; }}
  .title {{ display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }}
  .ohlc {{ font-size: .85rem; color: #8b949e; font-family: monospace; }}
  .flag {{ background: #d29922; color: #0e1116; padding: 2px 6px; border-radius: 3px; font-size: .7rem; font-weight: bold; }}
  .captures {{ display: grid; grid-template-columns: 3fr 1fr; gap: 1rem; margin-bottom: .75rem; }}
  .caplabel {{ font-size: .75rem; color: #8b949e; margin-bottom: .25rem; text-transform: uppercase; letter-spacing: .05em; }}
  .row {{ display: flex; gap: .5rem; flex-wrap: wrap; }}
  .row a {{ display: block; text-align: center; }}
  .row img {{ height: 110px; border: 1px solid #30363d; border-radius: 4px; cursor: zoom-in; }}
  .row img:hover {{ border-color: #58a6ff; }}
  .cap {{ font-size: .7rem; color: #8b949e; margin-top: 2px; text-transform: uppercase; }}
  .form {{ display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; padding-top: .75rem; border-top: 1px solid #30363d; font-size: .85rem; }}
  .form label {{ display: flex; align-items: center; gap: .25rem; }}
  .form select, .form input {{
    background: #0e1116; color: #e6edf3; border: 1px solid #30363d; padding: .25rem .4rem; border-radius: 4px; font-size: .85rem;
  }}
  .form input[type=number] {{ width: 110px; }}
  .form .notes {{ flex: 1; min-width: 250px; }}
  .form .notes input {{ width: 100%; }}
  .error-display {{ font-family: monospace; padding: 4px 8px; border-radius: 4px; }}
  .error-display.win-tight {{ background: #1f6feb33; color: #58a6ff; }}
  .error-display.win-loose {{ background: #3fb95033; color: #3fb950; }}
  .error-display.miss {{ background: #f8514933; color: #f85149; }}
  .missing {{ color: #f85149; padding: .5rem; }}
</style>
</head>
<body>
<header>
  <h1>Charm Pressure Pin Study — Scoring Tool</h1>
  <div class="stats">
    <span id="stat-total">Total: …</span>
    <span id="stat-scored">Scored: …</span>
    <span id="stat-correct">Dir correct: …</span>
    <span id="stat-median-error">Median error: …</span>
  </div>
  <div class="controls">
    <select id="filter">
      <option value="all">Show all</option>
      <option value="unscored">Unscored only</option>
      <option value="scored">Scored only</option>
    </select>
    <button onclick="exportCsv()">Export CSV</button>
    <button onclick="if(confirm('Clear all local scores?')) localStorage.clear()">Clear local</button>
  </div>
</header>
<main id="cards">
{cards}
</main>

<script>
const PREFILLED = {prefilled_json};
const FIELDS = ['dir', 'est_final', 'pin_type', 'structure', 'confidence', 'notes'];

function getScore(date) {{
  const stored = localStorage.getItem('score:' + date);
  if (stored) return JSON.parse(stored);
  if (PREFILLED[date]) return PREFILLED[date];
  return {{}};
}}
function setScore(date, score) {{
  localStorage.setItem('score:' + date, JSON.stringify(score));
}}
function isComplete(score) {{
  return score.dir && score.est_final !== undefined && score.est_final !== '' && score.pin_type && score.structure;
}}

function loadCard(card) {{
  const date = card.dataset.date;
  const score = getScore(date);
  for (const field of FIELDS) {{
    const el = card.querySelector(`[name="${{field}}"]`);
    if (el && score[field] !== undefined) el.value = score[field];
  }}
  updateError(card);
  updateCardClass(card, score);
}}

function saveCard(card) {{
  const date = card.dataset.date;
  const score = {{}};
  for (const field of FIELDS) {{
    const el = card.querySelector(`[name="${{field}}"]`);
    if (el) score[field] = el.value;
  }}
  setScore(date, score);
  updateError(card);
  updateCardClass(card, score);
  updateStats();
}}

function updateError(card) {{
  const date = card.dataset.date;
  const score = getScore(date);
  const actual = parseFloat(card.dataset.actualClose);
  const display = card.querySelector('.error-display');
  if (!score.est_final || isNaN(actual)) {{
    display.textContent = '';
    display.className = 'error-display';
    return;
  }}
  const err = Math.abs(parseFloat(score.est_final) - actual);
  display.textContent = `error: $${{err.toFixed(2)}}`;
  display.className = 'error-display ' + (err < 3 ? 'win-tight' : err < 8 ? 'win-loose' : 'miss');
}}

function updateCardClass(card, score) {{
  card.classList.toggle('scored', isComplete(score));
  card.classList.toggle('unscored', !isComplete(score));
}}

function updateStats() {{
  const cards = document.querySelectorAll('.card');
  let total = 0, scored = 0, correctDir = 0, errs = [];
  cards.forEach(card => {{
    total++;
    const score = getScore(card.dataset.date);
    if (!isComplete(score)) return;
    scored++;
    const actual = parseFloat(card.dataset.actualClose);
    const open = parseFloat(card.querySelector('.ohlc').textContent.match(/O \\$([\\d.]+)/)?.[1] ?? 'NaN');
    const actualDir = isNaN(open) ? null : actual > open ? 'long' : 'short';
    const dirMatch = score.dir === actualDir
      || (score.dir === 'short_to_long' && actualDir === 'long')
      || (score.dir === 'long_to_short' && actualDir === 'short');
    if (dirMatch) correctDir++;
    if (score.est_final && !isNaN(actual)) {{
      errs.push(Math.abs(parseFloat(score.est_final) - actual));
    }}
  }});
  errs.sort((a,b) => a-b);
  const median = errs.length ? errs[Math.floor(errs.length/2)] : NaN;
  document.getElementById('stat-total').textContent = `Total: ${{total}}`;
  document.getElementById('stat-scored').textContent = `Scored: ${{scored}}`;
  document.getElementById('stat-correct').textContent = `Dir correct: ${{correctDir}}/${{scored}}`;
  document.getElementById('stat-median-error').textContent =
    `Median error: ${{isNaN(median) ? '—' : '$' + median.toFixed(2)}}`;
}}

function exportCsv() {{
  const rows = [['date','actual_close','dir','est_final','pin_type','structure','confidence','notes','error']];
  document.querySelectorAll('.card').forEach(card => {{
    const date = card.dataset.date;
    const actual = card.dataset.actualClose;
    const s = getScore(date);
    const err = (s.est_final && actual) ? Math.abs(parseFloat(s.est_final) - parseFloat(actual)).toFixed(2) : '';
    rows.push([date, actual, s.dir||'', s.est_final||'', s.pin_type||'', s.structure||'', s.confidence||'', (s.notes||'').replaceAll(',',';'), err]);
  }});
  const csv = rows.map(r => r.join(',')).join('\\n');
  const blob = new Blob([csv], {{type: 'text/csv'}});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'charm-pin-scores.csv';
  a.click();
}}

// Wire up auto-save on every input
document.querySelectorAll('.card').forEach(card => {{
  loadCard(card);
  card.querySelectorAll('input, select').forEach(el => {{
    el.addEventListener('change', () => saveCard(card));
    el.addEventListener('blur', () => saveCard(card));
  }});
}});

// Filter
document.getElementById('filter').addEventListener('change', e => {{
  const mode = e.target.value;
  document.querySelectorAll('.card').forEach(card => {{
    const score = getScore(card.dataset.date);
    const complete = isComplete(score);
    card.style.display =
      mode === 'unscored' && complete ? 'none' :
      mode === 'scored' && !complete ? 'none' :
      '';
  }});
}});

updateStats();
</script>
</body>
</html>
"""
    OUT_HTML.write_text(html)
    print(f"Wrote {OUT_HTML}")
    print(f"Pre-populated {len(PREFILLED)} days from this conversation.")
    print(f"Total selected days in CSV: {len(df)}")
    print(f"Open with: open {OUT_HTML}")


if __name__ == "__main__":
    main()
