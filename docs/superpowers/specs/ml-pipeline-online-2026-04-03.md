# ML Pipeline Online — Design Spec

**Date:** 2026-04-03
**Scope:** Nightly ML pipeline automation, plot storage + Claude vision analysis, frontend carousel display

---

## Summary

Move the local-only ML pipeline to a nightly GitHub Actions workflow (M-F), upload generated plots to Vercel Blob, run Claude Sonnet vision analysis on each plot with rich per-plot context, store analyses in Postgres, and display everything in a new frontend carousel section.

### Goals

1. **Pipeline automation** — full pipeline (`health → eda → cluster → visualize → early → backtest → pin`) runs nightly after `build-features` cron completes, with manual dispatch available
2. **All scripts write findings** — every script outputs structured findings to a consolidated `findings.json` and upserts to the `ml_findings` DB table (currently only `eda.py` does this)
3. **Plots viewable online** — all PNGs uploaded to Vercel Blob, served to a frontend carousel
4. **Claude analysis per plot** — each of the ~21 plots gets a detailed, accurate analysis from Claude Sonnet using source code + underlying data + the image
5. **Calibration-ready** — architecture supports iterative calibration examples (empty initially, populated after first human review)

### Non-Goals

- Plot history / date browsing (overwrite latest only)
- Frontend "Run Pipeline" button (manual dispatch via GH Actions tab)
- GPU compute / model training (CPU-only pipeline)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Actions                              │
│  (cron: 01:45 UTC Tue-Sat / workflow_dispatch)                  │
│                                                                 │
│  1. Setup Python 3.13 + pip cache                               │
│  2. make -C ml all  (full pipeline against live Neon DB)        │
│  3. Upload ml/plots/*.png → Vercel Blob (ml-plots/latest/)     │
│  4. POST /api/ml/analyze-plots (trigger Claude vision pass)    │
│  5. Commit findings.json if changed                             │
└──────────────┬──────────────────────────┬───────────────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────┐    ┌──────────────────────────────────┐
│    Vercel Blob        │    │   Vercel Serverless (api/ml/)    │
│                       │    │                                  │
│  ml-plots/latest/     │    │  POST /analyze-plots             │
│    correlations.png   │    │    → list blobs under latest/    │
│    timeline.png       │    │    → fetch each PNG → base64     │
│    flow_reliability   │    │    → Claude Sonnet vision call   │
│    ... (21 total)     │    │    → upsert ml_plot_analyses     │
│                       │    │                                  │
│  (no history —        │    │  GET /plots                      │
│   overwrite on each   │    │    → blob URLs + analyses + find │
│   pipeline run)       │    │    → public, no auth             │
└──────────┬────────────┘    └──────────┬───────────────────────┘
           │                            │
           └────────────┬───────────────┘
                        ▼
              ┌─────────────────┐
              │   Neon Postgres  │
              │                  │
              │  ml_findings     │  (existing — expanded to all scripts)
              │  ml_plot_analyses│  (new table)
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────────────┐
              │  Frontend               │
              │  "ML Insights" carousel │
              │  - Tab groups by topic   │
              │  - Full analysis text    │
              │  - Findings summary      │
              └─────────────────────────┘
```

---

## Component Details

### 1. Python Pipeline Consolidation

#### Shared helper in `ml/src/utils.py`

New function `save_section_findings(section_name: str, data: dict)`:
- Read-modify-writes `ml/findings.json` (adds/updates the named section, preserves others)
- Updates top-level `generated_at` timestamp and `pipeline_sections` list
- Upserts the full consolidated JSON to `ml_findings` table (existing id=1 pattern)

#### Scripts to update

| Script | Section Name | Key Metrics to Capture |
|--------|-------------|----------------------|
| `health.py` | `health` | freshness per table, completeness trend, stationarity alerts (z-scores) |
| `eda.py` | `eda` | (existing) accuracy, calibration, flow reliability, top predictors |
| `clustering.py` | `clustering` | best k, silhouette/CH/DB scores, cluster profiles, chi-squared p-values |
| `phase2_early.py` | `phase2` | per-model accuracy table, walk-forward confusion matrix, top SHAP features |
| `visualize.py` | `plots` | plot manifest: `{ name, generated: bool, file_size_kb }` for each plot |
| `backtest.py` | `backtest` | per-strategy metrics: profit factor, win rate, max drawdown, total P&L |
| `pin_analysis.py` | `pin_analysis` | pin accuracy by method, gamma centroid vs peak gamma stats, asymmetry correlation |

#### Makefile update

Current `make all`: `eda cluster visualize`

New `make all`: `health eda cluster visualize early backtest pin`

Each target already exists individually. Just expand the `all` dependency list.

#### findings.json consolidated schema

```json
{
  "generated_at": "2026-04-04T01:50:00+00:00",
  "pipeline_sections": ["health", "eda", "clustering", "plots", "phase2", "backtest", "pin_analysis"],
  "dataset": {
    "total_days": 39,
    "labeled_days": 36,
    "date_range": ["2026-02-09", "2026-04-03"]
  },
  "health": { ... },
  "eda": { ... },
  "clustering": { ... },
  "plots": { ... },
  "phase2": { ... },
  "backtest": { ... },
  "pin_analysis": { ... }
}
```

### 2. GitHub Actions Workflow

**File:** `.github/workflows/ml-pipeline.yml`

**Schedule:** `cron: '45 1 * * 2-6'` — 01:45 UTC (9:45 PM ET), Tuesday through Saturday. This runs after the `build-features` cron (01:00 UTC / 9:00 PM ET) has populated `training_features` for Monday-Friday trading days.

**Manual trigger:** `workflow_dispatch` with no required inputs.

**Steps:**

1. `actions/checkout@v4`
2. `actions/setup-python@v5` with Python 3.13, pip cache
3. `pip install -r ml/requirements.txt`
4. `make -C ml all` — full pipeline. Env: `DATABASE_URL` from secrets
5. **Health gate** — if `make health` exits non-zero (stale data), skip remaining steps with annotation
6. Upload plots to Vercel Blob:
   - Use `@vercel/blob` via a small Node script or `curl` against the Blob API
   - Upload every `ml/plots/*.png` to `ml-plots/latest/{filename}`
   - Overwrite existing blobs (no history)
7. Trigger Claude analysis:
   - `curl -X POST $VERCEL_URL/api/ml/analyze-plots -H "Authorization: Bearer $CRON_SECRET"`
8. Commit `findings.json` if changed:
   - `git diff --quiet ml/findings.json || (git add ml/findings.json && git commit && git push)`
   - Use a bot identity for the commit

**Secrets required:**
- `DATABASE_URL` — Neon connection string
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob auth
- `CRON_SECRET` — authenticates the analyze-plots call
- `VERCEL_URL` — production URL for the API call

### 3. Vercel Blob Storage

**Prefix:** `ml-plots/latest/`

**Contents:** All PNGs from `ml/plots/` (~21 files, ~3 MB total)

**Behavior:** Each pipeline run overwrites all blobs under `latest/`. No date-organized history.

**Access:** Blob URLs are publicly readable (default Vercel Blob behavior). The GET endpoint returns these URLs directly to the frontend.

### 4. Database Migration

New table added via `migrateDb()` in `db-migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS ml_plot_analyses (
  plot_name TEXT PRIMARY KEY,
  blob_url TEXT NOT NULL,
  analysis TEXT NOT NULL,
  pipeline_date DATE NOT NULL,
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- Primary key on `plot_name` (no history — one row per plot, overwritten each run)
- `analysis` stores the full Claude response text
- `model` tracks which Claude model was used
- `pipeline_date` is the trading date the pipeline ran for

Also update `db.test.ts` per CLAUDE.md migration test pattern.

### 5. Plot Analysis Endpoint

**File:** `api/ml/analyze-plots.ts`

**Method:** POST

**Auth:** `CRON_SECRET` header (same pattern as existing crons)

**`maxDuration`:** 300 (21 plots × ~10-12s each, with buffer)

**Flow:**

1. Validate `CRON_SECRET`
2. List all blobs under `ml-plots/latest/` via `@vercel/blob` `list()`
3. Load findings from `ml_findings` table (for underlying data per plot)
4. For each plot (batched 3 at a time via `Promise.allSettled`):
   a. `fetch(blob.url)` → `arrayBuffer()` → `Buffer.from(...).toString('base64')`
   b. Look up plot name in `PLOT_REFERENCES` to get the source code + context
   c. Look up relevant findings section for this plot
   d. Build user message: plot name directive + underlying data + base64 image
   e. Call Claude Sonnet with cached system prompt + user message
   f. Parse response text
   g. Upsert into `ml_plot_analyses`
5. Return summary: `{ analyzed: number, failed: string[], duration_ms: number }`

**Error handling:** `Promise.allSettled` per batch — one failed plot doesn't block others. Failed plots are logged and returned in the response.

### 6. Prompt Architecture

#### Caching Strategy

```
System prompt (CACHED — one entry, reused across all 21 calls):
┌─────────────────────────────────────────────────────────────┐
│  PLOT_ANALYSIS_SYSTEM_PROMPT                                │
│  ├─ Role definition                                         │
│  ├─ Trading system overview                                 │
│  ├─ Analysis framework (5 sections)                         │
│  ├─ Uncertainty directive                                   │
│  ├─ Feature group definitions (from utils.py)               │
│  │                                                          │
│  ├─ <plot_reference name="correlations">                    │
│  │     <source_code>full generation code</source_code>      │
│  │     <feature_context>what features mean</feature_context>│
│  │     <analysis_guidance>what to focus on</analysis_guidance>
│  │     <calibration_example/>                               │
│  │  </plot_reference>                                       │
│  ├─ ... (21 plot_reference blocks total)                    │
│  │                                                          │
│  └─ Output format instructions                              │
│                                                             │
│  cache_control: { type: 'ephemeral', ttl: '1h' }           │
└─────────────────────────────────────────────────────────────┘

User message (PER-PLOT — varies for each of 21 calls):
┌─────────────────────────────────────────────────────────────┐
│  "Analyze the plot: {plot_name}"                            │
│                                                             │
│  <underlying_data>                                          │
│  {relevant findings.json section as JSON}                   │
│  Dataset: {total_days} days, {labeled_days} labeled         │
│  Date range: {start} to {end}                               │
│  </underlying_data>                                         │
│                                                             │
│  [base64 PNG image]                                         │
└─────────────────────────────────────────────────────────────┘
```

- Call 1: cache write (~30-60K tokens at full input price)
- Calls 2-21: cache read (97% discount on system prompt tokens)
- User messages are small: plot name + findings slice + image

#### System prompt structure

**File:** `api/_lib/plot-analysis-prompts.ts`

```
PLOT_ANALYSIS_SYSTEM_PROMPT:

  Role: You are an ML pipeline analyst for a 0DTE SPX options trading
  system. You analyze visualization output from a Python ML pipeline
  that processes 100+ daily features spanning volatility, GEX, flow,
  dark pool, options volume, and IV dynamics. Your analyses will be
  read by the system developer and may inform future trading rules
  and prompt calibration.

  Trading System Context:
  - Selects one of three credit spread structures daily: PCS, CCS, IC
  - Uses Claude Opus with a 23K-token system prompt for live analysis
  - ML findings feed back into the live prompt as calibration data
  - Pipeline processes 39+ trading days of feature data
  - Features are built by automated cron jobs from Schwab, UW, and
    dark pool APIs

  Analysis Framework:
  For each plot, provide these 5 sections:

  1. VISUALIZATION DESCRIPTION
     What type of plot this is. What the axes represent. What colors,
     shapes, or sizes encode. How to read the layout. Reference the
     source code to confirm visual encodings — do not guess.

  2. DATA INPUTS
     What tables and features feed this visualization. Any preprocessing
     (scaling, PCA, imputation, filtering). Sample size and date range.
     Reference the source code for exact data loading and transformation.

  3. STATISTICAL INTERPRETATION
     What patterns are visible. Statistical significance where applicable.
     Anomalies, outliers, or regime shifts. Compare visual patterns to
     the underlying numerical data provided — flag any discrepancies.

  4. TRADING SYSTEM IMPLICATIONS
     How these findings relate to structure selection, confidence
     calibration, rule validation, or feature engineering. Be specific
     about which trading decisions this data should influence. Connect
     findings to the three-structure model (PCS/CCS/IC) and the
     confidence tiers (HIGH/MODERATE/LOW).

  5. CAVEATS & LIMITATIONS
     Sample size concerns. Potential confounders. What would change
     these conclusions. Multiple comparison issues if relevant.
     Be explicit about what you cannot determine from the data shown.

  Uncertainty Directive:
  If you cannot read an axis label, determine a color encoding, or
  understand what a visual element represents — say so explicitly.
  State what you can determine and what you cannot. A flagged
  uncertainty is infinitely more useful than a confident wrong answer.
  The source code and underlying data are ground truth. The image is
  confirmation. If the image contradicts the data, trust the data and
  note the discrepancy.

  Feature Group Definitions:
  {VOLATILITY_FEATURES, GEX_FEATURES_T1T2, GREEK_FEATURES_CORE,
   DARK_POOL_FEATURES, OPTIONS_VOLUME_FEATURES, IV_PCR_FEATURES,
   FLOW_FEATURES_T1T2, MAX_PAIN_FEATURES, OI_CHANGE_FEATURES,
   VOL_SURFACE_FEATURES — all copied from utils.py constants}

  <plot_reference name="correlations">
    <source_code>
    {extracted from visualize.py — the full function that generates
     correlations.png, including data loading, feature selection,
     correlation computation, masking, and seaborn heatmap call}
    </source_code>
    <feature_context>
    Pearson correlation matrix of all ML features. Features grouped
    by category. High within-group correlation is expected (e.g.,
    gex_oi_t1 and gex_vol_t1 measure similar things). Cross-group
    correlations are the interesting signals — they reveal hidden
    relationships between market microstructure dimensions.
    </feature_context>
    <analysis_guidance>
    Focus on: (1) cross-group correlations above |0.5|, (2) features
    with low correlation to everything (independent signals), (3) any
    surprising decorrelations within groups, (4) potential multicollinearity
    issues for the Phase 2 classifiers.
    </analysis_guidance>
    <calibration_example/>
  </plot_reference>

  <plot_reference name="flow_reliability">
    ...
  </plot_reference>

  ... (21 total plot_reference blocks)

  Output Format:
  Respond with a JSON object:
  {
    "visualization": "...",
    "data_inputs": "...",
    "interpretation": "...",
    "implications": "...",
    "caveats": "..."
  }
  Each field should be 2-4 paragraphs of substantive analysis.
  Do not pad with filler. Every sentence should add information.
```

#### Per-plot context blocks

**File:** `api/_lib/plot-analysis-context.ts`

Contains `PLOT_REFERENCES: Record<string, PlotReference>` mapping each plot name to:

```typescript
interface PlotReference {
  sourceCode: string;       // Full Python function that generates this plot
  featureContext: string;   // What the features/data mean in trading terms
  analysisGuidance: string; // What to focus on, what's signal vs noise
  findingsKeys: string[];   // Which findings.json sections are relevant
  calibrationExample: string; // Initially empty, populated after first review
}
```

#### Calibration examples

**File:** `api/_lib/plot-analysis-calibration.ts`

Initially exports empty strings for all 21 plots. After the first pipeline run:
1. Review Claude's uncalibrated analyses
2. Edit each into what you actually wanted (adjust emphasis, add trading implications, correct any misreadings)
3. Those edited analyses become the calibration examples
4. They get injected into the `<calibration_example>` tags in the system prompt (still within the cached block)

### 7. Plots Read Endpoint

**File:** `api/ml/plots.ts`

**Method:** GET

**Auth:** None (public read, matches existing data endpoint pattern)

**Response:**

```json
{
  "plots": [
    {
      "name": "correlations",
      "blobUrl": "https://abc.public.blob.vercel-storage.com/ml-plots/latest/correlations.png",
      "analysis": {
        "visualization": "...",
        "data_inputs": "...",
        "interpretation": "...",
        "implications": "...",
        "caveats": "..."
      },
      "model": "claude-sonnet-4-6",
      "pipelineDate": "2026-04-03",
      "updatedAt": "2026-04-04T01:55:00Z"
    },
    ...
  ],
  "findings": { /* full consolidated findings.json from ml_findings table */ },
  "pipelineDate": "2026-04-03"
}
```

### 8. Frontend — ML Insights Carousel

**New files:**

```
src/components/ml-insights/
  MLInsights.tsx          Main container, data fetching
  PlotCarousel.tsx        Tab navigation + image display
  PlotAnalysis.tsx        Renders the 5-section analysis text
  FindingsSummary.tsx     Top-level metrics overview
