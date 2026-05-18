-- Migration #168: gamma_at_trigger + redefine combined_score.
--
-- Apply against Neon directly because OWNER_SECRET is empty in prod
-- and the POST /api/journal/migrate path 401s (see memory:
-- feedback_owner_secret_empty_in_prod).
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/apply-migration-168.sql
--
-- Mirrors api/_lib/db-migrations.ts migration #168 exactly. After
-- applying, INSERT the schema_migrations row at the bottom so the
-- TS-side migrateDb() won't try to re-run it.

BEGIN;

-- Step 1: gamma_at_trigger storage column on both tables.
ALTER TABLE lottery_finder_fires
  ADD COLUMN IF NOT EXISTS gamma_at_trigger NUMERIC;

ALTER TABLE silent_boom_alerts
  ADD COLUMN IF NOT EXISTS gamma_at_trigger NUMERIC;

-- Step 2: redefine combined_score to include the gamma bonus.
ALTER TABLE lottery_finder_fires DROP COLUMN IF EXISTS combined_score;

ALTER TABLE lottery_finder_fires
  ADD COLUMN combined_score INT GENERATED ALWAYS AS (
    GREATEST(
      0,
      COALESCE(score, 0)
      + COALESCE(round_trip_score_deduct, 0)
      + COALESCE(fire_count_score_adjustment, 0)
      + CASE
          WHEN underlying_symbol IN ('SPY', 'USO') THEN 0
          WHEN gamma_at_trigger IS NULL THEN 0
          WHEN gamma_at_trigger >= 0.025 THEN 1
          ELSE 0
        END
    )
  ) STORED;

-- Step 3: recreate the indexed-LIMIT path index.
CREATE INDEX IF NOT EXISTS lottery_finder_fires_combined_score_idx
  ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST);

-- Step 4: mark applied so the TS migrateDb() skips it on next run.
INSERT INTO schema_migrations (id) VALUES (168) ON CONFLICT DO NOTHING;

COMMIT;
