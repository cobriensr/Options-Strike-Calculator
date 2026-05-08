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
}
