// @vitest-environment jsdom

/**
 * The LOUDEST tile and the velocity tape read the same `view=velocity`
 * payload through the real `useGexbotData` hook (only the network primitive
 * is mocked). This pins the two things that make the pairing safe:
 *   - the hook's in-flight dedupe means the tile adds no extra fetch;
 *   - both show the same sign for the same row.
 */

import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DealerStateSummaryStrip } from '../components/Gexbot/DealerStateSummaryStrip';
import { DexoflowVelocityTape } from '../components/Gexbot/DexoflowVelocityTape';
import type { VelocityRow } from '../hooks/useGexbotData';

const mockFetchJson = vi.fn();
vi.mock('../hooks/useMarketData.fetchers', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

function velocityRow(
  ticker: string,
  overrides: Partial<VelocityRow>,
): VelocityRow {
  return {
    ticker,
    capturedAt: '2026-10-29T14:04:00Z',
    minDte: 0,
    dAggDex: null,
    dZgr: null,
    dZcvr: null,
    typicalAbsDAggDex: null,
    ...overrides,
  };
}

// The strip shows its tiles only when snapshots-latest has a row.
const SNAPSHOT_ROWS = [
  {
    ticker: 'SPX',
    capturedAt: '2026-10-29T14:04:00Z',
    spot: 5847,
    zeroGamma: 5820,
  },
];

function serve(velocityRows: VelocityRow[]) {
  mockFetchJson.mockImplementation(async (url: string) => ({
    data: {
      rows: url.includes('view=velocity') ? velocityRows : SNAPSHOT_ROWS,
    },
  }));
}

const velocityCalls = () =>
  mockFetchJson.mock.calls.filter((c) =>
    String(c[0]).includes('view=velocity'),
  );

function renderBoth() {
  return render(
    <>
      <DealerStateSummaryStrip marketOpen />
      <DexoflowVelocityTape marketOpen />
    </>,
  );
}

describe('LOUDEST tile and velocity tape together', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('share one velocity fetch: the tile adds no request of its own', async () => {
    serve([velocityRow('SPX', { dAggDex: 1.2, typicalAbsDAggDex: 0.4 })]);
    renderBoth();
    await waitFor(() =>
      expect(screen.getByTestId('dexoflow-tape')).toBeTruthy(),
    );
    expect(velocityCalls()).toHaveLength(1);
    // One more fetch in total: the strip's own snapshots-latest read.
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['positive', 1.2, /taker \+Δ flow \+1\.20/, 'positive +1.20'],
    ['negative', -1.2, /taker −Δ flow −1\.20/, 'negative −1.20'],
  ])(
    'agree on a %s change for the same row',
    async (_name, dAggDex, tileText, cellLabel) => {
      serve([
        velocityRow('SPX', { dAggDex, typicalAbsDAggDex: 0.4 }),
        velocityRow('QQQ', { dAggDex: 0.1, typicalAbsDAggDex: 0.4 }),
      ]);
      renderBoth();
      const tape = await screen.findByTestId('dexoflow-tape');
      const spxRow = within(tape)
        .getAllByRole('row')
        .find((r) => r.textContent?.startsWith('SPX'))!;
      const tapeCell = spxRow.querySelector('td span[aria-label]');
      expect(tapeCell?.getAttribute('aria-label')).toBe(cellLabel);

      await waitFor(() =>
        expect(
          screen.getByTestId('dealer-state-strip-loudest'),
        ).toHaveTextContent(/SPX/),
      );
      expect(
        screen.getByTestId('dealer-state-strip-loudest'),
      ).toHaveTextContent(tileText);
    },
  );

  it.each([
    ['at 3x its typical minute', 1.2, true],
    ['under 3x its typical minute', 1.1, false],
  ])(
    'agree on whether a row %s is unusual',
    async (_name, dAggDex, unusual) => {
      serve([velocityRow('SPX', { dAggDex, typicalAbsDAggDex: 0.4 })]);
      renderBoth();
      const tape = await screen.findByTestId('dexoflow-tape');
      const spxRow = within(tape)
        .getAllByRole('row')
        .find((r) => r.textContent?.startsWith('SPX'))!;
      expect(spxRow.getAttribute('data-unusual')).toBe(String(unusual));

      const tile = screen.getByTestId('dealer-state-strip-loudest');
      await waitFor(() => expect(tile).toHaveTextContent(/LOUDEST · SPX/));
      if (unusual) {
        expect(tile).toHaveTextContent(/most unusual taker Δ \/ min/);
        expect(tile).not.toHaveTextContent(/quiet/);
      } else {
        expect(tile).toHaveTextContent('quiet · nothing ≥ 3× typical');
        expect(tile).not.toHaveTextContent(/most unusual/);
      }
    },
  );
});
