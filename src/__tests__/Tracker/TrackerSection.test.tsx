import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock the data hooks so the test only exercises TrackerSection's own
// orchestration logic (tab switching, watchlist filter, loading/error
// gates, polling-enabled gating).
vi.mock('../../hooks/useTrackerContracts', () => ({
  useTrackerContracts: vi.fn(),
}));
vi.mock('../../hooks/useTrackerAlerts', () => ({
  useTrackerAlerts: vi.fn(),
}));

// Replace heavy children with simple test doubles so we can observe
// which props TrackerSection passes them.
vi.mock('../../components/Tracker/TrackerTabs', () => ({
  TrackerTabs: ({
    current,
    onChange,
    counts,
  }: {
    current: string;
    onChange: (next: string) => void;
    counts: Record<string, number>;
  }) => (
    <div data-testid="tabs" data-current={current}>
      <button onClick={() => onChange('active')}>active({counts.active})</button>
      <button onClick={() => onChange('watchlist')}>
        watchlist({counts.watchlist})
      </button>
      <button onClick={() => onChange('archive')}>
        archive({counts.archive})
      </button>
    </div>
  ),
}));
vi.mock('../../components/Tracker/ContractTable', () => ({
  ContractTable: ({
    contracts,
  }: {
    contracts: { id: number }[];
  }) => (
    <div data-testid="table">
      {contracts.map((c) => (
        <div key={c.id} data-testid={`tbl-${String(c.id)}`}>
          row-{c.id}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../../components/Tracker/ArchiveStats', () => ({
  ArchiveStats: () => <div data-testid="archive-stats" />,
}));
vi.mock('../../components/Tracker/AddContractForm', () => ({
  AddContractForm: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-form-open" /> : null,
}));
vi.mock('../../components/ui/SectionBox', () => ({
  // Real SectionBox starts collapsed and toggles via a header click;
  // for unit testing, force it always-expanded by invoking
  // onCollapsedChange(false) immediately. This lets the tab + table
  // rendering paths exercise without the collapse interaction.
  SectionBox: ({
    children,
    onCollapsedChange,
  }: {
    children: React.ReactNode;
    onCollapsedChange?: (next: boolean) => void;
  }) => {
    // Fire the expand callback once on mount via a microtask so the
    // hook gating (`enabled: !collapsed && ...`) flips before render.
    if (onCollapsedChange) {
      queueMicrotask(() => onCollapsedChange(false));
    }
    return <section data-testid="section-box">{children}</section>;
  },
}));
// helpers.isWatchlistContract — used by the watchlist filter
vi.mock('../../components/Tracker/helpers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../components/Tracker/helpers')>();
  return {
    ...actual,
    isWatchlistContract: vi.fn(
      (c: { id: number }) =>
        // Treat odd ids as watchlist for the test
        c.id % 2 === 1,
    ),
  };
});

import { TrackerSection } from '../../components/Tracker/TrackerSection';
import { useTrackerContracts } from '../../hooks/useTrackerContracts';
import { useTrackerAlerts } from '../../hooks/useTrackerAlerts';
import type { TrackerContract } from '../../components/Tracker/types';

function makeContract(id: number): TrackerContract {
  return {
    id,
    occ_symbol: 'X',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P',
    direction: 'long',
    entry_price: '5.00',
    quantity: 1,
    notes: null,
    status: 'active',
    closed_at: null,
    closed_price: null,
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-15T14:30:00.000Z',
    updated_at: '2026-05-15T14:30:00.000Z',
    latest_last: null,
    latest_bid: null,
    latest_ask: null,
    latest_underlying: null,
    latest_fetched_at: null,
  };
}

type ContractsHookReturn = ReturnType<typeof useTrackerContracts>;

function mockContractsHook(
  status: 'active' | 'closed',
  data: TrackerContract[],
  opts: { loading?: boolean; error?: string | null } = {},
) {
  return {
    data,
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    statusFilter: status,
  } as unknown as ContractsHookReturn;
}

describe('TrackerSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: alerts hook returns empty
    vi.mocked(useTrackerAlerts).mockReturnValue({
      data: [],
      loading: false,
      error: null,
      acknowledge: vi.fn(),
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useTrackerAlerts>);
  });

  it('starts on active tab; counts reflect both active and archive hooks', () => {
    // active tab → returns 3 active rows (ids 1,2,3); archive hook
    // returns 5 closed rows on its own call. The mock-by-call-order
    // pattern: first call is the active hook in TrackerSection.tsx
    // (line 55), second is the archive hook (line 63).
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(
        mockContractsHook('active', [
          makeContract(1),
          makeContract(2),
          makeContract(3),
        ]),
      )
      .mockReturnValueOnce(
        mockContractsHook('closed', [
          makeContract(10),
          makeContract(11),
          makeContract(12),
          makeContract(13),
          makeContract(14),
        ]),
      );

    render(<TrackerSection marketOpen={true} />);

    const tabs = screen.getByTestId('tabs');
    expect(tabs).toHaveAttribute('data-current', 'active');
    expect(screen.getByText('active(3)')).toBeInTheDocument();
    expect(screen.getByText('archive(5)')).toBeInTheDocument();
    // Watchlist count = odd ids in active list (1, 3) = 2
    expect(screen.getByText('watchlist(2)')).toBeInTheDocument();
  });

  it('shows "+ Add Contract" button on active and watchlist, hides on archive', () => {
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(mockContractsHook('active', [makeContract(1)]))
      .mockReturnValueOnce(mockContractsHook('closed', []));

    const { rerender } = render(<TrackerSection marketOpen={true} />);
    expect(
      screen.getByRole('button', { name: 'Add new contract to tracker' }),
    ).toBeInTheDocument();

    // Switch to archive — re-render with the same mocks
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(mockContractsHook('active', [makeContract(1)]))
      .mockReturnValueOnce(mockContractsHook('closed', []));
    rerender(<TrackerSection marketOpen={true} />);
    fireEvent.click(screen.getByText(/archive\(/));
    expect(
      screen.queryByRole('button', { name: 'Add new contract to tracker' }),
    ).toBeNull();
  });

  it('renders ArchiveStats only when on archive tab', () => {
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(mockContractsHook('active', [makeContract(1)]))
      .mockReturnValueOnce(mockContractsHook('closed', [makeContract(10)]));

    render(<TrackerSection marketOpen={true} />);
    expect(screen.queryByTestId('archive-stats')).toBeNull();

    // Switch tab — note that useTrackerContracts re-runs both calls
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(mockContractsHook('active', [makeContract(1)]))
      .mockReturnValueOnce(mockContractsHook('closed', [makeContract(10)]));
    fireEvent.click(screen.getByText(/archive\(/));
    expect(screen.getByTestId('archive-stats')).toBeInTheDocument();
  });

  it('shows "Loading…" placeholder and hides table when active hook is loading', () => {
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(
        mockContractsHook('active', [], { loading: true }),
      )
      .mockReturnValueOnce(mockContractsHook('closed', []));

    render(<TrackerSection marketOpen={true} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByTestId('table')).toBeNull();
  });

  it('shows role="alert" with error message when hook reports an error', () => {
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(
        mockContractsHook('active', [], { error: 'pg down' }),
      )
      .mockReturnValueOnce(mockContractsHook('closed', []));

    render(<TrackerSection marketOpen={true} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('pg down');
  });

  it('passes marketOpen through to the active contracts hook', () => {
    vi.mocked(useTrackerContracts)
      .mockReturnValueOnce(mockContractsHook('active', []))
      .mockReturnValueOnce(mockContractsHook('closed', []));

    render(<TrackerSection marketOpen={true} />);

    // First call = active hook
    const firstCallArg = vi.mocked(useTrackerContracts).mock.calls[0]?.[0];
    expect(firstCallArg).toMatchObject({
      status: 'active',
      marketOpen: true,
    });

    // Second call = archive hook with marketOpen forced false (static
    // data, no need to poll)
    const secondCallArg = vi.mocked(useTrackerContracts).mock.calls[1]?.[0];
    expect(secondCallArg).toMatchObject({
      status: 'closed',
      marketOpen: false,
    });
  });
});
