"""Structured JSON logging matching the existing pino-style output."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    """Emit one JSON object per log line, compatible with Railway log drain."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict = {
            "level": record.levelname.lower(),
            "time": datetime.now(timezone.utc).isoformat(),
            "service": "futures-relay",
            "msg": record.getMessage(),
        }
        # Attach any extra structured fields passed via `extra={}`
        for key in ("symbol", "symbols", "err", "backoff", "port", "alert"):
            val = getattr(record, key, None)
            if val is not None:
                log_entry[key] = val
        return json.dumps(log_entry)


def get_logger(name: str = "sidecar") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger


log = get_logger()
