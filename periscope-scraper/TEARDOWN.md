# Tearing down periscope-scraper

If the Periscope HTML ingestion feature is being retired, follow these steps
to fully shut the service down.

## 1. Stop the Railway service

In the Railway dashboard, open the `periscope-scraper` service and either:

- Pause it (preserves config and env vars; lets you resume later), or
- Delete it (removes the service entirely).

Pausing is preferred unless you're confident the feature won't return.

## 2. Confirm data flow has stopped

```sql
SELECT MAX(captured_at) FROM periscope_snapshots;
```

Run this against the Neon database 15 minutes after stopping the service.
The latest `captured_at` should be at least 15 minutes old.

## 3. (Optional) Drop the table

If the feature is fully retired and the historical data is no longer
needed, add a new migration to `api/_lib/db-migrations.ts` that drops the
table:

```sql
DROP TABLE IF EXISTS periscope_snapshots;
```

Do NOT drop the table directly via psql — every schema change goes through
a numbered migration so `schema_migrations` stays in sync.

## 4. Remove env vars

Delete `UW_SESSION_COOKIE` and `UW_PERISCOPE_URL` from the Railway service
config. `DATABASE_URL` and `SENTRY_DSN` are shared with other services —
leave those alone.

## 5. Disable auto-deploys (if pausing rather than deleting)

If you paused but didn't delete, edit the Railway service's GitHub
integration to disable auto-deploys, so future pushes to
`periscope-scraper/**` don't accidentally restart it.
