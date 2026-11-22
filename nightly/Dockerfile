# Build context: the REPO ROOT, not nightly/ (`docker build -f nightly/Dockerfile .`).
# The nightly pass runs the owner's enrich scripts, the refit modules and the research
# reports in place, so the image carries twenty-one files from outside nightly/. A file
# added to or removed from that set changes six places together (plan D1,
# docs/superpowers/plans/2026-10-29-nightly-pipeline-phase2.md):
#   1. a COPY line below
#   2. the Railway watch paths of the `nightly` service
#   3. the `scripts/` re-admits in the root .dockerignore
#   4. IMAGE_FILES in nightly/tests/test_image_layout.py
#   5. the `nightly` paths filter in .github/workflows/ci.yml
#   6. the watch-path list in nightly/README.md
FROM python:3.12-slim AS builder

WORKDIR /app

COPY nightly/requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim

RUN addgroup --system --gid 1001 nightly && \
    adduser --system --uid 1001 --ingroup nightly nightly

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=nightly:nightly nightly/src/ ./src/
COPY --chown=nightly:nightly \
    scripts/_tape_reader.py \
    scripts/_cli_paths.py \
    scripts/_pipeline_retry.py \
    scripts/backfill_lottery_scores.py \
    scripts/enrich_lottery_outcomes.py \
    scripts/enrich_silent_boom_outcomes.py \
    scripts/_eod_flow.py \
    scripts/_report_weights.py \
    scripts/exit_policy_search.py \
    scripts/flow_inversion_timing.py \
    scripts/feature_audit.py \
    scripts/daily_tracker.py \
    scripts/mine_outcome_patterns.py \
    scripts/score_lineage_audit.py \
    ./scripts/
# Three of those scripts, enrich_silent_boom_outcomes, backfill_lottery_scores and
# _report_weights (which every Neon report imports), put <ROOT>/ml/src at the front of
# sys.path themselves when imported, with ROOT = /app. The nightly modules import from
# ml/src too (weights_store loads lottery_weights), so PYTHONPATH carries /app/ml/src,
# last, for an import that comes before any of them.
COPY --chown=nightly:nightly \
    ml/src/lottery_exit_policies.py \
    ml/src/lottery_refit_gates.py \
    ml/src/lottery_scoring.py \
    ml/src/lottery_weights.py \
    ml/src/whale_plots.py \
    ml/src/takeit_drift_monitor.py \
    ml/src/score_components.py \
    ./ml/src/

# MPLBACKEND=Agg: the plots go to files and the image has no display. MPLCONFIGDIR is a
# writable cache directory for the in-process drift step, which imports matplotlib in the
# job's own process (the report subprocesses get their own under the research work dir).
ENV POLARS_MAX_THREADS=4 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src:/app/scripts:/app/ml/src \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib

USER nightly

# Cron job: runs once and exits. No HEALTHCHECK and no EXPOSE.
CMD ["python", "-m", "main"]
