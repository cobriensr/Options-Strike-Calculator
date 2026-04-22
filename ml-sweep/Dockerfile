FROM python:3.12-slim AS builder

WORKDIR /app

# Build deps for any wheels we need to compile (duckdb, psycopg2 in later
# phases). Keep them in the builder stage so the final image stays small.
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libc-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


FROM python:3.12-slim

# Runtime deps: curl for the Railway health probe.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 sweep && \
    adduser --system --uid 1001 --ingroup sweep sweep

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=sweep:sweep app.py runner.py archive_seeder.py ./

# Pre-create the archive mount point so chown can take effect before
# Railway mounts the volume at runtime (the volume will overlay this dir,
# but ensuring it exists prevents "No such file or directory" errors
# if /data isn't mounted during local Docker runs).
RUN mkdir -p /data/archive && chown -R sweep:sweep /data

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

USER sweep

# Railway injects $PORT. Bind to 0.0.0.0 so it's reachable from outside.
# uvicorn honours the env var via shell expansion — keep CMD as sh -c so
# $PORT actually interpolates at runtime.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-8080}/health || exit 1
