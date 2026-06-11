# Standalone multileg classifier service — split from sidecar/ per
# docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md
FROM python:3.12-slim AS builder

WORKDIR /app

# polars wheels are pure-binary on Linux, no system build deps needed.
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim

# curl is only used by the Docker HEALTHCHECK probe.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 classifier && \
    adduser --system --uid 1001 --ingroup classifier classifier

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=classifier:classifier src/ ./src/
COPY --chown=classifier:classifier _vendored_ml/ ./_vendored_ml/

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
# Make both src/ and the vendored matcher copies flat-importable. Mirrors
# the runtime sys.path injection that sidecar/src/multileg_routes.py's
# _ensure_ml_src_on_path() did dynamically; here we set it statically.
ENV PYTHONPATH=/app/src:/app/_vendored_ml
# Cap the polars thread pool. polars defaults to the host core count; on a
# multi-vCPU box each join fans into one build/probe partition per thread,
# each holding a slice of the intermediate, multiplying peak memory — so a
# bigger box raises the very peak that OOM-kills us. The matcher is ~1s/call
# and the crons call us sequentially, so 2 threads is ample throughput while
# capping the peak multiplier at 2x instead of Nx. Must be set BEFORE the
# process imports polars (read once at import). See
# docs/superpowers/specs/classifier-oom-rework-2026-06-11.md
ENV POLARS_MAX_THREADS=2
# Streaming-engine morsel size (rework Phase 3). Overridable for ops tuning.
ENV POLARS_STREAMING_CHUNK_SIZE=50000

USER classifier

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["python", "-m", "main"]
