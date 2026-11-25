import { describe, it, expect } from 'vitest';
import { historySlotKey } from '../../utils/history-slot-key';

/** The part of a history snapshot the key reads. */
const snapshotAt = (datetime: number, candleIndex: number) => ({
  candle: { datetime },
  candleIndex,
});

describe('historySlotKey', () => {
  it('is null without a history snapshot, whatever the label', () => {
    expect(historySlotKey(null, '8:30 AM CT')).toBeNull();
    expect(historySlotKey(undefined, '8:30 AM CT')).toBeNull();
    expect(historySlotKey(null, undefined)).toBeNull();
  });

  it('is the slot label when there is one', () => {
    expect(historySlotKey(snapshotAt(1000, 3), '8:45 AM CT')).toBe(
      '8:45 AM CT',
    );
  });

  // The as-of rule makes the entry bar the same at 8:30 and 8:35 CT (no bar,
  // then the first), and the same either side of a missing SPX bar, so the
  // label is what tells those slots apart.
  it('tells two slots on the same candle apart by their labels', () => {
    const sameBar = snapshotAt(1000, 0);

    expect(historySlotKey(sameBar, '8:35 AM CT')).not.toBe(
      historySlotKey(sameBar, '8:40 AM CT'),
    );
  });

  it('is the same for a slot whatever candle the snapshot reports for it', () => {
    expect(historySlotKey(snapshotAt(1000, 0), '8:35 AM CT')).toBe(
      historySlotKey(snapshotAt(2000, 7), '8:35 AM CT'),
    );
  });

  describe('without a label, the candle and its index are the identity', () => {
    it('joins the candle start and the index', () => {
      expect(historySlotKey(snapshotAt(1000, 3), undefined)).toBe('1000:3');
    });

    it('tells apart bars at the open and the first bar by the index, -1 against 0', () => {
      // At the open the entry index is -1 and the candle stands in as the
      // first bar; one slot later the first bar has ended and is index 0.
      expect(historySlotKey(snapshotAt(1000, -1), undefined)).toBe('1000:-1');
      expect(historySlotKey(snapshotAt(1000, -1), undefined)).not.toBe(
        historySlotKey(snapshotAt(1000, 0), undefined),
      );
    });

    it('tells two bars apart', () => {
      expect(historySlotKey(snapshotAt(1000, 3), undefined)).not.toBe(
        historySlotKey(snapshotAt(1300, 4), undefined),
      );
    });
  });
});
