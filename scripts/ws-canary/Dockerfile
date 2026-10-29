# Temporary websocket canary. Spec: docs/superpowers/specs/ws-canary-2026-10-28.md
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN addgroup --system --gid 1001 canary && \
    adduser --system --uid 1001 --ingroup canary canary

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY canary.py ./

USER canary

CMD ["python", "canary.py"]
