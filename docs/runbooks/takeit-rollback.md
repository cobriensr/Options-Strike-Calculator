# TAKE-IT bundle rollback

When a freshly-promoted TAKE-IT bundle is producing bad scores in production,
roll back by pointing the loader's manifest at a prior bundle path.

## Read the current active manifest

```bash
make takeit-rollback
```

Prints the current `takeit/latest.json` contents (lottery + silentboom paths).

## Find a prior bundle path

The Python pipeline uploads bundles to `takeit/lottery-vYYYY-MM-DD.json` and
`takeit/silentboom-vYYYY-MM-DD.json` (see `ml/src/takeit/export_model.py`).
List prior blobs in the Vercel Blob console at the project's Blob store, or
via the Vercel CLI:

```bash
vercel blob list --prefix takeit/lottery-
```

## Flip the pointer

```bash
make takeit-rollback FEED=lottery PATH_OVERRIDE=takeit/lottery-v2026-05-10.json
make takeit-rollback FEED=silentboom PATH_OVERRIDE=takeit/silentboom-v2026-05-10.json
```

Dry-run first (`DRY_RUN=1`) to verify the JSON you're about to write.

## Confirm propagation

The bundle loader caches the manifest with a 15-minute TTL. Wait up to
15 minutes (or restart a warm Vercel container) for the next cron tick to
pick up the new pointer. The detect crons log the bundle version they're
scoring against; check Vercel Function logs for the next `detect-lottery-fires`
or `detect-silent-boom` invocation to confirm the rollback landed:

```bash
vercel logs --app strike-calculator --filter function=/api/cron/detect-lottery-fires
```

(swap `detect-lottery-fires` for `detect-silent-boom` when rolling back the
silentboom feed.)

## Audit trail

The script writes `rolled_back_at` (UTC ISO timestamp) into the manifest.
Future loads carry that field in memory; it's not surfaced anywhere else
yet. Once the Phase 2 `audit-takeit-health` cron ships, `rolled_back_at`
will land in the `takeit_health_daily` table for historical visibility.
