import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import UpdateAvailableBanner from '../../../components/UpdateAvailable/UpdateAvailableBanner';
import {
  markNeedsRefresh,
  resetUpdateState,
  setUpdateFn,
} from '../../../lib/sw-update';

afterEach(() => {
  resetUpdateState();
  vi.restoreAllMocks();
});

describe('UpdateAvailableBanner', () => {
  it('renders nothing while no refresh is pending', () => {
    const { container } = render(<UpdateAvailableBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the toast and Reload button when markNeedsRefresh fires', () => {
    render(<UpdateAvailableBanner />);
    act(() => {
      markNeedsRefresh();
    });
    expect(
      screen.getByRole('status', { name: /new version available/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('calls the registered updateSW(true) when Reload is clicked', () => {
    const updateSW = vi.fn().mockResolvedValueOnce(undefined);
    setUpdateFn(updateSW);
    render(<UpdateAvailableBanner />);
    act(() => {
      markNeedsRefresh();
    });
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(updateSW).toHaveBeenCalledOnce();
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('coalesces repeated markNeedsRefresh calls into a single toast', () => {
    render(<UpdateAvailableBanner />);
    act(() => {
      markNeedsRefresh();
      markNeedsRefresh();
      markNeedsRefresh();
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