```

**Design:**

- Carousel with tab groups by topic:

| Group | Plots |
|-------|-------|
| Overview | timeline, stationarity, correlations |
| Regime | range_by_regime, gex_vs_range, day_of_week |
| Flow & Pool | flow_reliability, dark_pool_vs_range |
| Performance | structure_confidence, confidence_over_time, backtest_equity, failure_heatmap |
| Clustering | clusters_pca, clusters_heatmap, feature_importance_comparison |
| Pin Risk | pin_settlement, pin_time_decay, pin_composite |
| Transitions | prev_day_transition, cone_consumption |

- Active plot displayed large with analysis text below
- Analysis text rendered as 5 labeled sections (Visualization, Data Inputs, Interpretation, Implications, Caveats)
- Findings summary card at top showing: pipeline date, dataset stats, overall accuracy, health status
- Dark theme (matches existing app styling)
- Lazy-loads plot images (only fetch blob URL when tab is active)

**Data fetching:** New `useMLInsights` hook calls `GET /api/ml/plots` on mount. No polling (data only changes once nightly). Optional manual refresh button.

---

## Build Order

| Phase | Scope | Files | Testable In Isolation? |
|-------|-------|-------|----------------------|
| **1** | Python: `save_section_findings()` helper + wire up all 7 scripts | `ml/src/utils.py`, `ml/src/health.py`, `ml/src/clustering.py`, `ml/src/phase2_early.py`, `ml/src/visualize.py`, `ml/src/backtest.py`, `ml/src/pin_analysis.py` | Yes — `make all` locally |
| **2** | Makefile: expand `make all` | `ml/Makefile` | Yes — `make all` locally |
| **3** | DB migration: `ml_plot_analyses` table | `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts` | Yes — POST `/api/journal/init` |
| **4** | Plot analysis system prompt | `api/_lib/plot-analysis-prompts.ts` | No runtime test needed |
| **5** | Plot context blocks (21 source code extractions) | `api/_lib/plot-analysis-context.ts` | No runtime test needed |
| **6** | Plot calibration stubs | `api/_lib/plot-analysis-calibration.ts` | No runtime test needed |
| **7** | Analyze-plots endpoint | `api/ml/analyze-plots.ts` | Yes — `curl` with CRON_SECRET |
| **8** | Plots read endpoint | `api/ml/plots.ts` | Yes — `curl` |
| **9** | GitHub Actions workflow | `.github/workflows/ml-pipeline.yml` | Yes — manual dispatch |
| **10** | Frontend carousel | `src/components/ml-insights/`, `src/hooks/useMLInsights.ts` | Yes — dev server |

Phases 1-2 are Python-only. Phases 3-8 are TypeScript backend. Phase 9 is infra. Phase 10 is frontend. Each phase is independently verifiable.

---

## Cost Estimate

**Claude Sonnet vision (per pipeline run):**

| Component | Tokens | Cost |
|-----------|--------|------|
| System prompt (cache write, call 1) | ~50K | $0.15 |
| System prompt (cache read, calls 2-21) | ~50K × 20 | $0.03 |
| User messages (21 calls) | ~2K each | $0.13 |
| Output (21 calls) | ~1K each | $0.06 |
| **Total per run** | | **~$0.37** |

After calibration examples added (~80K system prompt): **~$0.60/run**

Nightly M-F ≈ 22 runs/month ≈ **$8-13/month**

**Vercel Blob storage:** ~3 MB (21 PNGs) — negligible

**GitHub Actions:** ~5 min/run × 22 runs/month — well within free tier

---

## Open Items (Post-First-Run)

1. **Write calibration examples** — review first uncalibrated output, edit into gold-standard examples, add to `plot-analysis-calibration.ts`
2. **Tune analysis guidance** — adjust per-plot `analysisGuidance` based on what Claude focuses on vs what you want
3. **Add SHAP plot** — `phase2_shap.png` may or may not be generated depending on SHAP availability; handle gracefully
4. **Bot protection** — add `/api/ml/plots` to `initBotId()` protect array if needed (currently public read)
5. **Milestone check** — decide whether `milestone_check.py` should also be in the pipeline (currently not in `make all`)
