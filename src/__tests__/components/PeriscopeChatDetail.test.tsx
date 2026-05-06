/**
 * Tests for the playbook display inside PeriscopeChatDetail.
 *
 * The legacy detail tests (fetch flow, parent breadcrumb, close
 * button, error state) live in PeriscopeChatHistory.test.tsx in the
 * <PeriscopeChatDetail /> describe block. This file covers the new
 * playbook card that surfaces the structured Phase 2/6 fields when a
 * past read is expanded — bias badge, confidence, trade-type chips,
 * key-level grid, futures plan — and the collapse-when-empty behavior
 * for legacy rows that have no playbook data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('../../components/ui/SectionBox', () => ({
  SectionBox: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

import PeriscopeChatDetail from '../../components/PeriscopeChat/PeriscopeChatDetail';

interface DetailFixture {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: 'pre_trade' | 'intraday' | 'debrief';
  parent_id: number | null;
  user_context: string | null;
  prose_text: string;
  spot: number | null;
  cone_lower: number | null;
  cone_upper: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  bias: string | null;
  trade_types_recommended: string[];
  trade_types_avoided: string[];
  key_levels: {
    gamma_floor: number | null;
    gamma_ceiling: number | null;
    magnet: number | null;
    charm_zero: number | null;
  } | null;
  expected_dealer_behavior: string | null;
  confidence: string | null;
  confidence_basis: string | null;
  futures_plan: string | null;
  calibration_quality: number | null;
  image_urls: Array<{ kind: string; url: string }>;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

const playbookFixture: DetailFixture = {
  id: 42,
  trading_date: '2026-04-30',
  captured_at: '2026-04-30T13:30:00Z',
  mode: 'intraday',
  parent_id: null,
  user_context: null,
  prose_text: 'Pin day at 7120.',
  spot: 7120,
  cone_lower: 7095,
  cone_upper: 7150,
  long_trigger: 7125,
  short_trigger: 7115,
  regime_tag: 'pin',
  bias: 'fade-only',
  trade_types_recommended: ['iron_condor', 'butterfly'],
  trade_types_avoided: ['naked_directional_long'],
  key_levels: {
    gamma_floor: 7100,
    gamma_ceiling: 7150,
    magnet: 7120,
    charm_zero: 7130,
  },
  expected_dealer_behavior: 'passive bid below 7100',
  confidence: 'medium',
  confidence_basis: 'twin-strike +γ floor',
  futures_plan:
    'LONG: above 7125 NQ\n\nSHORT: below 7115 NQ\n\nWAIT: 7115–7125',
  calibration_quality: null,
  image_urls: [],
  model: 'claude-opus-4-7',
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 800,
  cache_write_tokens: 0,
  duration_ms: 4500,
  created_at: '2026-04-30T13:30:05Z',
};

const legacyEmptyFixture: DetailFixture = {
  ...playbookFixture,
  bias: null,
  trade_types_recommended: [],
  trade_types_avoided: [],
  key_levels: null,
  expected_dealer_behavior: null,
  confidence: null,
  confidence_basis: null,
  futures_plan: null,
};

function setRoutes(routes: Record<string, { status?: number; body: unknown }>) {
  globalThis.fetch = vi.fn(async (url: RequestInfo) => {
    const u = typeof url === 'string' ? url : (url as Request).url;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        const status = handler.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => handler.body,
          text: async () =>
            typeof handler.body === 'string'
              ? handler.body
              : JSON.stringify(handler.body),
        } as unknown as Response;
      }
    }
    throw new Error(`Unmatched route: ${u}`);
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<PeriscopeChatDetail /> playbook display', () => {
  it('renders the playbook card with all fields when populated', async () => {
    setRoutes({
      '/api/periscope-chat-detail': { body: playbookFixture },
    });

    render(
      <PeriscopeChatDetail
        rowId={42}
        onClose={vi.fn()}
        onSelectParent={vi.fn()}
      />,
    );

    // Bias badge
    await waitFor(() => {
      expect(screen.getByText(/^fade-only$/i)).toBeInTheDocument();
    });
    // Confidence badge
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
    // Confidence basis
    expect(screen.getByText(/twin-strike \+γ floor/i)).toBeInTheDocument();
    // Recommended trade-type chips
    expect(screen.getByText('iron_condor')).toBeInTheDocument();
    expect(screen.getByText('butterfly')).toBeInTheDocument();
    // Avoided chip
    expect(screen.getByText('naked_directional_long')).toBeInTheDocument();
    // Futures plan label + body
    expect(screen.getByText(/futures plan/i)).toBeInTheDocument();
    expect(screen.getByText(/LONG: above 7125 NQ/)).toBeInTheDocument();
    // Key levels grid — use exact uppercase-label match to avoid
    // colliding with confidence_basis text that contains "γ floor".
    expect(screen.getByText('γ floor')).toBeInTheDocument();
    expect(screen.getByText('γ ceiling')).toBeInTheDocument();
    expect(screen.getByText('Magnet')).toBeInTheDocument();
    expect(screen.getByText('Charm zero')).toBeInTheDocument();
    // Expected dealer behavior
    expect(screen.getByText(/passive bid below 7100/i)).toBeInTheDocument();
  });

  it('hides the playbook card entirely on a legacy row with no playbook fields', async () => {
    setRoutes({
      '/api/periscope-chat-detail': { body: legacyEmptyFixture },
    });

    render(
      <PeriscopeChatDetail
        rowId={42}
        onClose={vi.fn()}
        onSelectParent={vi.fn()}
      />,
    );

    // Wait for prose to render so we know the detail loaded
    await waitFor(() => {
      expect(screen.getByText(/pin day at 7120/i)).toBeInTheDocument();
    });

    // None of the playbook surface should appear
    expect(screen.queryByText(/^fade-only$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/medium confidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/futures plan/i)).not.toBeInTheDocument();
    // The "γ floor" label only appears inside the playbook card's
    // key-level grid (not in the legacy trigger grid which uses
    // Spot/Cone/Long trigger/Short trigger/Regime), so its absence
    // confirms the playbook card is hidden.
    expect(screen.queryByText('γ floor')).not.toBeInTheDocument();
  });

  it('renders the futures plan when present even if other fields are sparse', async () => {
    setRoutes({
      '/api/periscope-chat-detail': {
        body: {
          ...legacyEmptyFixture,
          futures_plan: 'LONG: above 7150 only',
        },
      },
    });

    render(
      <PeriscopeChatDetail
        rowId={42}
        onClose={vi.fn()}
        onSelectParent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/futures plan/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/LONG: above 7150 only/)).toBeInTheDocument();
  });
});
