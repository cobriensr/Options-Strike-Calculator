# Build context: the REPO ROOT, not nightly/ (`docker build -f nightly/Dockerfile .`).
# The nightly pass runs the owner's enrich scripts in place, so the image carries six
# files from outside nightly/. A file added to or removed from that set changes six
# places together (plan D1, docs/superpowers/plans/2026-10-29-nightly-pipeline-phase2.md):
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
    scripts/enrich_lottery_outcomes.py \
    scripts/enrich_silent_boom_outcomes.py \
    ./scripts/
# The enrich script puts <ROOT>/ml/src on sys.path itself, with ROOT = /app.
COPY --chown=nightly:nightly ml/src/lottery_exit_policies.py ./ml/src/

ENV POLARS_MAX_THREADS=4 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src:/app/scripts

USER nightly

# Cron job: runs once and exits. No HEALTHCHECK and no EXPOSE.
CMD ["python", "-m", "main"]
