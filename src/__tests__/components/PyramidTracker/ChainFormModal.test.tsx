import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChainFormModal from '../../../components/PyramidTracker/ChainFormModal';
import type { PyramidChain, PyramidChainInput } from '../../../types/pyramid';
import { PyramidApiError } from '../../../hooks/usePyramidData';

// ============================================================
// Fixtures
// ============================================================

const fullChain: PyramidChain = {
  id: '2026-04-16-MNQ-1',
  trade_date: '2026-04-16',
  instrument: 'MNQ',
  direction: 'long',
  entry_time_ct: '09:15',
  exit_time_ct: '14:30',
  initial_entry_price: 21200.5,
  final_exit_price: 21250.75,
  exit_reason: 'reverse_choch',
  total_legs: 4,
  winning_legs: 3,
  net_points: 50.25,
  session_atr_pct: 0.65,
  day_type: 'trend',
  higher_tf_bias: 'bullish above 21100',
  notes: 'Clean trend day from OR low.',
  status: 'closed',
  created_at: '2026-04-16T14:30:00Z',
  updated_at: '2026-04-16T14:30:00Z',
};

function makeProps(
  overrides: Partial<React.ComponentProps<typeof ChainFormModal>> = {},
) {
  const defaults = {
    mode: 'create' as const,
    open: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
}

// ============================================================
// Tests
// ============================================================

describe('ChainFormModal', () => {
  it('renders in create mode with mostly empty fields', () => {
    const props = makeProps();
    render(<ChainFormModal {...props} />);

    // Dialog is present.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /new pyramid chain/i }),
    ).toBeInTheDocument();

    // Chain ID input is empty in create mode (placeholder shows suggestion).
    const idInput = screen.getByLabelText(/chain id/i);
    expect(idInput).toHaveValue('');

    // Direction is empty (user must pick).
    expect(screen.getByLabelText(/direction/i)).toHaveValue('');

    // Save and Cancel present.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('renders nothing when open=false', () => {
    const props = makeProps({ open: false });
    const { container } = render(<ChainFormModal {...props} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders in edit mode with initialChain pre-populated and id readonly', () => {
    const props = makeProps({ mode: 'edit', initialChain: fullChain });
    render(<ChainFormModal {...props} />);

    expect(
      screen.getByRole('heading', { name: /edit pyramid chain/i }),
    ).toBeInTheDocument();

    const idInput = screen.getByLabelText(/chain id/i);
    expect(idInput).toHaveValue(fullChain.id);
    expect(idInput).toHaveAttribute('readonly');

    expect(screen.getByLabelText(/trade date/i)).toHaveValue('2026-04-16');
    expect(screen.getByLabelText(/instrument/i)).toHaveValue('MNQ');
    expect(screen.getByLabelText(/direction/i)).toHaveValue('long');
    expect(screen.getByLabelText(/day type/i)).toHaveValue('trend');
    expect(screen.getByLabelText(/notes/i)).toHaveValue(
      'Clean trend day from OR low.',
    );
    expect(screen.getByLabelText(/status/i)).toHaveValue('closed');
  });

  it('renders all exit-reason options', () => {
    const props = makeProps();
    render(<ChainFormModal {...props} />);
    const select = screen.getByLabelText(/exit reason/i);
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => o.getAttribute('value'),
    );
    expect(optionValues).toEqual([
      '',
      'reverse_choch',
      'stopped_out',
      'manual',
      'eod',
    ]);
  });

  it('renders all day-type options', () => {
    render(<ChainFormModal {...makeProps()} />);
    const select = screen.getByLabelText(/day type/i);
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => o.getAttribute('value'),
    );
    expect(optionValues).toEqual(['', 'trend', 'chop', 'news', 'mixed']);
  });

  it('saves with partial data (all feature fields optional)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ChainFormModal {...makeProps({ onSubmit, onClose })} />);

    // Only type an ID; leave everything else at defaults / blank.
    await user.type(screen.getByLabelText(/chain id/i), '2026-04-16-MNQ-7');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0] as PyramidChainInput;
    expect(payload.id).toBe('2026-04-16-MNQ-7');
    // Blank fields serialize as null (not "") so the server stores NULL.
    expect(payload.direction).toBeNull();
    expect(payload.exit_reason).toBeNull();
    expect(payload.day_type).toBeNull();
    expect(payload.notes).toBeNull();
    // Default instrument dropdown is MNQ.
    expect(payload.instrument).toBe('MNQ');
    // Create mode forces status=open regardless of initial state.
    expect(payload.status).toBe('open');

    // Successful submit closes the modal.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('auto-suggests id when user leaves it blank in create mode', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ChainFormModal {...makeProps({ onSubmit })} />);

    // Don't type an ID. Date is today, instrument is MNQ.
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0] as PyramidChainInput;
    // Suggested id is {today}-MNQ-1.
    expect(payload.id).toMatch(/^\d{4}-\d{2}-\d{2}-MNQ-1$/);
  });

  it('submits the full payload shape when all fields are filled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ChainFormModal
        {...makeProps({ mode: 'edit', initialChain: fullChain, onSubmit })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0] as PyramidChainInput;
    expect(payload).toEqual({
      id: '2026-04-16-MNQ-1',
      trade_date: '2026-04-16',
      instrument: 'MNQ',
      direction: 'long',
      entry_time_ct: '09:15',
      exit_time_ct: '14:30',
      initial_entry_price: 21200.5,
      final_exit_price: 21250.75,
      exit_reason: 'reverse_choch',
      total_legs: 4,
      winning_legs: 3,
      net_points: 50.25,
      session_atr_pct: 0.65,
      day_type: 'trend',
      higher_tf_bias: 'bullish above 21100',
      notes: 'Clean trend day from OR low.',
      status: 'closed',
    });
  });

  it('completeness meter reflects fill state', async () => {
    const user = userEvent.setup();
    // 15 fillable fields; defaults fill trade_date + instrument => 2/15 = 13%.
    render(<ChainFormModal {...makeProps()} />);

    // Default fill: 2/15 rounds to 13%.
    expect(screen.getByTestId('completeness-percent')).toHaveTextContent(
      /Complete: 13%/,
    );

    // Fill more fields.
    await user.selectOptions(screen.getByLabelText(/direction/i), 'long');
    await user.type(screen.getByLabelText(/initial entry price/i), '21200');
    await user.selectOptions(screen.getByLabelText(/day type/i), 'trend');

    // 5 of 15 = 33%.
    expect(screen.getByTestId('completeness-percent')).toHaveTextContent(
      /Complete: 33%/,
    );
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ChainFormModal {...makeProps({ onClose })} />);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ChainFormModal {...makeProps({ onClose })} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses on backdrop mousedown that starts on the backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ChainFormModal {...makeProps({ onClose })} />,
    );
    // The backdrop is the aria-hidden div with bg-black/60. Find it via the
    // class token — avoids leaking implementation details into a testid.
    const backdrop = container.querySelector<HTMLElement>('.bg-black\\/60');
    expect(backdrop).not.toBeNull();
    // Dispatching on the backdrop itself means `event.target === backdrop`
    // === `currentTarget` inside the handler, so the close fires.
    fireEvent.mouseDown(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT dismiss when mousedown originates inside the dialog', () => {
    const onClose = vi.fn();
    render(<ChainFormModal {...makeProps({ onClose })} />);
    // Simulate a press starting inside the dialog (the common live case is
    // a text-highlight drag in the Notes textarea). mouseDown on the
    // textarea bubbles through the dialog panel, not through the backdrop
    // — the backdrop's handler never sees it, so `onClose` stays silent.
    const notes = screen.getByLabelText(/^notes$/i);
    fireEvent.mouseDown(notes);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('target-check: mousedown with a non-backdrop target does not close', () => {
    // Direct unit check of the guard: even if an event somehow reaches the
    // backdrop with a foreign `target` (e.g. a bubbled custom event), the
    // `e.target === e.currentTarget` check skips the close.
    const onClose = vi.fn();
    const { container } = render(
      <ChainFormModal {...makeProps({ onClose })} />,
    );
    const backdrop = container.querySelector<HTMLElement>('.bg-black\\/60');
    expect(backdrop).not.toBeNull();
    // Create a bare MouseEvent and dispatch it from a descendant of the
    // panel. It bubbles past the panel's own ancestors; since the backdrop
    // is a sibling of the panel (not an ancestor), this confirms the
    // backdrop handler is not spuriously invoked by in-dialog events.
    const notes = screen.getByLabelText(/^notes$/i);
    notes.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focus trap: Tab at last focusable element loops back to first', async () => {
    const user = userEvent.setup();
    render(<ChainFormModal {...makeProps()} />);

    // Find the first and last focusable descendants inside the dialog.
    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    // Focus the last element and press Tab — should wrap to first.
    last.focus();
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(first);

    // Shift+Tab from first should wrap back to last.
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(last);
  });

  it('surfaces PyramidApiError as an inline form error and does not close', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new PyramidApiError('DB exploded', 500));
    const onClose = vi.fn();
    render(<ChainFormModal {...makeProps({ onSubmit, onClose })} />);

    await user.type(screen.getByLabelText(/chain id/i), 'abc');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Inline alert is rendered; modal stays open.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /server error/i,
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
