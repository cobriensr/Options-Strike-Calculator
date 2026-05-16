"""Load DATABASE_URL from repo .env.local (mirrors scripts/enrich_silent_boom_outcomes.py)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = ROOT / '.env.local'

FULLTAPE_DIR = Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet'


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k.strip(), v)


def database_url() -> str:
    load_env()
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('DATABASE_URL not set after loading .env.local')
    return url


def fulltape_path(date_str: str) -> Path:
    return FULLTAPE_DIR / f'{date_str}-fulltape.parquet'


def fulltape_exists(date_str: str) -> bool:
    return fulltape_path(date_str).exists()
