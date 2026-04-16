/**
 * System prompt for the ML plot analysis endpoint.
 *
 * This is the cached system prompt used for ALL 21 plot analysis calls.
 * It contains the full source code that generates each plot so Claude
 * can cross-reference visual elements against the code that produced
 * them. The entire prompt is cached with ephemeral TTL — calls 2-21
 * read from cache at ~97% cost reduction.
 *
 * The per-plot user message contains only: plot name directive,
 * underlying findings data, and the base64 PNG image.
 */

import { PLOT_CALIBRATIONS } from './plot-analysis-calibration.js';

// ── Feature Group Definitions (from ml/src/utils.py) ─────────

const FEATURE_GROUPS = `
<feature_groups>
VOLATILITY_FEATURES:
  vix — CBOE Volatility Index (30-day implied vol of SPX options). Higher = wider expected ranges, more premium but more risk.
  vix1d — 1-day VIX. Measures expected move for today only. When vix1d << vix, market expects today to be calmer than the 30-day average (VIX1D inversion = favorable for premium selling).
  vix1d_vix_ratio — VIX1D / VIX. Values < 0.7 signal extreme inversion (historically very favorable for credit spreads). Values > 1.0 signal today is expected to be more volatile than average.
  vix_vix9d_ratio — VIX / VIX9D. Measures the term structure slope of near-term volatility.

GEX_FEATURES_T1T2 (Gamma Exposure at checkpoint 1 and 2):
  gex_oi_t1, gex_oi_t2 — Net gamma exposure from open interest. Positive = dealers long gamma (price suppression, walls reliable). Negative = dealers short gamma (price acceleration, walls may fail).
  gex_vol_t1, gex_vol_t2 — Net gamma from intraday volume. Divergence from OI gamma signals regime change mid-session.
  gex_dir_t1, gex_dir_t2 — Directionalized volume gamma. Combines volume gamma with the direction of the underlying move.

GREEK_FEATURES_CORE:
  agg_net_gamma — Aggregate net gamma across all expirations. The macro regime context for per-strike walls.
  dte0_net_charm — Net charm exposure for 0DTE options. Measures how gamma walls evolve with time.
  dte0_charm_pct — Charm as percentage of gamma. High values mean walls are decaying rapidly.
  charm_slope — Slope of charm across strikes. Positive slope below ATM + negative above = CCS-confirming pattern.

DARK_POOL_FEATURES:
  dp_total_premium — Total dark pool block trade premium ($). Large values indicate heavy institutional positioning.
  dp_cluster_count — Number of distinct dark pool price clusters. More clusters = more institutional consensus on levels.
  dp_top_cluster_dist — Distance (pts) from price to the largest dark pool cluster. Close clusters act as immediate support/resistance.
  dp_support_premium — Premium at buyer-initiated dark pool levels (structural support).
  dp_resistance_premium — Premium at seller-initiated dark pool levels (structural resistance).
  dp_support_resistance_ratio — Support / Resistance premium ratio. Values > 1 = more support than resistance (bullish structure).
  dp_concentration — Fraction of total dark pool premium in the top cluster. High concentration = single dominant institutional level.

OPTIONS_VOLUME_FEATURES:
  opt_call_volume, opt_put_volume — Raw call/put option volume.
  opt_call_oi, opt_put_oi — Open interest for calls and puts.
  opt_call_premium, opt_put_premium — Dollar premium traded.
  opt_bullish_premium, opt_bearish_premium — Premium classified by trade direction (ask-side vs bid-side).
  opt_call_vol_ask, opt_put_vol_bid — Volume at ask (bullish) and bid (bearish).
  opt_vol_pcr — Volume put/call ratio. Values > 1 = more puts than calls being traded.
  opt_oi_pcr — OI put/call ratio. Structural positioning bias.
  opt_premium_ratio — Call premium / put premium ratio. Values > 1 = more capital flowing to calls.
  opt_call_vol_vs_avg30, opt_put_vol_vs_avg30 — Volume relative to 30-day average. Values > 2 = unusually heavy activity.

IV_PCR_FEATURES:
  iv_open — Implied volatility at market open.
  iv_max — Peak IV during the session.
  iv_range — IV high minus low. Wide range = volatile IV regime.
  iv_crush_rate — Rate of IV decline from peak. Fast crush = favorable for premium sellers.
  iv_spike_count — Number of IV spikes during the session.
  iv_at_t2 — IV level at checkpoint 2 (mid-morning).
  pcr_open through pcr_spike_count — Put/call ratio dynamics throughout the session.
  pcr_trend_t1_t2 — PCR direction from checkpoint 1 to 2. Rising PCR associated with 64% UP settlement; falling with 31% UP.

MAX_PAIN_FEATURES:
  max_pain_0dte — The strike where total option holder losses are maximized. Settlement gravitates here in the final 2 hours.
  max_pain_dist — Distance from current price to max pain (pts). Negative = price above max pain.

OI_CHANGE_FEATURES:
  oic_net_oi_change — Net change in open interest (new positions being opened).
  oic_call_oi_change, oic_put_oi_change — Directional OI changes.
  oic_oi_change_pcr — Put/call ratio of OI changes.
  oic_net_premium — Net premium of OI changes.
  oic_ask_ratio — Fraction of OI changes at the ask (aggressive buying).
  oic_multi_leg_pct — Fraction of changes from multi-leg strategies (institutional).
  oic_top_strike_dist — Distance to the strike with the largest OI change.
  oic_concentration — How concentrated OI changes are at a single strike.

VOL_SURFACE_FEATURES:
  iv_ts_slope_0d_30d — IV term structure slope (0DTE vs 30DTE). Steep slope = market expects near-term vol.
  iv_ts_contango — Whether the IV term structure is in contango (normal) or backwardation (stressed).
  iv_ts_spread — Spread between 0DTE and 30DTE IV.
  uw_rv_30d — 30-day realized volatility.
  uw_iv_rv_spread — IV minus RV spread. Positive = IV-rich (premium sellers overcompensated).
  uw_iv_overpricing_pct — How much IV exceeds RV as a percentage. Higher = better for premium selling.
  iv_rank — IV percentile rank over 52 weeks. High rank = elevated vol environment.
</feature_groups>
`;

// ── Source Code Blocks (extracted from Python scripts) ────────

const SRC_CORRELATIONS = `def plot_correlation_heatmap(df: pd.DataFrame) -> None:
    features = [
        "vix", "vix1d", "vix1d_vix_ratio",
        "gex_oi_t1", "gex_dir_t1", "gex_vol_t1",
        "agg_net_gamma", "charm_slope", "dte0_charm_pct",
        "flow_agreement_t1", "mt_ncp_t1",
        "spx_ncp_t1", "spy_ncp_t1", "qqq_ncp_t1",
        "spy_etf_ncp_t1",
        "dp_total_premium", "dp_support_resistance_ratio",
        "dp_concentration",
        "opt_vol_pcr", "opt_premium_ratio",
        "iv_open", "iv_crush_rate",
        "max_pain_dist",
        "day_range_pts",
    ]
    available = [f for f in features if f in df.columns]
    subset = df[available].dropna(axis=0, how="all").astype(float)

    labels = {
        "vix1d_vix_ratio": "VIX1D/VIX",
        "gex_oi_t1": "GEX OI", "gex_dir_t1": "GEX Dir",
        "gex_vol_t1": "GEX Vol", "agg_net_gamma": "Agg Gamma",
        "charm_slope": "Charm Slope", "dte0_charm_pct": "0DTE Charm%",
        "flow_agreement_t1": "Flow Agree", "mt_ncp_t1": "Mkt Tide",
        "spx_ncp_t1": "SPX Flow", "spy_ncp_t1": "SPY Flow",
        "qqq_ncp_t1": "QQQ Flow", "spy_etf_ncp_t1": "SPY ETF",
        "dp_total_premium": "DP Premium",
        "dp_support_resistance_ratio": "DP S/R Ratio",
        "dp_concentration": "DP Conc.",
        "opt_vol_pcr": "Opt PCR", "opt_premium_ratio": "Prem Ratio",
        "iv_open": "IV Open", "iv_crush_rate": "IV Crush",
        "max_pain_dist": "Max Pain Dist", "day_range_pts": "Day Range",
    }

    corr = subset.corr()
    corr = corr.rename(index=labels, columns=labels)

    fig, ax = plt.subplots(figsize=(14, 12))
    mask = np.triu(np.ones_like(corr, dtype=bool))
    sns.heatmap(corr, mask=mask, annot=True, fmt=".2f", cmap="RdBu_r",
                center=0, vmin=-1, vmax=1, square=True, ax=ax,
                linewidths=0.5, annot_kws={"size": 8},
                cbar_kws={"shrink": 0.8})
    ax.set_title("Feature Correlations (incl. Dark Pool, Options, IV)")`;

const SRC_RANGE_BY_REGIME = `def plot_range_by_regime(df: pd.DataFrame) -> None:
    has_range = df[df["day_range_pts"].notna()].copy()
    has_range["day_range_pts"] = has_range["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 3, figsize=(16, 5))

    # Panel 1: By charm pattern
    charm_data = has_range[has_range["charm_pattern"].notna()]
    order = ["all_negative", "mixed", "ccs_confirming",
             "pcs_confirming", "all_positive"]
    order = [o for o in order if o in charm_data["charm_pattern"].values]
    sns.boxplot(data=charm_data, x="charm_pattern", y="day_range_pts",
                order=order, ...)
    sns.swarmplot(data=charm_data, x="charm_pattern", y="day_range_pts",
                  order=order, color="white", ...)

    # Panel 2: By VIX regime
    has_vix["VIX Regime"] = pd.cut(has_vix["vix_f"],
        bins=[0, 18, 22, 26, 50],
        labels=["<18 (Low)", "18-22 (Normal)",
                "22-26 (Elevated)", ">26 (High)"])
    sns.boxplot(data=has_vix, x="VIX Regime", y="day_range_pts", ...)

    # Panel 3: By GEX regime
    has_gex["gex_f"] = has_gex["gex_oi_t1"].astype(float) / 1e9
    has_gex["GEX Regime"] = pd.cut(has_gex["gex_f"],
        bins=[-200, -50, 0, 200],
        labels=["Deep Neg (<-50B)", "Mild Neg (-50 to 0)",
                "Positive (>0)"])
    sns.boxplot(data=has_gex, x="GEX Regime", y="day_range_pts", ...)

    fig.suptitle("What Drives Day Range?")`;

const SRC_FLOW_RELIABILITY = `def plot_flow_reliability(df: pd.DataFrame) -> None:
    has_flow = df[df["settlement_direction"].notna()].copy()

    sources = [
        ("spy_etf_ncp_t1", "SPY ETF Tide"),
        ("qqq_etf_ncp_t1", "QQQ ETF Tide"),
        ("mt_ncp_t1", "Market Tide"),
        ("qqq_ncp_t1", "QQQ Net Flow"),
        ("zero_dte_ncp_t1", "0DTE Index"),
        ("spy_ncp_t1", "SPY Net Flow"),
        ("spx_ncp_t1", "SPX Net Flow"),
    ]

    # For each source: compute directional accuracy
    # correct = ((ncp > 0) == actual_up).sum()
    # Wilson confidence intervals computed per source
    # Significant if CI excludes 0.50

    # Colors: green (>55%), gray (45-55%), red (<45%)
    # Horizontal bar chart sorted by accuracy ascending
    # 50% "coin flip" reference line
    # Bar labels: "61% (n=36)*" format
    # Footer: "Trust: X, Y | Fade: Z | * = significant"`;

const SRC_GEX_VS_RANGE = `def plot_gex_vs_range(df: pd.DataFrame) -> None:
    subset = df[["gex_oi_t1", "day_range_pts", "charm_pattern",
                 "structure_correct"]].dropna()
    subset["gex_b"] = subset["gex_oi_t1"].astype(float) / 1e9
    subset["range"] = subset["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Left: colored by charm pattern
    for pattern in sorted(subset["charm_pattern"].unique()):
        mask = subset["charm_pattern"] == pattern
        color = CHARM_COLORS.get(pattern, COLORS["gray"])
        ax.scatter(subset.loc[mask, "gex_b"],
                   subset.loc[mask, "range"], c=color, ...)
    ax.axvline(x=0, color="#555", linestyle="--")

    # Right: colored by structure correctness
    # Green dots = correct, Red X = incorrect
    ax.scatter(correct["gex_b"], correct["range"],
               c=COLORS["green"], label="Correct", ...)
    ax.scatter(incorrect["gex_b"], incorrect["range"],
               c=COLORS["red"], label="Incorrect", marker="X", ...)

    fig.suptitle("GEX Regime and Day Outcomes")`;

