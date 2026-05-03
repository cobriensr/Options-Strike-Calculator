"""Structured JSON logging for uw-stream.

Format mirrors the sidecar so Railway log drains can parse both
services with the same pipeline.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

# Fields that handlers may attach via `extra={}` in log calls. New
# fields are forwarded into the JSON line so we don't have to extend
# this list every time a caller wants to add structured context.
_RESERVED_LOGRECORD_ATTRS = frozenset(
    {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "asctime",
        "taskName",
    }
)


class JsonFormatter(logging.Formatter):
    """One JSON object per log line, compatible with Railway log drains."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            "level": record.levelname.lower(),
            "time": datetime.now(UTC).isoformat(),
            "service": "uw-stream",
            "msg": record.getMessage(),
        }
        # Forward any structured `extra` fields verbatim.
        for key, value in record.__dict__.items():
            if key not in _RESERVED_LOGRECORD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def get_logger(name: str = "uw-stream") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


log = get_logger()
