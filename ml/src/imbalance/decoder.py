"""Decode Databento DBN.zst imbalance files into a consolidated Parquet.

Usage:
    python -m src.imbalance.decoder <download-folder> <output-parquet>

A download folder is one of the four order folders under ~/Downloads:
- XNAS-*  (Nasdaq TotalView-ITCH, dataset XNAS.ITCH)
- XNYS-*  (NYSE Pillar, dataset XNYS.PILLAR)
- ARCX-*  (NYSE Arca, dataset ARCX.PILLAR)

Each folder contains one .dbn.zst file per trading day plus metadata.json.
The decoder iterates the daily files, decodes via the databento SDK, applies
schema cleanup, and writes a single Parquet to the output path.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import databento as db
import numpy as np
import pandas as pd

# uint32 sentinel that Databento uses for "field not populated"
NULL_U32 = 4_294_967_295

# Columns we keep in the output Parquet (rest are dropped to keep file small)
KEEP_COLS = [
    "ts_event_ns",
    "ts_event_et",
    "dataset",
    "symbol",
    "auction_type",
    "auction_time",
    "side",
    "unpaired_side",
    "ref_price",
    "cont_book_clr_price",
    "auct_interest_clr_price",
    "paired_qty",
    "total_imbalance_qty",
    "market_imbalance_qty",
    "unpaired_qty",
    "signed_imbalance",
    "significant_imbalance",
]


def _signed_imbalance(side: pd.Series, qty: pd.Series) -> pd.Series:
    """Signed imbalance: side='B' is buy-side (+), 'A' is sell-side (−), 'N' is 0.

    NaN quantity (from the UINT32 sentinel earlier) propagates as NaN so callers
    can distinguish "field not populated" from a real zero imbalance. Returns a
    nullable Int64 to permit NaN.
    """
    sign = np.select(
        [side == "B", side == "A"],
        [1, -1],
        default=0,
    )
    return (qty * sign).astype("Int64")


def _load_metadata(folder: Path) -> dict:
    return json.loads((folder / "metadata.json").read_text())


def _decode_one_file(path: Path, dataset: str) -> pd.DataFrame:
    store = db.DBNStore.from_file(str(path))
    df = store.to_df(pretty_ts=True, map_symbols=True)
    if df.empty:
        return df

    # ts_recv is the pandas index; promote to a column with a clearer name.
    df = df.reset_index()
    # ts_event is tz-aware (UTC) after pretty_ts=True; .astype('int64') yields ns
    # since epoch, which is what we want for stable cross-venue joins.
    df["ts_event_ns"] = df["ts_event"].astype("int64")
    df["ts_event_et"] = df["ts_event"].dt.tz_convert("America/New_York")
    df["dataset"] = dataset

    # Defensive: a missing side enum would silently zero-out via np.select default.
    # If this ever fires, the Databento schema or codec has changed.
    if df["side"].isna().any():
        n_bad = int(df["side"].isna().sum())
        raise ValueError(f"{path.name}: {n_bad} rows with NaN side — schema change?")

    # Replace UINT32 sentinel with NaN on quantity fields.
    for col in (
        "market_imbalance_qty",
        "unpaired_qty",
        "total_imbalance_qty",
        "paired_qty",
    ):
        if col in df.columns:
            df.loc[df[col] == NULL_U32, col] = np.nan

    df["signed_imbalance"] = _signed_imbalance(df["side"], df["total_imbalance_qty"])

    keep = [c for c in KEEP_COLS if c in df.columns]
    return df[keep]


def decode_folder(folder: Path, output: Path) -> int:
    """Decode every .dbn.zst file in `folder` and write a consolidated Parquet.

    Returns the total number of rows written.
    """
    meta = _load_metadata(folder)
    dataset = meta["query"]["dataset"]

    dbn_files = sorted(folder.glob("*.imbalance.dbn.zst"))
    if not dbn_files:
        raise FileNotFoundError(f"No .imbalance.dbn.zst files in {folder}")

    frames: list[pd.DataFrame] = []
    for i, path in enumerate(dbn_files, 1):
        try:
            df = _decode_one_file(path, dataset)
        except Exception as e:
            print(f"[{i}/{len(dbn_files)}] FAILED {path.name}: {e}", file=sys.stderr)
            raise
        if not df.empty:
            frames.append(df)
        if i % 25 == 0:
            print(f"  decoded {i}/{len(dbn_files)} files")

    if not frames:
        raise RuntimeError(f"No non-empty frames decoded from {folder}")

    out = pd.concat(frames, ignore_index=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(output, compression="zstd", index=False)
    return len(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Databento download folder")
    parser.add_argument("output", type=Path, help="Output parquet path")
    args = parser.parse_args()

    folder = args.folder.expanduser().resolve()
    output = args.output.expanduser().resolve()

    if not folder.is_dir():
        print(f"Not a directory: {folder}", file=sys.stderr)
        return 2

    print(f"Decoding {folder.name} → {output}")
    rows = decode_folder(folder, output)
    print(f"Wrote {rows:,} rows to {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
