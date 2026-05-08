/**
 * Shared types for the periscope-scraper service.
 *
 * Panel values mirror the CHECK constraint on `periscope_snapshots.panel`
 * (migration 140). Keep these strings in sync with the SQL constraint.
 */

export type Panel = 'gamma' | 'charm' | 'vanna' | 'positions';

export interface SnapshotRow {
  /** ISO-8601 UTC timestamp; serialized to TIMESTAMPTZ in Postgres. */
  capturedAt: string;
  /** ISO-8601 date (YYYY-MM-DD); serialized to DATE in Postgres. */
  expiry: string;
  panel: Panel;
  strike: number;
  value: number;
  /**
   * UW slot label the row was actually captured from, e.g.
   * "09:10 - 09:20". Stored to the `timeframe` column added by
   * migration 141. Required for new rows so timeframe drift across
   * panels at one captured_at is visible to consumers, and the
   * scraper can realign subsequent Greek captures back to the
   * gamma anchor when UW publishes a new slot mid-cycle.
   */
  timeframe: string;
}
