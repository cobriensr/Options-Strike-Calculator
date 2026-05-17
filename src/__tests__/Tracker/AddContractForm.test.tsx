import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddContractForm } from '../../components/Tracker/AddContractForm';

describe('AddContractForm', () => {
  function setup(onCreate = vi.fn().mockResolvedValue(undefined)) {
    const onClose = vi.fn();
    const utils = render(
      <AddContractForm open={true} onClose={onClose} onCreate={onCreate} />,
    );
    return { ...utils, onCreate, onClose };
  }

  it('renders modal with both tabs', () => {
    setup();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /Structured/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Free-text/i })).toBeInTheDocument();
  });

  it('returns null when closed', () => {
    const onCreate = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <AddContractForm open={false} onClose={onClose} onCreate={onCreate} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('submits structured form with the expected payload', async () => {
    const { onCreate, onClose } = setup();
    fireEvent.change(screen.getByLabelText(/Ticker/i), {
      target: { value: 'NVDA' },
    });
    fireEvent.change(screen.getByLabelText(/Expiry/i), {
      target: { value: '2026-05-22' },
    });
    fireEvent.change(screen.getByLabelText(/Strike/i), {
      target: { value: '225' },
    });
    fireEvent.change(screen.getByLabelText(/Entry price/i), {
      target: { value: '4.3' },
    });
    fireEvent.change(screen.getByLabelText(/Quantity/i), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      ticker: 'NVDA',
      expiry: '2026-05-22',
      strike: 225,
      side: 'C',
      direction: 'long',
      entry_price: 4.3,
      quantity: 5,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows validation error when strike is missing', async () => {
    const { onCreate } = setup();
    fireEvent.change(screen.getByLabelText(/Ticker/i), {
      target: { value: 'NVDA' },
    });
    fireEvent.change(screen.getByLabelText(/Expiry/i), {
      target: { value: '2026-05-22' },
    });
    fireEvent.change(screen.getByLabelText(/Entry price/i), {
      target: { value: '4.3' },
    });
    // Strike left blank; browser-level required validation suppresses
    // submit on native, but our parser also catches it. Force the
    // submit by bypassing the form (call the Save button which fires
    // FormEvent → preventDefault → our validator runs).
    fireEvent.submit(screen.getByLabelText(/Ticker/i).closest('form')!);
    await waitFor(() =>
      expect(
        screen.queryByText(/Strike must be a positive number/i),
      ).toBeInTheDocument(),
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('switches to free-text tab and submits free-text payload', async () => {
    const { onCreate, onClose } = setup();
    fireEvent.click(screen.getByRole('tab', { name: /Free-text/i }));
    fireEvent.change(screen.getByLabelText(/Free-text input/i), {
      target: { value: 'NVDA 225P 05/22/26 @ 4.30 x 5 long' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toEqual({
      input: 'NVDA 225P 05/22/26 @ 4.30 x 5 long',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows server error and keeps modal open when onCreate throws', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('Conflict 409'));
    const onClose = vi.fn();
    render(
      <AddContractForm open={true} onClose={onClose} onCreate={onCreate} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Free-text/i }));
    fireEvent.change(screen.getByLabelText(/Free-text input/i), {
      target: { value: 'NVDA 225P 05/22/26 @ 4.30 x 5 long' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('alert')).toHaveTextContent('Conflict 409'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
