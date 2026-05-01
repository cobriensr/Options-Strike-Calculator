/**
 * SortableHeader — shared sortable `<th>` cell for any table built on
 * `useTableSort`. Renders a focusable button whose label, sort indicator,
 * and `aria-sort` value reflect the active sort state.
 *
 * Extracted from the verbatim-duplicated definitions previously inlined
 * in `OptionsFlowTable` and `WhalePositioningTable`. Generic over the
 * sort-key string union so each table keeps its own typed column union
 * — the component is just a parameterized `<th>` button.
 *
 * Visual + accessibility contract (preserved bit-for-bit):
 *   - Sticky header cell with the surface-alt theme tokens used across
 *     flow tables.
 *   - `scope="col"` for screen-reader column association.
 *   - `aria-sort` reads `'ascending'` / `'descending'` when this column
 *     is active, `'none'` otherwise.
 *   - Active column shows a filled arrow (▲ asc, ▼ desc); inactive
 *     columns show a faint placeholder ▲ so column widths don't shift
 *     when the user clicks a header.
 *   - Default alignment is `right` (the more common case in numeric
 *     flow tables); pass `align="left"` or `align="center"` to override.
 *
 * The component does NOT manage its own state — it's a pure rendering
 * shell. State lives in `useTableSort` (or any equivalent controller),
 * which the consumer wires into `currentKey`, `currentDir`, and `onSort`.
 */

interface SortableHeaderProps<K extends string> {
  /** Visible column label, e.g. `"Premium"` or `"Δ Spot"`. */
  label: string;
  /** This column's sort key. Compared against `currentKey` for active state. */
  sortKey: K;
  /** Currently active sort key from the table-sort controller. */
  currentKey: K;
  /** Currently active sort direction from the table-sort controller. */
  currentDir: 'asc' | 'desc';
  /** Click handler — forwarded the column's `sortKey`. */
  onSort: (key: K) => void;
  /** Cell text alignment. Default: `'right'`. */
  align?: 'left' | 'right' | 'center';
  /**
   * Optional native `title` tooltip on the inner button. Used by columns
   * whose label is too short to convey full meaning (e.g. `"Vol/OI"` →
   * "Volume relative to open interest").
   */
  tooltip?: string;
}

const ALIGN_CLASSES = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

export function SortableHeader<K extends string>({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  align = 'right',
  tooltip,
}: SortableHeaderProps<K>) {
  const active = sortKey === currentKey;
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? currentDir === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  const alignClass = ALIGN_CLASSES[align];
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`bg-surface-alt border-edge-heavy sticky top-0 border-b px-2 py-2 font-sans text-[10px] font-semibold tracking-wider uppercase ${alignClass}`}
      style={{ color: 'var(--color-tertiary)' }}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={tooltip}
        className="inline-flex cursor-pointer items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={`font-mono text-[9px] ${active ? 'text-secondary' : 'text-muted/40'}`}
        >
          {active ? (currentDir === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </button>
    </th>
  );
}