const SRC_TIMELINE = `def plot_timeline(df: pd.DataFrame) -> None:
    has_data = df[df["day_range_pts"].notna()].copy()
    fig, axes = plt.subplots(4, 1, figsize=(16, 12), sharex=True)

    # Panel 1: Day range bars colored by correctness
    #   Blue = correct, Red = incorrect, Orange = extreme range
    #   Structure labels (PCS/CCS/IC) on each bar
    #   "MISS" annotation on failures
    #   Red shading on failure days spans ALL 4 panels

    # Panel 2: VIX and VIX1D line charts
    #   Red line = VIX, Cyan line = VIX1D
    #   Orange dotted = caution (22), Red dotted = stop (26)

    # Panel 3: GEX OI bars (billions)
    #   Green = positive, Red = negative
    #   Red dotted at -50B (deep negative threshold)

    # Panel 4: Flow Agreement bars (of 9 sources)
    #   Green >= 6, Blue >= 4, Red < 4
    #   Orange dotted at 4 (minimum consensus threshold)

    # X-axis: date labels (MM/DD format)
    # Footer: "N days | X/Y correct | avg range Z pts"`;

const SRC_STRUCTURE_CONFIDENCE = `def plot_structure_confidence(df: pd.DataFrame) -> None:
    labeled = df[df["structure_correct"].notna()].copy()
    fig, axes = plt.subplots(1, 2, figsize=(13, 5))

    # Left: Structure accuracy (stacked horizontal bars)
    structs = ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"]
    # Green bars = correct count, red bars = incorrect count
    # Labels: "13/13 (100%)" format

    # Right: Confidence calibration (vertical bars with error bars)
    conf_order = ["HIGH", "MODERATE", "LOW"]
    # Green/Orange/Red bars
    # Wilson confidence intervals as error bars
    # Faded bars if n < 3 (unreliable)
    # Labels: "96% (n=23)" format
    # 50% reference line

    fig.suptitle("Structure & Confidence Performance")`;

const SRC_DAY_OF_WEEK = String.raw`def plot_day_of_week(df: pd.DataFrame) -> None:
    has_range = df[df["day_range_pts"].notna()].copy()
    has_range["dow"] = has_range["day_of_week"].astype(int)
    day_names = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri"}

    fig, ax = plt.subplots(figsize=(8, 5))
    order = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    palette = [red, blue, green, orange, purple]

    sns.boxplot(data=has_range, x="day_name", y="range",
                order=order, ...)
    sns.swarmplot(data=has_range, x="day_name", y="range",
                  order=order, color="white", ...)

    # Labels: "avg X / med Y\nn=Z" above each box
    ax.set_title("Range by Day of Week")`;

const SRC_STATIONARITY = `def plot_stationarity(df: pd.DataFrame) -> None:
    features = {
        "vix": ("VIX", red),
        "gex_oi_t1": ("GEX OI (B)", green),       # scaled /1e9
        "day_range_pts": ("Day Range (pts)", blue),
        "flow_agreement_t1": ("Flow Agreement", orange),
        "dp_total_premium": ("DP Premium", purple), # scaled /1e6
        "opt_vol_pcr": ("Options PCR", cyan),
        "iv_open": ("IV Open", pink),
    }

    # One panel per feature, all sharing x-axis
    # Each panel shows:
    #   - Raw values (light, with dots)
    #   - Rolling mean (bold line, window=min(10, n//3))
    #   - Overall mean reference (dotted horizontal)
    # X-axis: date labels

    fig.suptitle("Feature Stationarity Check (Rolling Means)")`;

const SRC_FAILURE_HEATMAP = String.raw`def plot_failure_heatmap(df: pd.DataFrame) -> None:
    # Filter to days with GEX, VIX, and structure_correct
    has_data["gex_b"] = has_data["gex_oi_t1"].astype(float) / 1e9
    has_data["vix_f"] = has_data["vix"].astype(float)

    gex_bins = [-100, -50, -25, 0, 100]
    gex_labels = ["< -50B", "-50 to -25B", "-25 to 0", "> 0"]
    vix_bins = [0, 20, 24, 35]
    vix_labels = ["< 20", "20-24", "> 24"]

    # Compute accuracy rate per GEX x VIX cell
    # Display as imshow heatmap with RdYlGn colormap (0.5 to 1.0)
    # Cell annotations: "83%\nn=6" format
    # Dark text on bright cells, light text on dark cells

    ax.set_title("Structure Accuracy by GEX x VIX Regime")`;

const SRC_DARK_POOL_VS_RANGE = `def plot_dark_pool_vs_range(df: pd.DataFrame) -> None:
    has_data["dp_m"] = has_data["dp_total_premium"].astype(float) / 1e9
    has_data["range"] = has_data["day_range_pts"].astype(float)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Left: colored by support/resistance ratio
    # Green = support > resistance (S/R ratio > 1.0)
    # Red = resistance >= support (S/R ratio <= 1.0)
    ax.set_xlabel("Dark Pool Total Premium ($B)")
    ax.set_title("DP Premium vs Range, by S/R Ratio")

    # Right: colored by structure correctness
    # Green dots = correct, Red X = incorrect
    ax.set_title("DP Premium vs Range, by Correctness")

    fig.suptitle("Dark Pool Institutional Activity and Day Outcomes")`;

const SRC_CONE_CONSUMPTION = String.raw`def plot_cone_consumption(df: pd.DataFrame) -> None:
    # Uses "opening_range_pct_consumed" feature
    has_data["cone_pct"] = has_data["opening_range_pct_consumed"]

    fig, axes = plt.subplots(1, 2, figsize=(13, 5))

    # Left: overlapping histograms by correctness
    bins = np.arange(0, 1.1, 0.1)
    ax.hist(correct, bins=bins, color=green, alpha=0.7, ...)
    ax.hist(incorrect, bins=bins, color=red, alpha=0.7, ...)
    ax.axvline(x=0.65, color=orange, linestyle="--",
               label="Danger zone (65%)")

    # Right: accuracy by cone consumption bucket
    # Buckets: <30%, 30-50%, 50-65%, >65%
    # Green/Blue/Orange/Red bars
    # Labels: "83%\n(n=6)" format

    fig.suptitle("Does Entering Late in the Cone Hurt Accuracy?")`;

const SRC_PREV_DAY_TRANSITION = `def plot_prev_day_transition(df: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Left: prev day range vs today's range
    # Green dots = correct, Red X = incorrect
    # Diagonal "same range" reference line
    ax.set_title("Range Persistence: Yesterday -> Today")

    # Right: prev day VIX change vs today's range
    # Red dots = positive VIX change (vol rising)
    # Green dots = negative VIX change (vol falling)
    # Red X markers = structure failures (overlaid)
    # Vertical line at x=0
    ax.set_title("VIX Momentum -> Today's Range")

    fig.suptitle("Does Yesterday Predict Today?")`;

const SRC_CONFIDENCE_OVER_TIME = `def plot_confidence_over_time(df: pd.DataFrame) -> None:
    labeled = df[df["structure_correct"].notna()].copy()
    labeled["correct"] = labeled["structure_correct"].astype(float)

    fig, ax = plt.subplots(figsize=(14, 5))

    window = min(10, len(labeled) // 2)

    # Overall rolling accuracy (solid blue line)
    rolling_acc = labeled["correct"].rolling(window, min_periods=3).mean()

    # Per-confidence rolling (dashed lines)
    # GREEN dashed = HIGH confidence rolling
    # ORANGE dashed = MODERATE confidence rolling

    # Red triangle markers at y=0 for each failure day
    ax.axhline(y=0.90, color=cyan, linestyle=":",
               label="90% target")

    ax.set_title("Confidence Calibration Over Time")`;

const SRC_FEATURE_IMPORTANCE_COMPARISON = `def plot_feature_importance_comparison(df: pd.DataFrame) -> None:
    # EDA: point-biserial correlation with structure_correct
    for col in feature_cols:
        r, _p = stats.pointbiserialr(target, vals)
        eda_scores[col] = abs(r)
    eda_top = sorted(eda_scores.items(), key=lambda x: x[1],
                     reverse=True)[:15]

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Left: EDA correlation ranking (blue horizontal bars)
    # Normalized |r| values, raw r values as text labels

    # Right: XGBoost gain ranking (orange horizontal bars)
    # Read from latest ml/experiments/phase2_early_*.json
    # Cyan border on features that appear in BOTH lists

    fig.suptitle("Where Do Statistics and ML Agree?")
    # Footer: "Cyan border = feature appears in both top lists"`;

const SRC_BACKTEST_EQUITY = `def plot_equity_curves(strategies, metrics) -> None:
    fig, ax = plt.subplots(figsize=(14, 7))

    strategy_colors = {
        "Claude Analysis": green,
        "Majority Class (CCS)": orange,
        "Equal Size": blue,
    }

    # Line plot for each strategy's cumulative P&L
    for name, trades in strategies.items():
        ax.plot(trades.index, trades["cumulative"],
                label=name, color=color, linewidth=2)

    # Red shaded area for max drawdown period (Claude Analysis)
    ax.axvspan(peak_date, trough_date, alpha=0.15, color=red)

    # Metrics text box (top-left):
    #   Total P&L, Win Rate, Profit Factor, Max DD, Avg Win/Loss

    # Trade model: SPREAD_WIDTH=20 pts, CREDIT=$2.00/contract
    # MAX_LOSS = (20*100) - 200 = $1,800/contract
    # CONFIDENCE_SIZING: HIGH=2x, MODERATE=1x, LOW=1x

    ax.set_title("0DTE Credit Spread Backtest: Equity Curves")`;

const SRC_CLUSTERS_PCA = `def save_plots(X_pca, labels, k, df) -> None:
    # PCA scatter (PC1 vs PC2)
    fig, ax = plt.subplots(1, 1, figsize=(10, 7))
    colors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"]

    for i in range(k):
        mask = labels == i
        ax.scatter(X_pca[mask, 0], X_pca[mask, 1],
                   c=colors[i % len(colors)],
                   label=f"Cluster {i} (n={mask.sum()})",
                   s=80, alpha=0.8, edgecolors="white")

        # 95% confidence ellipse (chi-squared with 2 dof at 0.05)
        _draw_confidence_ellipse(ax, X_pca[mask, 0],
                                 X_pca[mask, 1], colors[i])

        # Date annotations (MM/DD) on each point
        for j, (x, y) in enumerate(zip(X_pca[mask, 0], X_pca[mask, 1])):
            ax.annotate(dates[j].strftime("%m/%d"), (x, y), ...)

    # Preprocessing: Pipeline([
    #   SimpleImputer(strategy="median"),
    #   StandardScaler(),
    #   PCA(n_components=0.85, random_state=42)
    # ])
    # ~100+ features -> N PCA components capturing 85% variance
    # K-Means with n_init=20, random_state=42

    ax.set_title(f"Day Type Clusters (k={k}, PCA projection)")`;

const SRC_CLUSTERS_HEATMAP = `def save_plots(X_pca, labels, k, df) -> None:
    # Cluster feature heatmap
    summary_features = [
        "vix", "vix1d_vix_ratio", "gex_oi_t1",
        "flow_agreement_t1", "charm_slope", "agg_net_gamma",
        "dp_support_resistance_ratio", "opt_vol_pcr", "iv_open",
    ]

    means = df_c.groupby("cluster")[available].mean().astype(float)
    # Z-score the means: (means - means.mean()) / means.std()
    means_z = (means - means.mean()) / means.std()

    fig2, ax2 = plt.subplots(1, 1, figsize=(8, max(3, k * 1.2)))
    im = ax2.imshow(means_z.values, cmap="RdBu_r", aspect="auto",
                    vmin=-2, vmax=2)
    ax2.set_title("Cluster Feature Profiles (z-scored)")`;

const SRC_PHASE2_SHAP = `def generate_shap_plot(model, X, plot_dir) -> bool:
    # Uses shap.TreeExplainer on the XGBoost model
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)

    # For multi-class, shap_values is a list of arrays
    # Select the class with the most variance in SHAP values
    if isinstance(shap_values, list):
        variances = [np.var(sv) for sv in shap_values]
        best_class = int(np.argmax(variances))
        shap.summary_plot(shap_values[best_class], X,
                          show=False, max_display=15)
    else:
        shap.summary_plot(shap_values, X, show=False, max_display=15)

    # SHAP beeswarm: each dot is one day, x = SHAP value,
    # color = feature value (blue=low, red=high)
    # Top 15 features by mean |SHAP|

    # XGBoost multiclass: PCS=0, CCS=1, IC=2
    # Walk-forward cross-validation (TimeSeriesSplit)
    # Features: 100+ from ALL_NUMERIC_FEATURES + one-hot charm`;

