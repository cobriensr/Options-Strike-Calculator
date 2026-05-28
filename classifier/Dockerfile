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

USER classifier

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["python", "-m", "main"]
