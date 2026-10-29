FROM python:3.12-slim AS builder

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim

RUN addgroup --system --gid 1001 nightly && \
    adduser --system --uid 1001 --ingroup nightly nightly

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=nightly:nightly src/ ./src/

ENV POLARS_MAX_THREADS=4 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src

USER nightly

# Cron job: runs once and exits. No HEALTHCHECK and no EXPOSE.
CMD ["python", "-m", "main"]
