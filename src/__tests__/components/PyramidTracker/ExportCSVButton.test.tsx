import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExportCSVButton from '../../../components/PyramidTracker/ExportCSVButton';
import {
  buildCsv,
  csvEscape,
} from '../../../components/PyramidTracker/pyramid-csv';
import type { PyramidChain, PyramidLeg } from '../../../types/pyramid';

// ============================================================
// Fixtures
// ============================================================

function makeChain(overrides: Partial<PyramidChain> = {}): PyramidChain {
  return {
    id: '2026-04-16-MNQ-1',
    trade_date: '2026-04-16',
    instrument: 'MNQ',
    direction: 'long',
    entry_time_ct: '09:15',
    exit_time_ct: '14:30',
    initial_entry_price: 21200,
    final_exit_price: 21250,
    exit_reason: 'reverse_choch',
    total_legs: 2,
    winning_legs: 2,
    net_points: 50,
    session_atr_pct: null,
    day_type: 'trend',
    higher_tf_bias: null,
    notes: 'Nothing to report',
    status: 'closed',
    created_at: '2026-04-16T14:30:00Z',
    updated_at: '2026-04-16T14:30:00Z',
    ...overrides,
  };
}

function makeLeg(overrides: Partial<PyramidLeg> = {}): PyramidLeg {
  return {
    id: 'leg-1',
    chain_id: '2026-04-16-MNQ-1',
    leg_number: 1,
    signal_type: 'CHoCH',
    entry_time_ct: '09:30',
    entry_price: 21200,
    stop_price: 21185,
    stop_distance_pts: 15,
    stop_compression_ratio: 1,
    vwap_at_entry: null,
    vwap_1sd_upper: null,
    vwap_1sd_lower: null,
    vwap_band_position: null,
    vwap_band_distance_pts: null,
    minutes_since_chain_start: 0,
    minutes_since_prior_bos: null,
    ob_quality: null,
    relative_volume: null,
    session_phase: null,
    session_high_at_entry: null,
    session_low_at_entry: null,
    retracement_extreme_before_entry: null,
    exit_price: 21230,
    exit_reason: 'trailed_stop',
    points_captured: 30,
    r_multiple: 2,
    was_profitable: true,
    notes: null,
    ob_high: null,
    ob_low: null,
    ob_poc_price: null,
    ob_poc_pct: null,
    ob_secondary_node_pct: null,
    ob_tertiary_node_pct: null,
    ob_total_volume: null,
    created_at: '2026-04-16T09:30:00Z',
    updated_at: '2026-04-16T09:30:00Z',
    ...overrides,
  };
}

// ============================================================
// CSV string helpers
// ============================================================

describe('csvEscape', () => {
  it('returns an empty string for null / undefined', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('returns bare strings / numbers / booleans unquoted when no special chars', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(true)).toBe('true');
    expect(csvEscape(false)).toBe('false');
  });

  it('quotes cells containing commas', () => {
    expect(csvEscape('a,b,c')).toBe('"a,b,c"');
  });

  it('quotes cells containing quotes and doubles internal quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes cells containing newlines and carriage returns', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

describe('buildCsv', () => {
  it('serialises rows with a header line and RFC 4180 line endings', () => {
    const rows = [
      { id: 'a', name: 'Alice', notes: 'hello' },
      { id: 'b', name: 'Bob', notes: null },
    ];
    const csv = buildCsv(['id', 'name', 'notes'] as const, rows);
    expect(csv).toBe('id,name,notes\r\na,Alice,hello\r\nb,Bob,\r\n');
  });

  it('emits only a header row when given no data rows', () => {
    const csv = buildCsv(
      ['id', 'name'] as const,
      [] as ReadonlyArray<{ id: string; name: string }>,
    );
    expect(csv).toBe('id,name\r\n');
  });

  it('quotes cells with commas and preserves column order', () => {
    const rows = [{ a: 'x', b: 'comma, inside', c: 'q"ote' }];
    const csv = buildCsv(['b', 'a', 'c'] as const, rows);
    expect(csv).toBe('b,a,c\r\n"comma, inside",x,"q""ote"\r\n');
  });
});

// ============================================================
// Component
// ============================================================

describe('ExportCSVButton', () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let createObjectURLSpy: ReturnType<typeof vi.fn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

  beforeEach(() => {
    // Stub URL.createObjectURL / revokeObjectURL which jsdom doesn't
    // implement by default. The download path creates an <a>, clicks it,
    // then removes it — the click triggers navigation that jsdom ignores,
    // which is fine for our assertions (we check the anchor attributes).
    createObjectURLSpy = vi.fn(() => 'blob:fake-url');
    revokeObjectURLSpy = vi.fn();
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLSpy,
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLSpy,
    });

    // Intercept anchor.click() to record downloads without navigation.
    clickSpy = vi.fn();
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: clickSpy,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
    vi.restoreAllMocks();
  });

  it('is disabled when there are no chains', () => {
    render(<ExportCSVButton chains={[]} fetchAllLegs={vi.fn()} />);
    expect(screen.getByRole('button', { name: /export/i })).toBeDisabled();
  });

  it('triggers two downloads (chains + legs) with timestamped filenames', async () => {
    const chains = [makeChain()];
    const legs = [makeLeg()];
    const fetchAllLegs = vi.fn().mockResolvedValue(legs);

    render(<ExportCSVButton chains={chains} fetchAllLegs={fetchAllLegs} />);

    // Capture the anchor elements that get appended.
    const downloads: string[] = [];
    const origAppend = document.body.appendChild.bind(document.body);
    const spy = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation(<T extends Node>(node: T): T => {
        if (node instanceof HTMLAnchorElement) {
          downloads.push(node.download);
        }
        return origAppend(node);
      });

    await userEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => expect(fetchAllLegs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(2));

    // Filenames include today's date and the correct CSV prefixes.
    const today = new Date();
    const y = String(today.getFullYear());
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const stamp = `${y}-${m}-${d}`;

    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toBe(`pyramid_chains_${stamp}.csv`);
    expect(downloads[1]).toBe(`pyramid_legs_${stamp}.csv`);

    spy.mockRestore();
  });

  it('surfaces an error alert when fetchAllLegs rejects', async () => {
    const fetchAllLegs = vi.fn().mockRejectedValue(new Error('network fail'));
    render(
      <ExportCSVButton chains={[makeChain()]} fetchAllLegs={fetchAllLegs} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/network fail/i),
    );
  });

  it('embeds correctly quoted values for cells with commas and newlines', () => {
    // Unit-level: make sure a row with dangerous characters round-trips.
    const csv = buildCsv(['id', 'notes'] as const, [
      { id: 'a', notes: 'hello, world' },
      { id: 'b', notes: 'multi\nline' },
    ]);
    expect(csv).toContain('"hello, world"');
    expect(csv).toContain('"multi\nline"');
  });
});
