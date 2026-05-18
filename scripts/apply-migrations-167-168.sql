-- Consolidated apply for migrations #167 + #168.
--
-- Prod (Neon) was at schema_migrations.MAX(id)=166 when this was
-- authored; the in-app migrateDb() path is blocked because
-- OWNER_SECRET is empty in prod (memory:
-- feedback_owner_secret_empty_in_prod). This script applies both
-- pending migrations + records them in schema_migrations so future
-- migrateDb() runs skip them.
--
-- Both touch combined_score (a STORED generated column). #167 adds
-- fire_count_score_adjustment + recreates combined_score; #168 adds
-- gamma_at_trigger + recreates combined_score AGAIN. Applying both
-- in one transaction collapses the work — the final combined_score
-- definition is the #168 version (which sums both new adjustments).
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/apply-migrations-167-168.sql

BEGIN;

-- ============================================================
-- #167: fire_count_score_adjustment + chain-day trigger
-- ============================================================

-- Step 1: storage column. SMALLINT DEFAULT 0 → backfill in step 2
-- corrects any existing rows.
ALTER TABLE lottery_finder_fires
  ADD COLUMN IF NOT EXISTS fire_count_score_adjustment SMALLINT NOT NULL DEFAULT 0;

-- Step 2: backfill from current chain-day fire counts. CASE ladder
-- mirrors the TS fireCountScoreAdjustment helper.
WITH chain_day_counts AS (
  SELECT date, option_chain_id, COUNT(*)::int AS fc
    FROM lottery_finder_fires
   GROUP BY date, option_chain_id
)
UPDATE lottery_finder_fires lf
   SET fire_count_score_adjustment = CASE
     WHEN cdc.fc = 1 THEN -3
     WHEN cdc.fc <= 3 THEN -1
     WHEN cdc.fc <= 7 THEN 0
     WHEN cdc.fc <= 15 THEN 1
     ELSE 2
   END
  FROM chain_day_counts cdc
 WHERE lf.date = cdc.date
   AND lf.option_chain_id = cdc.option_chain_id;

-- Step 3: trigger function. AFTER INSERT ONLY so it doesn't recurse
-- via its own UPDATE. Bucket-boundary detection keeps the heavy
-- O(N-per-chain-day) path to 4 firings per chain over its session.
CREATE OR REPLACE FUNCTION update_lottery_fire_count_score_adj()
RETURNS TRIGGER AS $$
-- Concurrency note: COUNT(*) below could race under concurrent
-- INSERTs into the same chain-day. The final state still converges
-- (all rows end at the same bucket adjustment) but the boundary
-- branch could fire redundantly. The detect-lottery-fires cron is
-- single-process so this won't materialize in practice.
DECLARE
  new_count INT;
  new_adj   SMALLINT;
BEGIN
  SELECT COUNT(*)::int INTO new_count
    FROM lottery_finder_fires
   WHERE date = NEW.date AND option_chain_id = NEW.option_chain_id;

  new_adj := CASE
    WHEN new_count = 1 THEN -3
    WHEN new_count <= 3 THEN -1
    WHEN new_count <= 7 THEN 0
    WHEN new_count <= 15 THEN 1
    ELSE 2
  END;

  IF new_count IN (1, 2, 4, 8, 16) THEN
    UPDATE lottery_finder_fires
       SET fire_count_score_adjustment = new_adj
     WHERE date = NEW.date
       AND option_chain_id = NEW.option_chain_id;
  ELSE
    UPDATE lottery_finder_fires
       SET fire_count_score_adjustment = new_adj
     WHERE id = NEW.id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lottery_finder_fires_fc_adj_trg
  ON lottery_finder_fires;

CREATE TRIGGER lottery_finder_fires_fc_adj_trg
  AFTER INSERT ON lottery_finder_fires
  FOR EACH ROW
  EXECUTE FUNCTION update_lottery_fire_count_score_adj();

-- ============================================================
-- #168: gamma_at_trigger + combined_score with gamma bonus
-- ============================================================

ALTER TABLE lottery_finder_fires
  ADD COLUMN IF NOT EXISTS gamma_at_trigger NUMERIC;

ALTER TABLE silent_boom_alerts
  ADD COLUMN IF NOT EXISTS gamma_at_trigger NUMERIC;

-- combined_score: drop the existing definition (#159 / #167 state)
-- and recreate with BOTH fire_count_score_adjustment AND the gamma
-- CASE expression. Collapsing the two migrations into one
-- combined_score recreation saves one drop+recreate cycle.
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

-- Recreate the indexed-LIMIT path index that combined_score uses.
CREATE INDEX IF NOT EXISTS lottery_finder_fires_combined_score_idx
  ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST);

-- ============================================================
-- Mark both migrations as applied so future migrateDb() skips them.
-- ============================================================

INSERT INTO schema_migrations (id, description) VALUES
  (167, 'Promote fire_count_score_adjustment to stored DB column on lottery_finder_fires; trigger maintains it across the bucket-boundary set {1,2,4,8,16}.'),
  (168, 'Add gamma_at_trigger to lottery_finder_fires + silent_boom_alerts; redefine combined_score to include +1 gamma bonus (ticker NOT IN (SPY,USO) AND gamma >= 0.025).')
  ON CONFLICT DO NOTHING;

COMMIT;
