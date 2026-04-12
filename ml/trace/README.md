# TRACE Delta Pressure — Prediction Accuracy Pipeline

Offline ML pipeline that validates SPX end-of-day close predictions derived
from SpotGamma's TRACE Delta Pressure Heatmap (Market Maker mode).

## How it works

At 8:30 AM CT, the Delta Pressure heatmap shows where market-maker hedging
pressure is concentrated. The dark/neutral band between the red (selling) and
blue (buying) zones is the zero-delta equilibrium level — the price SPX tends
to pin near at close in positive-gamma environments. Claude Vision reads that
band's position at the 3 PM column to extract the predicted close.

## Directory structure

```text
ml/trace/
  images/          Screenshots go here — one per trading day, named YYYY-MM-DD.png
  results/
    predictions.csv    Extracted predictions (date, current_price, predicted_close, confidence, notes)
    actual_prices.csv  SPX actual closes fetched from yfinance
    accuracy_report.csv  Merged analysis with error columns
  README.md
  extract_predictions.py  Step 1 — Claude Vision extraction (manual/ad-hoc)
  fetch_prices.py         Step 2 — Fetch actual SPX closes (runs nightly)
  analyze_accuracy.py     Step 3 — Compute accuracy stats + generate plots (runs nightly)
```

## Setup

Requires the ML virtual environment with `anthropic` and `yfinance` installed:

```bash
cd ml
.venv/bin/pip install -r requirements.txt
```

Set `ANTHROPIC_API_KEY` in `ml/.env` or the environment before running
`extract_predictions.py`.

## Workflow

### Step 1 — Add screenshots (manual)

Save TRACE Delta Pressure Heatmap screenshots to `ml/trace/images/`. Shottr's
default naming is supported directly — no renaming needed:

```text
ml/trace/images/SCR-20260407-twzd.png
ml/trace/images/SCR-20260408-abcd.png
```

Manual `YYYY-MM-DD.png` names also work. Files with unrecognized names are
skipped with a warning.

Capture at approximately 8:30 AM CT (after the market open), using Market
Maker mode with the Delta Pressure lens selected. Before screenshotting:

- Hide the right-hand HIRO axis if possible (it confuses the price reading)
- Crop tightly to the chart area, excluding the right Y-axis (HIRO scale)
- The green/red candlesticks and left Y-axis (SPX price) are all that's needed

#### Optional: Charm Pressure screenshots (improves within-zone accuracy)

For each Delta Pressure image, you can also capture the Charm Pressure lens at
the same time. Name it `charm-YYYYMMDD.png`:

```text
ml/trace/images/charm-20260407.png
ml/trace/images/charm-20260408.png
```

When a charm image is present for a date, both screenshots are sent together in
one API call. Charm Pressure tells Claude _where within_ the equilibrium zone
price will pin: red charm → floor (Point A), blue charm → ceiling (Point B),
mixed → midpoint. Adds `charm_bias`, `point_a`, and `point_b` columns to the
output CSV.

If you add charm images for dates already in `predictions.csv`, the script
detects the upgrade automatically and re-runs only those dates.

### Step 2 — Extract predictions (manual, after adding screenshots)

```bash
ml/.venv/bin/python ml/trace/extract_predictions.py
```

- Calls `claude-opus-4-6` via vision API for each new screenshot
- Skips dates already in `predictions.csv` (incremental — no duplicate billing)
- Writes `{date, current_price, predicted_close, confidence, notes}` to
  `ml/trace/results/predictions.csv`
- Rate-limited to 1.5s between API calls

Commit the new screenshots and updated `predictions.csv` after running.

### Step 3 — Run accuracy analysis (automated nightly, or manual)

```bash
ml/.venv/bin/python ml/trace/fetch_prices.py     # update actual closes
ml/.venv/bin/python ml/trace/analyze_accuracy.py # regenerate plots + report
```

Or via make:

```bash
cd ml && make trace
```

`fetch_prices.py` fetches the SPX closing price for every date in
`predictions.csv` via yfinance and saves to `actual_prices.csv`.

`analyze_accuracy.py` merges predictions with actuals, computes error
columns, prints a summary report, and saves three plots to `ml/plots/`:

| File                               | Contents                                           |
| ---------------------------------- | -------------------------------------------------- |
| `trace_error_distribution.png`     | Histogram of prediction error (actual − predicted) |
| `trace_predicted_vs_actual.png`    | Scatter plot colored by confidence level           |
| `trace_accuracy_by_confidence.png` | MAE and ±10pt hit rate by confidence level         |

Requires at least 5 data points to run.

## Nightly pipeline integration

`make trace` is included in `make all`, which runs in GitHub Actions nightly
(01:45 UTC, Tue–Sat). The pipeline:

1. Fetches latest SPX closes for any new dates in `predictions.csv`
2. Regenerates accuracy plots with fresh data
3. Uploads `trace_*.png` to Vercel Blob alongside all other ML plots
4. Triggers `/api/ml/analyze-plots` — Claude Vision analyzes the plots and
   writes results to `ml_plot_analyses` DB table
5. Dashboard "TRACE Pin" tab reads from DB and displays the plots + analysis

Note: `extract_predictions.py` is **not** part of the nightly pipeline because
it requires manually provided screenshots. Run it locally after capturing new
images, then commit the results.

## Accuracy columns (accuracy_report.csv)

| Column                 | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `error`                | actual_close − predicted_close                              |
| `abs_error`            | Absolute value of error                                     |
| `direction_correct`    | Whether predicted direction (up/down from open) was correct |
| `hit_5pt` … `hit_20pt` | Whether actual close was within N points of prediction      |
