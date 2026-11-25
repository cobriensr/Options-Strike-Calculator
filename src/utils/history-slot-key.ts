/** The part of a history snapshot that says where in the session it stands. */
interface SlotPosition {
  readonly candle: { readonly datetime: number };
  readonly candleIndex: number;
}

/**
 * What a card that holds a user's edit is tied to, so the edit resets at the
 * next slot: null when the view has no history snapshot.
 *
 * The slot label (the time picker's own text) tells slots apart exactly. The
 * candle does not: under the as-of rule the entry bar is the same first bar at
 * 8:30 and 8:35 CT, and the same last ended bar either side of a missing SPX
 * bar, while the VIX family still moves. Without a label, the candle and its
 * index are the best identity there is: the index separates the open (-1) from
 * the first bar (0), where the candle is the same. The caller adds the date,
 * which separates two dates read at the same label.
 */
export function historySlotKey(
  snapshot: SlotPosition | null | undefined,
  entryTimeLabel: string | undefined,
): string | null {
  if (!snapshot) return null;
  return (
    entryTimeLabel ?? `${snapshot.candle.datetime}:${snapshot.candleIndex}`
  );
}
