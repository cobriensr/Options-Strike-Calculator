/**
 * PeriscopeChat unit tests — pragmatic smoke + state coverage. The
 * heavy lifting (NDJSON streaming, file→base64, paste-routing) lives
 * in `usePeriscopeChat` and is covered separately in
 * `src/__tests__/hooks/usePeriscopeChat.test.ts`. Here we mock that
 * hook at the module boundary and verify the panel's presentation
 * logic + key interactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  PeriscopeChatSuccess,
  PeriscopeStructuredFields,
} from '../components/PeriscopeChat/types';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUsePeriscopeChat, mockProseView, mockPlaybookView } = vi.hoisted(
  () => ({
    mockUsePeriscopeChat: vi.fn(),
    mockProseView: vi.fn(({ prose }: { prose: string }) => (
      <div data-testid="prose-view">{prose}</div>
    )),
    mockPlaybookView: vi.fn(() => <div data-testid="playbook-view" />),
  }),
);

vi.mock('../components/PeriscopeChat/usePeriscopeChat', () => ({
  usePeriscopeChat: mockUsePeriscopeChat,
}));

vi.mock('../components/PeriscopeChat/PeriscopeProse', () => ({
  ProseView: mockProseView,
}));

vi.mock('../components/PeriscopeChat/PlaybookView', () => ({
  default: mockPlaybookView,
}));

import PeriscopeChat from '../components/PeriscopeChat/PeriscopeChat';

// ── Fixture factories ─────────────────────────────────────────────────

function makeStructured(
  overrides: Partial<PeriscopeStructuredFields> = {},
): PeriscopeStructuredFields {
  return {
    spot: 5800,
    cone_lower: 5750,
    cone_upper: 5850,
    long_trigger: 5810,
    short_trigger: 5790,
    regime_tag: 'pin',
    bias: 'fade-only',
    trade_types_recommended: ['iron_condor'],
    trade_types_avoided: [],
    key_levels: null,
    expected_dealer_behavior: null,
    confidence: 'medium',
    confidence_basis: 'twin-strike +γ floor',
    futures_plan: null,
    ...overrides,
  };
}

function makeSuccessResponse(
  overrides: Partial<PeriscopeChatSuccess> = {},
): PeriscopeChatSuccess {
  return {
    ok: true,
    id: 1,
    mode: 'pre_trade',
    prose: 'Pin day at 5800.',
    structured: makeStructured(),
    parseOk: true,
    spotAtReadTime: 5800,
    spotSource: 'db_exact',
    readTime: '2026-05-08T13:30:00.000Z',
    model: 'claude-opus-4-7',
    durationMs: 12_500,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 100 },
    ...overrides,
  };
}

const defaultHookReturn = {
  mode: 'intraday' as const,
  images: {},
  parentId: null as number | null,
  readDate: '2026-05-08',
  readTime: '13:30',
  inFlight: false,
  elapsedMs: 0,
  response: null as PeriscopeChatSuccess | null,
  error: null as string | null,
  setMode: vi.fn(),
  setParentId: vi.fn(),
  setReadDate: vi.fn(),
  setReadTime: vi.fn(),
  setImage: vi.fn(),
  submit: vi.fn(),
  reset: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUsePeriscopeChat.mockReturnValue(defaultHookReturn);
});

// ============================================================
// SMOKE
// ============================================================

describe('PeriscopeChat: smoke', () => {
  it('renders the section heading and primary controls', () => {
    render(<PeriscopeChat />);
    expect(
      screen.getByRole('heading', { name: /periscope chat/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: /analysis mode/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /submit intraday/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^reset$/i }),
    ).toBeInTheDocument();
  });

  it('upload boxes are collapsed by default with override toggle visible', () => {
    render(<PeriscopeChat />);
    // Default copy that explains the screenshotless flow
    expect(
      screen.getByText(/Default: Claude reads the latest scraped Periscope/i),
    ).toBeInTheDocument();
    // Upload prompt copy is hidden until override clicked
    expect(
      screen.queryByText(/Drop, click, or paste/i),
    ).not.toBeInTheDocument();
    // The upload override button is present
    expect(
      screen.getByRole('button', { name: /override with screenshots/i }),
    ).toBeInTheDocument();
  });

  it('reflects the empty/no-images-staged status text', () => {
    render(<PeriscopeChat />);
    expect(
      screen.getByText(/No images staged · using stored Periscope data/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// MODE TOGGLE
// ============================================================

describe('PeriscopeChat: mode toggle', () => {
  it('renders all three mode radios', () => {
    render(<PeriscopeChat />);
    expect(
      screen.getByRole('radio', { name: /pre-trade/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /intraday/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /debrief/i })).toBeInTheDocument();
  });

  it('marks the active mode radio as checked', () => {
    render(<PeriscopeChat />);
    expect(screen.getByRole('radio', { name: /intraday/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('calls setMode when a different mode radio is clicked', () => {
    const setMode = vi.fn();
    mockUsePeriscopeChat.mockReturnValue({ ...defaultHookReturn, setMode });
    render(<PeriscopeChat />);
    fireEvent.click(screen.getByRole('radio', { name: /pre-trade/i }));
    expect(setMode).toHaveBeenCalledWith('pre_trade');
  });

  it('shows the Linked-to-read badge when parentId is set in intraday/debrief mode', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      mode: 'debrief',
      parentId: 42,
    });
    render(<PeriscopeChat />);
    expect(screen.getByText(/Linked to read #42/)).toBeInTheDocument();
  });
});

// ============================================================
// LOADING / ERROR / EMPTY STATES
// ============================================================

describe('PeriscopeChat: states', () => {
  it('shows loading / analyzing label and elapsed seconds while inFlight', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      inFlight: true,
      elapsedMs: 5_000,
    });
    render(<PeriscopeChat />);
    expect(
      screen.getByRole('button', { name: /Analyzing.*5s elapsed/i }),
    ).toBeInTheDocument();
  });

  it('shows the error block when error is set', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      error: 'no_periscope_data: scraper has no slot for 13:30',
    });
    render(<PeriscopeChat />);
    expect(screen.getByRole('alert')).toHaveTextContent(/no_periscope_data/);
  });

  it('renders no response area when response is null and no error', () => {
    render(<PeriscopeChat />);
    expect(screen.queryByTestId('prose-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-view')).not.toBeInTheDocument();
  });

  it('renders structured fields, playbook, and prose when a response is present', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      response: makeSuccessResponse(),
    });
    render(<PeriscopeChat />);
    expect(screen.getByTestId('prose-view')).toHaveTextContent(/Pin day at/);
    expect(screen.getByTestId('playbook-view')).toBeInTheDocument();
    // Structured fields grid renders the regime tag
    expect(screen.getByText('pin')).toBeInTheDocument();
    // Spot-at-read footer rendered
    expect(
      screen.getByText(/Spot at read time: 5800\.00 \(db_exact\)/),
    ).toBeInTheDocument();
  });

  it('shows the parseOk=false warning banner when the JSON block was malformed', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      response: makeSuccessResponse({ parseOk: false }),
    });
    render(<PeriscopeChat />);
    expect(screen.getByRole('status')).toHaveTextContent(
      /JSON playbook block was missing or malformed/i,
    );
  });
});

// ============================================================
// INTERACTION — submit / reset / upload override
// ============================================================

describe('PeriscopeChat: interactions', () => {
  it('invokes submit() when the submit button is clicked', () => {
    const submit = vi.fn();
    mockUsePeriscopeChat.mockReturnValue({ ...defaultHookReturn, submit });
    render(<PeriscopeChat />);
    fireEvent.click(screen.getByRole('button', { name: /submit intraday/i }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('invokes reset() when the Reset button is clicked', () => {
    const reset = vi.fn();
    mockUsePeriscopeChat.mockReturnValue({ ...defaultHookReturn, reset });
    render(<PeriscopeChat />);
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('clicking override-with-screenshots reveals the upload zones', () => {
    render(<PeriscopeChat />);
    expect(
      screen.queryByText(/Drop, click, or paste/i),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /override with screenshots/i }),
    );
    expect(screen.getByText(/Drop, click, or paste/i)).toBeInTheDocument();
    // All three image kinds get an upload role-button slot
    expect(
      screen.getByRole('button', { name: /upload periscope chart/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /upload net gex heat map/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /upload net charm heat map/i }),
    ).toBeInTheDocument();
  });

  it('updates submit-button label when mode is debrief', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      mode: 'debrief',
    });
    render(<PeriscopeChat />);
    expect(
      screen.getByRole('button', { name: /submit debrief/i }),
    ).toBeInTheDocument();
  });

  it('updates submit-button label when mode is pre_trade', () => {
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      mode: 'pre_trade',
    });
    render(<PeriscopeChat />);
    expect(
      screen.getByRole('button', { name: /submit pre-trade/i }),
    ).toBeInTheDocument();
  });

  it('calls setReadDate when the read-date input changes', () => {
    const setReadDate = vi.fn();
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      setReadDate,
    });
    render(<PeriscopeChat />);
    fireEvent.change(screen.getByLabelText(/read date/i), {
      target: { value: '2026-05-09' },
    });
    expect(setReadDate).toHaveBeenCalledWith('2026-05-09');
  });

  it('calls setReadTime when the read-time select changes', () => {
    const setReadTime = vi.fn();
    mockUsePeriscopeChat.mockReturnValue({
      ...defaultHookReturn,
      setReadTime,
    });
    render(<PeriscopeChat />);
    fireEvent.change(screen.getByLabelText(/read time/i), {
      target: { value: '14:00' },
    });
    expect(setReadTime).toHaveBeenCalledWith('14:00');
  });
});
