FROM python:3.12-slim AS builder

WORKDIR /app

# Install build dependencies for psycopg2
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libc-dev libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Theta Data Terminal requires Java 21+. We source the JRE from the
# official Eclipse Temurin image rather than apt so the exact same JDK
# verified on the developer's laptop ships to Railway.
FROM eclipse-temurin:21-jre-jammy AS jre

FROM python:3.12-slim

# Runtime dependencies: libpq5 for psycopg2, curl for the health probe.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 curl && \
    rm -rf /var/lib/apt/lists/*

# Co-resident Temurin 21 JRE for Theta Data Terminal. ~170 MB layer.
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN addgroup --system --gid 1001 sidecar && \
    adduser --system --uid 1001 --ingroup sidecar sidecar

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=sidecar:sidecar src/ ./src/
COPY --chown=sidecar:sidecar ThetaTerminalv3.jar ./

# Pre-create the working dir the Theta jar writes into (creds.txt, logs,
# config). Owned by sidecar so the non-root runtime can populate it.
RUN mkdir -p /app/theta_data/ThetaTerminal && \
    chown -R sidecar:sidecar /app/theta_data

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

USER sidecar

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["python", "-m", "src.main"]
