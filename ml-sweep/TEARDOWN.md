# ml-sweep — teardown & cleanup

How to stop, scale down, or completely remove the `ml-sweep` Railway
service. Ordered by reversibility — least destructive first.

## Pause (keeps code + volume + history)

Use this when you're between sweep campaigns and want to stop paying
for the running container, but keep everything in place for the next
run. Cheapest-to-resume option.

```bash
railway service scale --replicas 0 --service ml-sweep
```

- Container stops; `/data/archive` and `/data/jobs/*` on the volume are
  preserved untouched.
- Env vars, Railway service config, and deploy history are preserved.
- Bringing it back: `railway service scale --replicas 1 --service ml-sweep`.
  Cold start ~15-30 sec.

## Prune old job scratch (keeps archive)

Over time `/data/jobs/<id>/` accumulates meta.json + log.txt + result.json
for every sweep ever run. Each is small (~tens of KB), but N in the
thousands will eat the volume.

```bash
# From a one-shot run container or via railway run:
railway run --service ml-sweep -- bash -lc \
  'find /data/jobs -maxdepth 1 -mindepth 1 -type d -mtime +30 -print -exec rm -rf {} +'
```

Prunes job directories older than 30 days. Adjust `-mtime` to taste.
The archive at `/data/archive` is untouched.

## Wipe the archive (keeps service + volume)

If the archive is corrupt or you want a clean re-hydrate:

```bash
# Remove the parquets only:
railway run --service ml-sweep -- bash -lc 'rm -rf /data/archive/*'

# Then re-hydrate from Vercel Blob:
source ml-sweep/.env
curl -sS -X POST "$ML_SWEEP_URL/hydrate" \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

Re-hydration is SHA-resumable — any files that already match are
skipped. A full 5 GB re-pull takes ~100 sec at Railway's internal
bandwidth.

## Delete the service (keeps project + volume)

Removes the compute service but leaves the attached volume and the
parent project intact. Use when you're done with PAC sweeps for now
but want to preserve the archive for later.

```bash
railway service delete ml-sweep
```

The 5 GB volume at `/data` persists in the Railway project and can be
re-attached to a new service later. Env vars on the service are deleted
along with the service; copy `AUTH_TOKEN`, `ARCHIVE_MANIFEST_URL`, and
`BLOB_READ_WRITE_TOKEN` off somewhere first if you'll need them.

## Delete the volume (full reset)

Nuclear option. Frees the 5 GB attached volume.

1. Railway dashboard → Theta-Options project → ml-sweep service → Volumes
2. Click the volume row → Delete
3. Confirm.

The next hydrate will need ~100 sec to fully repopulate from Blob. The
archive in Vercel Blob is untouched — that's the authoritative source.

## Full removal (service + volume + env vars)

```bash
# 1. Scale down to stop any in-flight jobs:
railway service scale --replicas 0 --service ml-sweep

# 2. Confirm no jobs are stuck running:
curl -sS "$ML_SWEEP_URL/status/<any-recent-job-id>" \
  -H "Authorization: Bearer $AUTH_TOKEN"
# (Expect connection refused since replicas=0.)

# 3. Delete the volume via the Railway dashboard (see section above).

# 4. Delete the service:
railway service delete ml-sweep
```

The Vercel Blob archive and the Postgres sidecar are both unaffected —
this only removes the Railway sweep runner.

## Recovery after accidental teardown

The Databento archive is canonical in Vercel Blob, so a full teardown
is recoverable:

1. Create a new Railway service from the `ml-sweep/Dockerfile`.
2. Attach a 5 GB volume at `/data`.
3. Set the env vars from the [README's required env vars table](./README.md#required-env-vars-on-railway).
4. `POST /hydrate` to repopulate the archive (~100 sec).
5. Resume sweep campaigns.

No code changes required — the service's only authoritative state is
the env vars and the archive, both of which are sourced from outside
the service.
