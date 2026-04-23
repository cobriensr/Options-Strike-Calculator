FROM python:3.12-slim AS builder

WORKDIR /app

# Build deps for wheels that compile from source (numpy, pandas on edge
# versions, duckdb). gcc + libc-dev is enough; pandas/numpy ship most
# arch wheels but smaller packages sometimes rebuild.
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libc-dev && \
    rm -rf /var/lib/apt/lists/*

# Both requirements sets share the same pip install so Python wheels
# cache cleanly across sweep + seeder deps.
COPY ml-sweep/requirements.txt ./sweep-requirements.txt
COPY ml/requirements.txt ./ml-requirements.txt
RUN pip install --no-cache-dir --prefix=/install \
    -r sweep-requirements.txt -r ml-requirements.txt


FROM python:3.12-slim

# Runtime deps: curl for Railway health probe.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Non-root user exists in the image for least-privilege defaults, BUT
# Railway volumes mount as root so we set RAILWAY_RUN_UID=0 on the service
# to actually run as root at runtime. The user is kept around anyway so
# future refactors can add an entrypoint chown+gosu drop-priv dance.
RUN addgroup --system --gid 1001 sweep && \
    adduser --system --uid 1001 --ingroup sweep sweep

WORKDIR /app

COPY --from=builder /install /usr/local

# Sweep service code
COPY ml-sweep/app.py ml-sweep/runner.py ml-sweep/archive_seeder.py /app/

# Python backtest library + sweep entry scripts. PYTHONPATH points at
# ml-src so the subprocess spawned by runner.py can `import pac.archive_loader`
# exactly like the developer's laptop does.
COPY ml/src /app/ml-src
COPY ml/scripts /app/ml-scripts

# Pre-create the volume mount point so local Docker runs (without the
# Railway volume overlay) still succeed. The volume overlay at runtime
# masks this dir but keeps the path valid in CI/testing.
RUN mkdir -p /data/archive /data/jobs

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONPATH=/app/ml-src

# Railway injects $PORT. Bind 0.0.0.0.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]

# INTENTIONALLY NO `HEALTHCHECK` DIRECTIVE.
#
# Railway runs a 5-sec curl probe to this container; if /health misses 3
# consecutive probes, Railway restarts the container. Our dispatched
# subprocess is in a SEPARATE process with its own GIL, so the parent
# uvicorn process stays responsive during sweeps in theory. In practice,
# the overnight 3-yr sweep and a second 5-min attempt both saw the
# container get killed mid-subprocess with no Python traceback — the
# classic signature of an external SIGKILL (OOM or health-probe trip).
#
# Since Railway provides its own port-liveness probe (less aggressive
# than a Docker HEALTHCHECK), we don't add one here. Without our own
# HEALTHCHECK the subprocess gets the full 6h runtime budget. If the
# container still restarts mid-sweep, /logs/{job_id} on the volume will
# show whatever the Python process printed before dying.