const SRC_PIN_SETTLEMENT = `# Pin settlement plot generation:
    # Scatter of prox-centroid prediction error vs abs error
    fig, ax = plt.subplots(figsize=(10, 7))

    for tier in ("HIGH", "MEDIUM", "LOW"):
        subset = conf_df[conf_df["confidence"] == tier]
        ax.scatter(subset["error"], subset["error"].abs(),
                   c=conf_colors[tier],
                   label=f"{tier} ({len(subset)})")

    # Reference bands:
    ax.axhspan(0, 10, color=green, alpha=0.08,
                label="Within +/-10 pts")
    ax.axhspan(10, 20, color=orange, alpha=0.06,
                label="Within +/-20 pts")
    ax.axvline(0, color="#666", linewidth=0.8, linestyle="--")

    # Confidence tiers based on 0DTE-1DTE centroid disagreement:
    #   HIGH: disagreement <= 10 pts
    #   MEDIUM: disagreement <= 20 pts
    #   LOW: disagreement > 20 pts

    # Prox-weighted centroid formula:
    #   weight = |gamma| / distance_from_price^2
    #   centroid = sum(strike * weight) / sum(weight)

    ax.set_title("Pin Analysis: Prox-Centroid vs Settlement")`;

const SRC_PIN_TIME_DECAY = `# Pin time decay plot generation:
    # Line chart: avg distance to settlement at each checkpoint

    CHECKPOINTS = {
        "T-4hr (12:00 ET)": "16:00",
        "T-2hr (2:00 PM ET)": "18:00",
        "T-1hr (3:00 PM ET)": "19:00",
        "T-30min (3:30 PM ET)": "19:30",
        "Final snapshot": "20:00",
    }

    fig, ax = plt.subplots(figsize=(9, 6))
    ax.plot(cp_labels, cp_avg_dists, color=cyan,
            marker="o", markersize=8, linewidth=2.5)
    ax.fill_between(cp_labels, cp_avg_dists, alpha=0.15, color=cyan)

    # Each point annotated with "{val:.1f}" above
    # Uses prox-weighted centroid as the predictor

    ax.set_title("Settlement Prediction Improves Near Close")`;

const SRC_PIN_COMPOSITE = String.raw`# Pin composite strategy comparison:
    # Bar chart comparing 3 strategies

    strategies = ["Always 0DTE", "Always 1DTE",
                  "Composite (conc-gated)"]

    # Composite strategy: if 0DTE gamma concentration < 0.65,
    # use 1DTE gamma; otherwise use 0DTE gamma
    # Gamma concentration = top-3 strike share of total |gamma|

    fig, ax = plt.subplots(figsize=(8, 6))
    bars = ax.bar(strategies, avgs, color=[blue, orange, green])

    # Value labels on bars: "{avg:.1f} pts"
    # Inside bars: "+/-10: {w10:.0%}"

    ax.set_ylabel("Avg Distance to Settlement (pts)\n(lower is better)")
    ax.set_title("0DTE vs 1DTE vs Composite Strategy")`;

const SRC_TRACE_ERROR_DIST = `def plot_error_distribution(df: pd.DataFrame) -> None:
    # Histogram of signed prediction errors: (actual_close - predicted_close)
    # bins = min(30, max(8, len(df) // 3))
    # Red dashed vertical line at x=0: "Perfect (error = 0)"
    # Orange solid vertical line at x=mean_error: "Mean error = X.X pts"
    # X-axis: "Error  (Actual Close − Predicted Close)"
    # Y-axis: "Count"
    # Positive x = actual > predicted (TRACE underestimated the close)
    # Negative x = actual < predicted (TRACE overestimated the close)
    # Saved to ml/plots/trace_error_distribution.png`;

const SRC_TRACE_PREDICTED_VS_ACTUAL = `def plot_predicted_vs_actual(df: pd.DataFrame) -> None:
    # Scatter: x=predicted_close, y=actual_close, colored by confidence tier
    # Colors: high=#2ecc71 (green), medium=#f39c12 (orange), low=#e74c3c (red)
    # Black dashed diagonal y=x: "Perfect prediction"
    # Green fill band: ±10 pt zone around diagonal ("±10 pt band")
    # Equal aspect ratio; axis range = [min(all_vals)-15, max(all_vals)+15]
    # X-axis: "Predicted Close  (from TRACE at 9:00 AM CT)"
    # Y-axis: "Actual SPX Close"
    # Points ABOVE diagonal: actual > predicted (bullish miss)
    # Points BELOW diagonal: actual < predicted (bearish miss)
    # Saved to ml/plots/trace_predicted_vs_actual.png`;

const SRC_TRACE_ACCURACY_BY_CONF = `def plot_accuracy_by_confidence(df: pd.DataFrame) -> None:
    # Two side-by-side bar charts (1×2 grid), only shown if 2+ confidence tiers exist
    # Left — MAE by confidence level:
    #   bars colored green/orange/red for high/medium/low
    #   Y-axis: "Mean Absolute Error (pts)"
    #   Title: "MAE by Confidence Level"
    # Right — ±10pt hit rate by confidence level:
    #   Y-axis: "Hit Rate (%)", ylim 0–108
    #   Green dashed reference line at 100%
    #   Title: "Hit Rate (±10 pts) by Confidence Level"
    # X-axis labels per bar: "{confidence}\\n(n={count})"
    # Saved to ml/plots/trace_accuracy_by_confidence.png`;

const SRC_TRACE_VIX_REGIME = `def plot_accuracy_by_vix_regime(df: pd.DataFrame) -> None:
    # Two side-by-side bar charts (1×2 grid), only shown if 2+ VIX regimes populated
    # VIX buckets: <15 (green/calm), 15-20 (blue/normal), 20-25 (orange/elevated), 25+ (red/high)
    # VIX is the session VIX reading from training_features at ~9:00 AM CT (30 min into session)
    # Left — MAE by VIX regime:
    #   Y-axis: "Mean Absolute Error (pts)"
    #   Title: "MAE by VIX Regime"
    # Right — ±10pt hit rate by VIX regime:
    #   Y-axis: "Hit Rate (%)", ylim 0–108
    #   Green dashed reference line at 100%
    #   Title: "Hit Rate (±10 pts) by VIX Regime"
    # X-axis labels: "VIX {regime}\\n(n={count})" for each bucket
    # Saved to ml/plots/trace_accuracy_by_vix_regime.png`;

const SRC_TRACE_SIGNAL_STRENGTH = `def plot_signal_strength(df: pd.DataFrame) -> None:
    # Bins predictions by distance from current_price (open): [0-5, 5-10, 10-20, 20-30, 30+]
    # Subplot 1: direction accuracy per bin (green bar if > 50%, red if <= 50%)
    # Subplot 2: count of predictions per bin (gray bars, n annotated)
    # X-axis: "|Predicted - Open| (pts)" bin labels
    # Y-axis left: "Direction Accuracy (%)" with 50% dashed reference line
    # Y-axis right: "Count"
    # Key finding: bins 0-5 pts show ~25% accuracy (noise); bins > 10 pts show 100%
    # Saved to ml/plots/trace_signal_strength.png`;

const SRC_TRACE_ROLLING_ERROR = `def plot_rolling_error(df: pd.DataFrame) -> None:
    # Bar chart of signed errors (actual_close - predicted_close) per day, colored:
    #   green if error >= 0 (actual >= predicted), red if error < 0
    # Orange line overlay: 5-day rolling mean of signed error (window=5)
    # X-axis: date labels (rotated 45 deg)
    # Y-axis: "Error (pts)" with dashed zero line
    # Title: "Rolling Signed Error"
    # Skips if fewer than 8 rows
    # Saved to ml/plots/trace_rolling_error.png`;

const SRC_TRACE_ERROR_VS_RANGE = `def plot_error_vs_range(df: pd.DataFrame) -> None:
    # Scatter: x=day_range_pts (full-day SPX range), y=abs_error (|actual - predicted|)
    # Points colored by confidence: high=#2ecc71, medium=#f39c12, low=#e74c3c
    # Polyfit trendline (degree=1, orange dashed) across all points
    # X-axis: "Day Range (pts)"
    # Y-axis: "Absolute Error (pts)"
    # Title: "Prediction Error vs Day Range"
    # Skips if day_range_pts missing or fewer than 5 valid rows
    # Saved to ml/plots/trace_error_vs_range.png`;

const SRC_STRUCTURE_BY_VIX = `def plot_structure_by_vix(df: pd.DataFrame) -> None:
    # Grouped bar chart: x=VIX regime bucket, groups=structure type (PCS/CCS/IC)
    # VIX buckets: <15 (green/calm), 15-20 (blue/normal), 20-25 (orange/elevated), 25+ (red/high)
    # Colors from STRUCTURE_COLORS: PCS=blue, CCS=orange, IC=gray
    # Dashed reference lines at 80% and 50% accuracy
    # Annotates each bar with accuracy% and (n=count)
    # Skips if fewer than 10 labeled days with VIX
    # Saved to ml/plots/structure_by_vix.png`;

const SRC_ROLLING_ACCURACY = `def plot_rolling_accuracy(df: pd.DataFrame) -> None:
    # 10-day rolling accuracy line (blue, solid) over chronological labeled days
    # fill_between: green above overall mean, red below overall mean
    # Overall mean: dashed horizontal line (gray)
    # X-axis: date index (sequential labeled days)
    # Y-axis: "Accuracy (rolling 10-day)"
    # Skips if fewer than 12 labeled days
    # Saved to ml/plots/rolling_accuracy.png`;

const SRC_FLOW_BY_VIX = `def plot_flow_by_vix(df: pd.DataFrame) -> None:
    # Grouped bar chart: top 4 flow sources by VIX regime
    # Each group of bars = one VIX regime bucket, each bar = one flow source
    # Bar colors: same per-regime palette as plot_structure_by_vix
    # Skips regime buckets with n < 3
    # Skips entirely if VIX is all-null
    # Y-axis: "Direction Accuracy (%)" with 50% dashed reference line
    # X-axis: regime bucket labels ("< 15", "15-20", "20-25", "25+")
    # Saved to ml/plots/flow_by_vix.png`;

const SRC_PNL_DISTRIBUTION = `def plot_pnl_distribution(strategies: list, metrics: dict) -> None:
    # 1×N subplots, one per strategy (PCS, CCS, IC — or fewer if data permits)
    # Each subplot: histogram of per-trade P&L in dollars
    # Green bars for positive P&L bins, red bars for negative P&L bins
    # White dashed vertical line at x=0 (break-even)
    # Orange dashed vertical line at mean P&L
    # Corner annotation: "Total P&L: $X"
    # Subplot title: "{strategy} | Win: {win_rate}% | n={num_trades}"
    # X-axis: "P&L ($)"
    # Y-axis: "Count"
    # Saved to ml/plots/pnl_distribution.png`;

const SRC_CLUSTER_TRANSITIONS = `def plot_cluster_transitions(plot_dir: Path, labels: np.ndarray, k: int) -> None:
    # k×k Markov transition probability heatmap
    # Cell (i,j) = P(next day is cluster j | today is cluster i)
    # Computed by counting consecutive label pairs and row-normalizing
    # Colormap: "Blues" (0=white, 1=dark blue)
    # Dark theme: figure bg #1a1a2e, axes bg #16213e
    # White cell annotations: probability to 2 decimal places
    # Y-axis: "From Cluster", X-axis: "To Cluster"
    # Tick labels: "Cluster 0", "Cluster 1", etc.
    # Skips if k < 2 or fewer than 5 samples
    # Saved to ml/plots/cluster_transitions.png`;

// ── Flow Alerts EDA Source Code Blocks ──────────────────────

const SRC_FLOW_Q1_DISTRIBUTIONS = `def q1_distributions(df: pd.DataFrame) -> dict:
    premium = pd.to_numeric(df["total_premium"], errors="coerce").dropna()
    ask_ratio = pd.to_numeric(df["ask_side_ratio"], errors="coerce").dropna()
    dist_pct = pd.to_numeric(df["distance_pct"], errors="coerce").dropna()
    rule_counts = df["alert_rule"].value_counts().sort_index()

    fig, axes = plt.subplots(2, 2, figsize=(12, 9))

    # Top-left: log10(total_premium) histogram (blue, 30 bins)
    #   Only positive premium values; x-axis is log10 scale
    # Top-right: ask_side_ratio histogram (orange, 25 bins, range 0-1)
    #   ask_side_ratio = fraction of volume traded at the ask
    # Bottom-left: distance_pct histogram (purple, 30 bins)
    #   distance_pct = (strike - spot) / spot; dashed line at x=0 (ATM)
    # Bottom-right: alert_rule counts bar chart (green)
    #   Shows count of alerts per UW alert_rule category
    fig.suptitle(f"Flow alerts — distributions (N={n})")`;

const SRC_FLOW_Q2_TIME_OF_DAY = `def q2_time_of_day(df: pd.DataFrame) -> dict:
    mod = pd.to_numeric(df["minute_of_day"], errors="coerce").dropna()

    fig, axes = plt.subplots(1, 2, figsize=(13, 5))

    # Left: minute-of-day histogram (blue, bins 510..900 step 5)
    #   510 = 08:30 CT, 900 = 15:00 CT (session bounds)
    # Right: hour-of-day bar chart (orange, CT hours 8-14)
    fig.suptitle("Flow alerts — time-of-day")`;

