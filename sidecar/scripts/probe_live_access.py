#!/usr/bin/env python3
"""Probe whether the current Databento license covers LIVE streaming for
CFE (VX) and IFUS (DX).

Run from sidecar/:

    .venv/bin/python scripts/probe_live_access.py

Each probe opens a brief (~5 s) Live session per dataset. Databento may
bill per session-minute, so keep probe runs infrequent. The probe does
NOT test CME (already known-good from the running Railway sidecar) —
adding it would spin up a second concurrent Live session on your key.

Success signal: a SymbolMappingMsg arrives within the timeout. On
weekends, no market data flows, so the mapping message is the only
positive entitlement indicator. An ErrorMsg indicates entitlement
denied.
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path
from types import FrameType

import databento as db
from dotenv import load_dotenv


PROBE_TIMEOUT_S = 5
MAX_RECORDS_PER_PROBE = 20

TESTS: list[tuple[str, str, str, list[str]]] = [
    ("CFE VX (new)",              "XCBF.PITCH",  "continuous", ["VX.n.0"]),
    ("IFUS DX (was blocked)",     "IFUS.IMPACT", "continuous", ["DX.n.0"]),
]


class _Timeout(Exception):
    pass


def _timeout_handler(_signum: int, _frame: FrameType | None) -> None:
    raise _Timeout()


def probe_live(
    api_key: str,
    label: str,
    dataset: str,
    stype_in: str,
    symbols: list[str],
) -> None:
    print(f"\n=== {label} ===")
    print(f"dataset={dataset} stype_in={stype_in} symbols={symbols}")

    client = db.Live(key=api_key)
    errors: list[str] = []
    saw_symbol_mapping = False
    record_count = 0

    try:
        client.subscribe(
            dataset=dataset,
            schema="trades",
            stype_in=stype_in,
            symbols=symbols,
        )
    except Exception as exc:
        print(f"  [FAIL] subscribe raised: {exc}")
        return

    prev_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(PROBE_TIMEOUT_S)

    try:
        client.start()
        for record in client:
            record_count += 1
            type_name = type(record).__name__
            if "Error" in type_name:
                raw = getattr(record, "err", None) or getattr(record, "message", "")
                if isinstance(raw, bytes):
                    raw = raw.decode(errors="replace")
                errors.append(f"{type_name}: {raw}")
                break
            if "SymbolMapping" in type_name:
                saw_symbol_mapping = True
            if record_count >= MAX_RECORDS_PER_PROBE:
                break
    except _Timeout:
        pass
    except Exception as exc:
        errors.append(f"stream exception: {exc}")
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, prev_handler)
        try:
            client.stop()
        except Exception:
            pass

    if errors:
        print(f"  [FAIL] {errors[0]}")
        for extra in errors[1:]:
            print(f"         {extra}")
    elif saw_symbol_mapping:
        print(f"  [OK] Subscription handshake succeeded ({record_count} frames).")
    else:
        print(f"  [INCONCLUSIVE] {record_count} frames, no symbol mapping, no error.")
        print("     Weekend — no market data expected; broker may not emit")
        print("     mapping until session opens. Re-run during market hours.")


def main() -> int:
    # .env lives in sidecar/, this script lives in sidecar/scripts/.
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    api_key = os.environ.get("DATABENTO_API_KEY")
    if not api_key:
        print("[FAIL] DATABENTO_API_KEY not set in sidecar/.env")
        return 1

    for label, dataset, stype_in, symbols in TESTS:
        probe_live(api_key, label, dataset, stype_in, symbols)

    return 0


if __name__ == "__main__":
    sys.exit(main())
