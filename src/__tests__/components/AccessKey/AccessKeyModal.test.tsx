import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccessKeyModal from '../../../components/AccessKey/AccessKeyModal';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccessKeyModal — public mode', () => {
  it('renders the input form and disables submit when empty', () => {
    render(
      <AccessKeyModal
        mode="public"
        onClose={vi.fn()}
        onLoginSuccess={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /enter access key/i }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  it('calls onLoginSuccess when POST returns 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    const onLoginSuccess = vi.fn();
    render(
      <AccessKeyModal
        mode="public"
        onClose={vi.fn()}
        onLoginSuccess={onLoginSuccess}
        onLogout={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/paste key/i), {
      target: { value: 'shared-secret-12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/guest-key',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ key: 'shared-secret-12345' }),
      }),
    );
  });

  it('shows the server error message on a failed POST', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid access key' }),
    });
    const onLoginSuccess = vi.fn();
    render(
      <AccessKeyModal
        mode="public"
        onClose={vi.fn()}
        onLoginSuccess={onLoginSuccess}
        onLogout={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/paste key/i), {
      target: { value: 'wrong-key-1234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /invalid access key/i,
      ),
    );
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('closes on ESC keypress', () => {
    const onClose = vi.fn();
    render(
      <AccessKeyModal
        mode="public"
        onClose={onClose}
        onLoginSuccess={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <AccessKeyModal
        mode="public"
        onClose={onClose}
        onLoginSuccess={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('AccessKeyModal — guest mode', () => {
  it('shows guest message and Sign out button', () => {
    render(
      <AccessKeyModal
        mode="guest"
        onClose={vi.fn()}
        onLoginSuccess={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /signed in as guest/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it('calls onLogout and onClose when Sign out is clicked', async () => {
    const onLogout = vi.fn().mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(
      <AccessKeyModal
        mode="guest"
        onClose={onClose}
        onLoginSuccess={vi.fn()}
        onLogout={onLogout}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('AccessKeyModal — owner mode', () => {
  it('shows informational copy without an input', () => {
    render(
      <AccessKeyModal
        mode="owner"
        onClose={vi.fn()}
        onLoginSuccess={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /you'?re the owner/i }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/paste key/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /sign in/i }),
    ).not.toBeInTheDocument();
  });
});
