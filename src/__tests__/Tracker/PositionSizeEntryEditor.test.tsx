/**
 * Unit tests for PositionSizeEntryEditor — the size + entry-price
 * editor in the Contract Tracker expandable row.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { PositionSizeEntryEditor } from '../../components/Tracker/PositionSizeEntryEditor';

describe('PositionSizeEntryEditor', () => {
  it('renders inputs pre-filled with current size and entry', () => {
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.3000"
        onSave={vi.fn()}
      />,
    );
    const sizeInput = screen.getByLabelText(/Position size/i);
    const entryInput = screen.getByLabelText(/Entry price/i);
    expect(sizeInput).toHaveValue(5);
    // Trailing zeros are stripped for display: "4.3000" → "4.3"
    expect(entryInput).toHaveValue(4.3);
  });

  it('disables Save when pristine', () => {
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('enables Save when size changes and calls onSave with new values', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Position size/i), {
      target: { value: '10' },
    });
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ quantity: 10, entryPrice: 4.3 });
  });

  it('enables Save when entry price changes and calls onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Entry price/i), {
      target: { value: '5.75' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ quantity: 5, entryPrice: 5.75 });
  });

  it('rejects zero entry price (Save stays disabled)', () => {
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Entry price/i), {
      target: { value: '0' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('rejects non-integer size (Save stays disabled)', () => {
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Position size/i), {
      target: { value: '1.5' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('surfaces save errors inline', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Position size/i), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('boom'),
    );
  });

  it('rejects sub-precision entry price (1e-12) — guards against NUMERIC(10,4) underflow', () => {
    render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Entry price/i), {
      target: { value: '1e-12' },
    });
    // Save stays disabled — anything below 0.0001 rounds to 0 on
    // the NUMERIC(10,4) column and would corrupt downstream PnL.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('preserves user mid-typing when parent props update (poll-vs-edit race)', () => {
    const { rerender } = render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    // User is in the middle of typing a new size...
    fireEvent.change(screen.getByLabelText(/Position size/i), {
      target: { value: '7' },
    });
    expect(screen.getByLabelText(/Position size/i)).toHaveValue(7);

    // ...the tracker poll lands with a refreshed (different) row.
    // Without dirty-gating, this would silently clobber the "7"
    // back to the polled value. With dirty-gating, the draft is
    // preserved until the user explicitly Saves or Cancels.
    rerender(
      <PositionSizeEntryEditor
        quantity={8}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Position size/i)).toHaveValue(7);
  });

  it('resyncs drafts when parent props change after save', async () => {
    const { rerender } = render(
      <PositionSizeEntryEditor
        quantity={5}
        entryPrice="4.30"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Position size/i)).toHaveValue(5);

    // Parent received a refreshed contract with new size + entry.
    rerender(
      <PositionSizeEntryEditor
        quantity={10}
        entryPrice="5.7500"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Position size/i)).toHaveValue(10);
    expect(screen.getByLabelText(/Entry price/i)).toHaveValue(5.75);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
