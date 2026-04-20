# Archive Volume Seed (Databento ES/NQ 1m historical)

## Goal

Seed the Railway `/data` volume (5GB, mounted on the sidecar) with our 476MB
DBN→Parquet archive so DuckDB on the sidecar can serve analog-day and
IV-rank lookups without dragging 16 years of 1m bars through the hot path.

Because Railway explicitly does not support SCP/SFTP/rsync into volumes
(per docs, SSH is WebSocket-based and for interactive debugging only),
we use **Vercel Blob as an intermediate**:

```
laptop  ──upload──>  Vercel Blob  ──download──>  /data/archive (Railway volume)
  (one-time)          (persistent DR)             (queried by DuckDB)
```

## Why Blob as intermediate (not ngrok, not baked into image)

- Blob is already wired up in the repo (used for ML plots). Zero new auth.
- Durable snapshot: if the Railway volume is ever lost or resized
  destructively, the sidecar re-seeds automatically. No manual re-upload.
- Resumable: per-file SHA-256 check lets the seeder skip files already
  present on the volume with matching content.
- No new infra: ngrok would solve the transfer but adds a tool to install,
  a random public URL, and no durability story.

## Data dependencies

- `BLOB_READ_WRITE_TOKEN` — Vercel env var, already set in Vercel project.
  Needs to be **copied into Railway** as well (Railway service → Variables
  → add `BLOB_READ_WRITE_TOKEN`) so the sidecar can download.
- `ARCHIVE_SEED_TOKEN` — new admin token gating `POST /admin/seed-archive`
  to prevent public triggering. Set in Railway only.
- `ARCHIVE_ROOT` — already planned; set to `/data/archive` on Railway.
- `ARCHIVE_MANIFEST_URL` — Blob URL of the manifest JSON; exported by the
  upload script, set as a Railway env var after Phase 1.

## Files created / modified

| File                                   | Purpose                                        |
| -------------------------------------- | ---------------------------------------------- |
| `scripts/upload-archive-to-blob.mjs`   | NEW — laptop-side uploader                     |
| `sidecar/src/archive_seeder.py`        | NEW — download + SHA verify + write            |
| `sidecar/src/main.py`                  | MODIFIED — register `POST /admin/seed-archive` |
| `sidecar/src/archive_query.py`         | NEW (Phase 6) — DuckDB query layer             |
| `sidecar/tests/test_archive_seeder.py` | NEW — unit tests with mocked httpx             |
| `.gitignore`                           | MODIFIED — exclude `ml/data/archive/`          |
| `CLAUDE.md`                            | MODIFIED — document `ARCHIVE_*` env vars       |

## Open questions (default picks noted)

- **Concurrent downloads on seeder?** Default: 4 parallel. Blob CDN handles
  it fine; network to Railway US-West is the bottleneck not CPU.
- **Compression during upload?** Default: **no**. Parquet files are already
  zstd-compressed; re-compressing wastes CPU with zero size win.
- **Keep the admin endpoint after seed, or remove?** Default: **keep**,
  gated behind `ARCHIVE_SEED_TOKEN`. Makes re-seeding trivial if the
  volume ever needs to be rebuilt.

## Thresholds / constants

- Blob upload chunk size: `8 MiB` (Vercel Blob SDK default, good for 25MB files)
- Seeder retry: 3 attempts per file with exponential backoff (1s, 4s, 16s)
- SHA-256 verification: mandatory on every downloaded file; mismatch = fail loud
- Manifest format: `{ schema: 1, files: [{ path, size, sha256, blob_url }] }`

## Phases

### Phase 1 — Upload script + manifest (laptop → Blob)

- [ ] Write `scripts/upload-archive-to-blob.mjs` — walks
      `ml/data/archive/` recursively, uploads each file to Vercel Blob
      under path `archive/v1/<relative-path>`, computes SHA-256, appends
      to an in-memory manifest, finally uploads the manifest as
      `archive/v1/manifest.json` and prints its Blob URL.
- [ ] Run: `node scripts/upload-archive-to-blob.mjs`.
      → Verify: manifest URL printed; ~20 files listed; total bytes ≈ 476MB.
- [ ] Set `ARCHIVE_MANIFEST_URL` in Railway to the printed URL.

### Phase 2 — Seeder module + endpoint (sidecar)

- [ ] Write `sidecar/src/archive_seeder.py` with:
  - `seed_from_manifest(manifest_url, dest_root) -> SeedResult`
  - `SeedResult { downloaded, skipped, failed, bytes, elapsed_ms }`
  - Per-file SHA-256 verification; skip if already present with matching SHA.
  - 4-way concurrent download via `httpx.AsyncClient`.
- [ ] Wire `POST /admin/seed-archive` in `sidecar/src/main.py`:
  - Gate: `X-Admin-Token` header must equal `ARCHIVE_SEED_TOKEN` env.
  - Returns `SeedResult` JSON.
  - 423 Locked while seed is in progress (single-flight).
- [ ] Write `sidecar/tests/test_archive_seeder.py`:
  - Happy path (3 fake files, mocked httpx).
  - Resume path (files already present, skipped).
  - Integrity fail (bad SHA raises + partial file cleaned up).
  - Concurrent seed request returns 423.

### Phase 3 — Trigger + Verify

- [ ] Set `ARCHIVE_SEED_TOKEN` in Railway (`openssl rand -hex 32`).
- [ ] Set `BLOB_READ_WRITE_TOKEN` in Railway (copy from Vercel).
- [ ] `curl -X POST -H "X-Admin-Token: ..." https://sidecar.railway.app/admin/seed-archive`.
      → Verify: `SeedResult` returns `{ downloaded: ~20, failed: 0 }`.
- [ ] `railway ssh -- ls -la /data/archive/ohlcv_1m/ | wc -l`.
      → Verify: 17 year partitions present.
- [ ] `railway ssh -- du -sh /data/archive`.
      → Verify: ≈ 476MB on disk.

### Phase 4 — Gitignore + env docs

- [ ] Add `ml/data/archive/` to `.gitignore`.
- [ ] Document `ARCHIVE_ROOT`, `ARCHIVE_MANIFEST_URL`, `ARCHIVE_SEED_TOKEN`
      in `CLAUDE.md` env var table.
- [ ] Commit.

### Phase 5 — Verification (LAST)

- [ ] `npm run review` — tsc + eslint + prettier + vitest all green.
- [ ] `cd sidecar && pytest tests/test_archive_seeder.py -v` — all pass.
- [ ] Manually re-trigger the seed endpoint: expect `downloaded: 0, skipped: ~20`
      (proves SHA-based resume is working).

## Done when

- [ ] `/data/archive` on Railway has all 17 year partitions + symbology.parquet + condition.json + convert_summary.json.
- [ ] Re-triggering the seeder is a no-op (SHA match → all skipped).
- [ ] `npm run review` is green.
- [ ] Seeder tests pass.

## Notes

- **Phase 6 (out of scope for this plan)**: write `archive_query.py` with
  DuckDB-backed FastAPI routes — `/archive/analog-days`,
  `/archive/iv-rank`, `/archive/contract-history`. Blocked on volume
  being populated, so gated on this plan completing first.
- **Why no manifest signing**: single-user system, and the Blob URL itself
  is the capability. If the URL leaks, the worst case is someone seeing
  our Parquet files — no secrets, no PII, only public market data.
- **Why `X-Admin-Token` and not Railway's own auth**: Railway doesn't
  gate inbound HTTP. The sidecar is public-by-default, and the existing
  endpoints already use per-route tokens. Same pattern here.