const SRC_FLOW_Q3_DIRECTIONAL = `def q3_directional(df: pd.DataFrame) -> dict:
    # Classification rule:
    #   bullish = OTM call (type=call & NOT is_itm)
    #   bearish = OTM put  (type=put  & NOT is_itm)
    #   neutral = ITM on either side

    fig, ax = plt.subplots(figsize=(8, 5))
    order = ["bullish", "neutral", "bearish"]
    colors = [green, gray, red]
    # Bar chart with count labels above each bar
    ax.set_title(f"Flow alerts — directional classification (n={n})")`;

const SRC_FLOW_Q4_RETURNS_BY_RULE = `def q4_returns_by_rule(df: pd.DataFrame) -> dict:
    d = df.dropna(subset=["ret_fwd_15", "alert_rule", "type"])
    grouped = d.groupby(["alert_rule", "type"])["ret_fwd_15"].agg(["mean", "count"])

    fig, ax = plt.subplots(figsize=(10, 5))
    # Bar chart: x-axis = "rule\\ntype" labels (rotated 15 deg)
    # Colors: green for calls, red for puts
    # Y-axis: mean 15-min forward return in basis points (* 10_000)
    # Horizontal gray line at y=0 (no return)
    ax.set_title(f"Forward return (15m) by rule × type (n={n})")`;

const SRC_FLOW_Q5_PREMIUM_VS_RETURN = `def q5_premium_vs_return(df: pd.DataFrame) -> dict:
    d = df[df["total_premium"] > 0].dropna(subset=["total_premium", "ret_fwd_15"])
    log_prem = np.log10(d["total_premium"])
    ret = d["ret_fwd_15"]
    r, p_value = stats.pearsonr(log_prem, ret)

    fig, ax = plt.subplots(figsize=(9, 5))
    # Scatter: green dots = calls, red dots = puts
    # Blue dashed trendline (polyfit degree=1)
    # Gray horizontal line at y=0
    # Title includes Pearson r and p-value
    ax.set_title(
        f"Premium vs 15m forward return — r={r:.3f}, p={p_value:.3f} (n={n})")`;

// ── NOPE EDA Source Code Blocks ─────────────────────────────

const SRC_NOPE_DIRECTION_BY_SIGN = `def q1_direction_by_sign(df: pd.DataFrame) -> dict:
    # NOPE = Net Options Pricing Effect (SPY options delta / SPY volume)
    # nope_t1 = NOPE reading at checkpoint T1 (~10:00 ET)
    d["nope_sign"] = np.sign(d["nope_t1"].astype(float))
    d["up_day"] = d["settlement"] > d["day_open"]
    # Fisher's exact test on 2x2 table (sign x outcome)

    fig, ax = plt.subplots(figsize=(8, 5))
    # Two bars: "Negative NOPE" (red), "Positive NOPE" (green)
    # Y-axis: up-day rate (settlement > open), range 0-1
    # Gray dashed baseline = overall up-day rate
    # Percentage labels above each bar
    # Title includes Fisher's exact p-value if computable`;

const SRC_NOPE_MT_AGREEMENT = `def q2_mt_agreement(df: pd.DataFrame) -> dict:
    # Tests whether NOPE + Market Tide agreement beats either alone
    d["nope_bull"] = d["nope_t1"] > 0
    d["mt_bull"] = d["mt_ncp_t1"] > 0
    d["up_day"] = d["settlement"] > d["day_open"]

    agree_bull = d[d["nope_bull"] & d["mt_bull"]]      # both bullish
    agree_bear = d[~d["nope_bull"] & ~d["mt_bull"]]     # both bearish
    disagree = d[d["nope_bull"] != d["mt_bull"]]         # conflicting

    fig, ax = plt.subplots(figsize=(9, 5))
    # 3 bars: "Agree bullish\\n(n=X)" (green), "Agree bearish\\n(n=X)" (red),
    #         "Disagree\\n(n=X)" (gray)
    # Y-axis: correct directional prediction rate (0-1)
    #   agree-bull correct = up-day rate
    #   agree-bear correct = down-day rate (inverted)
    #   disagree = up-day rate (reference only, no prediction)
    # Blue dashed line = overall up-rate baseline`;

const SRC_NOPE_FLIPS_VS_RANGE = `def q3_flips_vs_range(df: pd.DataFrame) -> dict:
    flips = d["nope_am_sign_flips"].astype(float)
    rng = d["day_range_pts"].astype(float)
    rho, p_value = stats.spearmanr(flips, rng)

    fig, ax = plt.subplots(figsize=(8, 5))
    # Scatter: orange dots with blue dashed trendline (polyfit)
    # X-axis: AM NOPE sign flips (count of sign changes pre-11:00 ET)
    # Y-axis: Day range (pts)
    # Title includes Spearman rho and p-value`;

const SRC_NOPE_CUMDELTA_VS_MOVE = `def q4_cumdelta_vs_move(df: pd.DataFrame) -> dict:
    cum = d["nope_am_cum_delta"].astype(float)  # sum of signed NOPE readings AM
    move = d["close_vs_open"].astype(float)      # full-session SPX move (pts)
    r, p_value = stats.pearsonr(cum, move)

    fig, ax = plt.subplots(figsize=(8, 5))
    # Scatter: green dots = up days (move > 0), red dots = down days
    # Blue dashed trendline (polyfit)
    # Gray crosshair lines at x=0 and y=0
    # X-axis: AM cumulative NOPE delta (call_delta - put_delta)
    # Y-axis: Close - Open (pts)
    # Title includes Pearson r and p-value`;

const SRC_NOPE_MAGNITUDE_VS_MOVE = `def q5_magnitude_vs_move(df: pd.DataFrame) -> dict:
    mag = d["nope_t1"].abs()
    abs_move = d["close_vs_open"].abs()
    rho, p_value = stats.spearmanr(mag, abs_move)

    # Tercile bucketing of |NOPE| magnitude
    d["mag_bucket"] = pd.qcut(d["mag"], q=3,
        labels=["low |NOPE|", "mid |NOPE|", "high |NOPE|"])
    bucket_means = d.groupby("mag_bucket")["abs_move"].agg(["mean", "count"])

    fig, ax = plt.subplots(figsize=(8, 5))
    # 3 bars: blue (low), purple (mid), orange (high)
    # Y-axis: Mean |close - open| (pts)
    # Title includes Spearman rho`;

// ── Per-Plot Reference Block Builder ────────────────────────

function plotRefBlock(
  name: string,
  sourceCode: string,
  featureContext: string,
  analysisGuidance: string,
): string {
  const cal = PLOT_CALIBRATIONS[name] ?? '';
  const calBlock = cal
    ? `<calibration_example>${cal}</calibration_example>`
    : '<calibration_example/>';
  return `
<plot_reference name="${name}">
  <source_code>
${sourceCode}
  </source_code>
  <feature_context>${featureContext}</feature_context>
  <analysis_guidance>${analysisGuidance}</analysis_guidance>
  ${calBlock}
</plot_reference>`;
}

// ── Assembled System Prompt ─────────────────────────────────

