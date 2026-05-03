FROM python:3.12-slim AS builder

WORKDIR /app

# asyncpg + aiohttp wheels are pure-Python on Linux, so no system build
# deps needed beyond what python:3.12-slim ships with.
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim

# curl is only used by the Docker HEALTHCHECK probe.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 uwstream && \
    adduser --system --uid 1001 --ingroup uwstream uwstream

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=uwstream:uwstream src/ ./src/

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
# Make src/ flat-importable: handlers, config, db, etc. resolve as
# top-level modules. Mirrors the conftest sys.path setup used in tests.
ENV PYTHONPATH=/app/src

USER uwstream

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8080/healthz || exit 1

CMD ["python", "-m", "main"]
