/**
 * Shared UI primitives for the Periscope panel sections.
 *
 * `SectionHeader` and `Row` are thin layout helpers used by every
 * section. `RankedCell` formats a single (strike, value, ptsFromSpot)
 * tuple for the +γ ceiling/floor, charm/vanna top-by-|abs|, and
 * −γ accel rows.
 *
 * Extracted from PeriscopePanel.tsx during the Phase 3A decomposition
 * (2026-05-19).
 */

import { theme } from '../../themes';
import type {
  RankedRow,
  RankedRowSimple,
} from '../../hooks/usePeriscopeExposure';
import {
  colorForValue,
  fmtPts,
  fmtSigned,
} from '../../utils/periscope-formatting';

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
      style={{ color: theme.textTertiary }}
    >
      {children}
    </h3>
  );
}

export function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span
        className="font-mono text-[11px]"
        style={{ color: theme.textSecondary }}
      >
        {label}
      </span>
      <span className="font-mono text-[12px]">{value}</span>
    </div>
  );
}

export function RankedCell({ row }: { row: RankedRow | RankedRowSimple }) {
  const ptsLabel = 'ptsFromSpot' in row ? ` (${fmtPts(row.ptsFromSpot)})` : '';
  return (
    <span className="font-mono text-[12px]">
      <span style={{ color: theme.text }}>{row.strike}</span>{' '}
      <span style={{ color: colorForValue(row.value) }}>
        {fmtSigned(row.value)}
      </span>
      {ptsLabel && <span style={{ color: theme.textMuted }}>{ptsLabel}</span>}
    </span>
  );
}