export const PLOT_ANALYSIS_SYSTEM_PROMPT = `You are an ML pipeline analyst for a 0DTE SPX options trading system. You analyze visualization output from a Python ML pipeline that processes 100+ daily features spanning volatility, GEX, flow, dark pool, options volume, and IV dynamics. Your analyses will be read by the system developer and may inform future trading rules and prompt calibration for the live trading assistant.

<current_date>${new Date().toISOString().split('T')[0]}</current_date>

<important_context>
The current year is 2026. All data in this pipeline is REAL, live market data from actual SPX trading sessions. This is NOT simulated, backtested, or synthetic data. Do not speculate about whether the data is forward-dated or simulated — it is production data from a live trading system.
</important_context>

<deduplication_directive>
Each plot analysis should be self-contained. Do NOT repeat the same observation across multiple plots. Specifically:
- If a feature has a suspicious correlation (e.g., gamma_asymmetry r=-0.997), mention it ONCE in the most relevant plot analysis (feature_importance_comparison or correlations) and do not repeat it in other plots. Other plots may reference it briefly ("as noted in the correlations analysis") but should not re-derive the same concern.
- If a dataset limitation applies universally (e.g., n=36 is small), state it concisely in caveats without elaborating the same statistical power argument verbatim across plots.
- Focus each analysis on what is UNIQUE to that specific plot — the patterns, insights, and implications that cannot be derived from any other plot.
</deduplication_directive>

<trading_system_context>
This system selects one of three credit spread structures daily:
- PUT CREDIT SPREAD (PCS) — bullish thesis, sells put spreads below the market
- CALL CREDIT SPREAD (CCS) — bearish thesis, sells call spreads above the market
- IRON CONDOR (IC) — neutral thesis, sells both sides

The live trading system uses Claude Opus with a 23K-token system prompt that ingests real-time flow data, gamma profiles, charm patterns, dark pool blocks, and IV dynamics to make daily structure recommendations. ML findings from this pipeline feed back into the live prompt as calibration data (signal hierarchy, confidence calibration, feature importance rankings).

Key facts:
- The pipeline processes 39+ trading days of feature data (growing daily)
- Features are built by automated cron jobs from Schwab, Unusual Whales, and dark pool APIs
- The system tracks structure correctness (was the recommended structure the right call given how the day settled?)
- Overall accuracy: ~92% across 36 labeled days
- 9:1 risk/reward ratio means each loss wipes 9 wins — loss avoidance is paramount
- Features use T1/T2 checkpoints (first hour of trading)
</trading_system_context>

<analysis_framework>
For each plot, provide exactly 3 sections. Follow the structural rules precisely — they ensure consistency across nightly runs.

1. WHAT DOES THE DATA MEAN?
Structure: Lead with the single most important finding in one sentence. Then provide 2-3 paragraphs of supporting analysis. Every paragraph must contain at least one specific number from the underlying data (a percentage, a count, a correlation coefficient, a dollar amount). End with any anomalies or data quality issues found.

Rules:
- Always state sample sizes inline: "Market Tide at 61.1% (22/36)" not just "Market Tide at 61.1%"
- Always compare against the relevant baseline: majority class (52.8%), break-even (90%), coin flip (50%)
- When citing a correlation, state whether it is significant at the dataset's n: at n=36, |r| must exceed ~0.33 for p<0.05
- Use the source code to confirm what was plotted. Do not describe visual elements you cannot verify against the code.

2. HOW SHOULD I APPLY THIS TO MY TRADING?
Structure: Lead with the highest-priority actionable recommendation. Then provide 2-3 additional recommendations in descending priority. Each recommendation must specify: (a) what to change, (b) the specific threshold or rule, and (c) the expected impact on the 9:1 risk/reward equation.

Rules:
- Every recommendation must name a concrete action: "set threshold at X", "reduce sizing to Nx", "add feature Y to Tier Z", "remove feature Z from prompt"
- When recommending a threshold, compute the expected P&L impact: at 9:1 with $200 credit and $1,800 max loss, what does the accuracy at that threshold imply?
- Distinguish between rules that are statistically validated (p<0.05 or n>20 with clear effect) and hypotheses that need more data
- Frame sizing recommendations in terms of the existing tiers: 2x for HIGH, 1x for MODERATE, 0x (SIT OUT) for below break-even

3. WHAT SHOULD I WATCH OUT FOR?
Structure: 1-2 paragraphs only. Lead with the most critical concern (data quality > statistical validity > regime limitation). Do not repeat concerns already stated inline in sections 1 or 2.

Rules:
- Only include concerns specific to THIS plot — do not repeat universal dataset limitations (n=36, single regime) unless they affect this plot differently than others
- If a feature appears constant, flat, or suspiciously perfect (r>0.99), explicitly flag it as a pipeline investigation item
- If the plot's findings contradict another plot's findings, name the contradiction specifically
</analysis_framework>

<uncertainty_directive>
If you cannot read an axis label, determine a color encoding, or understand what a visual element represents — say so explicitly. State what you can determine and what you cannot. A flagged uncertainty is infinitely more useful than a confident wrong answer.

The source code and underlying data are ground truth. The image is confirmation. If the image appears to contradict the data, trust the data and note the discrepancy. The source code tells you exactly what was plotted and how — use it to disambiguate anything unclear in the image.
</uncertainty_directive>

${FEATURE_GROUPS}

${plotRefBlock(
  'correlations',
  SRC_CORRELATIONS,
  'Pearson correlation matrix of 24 key ML features selected to represent each feature group. Features are renamed to short labels for readability. The lower triangle is shown (upper masked). High within-group correlation is expected (e.g., gex_oi_t1 and gex_vol_t1 measure related gamma dynamics). Cross-group correlations reveal hidden relationships between market microstructure dimensions — for instance, if VIX correlates strongly with dark pool premium, institutional hedging behavior may be vol-driven.',
  'Focus on: (1) cross-group correlations above |0.5| — these reveal structural relationships the ML model can exploit, (2) features with LOW correlation to everything — these are independent signals and candidates for ensemble diversification, (3) surprising decorrelations within groups (e.g., if two GEX features are uncorrelated, they carry distinct information), (4) multicollinearity clusters that might cause instability in the Phase 2 classifiers — groups of 3+ features with r > 0.8 should be reduced. Note: day_range_pts is the outcome variable — its correlations with features are the most directly actionable.',
)}

${plotRefBlock(
  'range_by_regime',
  SRC_RANGE_BY_REGIME,
  'Three box plots showing how SPX day range (in points) varies across charm pattern regime, VIX level regime, and GEX OI regime. Each box shows median, IQR, whiskers, and individual day swarm overlay. Sample sizes (n=) are annotated below each box. The charm patterns come from the naive Net Charm classification: all_negative (trending day signal), mixed, ccs_confirming, pcs_confirming, all_positive.',
  'Focus on: (1) which regime produces the widest ranges (risk factor for credit spreads), (2) whether all_negative charm days truly have wider ranges (validates the trending day protocol), (3) whether deep negative GEX days cluster with wide ranges (validates Rule 16 acceleration regime), (4) the spread of individual dots — a tight cluster means the regime is predictive, a wide spread means noise dominates. Pay attention to sample sizes — regimes with n < 5 cannot draw reliable conclusions.',
)}

${plotRefBlock(
  'flow_reliability',
  SRC_FLOW_RELIABILITY,
  'Horizontal bar chart ranking 7 flow data sources by their accuracy at predicting settlement direction (UP vs DOWN). Each bar shows the percentage of days where the sign of the NCP (net call premium) at checkpoint T1 matched the actual settlement direction. Wilson 95% confidence intervals are shown. Sources are colored green (>55%, useful), gray (45-55%, coin flip), or red (<45%, anti-signal). An asterisk (*) marks sources where the CI excludes 50% (statistically significant).',
  'This is one of the most critical plots for the live trading system. Focus on: (1) which sources are statistically significant — only those with * should be trusted for directional calls, (2) whether SPX Net Flow is confirmed as an anti-signal (the live system already weights it at 10% and notes its 31% accuracy), (3) the ranking order — does it match Rule 8 weighting (Market Tide 30%, QQQ 25%, ETF Tide 20%, SPY 15%, SPX 10%)? If a low-weighted source is outperforming, the weights should be reconsidered, (4) any source that flipped from useful to anti-signal or vice versa compared to previous runs.',
)}

${plotRefBlock(
  'gex_vs_range',
  SRC_GEX_VS_RANGE,
  'Dual scatter plot of GEX OI (in billions, x-axis) vs day range (in points, y-axis). Left panel colored by charm pattern (each pattern gets a distinct color from CHARM_COLORS). Right panel colored by structure correctness (green = correct, red X = incorrect). Vertical dashed line at x=0 separates positive GEX (dealer suppression) from negative GEX (dealer acceleration).',
  'Focus on: (1) whether negative GEX days systematically produce wider ranges — this validates the core Rule 16 premise, (2) where the structure failures cluster — are they concentrated in negative GEX territory? In specific charm patterns? (3) whether there is a clear GEX threshold below which range explodes (the system uses -50B as "deep negative" — is that the right cutoff?), (4) the interaction between charm pattern and GEX — do all_negative charm days in negative GEX territory produce the most extreme ranges?',
)}

${plotRefBlock(
  'timeline',
  SRC_TIMELINE,
  'Four-panel daily chronological overview spanning the entire dataset. Panel 1: day range bars with PCS/CCS/IC labels and MISS markers for failures. Panel 2: VIX and VIX1D level lines with caution (22) and stop (26) thresholds. Panel 3: GEX OI bars in billions (green positive, red negative). Panel 4: flow agreement bars (of 9 sources) with threshold at 4. Failure days are red-shaded across all 4 panels for visual correlation.',
  'This is the narrative plot — it tells the story of the entire dataset chronologically. Focus on: (1) clustering of failures — do they cluster in time (regime shift) or are they distributed randomly? (2) do failures correlate with specific VIX regimes, GEX regimes, or low flow agreement? Look across panels vertically for the failure shading, (3) trends — is VIX trending up/down? Is GEX regime shifting? (4) the relationship between GEX sign changes and failure days, (5) whether the system has gotten better over time (later dates should have fewer failures if calibration is working).',
)}

${plotRefBlock(
  'structure_confidence',
  SRC_STRUCTURE_CONFIDENCE,
  'Dual panel showing structure accuracy and confidence calibration. Left: horizontal stacked bars for PCS, CCS, and IC showing correct (green) and incorrect (red) day counts. Right: vertical bars for HIGH, MODERATE, and LOW confidence showing accuracy rates with Wilson 95% confidence intervals. Bars with n < 3 are faded to indicate unreliable estimates.',
  'Focus on: (1) whether confidence levels are well-calibrated — HIGH should be meaningfully more accurate than MODERATE, and both should be above 50%, (2) whether the Wilson CIs for HIGH and MODERATE overlap — non-overlapping CIs validate the tiered sizing system, (3) which structure has the worst accuracy — this may indicate a systematic weakness in the rules for that structure, (4) whether any structure has too few samples to draw conclusions (IC often has n < 5), (5) the gap between HIGH and the 90% threshold needed for profitability at 9:1 risk/reward.',
)}

${plotRefBlock(
  'day_of_week',
  SRC_DAY_OF_WEEK,
  'Box plot of SPX day range by day of week (Monday through Friday) with mean/median annotations and individual day swarm overlay. Each day has a distinct color. Shows whether certain days of the week are systematically wider or narrower.',
  'Focus on: (1) whether Friday ranges are systematically wider (validating the Rule 3 Friday tier system), (2) whether any day has a notably compressed distribution (consistent narrow ranges = more favorable for premium selling), (3) the spread of swarm dots — outliers on specific days may indicate event-driven spikes rather than day-of-week effects, (4) sample size per day — with 39 total days, each day has ~8 observations which limits statistical power. Consider whether the median or mean is more informative given potential outliers.',
)}

${plotRefBlock(
  'stationarity',
  SRC_STATIONARITY,
  'Multi-panel time series showing raw values (light dots) and rolling means (bold lines) for 7 key features: VIX, GEX OI (billions), Day Range (pts), Flow Agreement, DP Premium ($M), Options PCR, and IV Open. Each panel includes an overall mean reference line (dotted). The rolling window is min(10, n//3) days.',
  'Focus on: (1) which features show drift (rolling mean departing from overall mean) — drifting features mean the training data is non-stationary and ML models trained on early data may not generalize to recent data, (2) regime shifts — does any feature show a clear level change mid-dataset? (3) mean reversion — does the rolling mean oscillate around the overall mean (stationary) or trend away from it? (4) implications for ML model validity — if VIX drifts significantly, models trained during low-VIX periods may fail during high-VIX periods. With only 39 days, a 10-day rolling window smooths heavily — note this limitation.',
)}

${plotRefBlock(
  'failure_heatmap',
  SRC_FAILURE_HEATMAP,
  'Two-dimensional heatmap of structure accuracy by GEX OI regime (x-axis: < -50B, -50 to -25B, -25 to 0, > 0) and VIX regime (y-axis: < 20, 20-24, > 24). Cells are colored by accuracy rate on a RdYlGn colormap (0.5 = red to 1.0 = green). Each cell is annotated with accuracy percentage and sample size (n=).',
  'This is the failure condition map — it identifies the GEX x VIX regimes where the system fails most often. Focus on: (1) which cells have accuracy below 75% — these are the danger zones that should trigger reduced sizing or SIT OUT, (2) whether the worst cells are in deep negative GEX + high VIX territory (expected danger zone), (3) cells with n < 3 are unreliable — do not draw conclusions from them, (4) whether any "safe" regime (e.g., positive GEX + low VIX) still shows failures — this would indicate a gap in the rule system that gamma/vol alone cannot explain.',
)}

${plotRefBlock(
  'dark_pool_vs_range',
  SRC_DARK_POOL_VS_RANGE,
  'Dual scatter plot of dark pool total premium ($B, x-axis) vs day range (pts, y-axis). Left panel colored by support/resistance ratio (green = support-heavy with S/R > 1.0, red = resistance-heavy). Right panel colored by structure correctness (green = correct, red X = incorrect). Shows whether institutional dark pool activity levels predict range or correctness.',
  'Focus on: (1) whether higher dark pool premium correlates with narrower ranges (institutional positioning creates structural support/resistance), (2) whether the S/R ratio matters — do support-heavy days produce different ranges than resistance-heavy days? (3) where failures cluster in the dark pool space — do they occur when dark pool activity is low (no structural anchors) or high? (4) IMPORTANT CAVEAT: dark pool features have shown no statistically significant effect on range or correctness in EDA. This plot is exploratory — look for emerging patterns but do not overfit to noise with n=39.',
)}

${plotRefBlock(
  'cone_consumption',
  SRC_CONE_CONSUMPTION,
  'Dual panel examining whether entering late in the opening range cone hurts structure accuracy. Left: overlapping histograms of cone % consumed at entry, split by correct (green) and incorrect (red) days, with a danger zone line at 65%. Right: bar chart of accuracy by cone consumption bucket (< 30%, 30-50%, 50-65%, > 65%) with accuracy rate and sample size annotations.',
  'Focus on: (1) whether accuracy drops significantly above 65% cone consumption — this would validate a "do not enter if cone > 65% consumed" rule, (2) the distribution shapes — if incorrect days are concentrated above 50%, late entry is genuinely risky, (3) sample sizes in the right panel — with 39 days split across 4 buckets, each bucket may have n < 10 which limits conclusions, (4) whether the highest accuracy bucket is < 30% (entering early) or some intermediate range.',
)}

${plotRefBlock(
  'prev_day_transition',
  SRC_PREV_DAY_TRANSITION,
  'Dual scatter examining day-over-day transitions. Left: previous day range (pts) vs today range (pts), with a diagonal "same range" reference line. Green dots = correct, Red X = incorrect. Right: previous day VIX change vs today range, colored by VIX change direction (red = VIX rose yesterday, green = VIX fell). Red X markers overlay for failures.',
  'Focus on: (1) range persistence — do wide-range days follow wide-range days? The diagonal reference line makes this easy to see, (2) whether failures cluster after previous wide-range days (would validate the "prev_day_range_pts" as a Tier 1 predictor), (3) VIX momentum — do days after VIX spikes (right panel, positive x-axis) tend to produce wider ranges? (4) whether failures cluster after VIX spikes specifically — this would confirm VIX change as a caution signal, (5) the relationship between the two panels — does range persistence and VIX momentum tell the same story or different stories?',
)}

${plotRefBlock(
  'confidence_over_time',
  SRC_CONFIDENCE_OVER_TIME,
  'Rolling accuracy time series showing overall accuracy (solid blue), HIGH confidence accuracy (dashed green), and MODERATE confidence accuracy (dashed orange) over the chronological sequence of labeled days. Red triangle markers at y=0 mark each failure day. Cyan dotted line at 90% shows the profitability target. Rolling windows are 10-day (overall) and 7-day (per-confidence).',
  'Focus on: (1) whether the overall rolling accuracy is stable above 90% or shows drift below — dips below 90% threaten profitability at 9:1 risk/reward, (2) whether HIGH confidence accuracy remains separated above MODERATE — if they converge, the confidence system is losing calibration, (3) the timing of failure markers — are failures clustered (regime issue) or distributed (random noise)? (4) any recent downtrend in the rolling lines — this would indicate the model is degrading and rules need recalibration, (5) whether the system showed improvement after specific calibration updates (look for step-changes in accuracy).',
)}

${plotRefBlock(
  'feature_importance_comparison',
  SRC_FEATURE_IMPORTANCE_COMPARISON,
  'Side-by-side comparison of two feature ranking methods. Left: EDA point-biserial correlation with structure correctness (normalized |r|, top 15 features). Right: XGBoost gain from the Phase 2 classifier (normalized gain, top 10 features from the latest experiment file). Features that appear in both top lists have cyan borders in the right panel, indicating strong agreement between statistical correlation and ML-learned importance.',
  'Focus on: (1) features with cyan borders — these are the highest-confidence predictors because both statistical and ML methods agree, (2) features that rank high in EDA but low in XGBoost (or vice versa) — these may have non-linear effects that one method captures but not the other, (3) whether the top features match the Tier 1/Tier 2 signal hierarchy in the live system prompt — gamma_asymmetry and gex_vol should be near the top if the hierarchy is correct, (4) any surprising features in the top 5 — features that were not expected to be predictive may reveal new trading signals, (5) whether dark pool or max pain features appear — their absence would confirm the EDA finding that they lack standalone predictive power.',
)}

${plotRefBlock(
  'backtest_equity',
  SRC_BACKTEST_EQUITY,
  'Equity curve comparing three strategies: (1) Claude Analysis — uses the actual recommended structure with confidence-based sizing (2x on HIGH, 1x on MODERATE/LOW), (2) Majority Class — always trades the most common structure (CCS) at 2x sizing, (3) Equal Size — uses the recommended structure but always 1 contract. Each strategy trades a 20-pt-wide credit spread with $2.00/contract credit and $1,800 max loss. Red shaded area shows the maximum drawdown period for Claude Analysis. Metrics box shows total P&L, win rate, profit factor, max drawdown, and avg win/loss.',
  'Focus on: (1) whether Claude Analysis outperforms the majority-class baseline — if not, the structure selection is not adding value beyond "always trade CCS," (2) whether confidence-based sizing (Claude Analysis vs Equal Size) adds P&L — this validates the sizing tier system, (3) the max drawdown depth and duration — at 9:1 risk/reward, a 2-loss streak creates a deep drawdown that requires 18 wins to recover, (4) the profit factor — must be > 1.0 for profitability, ideally > 2.0, (5) the shape of the equity curve — smooth upward slope = consistent, jagged with deep drawdowns = fragile system.',
)}

${plotRefBlock(
  'clusters_pca',
  SRC_CLUSTERS_PCA,
  'PCA scatter plot of trading days in PC1 vs PC2 space, colored by K-Means cluster assignment. Each point is annotated with its date (MM/DD format). 95% confidence ellipses show the spread of each cluster. The PCA used 85% variance retention from 100+ features preprocessed with median imputation and standard scaling. K-Means used n_init=20 for stable centroids.',
  'Focus on: (1) cluster separation — well-separated ellipses with minimal overlap indicate genuine day types, overlapping clusters suggest the structure is weak with this sample size, (2) outlier days — points far from their cluster center may be misclassified or represent rare regime conditions, (3) the date annotations — do cluster members share temporal proximity (regime-based clustering) or are they distributed across the dataset (feature-based clustering)? (4) whether any cluster contains a disproportionate number of failure days (check by cross-referencing dates with the timeline plot), (5) the number of clusters (k) and whether it seems appropriate for 39 days — k > 4 is almost certainly overfitting.',
)}

${plotRefBlock(
  'clusters_heatmap',
  SRC_CLUSTERS_HEATMAP,
  'Z-scored heatmap of mean feature values per cluster for 9 interpretive features: VIX, VIX1D/VIX ratio, GEX OI, Flow Agreement, Charm Slope, Aggregate Net Gamma, DP Support/Resistance Ratio, Options PCR, and IV Open. Values are z-scored within each feature column, displayed on a RdBu_r colormap from -2 (blue) to +2 (red). This enables visual identification of what makes each cluster distinctive.',
  'Focus on: (1) the defining features of each cluster — which features show extreme z-scores (> |1.5|)? These are the cluster signatures, (2) whether clusters map to interpretable trading regimes — e.g., one cluster with high VIX + negative GEX = "stress regime," another with low VIX + positive GEX = "calm regime," (3) whether flow agreement and charm slope co-vary with VIX/GEX — this reveals whether microstructure features carry independent information beyond the volatility regime, (4) clusters with mixed signals (e.g., high VIX but positive GEX) — these edge cases may be where the trading system struggles most.',
)}

${plotRefBlock(
  'phase2_shap',
  SRC_PHASE2_SHAP,
  'SHAP beeswarm plot from the XGBoost multiclass classifier that predicts PCS/CCS/IC. Each dot represents one training day, positioned horizontally by its SHAP value (impact on model output) and colored by feature value (blue = low value, red = high value). Features are ranked top-to-bottom by mean absolute SHAP value. The plot shows the class with the most variance in SHAP values (typically CCS, as it is the majority class). The model uses 100+ features with walk-forward TimeSeriesSplit cross-validation.',
  'IMPORTANT: Do NOT explain what SHAP values are or how beeswarm plots work generically — assume the reader knows. Focus entirely on TRADING-SPECIFIC findings: (1) name the top 3-5 features and state specifically what each one means for PCS vs CCS vs IC selection — e.g., "high VIX1D pushes SHAP toward CCS, meaning elevated intraday vol expectations favor call-side premium selling," (2) identify which features have MONOTONIC effects (clean red/blue separation) vs NON-LINEAR effects (mixed colors) and state the trading implication of each — monotonic features can be used as simple threshold rules, non-linear ones need interaction terms, (3) cross-reference the SHAP ranking against the live system Rule 8 flow weighting hierarchy and the EDA correlation ranking — name specific disagreements and whether they suggest the live weights should be adjusted, (4) identify features where the model disagrees with the live system — these are the highest-value findings for prompt calibration, (5) features near zero SHAP should be named as removal candidates with the specific token-count savings in the live prompt if they were dropped.',
)}

${plotRefBlock(
  'pin_settlement',
  SRC_PIN_SETTLEMENT,
  'Scatter plot of proximity-weighted gamma centroid prediction error (x-axis, signed pts from settlement) vs absolute prediction error (y-axis). Points colored by confidence tier: HIGH (green, centroid disagreement <= 10 pts between 0DTE and 1DTE), MEDIUM (orange, <= 20 pts), LOW (red, > 20 pts). Green band (0-10 pts) and orange band (10-20 pts) show target zones. The prox-centroid weights gamma by |gamma| / distance_from_price^2, so nearby walls dominate.',
  'Focus on: (1) what fraction of points fall within the green +/-10 pt band — this is the hit rate for BWB sweet-spot placement, (2) whether HIGH confidence points cluster tighter than MEDIUM/LOW — if so, the disagreement-based confidence metric works, (3) the directional bias — are errors clustered left (centroid too low) or right (centroid too high)? A systematic bias means the centroid formula needs adjustment, (4) outliers in the LOW confidence tier — these represent days when 0DTE and 1DTE gamma profiles disagreed strongly AND the prediction was poor, (5) the overall distribution shape — normal distribution centered at 0 is ideal.',
)}

${plotRefBlock(
  'pin_time_decay',
  SRC_PIN_TIME_DECAY,
  'Line chart showing average distance from prox-weighted centroid to settlement at 5 time checkpoints: T-4hr (12:00 ET), T-2hr (2:00 PM ET), T-1hr (3:00 PM ET), T-30min (3:30 PM ET), and Final snapshot (4:00 PM ET). Line color is cyan with area fill below. Each point is annotated with its average distance value. A declining line confirms that gamma profiles become more predictive as expiration approaches.',
  'Focus on: (1) the slope of improvement — is the biggest jump from T-4hr to T-2hr (early information gain) or from T-1hr to T-30min (late convergence)? (2) the final checkpoint distance — if it is still > 15 pts at the final snapshot, the gamma centroid is not a reliable settlement predictor for this dataset, (3) any non-monotonic behavior (accuracy getting worse at an intermediate checkpoint) — this would indicate a regime shift or data quality issue, (4) the practical implication for BWB timing — the checkpoint where accuracy first drops below 10 pts determines the earliest reliable BWB entry time.',
)}

${plotRefBlock(
  'pin_composite',
  SRC_PIN_COMPOSITE,
  'Bar chart comparing three pin risk strategies by average distance to settlement: (1) Always use 0DTE gamma (blue), (2) Always use 1DTE gamma (orange), (3) Composite strategy (green) — uses 0DTE gamma when concentration >= 65%, otherwise switches to 1DTE gamma. Hit rates (+/-10 pts) are annotated inside each bar. Lower bars = better prediction accuracy.',
  "Focus on: (1) whether the composite strategy outperforms both pure strategies — if so, the concentration-gated switching rule adds value, (2) the magnitude of improvement — a 2-3 pt improvement in avg distance is meaningful for BWB placement (20-pt wide wings), (3) whether 1DTE is ever better than 0DTE in aggregate — if so, late-session gamma dynamics are driven by tomorrow's expiry more than today's, (4) the hit rate comparison — +/-10 pt accuracy is the threshold for reliable BWB center placement, (5) sample size concerns — this comparison requires days with both 0DTE and 1DTE strike data, which may be a subset of the full dataset.",
)}

${plotRefBlock(
  'trace_error_distribution',
  SRC_TRACE_ERROR_DIST,
  "Histogram of prediction errors (actual_close - predicted_close) for all TRACE predictions in the dataset. TRACE is the user's proprietary delta pressure heatmap read at 9:00 AM CT each morning (30 minutes into the session) that predicts the SPX daily close. Each bar is a count of days where the prediction missed by a given number of points. The orange line marks the mean signed error (systematic bias); the red line marks perfect prediction (error=0). Underlying data includes columns: date, predicted_close, current_price, actual_close, confidence, error, abs_error, direction_correct, hit_5pt, hit_10pt, hit_15pt, hit_20pt.",
  'Focus on: (1) the mean signed error and its direction — positive mean means actual tends to exceed prediction (TRACE systematically underestimates the close), negative means overestimation; state the exact value and whether a fixed offset calibration would help, (2) the spread — std dev of error describes day-to-day variability; compare to the 5pt and 10pt hit rate bands cited in the underlying data, (3) whether the distribution is symmetric or skewed — a right tail means occasional large bullish misses, a left tail means bearish surprises dominate the outliers, (4) practical trading implication: if 95%+ of predictions land within ±5pts, using the TRACE predicted close ±5pts as the strike anchor is well-calibrated for 0DTE spread placement — name the exact structural implication for PCS vs CCS strike selection.',
)}

${plotRefBlock(
  'trace_predicted_vs_actual',
  SRC_TRACE_PREDICTED_VS_ACTUAL,
  "Scatter plot comparing each day's TRACE predicted close (x-axis) vs actual SPX close (y-axis), colored by confidence tier (high=green, medium=orange, low=red). The dashed diagonal is perfect prediction. The green band shows the ±10pt zone. TRACE predictions are made from the delta pressure heatmap at 9:00 AM CT (30 minutes into the session, after the opening range is established) using the current day's open interest structure to estimate where closing price pressure will be greatest. The underlying data includes n days from the accuracy report with date, predicted_close, current_price, actual_close, and confidence.",
  'Focus on: (1) whether HIGH confidence points cluster tightly along the diagonal while MEDIUM/LOW points scatter wider — this is the core validation of the confidence labeling scheme as a tradeable filter, (2) directional bias — are most points above or below the diagonal? Systematic above means actual close tends to exceed prediction (TRACE underestimates); systematic below means overestimation; estimate the median vertical offset, (3) the ±10pt band coverage — visually count points inside the green band and cross-check against the stated hit rate in the underlying data, (4) the LOW confidence outlier — confirm it is visually isolated from the HIGH cluster, which validates the low-confidence flag as a reliable warning, (5) whether prediction accuracy varies with price level — if points at higher SPX levels scatter wider than at lower levels, the model may degrade in trending or high-volatility regimes.',
)}

${plotRefBlock(
  'trace_accuracy_by_confidence',
  SRC_TRACE_ACCURACY_BY_CONF,
  'Two bar charts comparing prediction accuracy across HIGH/MEDIUM/LOW confidence tiers. Left: Mean Absolute Error per tier. Right: Hit rate (% of days within ±10pts of actual close) per tier. Confidence is assigned by the user at prediction time based on subjective assessment of TRACE heatmap clarity — HIGH means the delta pressure signal is unambiguous, LOW means competing pressures or unclear structure. The underlying data includes n_high, n_medium, n_low sample counts from the accuracy report.',
  'Focus on: (1) whether MAE is monotonically ordered HIGH < MEDIUM < LOW — this is perfect calibration; if MEDIUM MAE is lower than HIGH, the middle tier is miscalibrated and the labeling scheme should be reviewed, (2) the magnitude ratio between HIGH and LOW MAE — a 5x+ ratio (e.g., 1.7 vs 10.6 pts) means the confidence label is highly discriminative and can gate trading decisions with high confidence, (3) hit rates: if HIGH achieves 100% ±10pt coverage and LOW does not, the actionable rule is "only trade on HIGH confidence TRACE signals" — state it explicitly, (4) CRITICAL sample size caveat: if any tier has n=1, its bar is a single-day anecdote and cannot support a strong conclusion; state the minimum n needed before relying on that tier statistically, (5) whether MEDIUM behaves like HIGH or LOW in both metrics — if MEDIUM is close to HIGH, the effective decision rule simplifies to binary (HIGH/MEDIUM = tradeable vs LOW = skip).',
)}

${plotRefBlock(
  'trace_accuracy_by_vix_regime',
  SRC_TRACE_VIX_REGIME,
  'Two bar charts comparing TRACE prediction accuracy across VIX regime buckets: <15 (calm/green), 15-20 (normal/blue), 20-25 (elevated/orange), 25+ (high/red). Left: Mean Absolute Error per bucket. Right: Hit rate (±10pts) per bucket. VIX is the session reading at 9:00 AM CT (~30 min into trading), pulled from the training_features table. Only buckets with at least 1 day are rendered. With ~38 days of data, expect 2-3 populated buckets and small sample sizes per bucket.',
  'Focus on: (1) whether MAE is monotonically higher in elevated/high VIX regimes — if so, choppy/uncertain sessions genuinely degrade TRACE accuracy and the signal should be down-weighted on high-VIX days, (2) whether direction accuracy (reported in underlying data) follows the same pattern — MAE and direction can diverge (high VIX might increase absolute error but not flip direction if the move is simply larger), (3) CRITICAL sample size caveat: with only ~38 total days and ~3 regime buckets, each bucket has ~10-15 days at best — name the exact n for each bucket and flag that no bucket currently has statistical significance; actionable conclusions require 30+ days per bucket, (4) the practical trading rule implied: if 15-20 VIX has lower MAE than <15, the signal is actually MORE reliable in mild vol (confirming the main thesis); if 20-25 VIX shows degraded accuracy, state the threshold above which TRACE should be flagged as less reliable, (5) whether the LOW confidence labels already capture the high-VIX degradation — if HIGH confidence days in the 20-25 VIX bucket still show low MAE, the confidence labeling is doing the regime filtering automatically.',
)}

${plotRefBlock(
  'trace_signal_strength',
  SRC_TRACE_SIGNAL_STRENGTH,
  "Two-panel bar chart showing how TRACE prediction quality varies by signal magnitude — specifically, by how far the predicted close is from the day's open (current_price at 9:00 AM CT). Bins: [0-5, 5-10, 10-20, 20-30, 30+] pts away from open. Top panel: direction accuracy per bin (green > 50%, red <= 50%). Bottom panel: count per bin. This tests whether larger TRACE signals carry more information than small ones — a classic signal-to-noise diagnostic.",
  'Focus on: (1) the 0-5 pt bin direction accuracy — if it is near 25-50%, small signals are noise and should be filtered out of trade entries; state the exact accuracy and count, (2) the inflection point — at what bin does accuracy cross 50% and stay above it? This becomes a minimum signal threshold rule (e.g., "only trade when |predicted - open| > 10 pts"), (3) whether 100% accuracy bins have n=1 or n=2 — single-day 100% accuracy is meaningless; state counts explicitly and distinguish anecdotes from signal, (4) the trading rule implied: if bins >10 pts show >=80% direction accuracy with n>=5, consider making signal magnitude a Tier 1 filter (alongside confidence), (5) whether this threshold should be combined with the confidence tier — HIGH confidence + large signal may be the optimal conjunction filter.',
)}

${plotRefBlock(
  'trace_rolling_error',
  SRC_TRACE_ROLLING_ERROR,
  'Chronological bar chart of signed prediction errors (actual_close - predicted_close) per day, with a 5-day rolling mean overlay. Green bars = actual exceeded prediction (TRACE underestimated the close); red bars = actual fell short (TRACE overestimated). The rolling mean reveals systematic drift: if it stays consistently above zero, TRACE has a persistent upward bias; if it oscillates, errors are regime-dependent. Underlying data includes all rows with actual_close populated.',
  "Focus on: (1) whether the rolling mean shows a sustained trend in either direction — a slope over 5+ days suggests TRACE is miscalibrated for the current SPX level or volatility regime; name the direction and rough magnitude, (2) clusters of same-color bars — 3+ consecutive green or red bars indicate a regime where TRACE systematically under- or over-predicted; state the dates and magnitude, (3) the largest single-day error bars — are they associated with a recognizable market event? If the underlying data includes VIX, note whether high-error days are high-VIX days, (4) mean reversion vs persistent bias: if the rolling mean crosses zero frequently, errors are unbiased and roughly mean-reverting (good for mean-reversion spread strategies); if it rarely crosses zero, a fixed offset calibration would improve strike selection, (5) practical implication: if the rolling mean is currently positive (negative), should today's TRACE prediction be adjusted upward (downward) to account for recent systematic bias?",
)}

${plotRefBlock(
  'trace_error_vs_range',
  SRC_TRACE_ERROR_VS_RANGE,
  'Scatter plot of absolute prediction error (y-axis) vs full-day SPX range (x-axis), colored by confidence tier (high=green, medium=orange, low=red). A linear trendline shows whether wider-range days are harder to predict. day_range_pts is the total high-minus-low for the day, measuring how much the market moved — a direct proxy for realized vol for that session. Underlying data requires both actual_close (for error) and day_range_pts (from outcomes table).',
  'Focus on: (1) the trendline slope — positive slope means wider days are harder to predict (error grows with range); quantify the expected error increase per 10 pts of additional range, (2) whether HIGH confidence points are clustered in the lower-left (low error, narrow range) — this would confirm that the user naturally assigns high confidence on quieter days with cleaner TRACE signals, (3) outliers: any HIGH confidence point with large error is a misfire worth investigating — note its approximate coordinates if visible, (4) whether the trendline slope is steep enough to justify a "skip TRACE on wide-range days" rule — if error > 10 pts only when range > 30 pts, the rule has a natural threshold, (5) sample size caveat: day_range_pts requires both actual_close and the outcomes table to be populated for the same date; fewer points than the total prediction count indicates missing outcome data; state the approximate n visible in the scatter.',
)}

${plotRefBlock(
  'structure_by_vix',
  SRC_STRUCTURE_BY_VIX,
  'Grouped bar chart showing structure type accuracy (PCS/CCS/IC) across VIX regime buckets (<15 calm, 15-20 normal, 20-25 elevated, 25+ high). Each cluster of bars = one VIX regime; bars within each cluster = accuracy for PCS, CCS, and IC respectively. Reference lines at 80% (profitability target) and 50% (break-even). This reveals whether structure selection accuracy is regime-dependent — for example, whether CCS accuracy degrades in elevated VIX (when directional calls are harder) while PCS remains strong.',
  'Focus on: (1) which structure is most regime-sensitive — a structure whose bar heights vary greatly across VIX buckets is unreliable and should be sized down in high-VIX regimes; name the structure and the accuracy range, (2) whether the 80% profitability threshold is met for each structure in the 15-20 VIX bucket (the most common regime) — this is the primary operating regime and its accuracy determines baseline sizing, (3) the elevated (20-25) VIX bucket — if accuracy drops below 80% there, the trading rule should require higher confirmation signals in that regime, (4) CRITICAL sample size: with ~39 total days split across 3-4 buckets and 3 structures, many cells have n < 5; state the smallest n visible and whether any bar should be ignored for being a single-day anecdote, (5) whether one VIX regime uniformly dominates all others (all three structures accurate) — that would be the ideal operating environment to over-size, while regimes with mixed accuracy should reduce sizing.',
)}

${plotRefBlock(
  'rolling_accuracy',
  SRC_ROLLING_ACCURACY,
  '10-day rolling accuracy time series over the chronological sequence of labeled trading days. The line shows smoothed accuracy over the most recent 10 days; the green fill above the overall mean and red fill below reveal periods of outperformance and underperformance. The dashed horizontal overall mean line (~92% from the static system context) is the benchmark. This is the primary drift-detection plot: a sustained red fill over 10+ days signals model degradation or regime change.',
  'Focus on: (1) whether the rolling accuracy is currently above or below the overall mean — state the approximate current value and direction of the last slope, (2) any extended red-fill periods (rolling accuracy below mean for 5+ days) — these indicate regime changes where the model struggled; identify the date range and magnitude of the dip, (3) whether the rolling accuracy is trending up or down toward the end of the time series — a downward trend at the tail signals emerging degradation that warrants investigation before it reaches statistical significance, (4) the amplitude of oscillation — if accuracy swings between 70-100% on a 10-day window with only 40 days of data, the rolling window is too small to be reliable; note whether the fill area oscillates rapidly or shows sustained trends, (5) whether accuracy drops align with any patterns observable in other plots (e.g., high-VIX periods, wider range days) — cross-reference if the timing is consistent.',
)}

${plotRefBlock(
  'flow_by_vix',
  SRC_FLOW_BY_VIX,
  "Grouped bar chart comparing the top 4 flow sources' direction accuracy across VIX regime buckets. Each regime bucket is a cluster of 4 bars (one per flow source). This reveals whether flow signals degrade in elevated volatility — for example, whether Market Tide accuracy drops from 61% in 15-20 VIX to near-50% in 20-25 VIX, which would justify down-weighting flow signals in high-vol sessions. The 50% dashed reference line marks coin-flip accuracy.",
  'Focus on: (1) which flow sources are most regime-stable — a source whose accuracy stays above 55% across all VIX buckets is a reliable all-weather signal vs one that is only useful in calm conditions; name the sources in both categories, (2) whether any source actually improves accuracy in elevated VIX (potentially anti-correlated with vol) — this would be a contrarian signal worth elevating in the live prompt during high-VIX sessions, (3) whether the 15-20 VIX bucket (most common regime) shows meaningful differentiation between sources — if accuracy ranges from 45-70% in that bucket, the spread validates the source ranking system, (4) CRITICAL sample size: with ~39 total days split across 3-4 VIX buckets, each bucket may have n=10-15 days; at n=10, Wilson CI half-width is ±15pp, meaning 61% accuracy has CI of [46%, 76%] — flag any bar where the implied CI overlaps 50%, (5) whether the flow reliability ranking from the flow_reliability plot holds within each VIX bucket — if Market Tide is ranked #1 overall but drops to #3 in elevated VIX, the Tier 1/2/3 signal hierarchy needs conditional branching.',
)}

${plotRefBlock(
  'pnl_distribution',
  SRC_PNL_DISTRIBUTION,
  'P&L distribution histograms from the backtest, one subplot per trading structure (PCS/CCS/IC). Each bar is green if its P&L bin is positive, red if negative. A white dashed line marks zero (break-even); an orange dashed line marks the mean P&L. The corner annotation shows total accumulated P&L for each structure. Win rates and trade counts are in the subplot titles. This shows the distribution shape — bimodal (win/loss binary from spreads), right-skewed, or surprisingly wide — which affects Kelly sizing and drawdown expectations.',
  'Focus on: (1) the bimodality pattern — credit spread P&L should cluster near +$200 (max credit) and -$1,800 (max loss) creating two distinct humps; if the distribution is smooth/normal, the backtest may have position sizing artifacts, (2) the win/loss count ratio embedded in the bar sizes — cross-validate against win_rate stated in the title, (3) whether any structure has a right-skewed outlier (large positive P&L) that suggests leveraged winners — this would be inconsistent with defined-risk credit spreads and warrants investigation, (4) the mean P&L line position — if the orange line is to the right of zero, expected value per trade is positive; name the approximate value and multiply by trade count for annualized expectation, (5) cross-structure comparison: which structure has the cleanest bimodal distribution (fewest partial fills or adjustment trades), and does the structure with highest win_rate also show the best total P&L — if not, the win rate may be misleading due to different premium sizes.',
)}

${plotRefBlock(
  'cluster_transitions',
  SRC_CLUSTER_TRANSITIONS,
  "Markov transition probability heatmap for day-type clusters. Each row is a 'from' cluster (today's day type); each column is a 'to' cluster (next trading day's type). Cell (i,j) = P(next day is cluster j | today is cluster i). Row sums to 1.0. High diagonal values indicate regime persistence (today's cluster predicts tomorrow's cluster). High off-diagonal values indicate systematic regime rotation. This is operationally important: if you are in a low-volatility cluster today with 80% probability of staying tomorrow, you have advance notice to continue current strategy sizing.",
  'Focus on: (1) diagonal dominance — if diagonal cells are all > 0.5, regime persistence is the rule and yesterday\'s cluster is predictive; state the minimum diagonal value and which cluster is LEAST persistent (most likely to switch), (2) the specific high off-diagonal transitions — if cluster 0 → cluster 1 has p=0.60, this is an actionable signal: when in cluster 0, prepare for cluster 1 conditions the next day; name any off-diagonal cell above 0.3 and state its trading implication, (3) whether any cluster is a "trap" state — a cluster where almost all transitions go to a single other cluster (one dominant off-diagonal) would indicate a predictable forced rotation, (4) CRITICAL sample size: with ~39 trading days and k=2-3 clusters, the most common cluster may have 25 days and the rarest 5 days; at n=5 transitions, each cell\'s empirical probability has a 95% CI of roughly ±40%; flag cells based on small n before drawing operational conclusions, (5) whether the transition probabilities align with the VIX regime dynamics observed in other plots — if high-VIX clusters show lower self-transition rates (more unstable), that confirms VIX as a regime-change predictor and warrants heightened monitoring.',
)}

${plotRefBlock(
  'flow_q1_distributions',
  SRC_FLOW_Q1_DISTRIBUTIONS,
  'Four-panel (2x2) distribution overview of UW (Unusual Whales) 0-1 DTE SPXW repeated-hit flow alerts. These alerts are ingested via cron from the UW API and represent unusual options activity on SPX weekly options expiring today or tomorrow. Top-left: total premium distribution on log10 scale (captures the heavy right tail of institutional-size trades). Top-right: ask-side ratio (fraction of volume at the ask — values near 1.0 indicate aggressive buying). Bottom-left: distance percentage from ATM (negative = ITM, positive = OTM, zero line = at-the-money). Bottom-right: alert rule category counts from UW classification.',
  'Focus on: (1) the premium distribution shape — is it log-normal as expected, or does it show a bimodal pattern suggesting two distinct populations (retail vs institutional flow)? If the median premium is below $50K, most alerts may be retail noise, (2) the ask-side ratio — if the distribution is concentrated above 0.7, alerts are predominantly aggressive (ask-side) trades which carry stronger directional signal, (3) the distance_pct distribution — are most alerts clustered near ATM (< 1%) or spread across OTM strikes? ATM clustering suggests hedging; OTM concentration suggests directional bets, (4) the alert rule breakdown — which UW rule categories dominate? If one rule accounts for >60% of alerts, the dataset may lack diversity in flow signal types.',
)}

${plotRefBlock(
  'flow_q2_time_of_day',
  SRC_FLOW_Q2_TIME_OF_DAY,
  'Two-panel time distribution of flow alerts during the CT trading session. Left: minute-level histogram (5-minute bins from 08:30 to 15:00 CT) showing when alerts fire during the day. Right: hourly aggregation. Both are in Central Time. The session bounds match the regular SPX session (08:30-15:00 CT).',
  'Focus on: (1) the intraday concentration pattern — is there a strong opening burst (08:30-09:00 CT) that decays, or a more uniform distribution? A heavy opening cluster means alerts are reacting to overnight positioning unwind, which has different information content than mid-session alerts, (2) whether there is a lunch lull (11:30-12:30 CT) — the absence of alerts during low-volume periods would confirm they are volume-dependent signals, (3) any late-session spike (14:00-15:00 CT) — this is the 0DTE gamma intensification window, and flow alerts here may carry outsized pin risk information, (4) the practical implication for the live trading system: if 80%+ of alerts fire before 10:00 CT, the T1 checkpoint already captures most flow signal and later checkpoints add little incremental information.',
)}

${plotRefBlock(
  'flow_q3_directional',
  SRC_FLOW_Q3_DIRECTIONAL,
  'Bar chart classifying all flow alerts as bullish (OTM calls), bearish (OTM puts), or neutral (ITM options on either side). Green/gray/red color coding. The classification uses the is_itm flag and option type from the UW data. This shows the aggregate directional tilt of unusual flow activity across the dataset.',
  'Focus on: (1) the bullish/bearish ratio — a ratio significantly above 1.0 across the full dataset indicates a structural call-buying bias in SPX weekly options (common in trending bull markets), while near 1.0 suggests balanced flow, (2) the neutral (ITM) fraction — a large neutral bar means many alerts are on ITM options which are typically hedging or rolling activity, not directional bets; if neutral exceeds 30%, the directional signal from flow alerts is diluted, (3) comparison against the base rate of settlement direction — if the dataset is 55% up-settlement and 60% of alerts are bullish, flow alerts may simply mirror the underlying trend rather than providing alpha, (4) sample size — state the total N and whether it is sufficient to trust the ratio as representative of typical market conditions.',
)}

${plotRefBlock(
  'flow_q4_returns_by_rule',
  SRC_FLOW_Q4_RETURNS_BY_RULE,
  'Bar chart of mean 15-minute forward returns (in basis points) for each combination of UW alert_rule and option type (call/put). Green bars = call alerts, red bars = put alerts. The forward return is measured from the alert timestamp to 15 minutes later. This tests whether different UW alert rule categories carry distinct short-term predictive power for SPX price movement.',
  'Focus on: (1) which rule × type combinations show positive mean returns — these are the flow signals that actually predict near-term direction; a call alert with positive 15-min return means buying after the alert was profitable on average, (2) the magnitude — returns of ±5 bps over 15 minutes are meaningful for 0DTE SPX options (roughly ±3 pts on a 5800 SPX), (3) whether calls and puts within the same rule show opposite signs (expected if the rule captures genuine directional flow) or same signs (suggests the rule captures volatility events, not direction), (4) CRITICAL: 15-minute returns are noisy and require large n per group for statistical reliability — groups with n < 20 should be flagged as unreliable regardless of how extreme the mean return appears, (5) whether any rule × type combination shows consistently negative returns — this would be an anti-signal worth fading in the live system.',
)}

${plotRefBlock(
  'flow_q5_premium_vs_return',
  SRC_FLOW_Q5_PREMIUM_VS_RETURN,
  'Scatter plot of log10(total_premium) on x-axis vs 15-minute forward return on y-axis, colored by option type (green = calls, red = puts). Linear trendline (blue dashed) fitted via polyfit. Pearson r and p-value in the title. This tests whether larger premium trades carry stronger directional signal — the hypothesis is that institutional-size flow (high premium) is more informative than retail-size flow.',
  'Focus on: (1) the Pearson r and p-value — at the dataset n, is the correlation statistically significant? A positive r for calls would mean larger call trades predict upward moves; a negative r would be surprising and worth investigating, (2) the scatter pattern — is it a clean linear relationship (r > 0.3) or a noisy cloud (r < 0.1)? If the cloud dominates, premium size alone does not predict direction, (3) whether separating calls from puts would show different slopes — the aggregate Pearson r may mask opposing relationships in the two groups, (4) the practical threshold: if only trades above $500K premium show a meaningful return pattern, the live system should filter flow alerts by a minimum premium floor before using them for directional bias, (5) outliers — individual large-premium trades with extreme returns may dominate the trendline; note if the regression appears driven by 1-2 points.',
)}

${plotRefBlock(
  'nope_direction_by_sign',
  SRC_NOPE_DIRECTION_BY_SIGN,
  'Bar chart comparing up-day settlement rates when NOPE (Net Options Pricing Effect) at checkpoint T1 is positive vs negative. NOPE measures the net delta impact of all SPY options flow normalized by SPY share volume — positive NOPE means net call-delta pressure (bullish options positioning), negative means net put-delta pressure. Fisher exact test p-value is shown in the title. Baseline up-day rate shown as gray dashed line.',
  'Focus on: (1) the directional separation — if positive NOPE days settle up at 65%+ while negative NOPE days settle up at <45%, the signal has genuine predictive power and deserves a slot in the live system Rule 8 signal hierarchy, (2) the Fisher exact p-value — at the dataset n, p < 0.05 means the effect is statistically significant; p > 0.15 means it could be chance, (3) comparison against existing flow sources — the flow_reliability plot shows Market Tide at ~61%; if NOPE exceeds this, it should be weighted higher in the live prompt, (4) the baseline up-rate — if the dataset has a strong bull bias (>60% up days), even a 65% positive-NOPE up-rate may not beat the base rate meaningfully, (5) sample size per bar — with small n, the bars may be misleading; state the counts and whether Wilson CIs overlap 50%.',
)}

${plotRefBlock(
  'nope_mt_agreement',
  SRC_NOPE_MT_AGREEMENT,
  'Three-bar chart showing correct prediction rates when NOPE and Market Tide (mt_ncp_t1) agree bullish, agree bearish, or disagree at checkpoint T1. For agree-bullish, correct = up-day rate. For agree-bearish, correct = down-day rate (inverted). For disagree, up-day rate is shown as reference only (no prediction made). Overall up-rate baseline shown as blue dashed line.',
  'Focus on: (1) whether agreement boosts accuracy — if agree-bull correct rate (say 75%) significantly exceeds both NOPE-alone (~60%) and Market Tide-alone (~61%), the conjunction filter adds real value and should be implemented as a Tier 1 signal in the live prompt, (2) the agree-bearish correct rate — this is the harder test since down days are the minority class; a high rate here (>60%) would be especially valuable for CCS selection, (3) the disagree bar — if disagreement up-rate is near 50%, conflicting signals genuinely indicate uncertainty and the system should reduce confidence or sit out, (4) the agree-bull vs agree-bear sample sizes — extreme asymmetry (e.g., 25 agree-bull vs 5 agree-bear) means the bearish agreement rate is unreliable, (5) the operational implication: define the specific conjunction rule ("if NOPE > 0 AND Market Tide > 0, then bullish bias at +X confidence") and the expected P&L impact at 9:1 risk/reward.',
)}

${plotRefBlock(
  'nope_flips_vs_range',
  SRC_NOPE_FLIPS_VS_RANGE,
  'Scatter plot of morning NOPE sign flips (x-axis) vs full-day SPX range in points (y-axis). AM sign flips count how many times NOPE crossed zero during the pre-11:00 ET morning session — frequent sign changes indicate oscillating options flow with no consistent directional pressure. Orange dots with blue trendline. Spearman rho and p-value in the title.',
  'Focus on: (1) the Spearman rho sign and significance — a positive rho (more flips → wider range) would validate sign flips as a chop/volatility indicator; the system could use high-flip mornings as a caution signal for iron condor risk, (2) the practical threshold — is there a flip count above which ranges are consistently wider (e.g., >4 flips → range > 30 pts)? This would become a binary rule for the live system, (3) whether the relationship is linear or has a threshold effect — the trendline may be flat for 0-2 flips and steep for 3+, which means a simple correlation underestimates the signal at the extremes, (4) sample size and the flip count distribution — if most days have 0-1 flips and only 3-4 days have 4+ flips, the tail is unreliable, (5) cross-reference with GEX regime: do high-flip + negative-GEX days produce the widest ranges? This interaction would compound the risk signal.',
)}

${plotRefBlock(
  'nope_cumdelta_vs_move',
  SRC_NOPE_CUMDELTA_VS_MOVE,
  'Scatter plot of AM cumulative NOPE delta (x-axis) vs full-session SPX close-minus-open move in points (y-axis). The cumulative delta sums all signed NOPE readings during the morning session — a large positive value means persistent call-delta pressure, large negative means persistent put-delta pressure. Green dots = up days, red dots = down days. Blue trendline. Pearson r and p-value in title.',
  'Focus on: (1) the Pearson r direction and significance — a positive r means AM cumulative call-delta pressure predicts upward closes (the intuitive direction); state the exact r and p, (2) the trendline slope in practical terms — how many points of close-open move does each unit of cumulative NOPE delta predict? This translates directly to strike selection offset, (3) whether green (up) and red (down) dots separate cleanly along the trendline or intermix — clean separation validates the signal for directional trading; intermixing means the signal carries noise, (4) outliers — any large cumulative delta day with opposite settlement direction is a failure case worth investigating (market override of options flow signal), (5) comparison against the TRACE predicted close — if both NOPE cumulative delta and TRACE agree on direction, that conjunction may be the highest-conviction filter available to the system.',
)}

${plotRefBlock(
  'nope_magnitude_vs_move',
  SRC_NOPE_MAGNITUDE_VS_MOVE,
  'Bar chart of mean absolute SPX move (|close - open| in pts) bucketed by NOPE magnitude terciles at T1: low |NOPE|, mid |NOPE|, high |NOPE|. Tests whether stronger NOPE readings (either direction) predict larger absolute moves — the conviction hypothesis. Blue/purple/orange bars. Spearman rho in title.',
  'Focus on: (1) whether the bars show a monotonic increase (low → mid → high NOPE magnitude → larger absolute moves) — this validates NOPE magnitude as a conviction indicator and the live system could use it for sizing (high |NOPE| = larger position), (2) the magnitude difference — if high |NOPE| days average 25 pts vs low |NOPE| at 15 pts, that 10-pt spread matters for credit spread width selection, (3) Spearman rho significance — at the dataset n, is the rank correlation statistically meaningful or just tercile artifacts with small n? (4) whether this interacts with direction — high magnitude + correct direction = best case; high magnitude + wrong direction = worst case (the 9:1 risk/reward amplifies both), (5) sample size per tercile — each has n/3 days; state the counts and whether any tercile mean is driven by a single outlier day.',
)}

<output_format>
Respond with a valid JSON object containing exactly these 3 fields:
{
  "what_it_means": "...",
  "how_to_apply": "...",
  "watch_out_for": "..."
}

Each field should contain 2-5 paragraphs of substantive analysis. Every sentence must add information — do not pad with filler, throat-clearing, or vague generalities. Be specific: cite numbers from the data, reference specific features by name, and connect findings to concrete trading decisions.

Do NOT wrap the JSON in markdown code fences. Return raw JSON only.
</output_format>`;
