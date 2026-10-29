// @vitest-environment jsdom

/**
 * SchwabExpiryBadge — owner-only refresh-token countdown in the header:
 * green > 24 h, amber ≤ 24 h, red ≤ 2 h / expired / logged out, with its
 * own Re-auth link unless the 401-driven prompt is already showing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SchwabAuthStatus } from '../../utils/schwab-expiry';

const { mockUseStatus, mockUseNow } = vi.hoisted(() => ({
  mockUseStatus: vi.fn(),
  mockUseNow: vi.fn(),
}));

vi.mock('../../hooks/useSchwabAuthStatus', () => ({
  useSchwabAuthStatus: mockUseStatus,
}));
vi.mock('../../hooks/useNowMinute', () => ({ useNowMinute: mockUseNow }));

import SchwabExpiryBadge from '../../components/AppHeader/SchwabExpiryBadge';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// Thu Oct 1 2026, 10:00 AM CT.
const NOW = Date.parse('2026-10-01T15:00:00Z');

function renderBadge(
  status: SchwabAuthStatus | null,
  { isOwner = true, reauthPromptShown = false } = {},
) {
  mockUseStatus.mockReturnValue(status);
  return render(
    <SchwabExpiryBadge
      isOwner={isOwner}
      reauthPromptShown={reauthPromptShown}
    />,
  );
}

function expiresIn(ms: number): SchwabAuthStatus {
  return { state: 'active', refreshExpiresAt: NOW + ms };
}

/** Found by its role and accessible name, so every test checks both. */
function badge(): HTMLElement {
  return screen.getByRole('timer', { name: 'Schwab login expiry' });
}

function reauthLink(): HTMLElement | null {
  return screen.queryByRole('link', { name: 'Re-auth with Schwab' });
}

describe('SchwabExpiryBadge', () => {
  beforeEach(() => {
    mockUseStatus.mockReset();
    mockUseNow.mockReset().mockReturnValue(NOW);
  });

  describe('renders nothing and runs no minute clock', () => {
    it('for a non-owner, and keeps the status hook disabled', () => {
      const { container } = renderBadge(expiresIn(HOUR_MS), {
        isOwner: false,
      });
      expect(container).toBeEmptyDOMElement();
      expect(mockUseStatus).toHaveBeenCalledWith(false);
      expect(mockUseNow).not.toHaveBeenCalled();
    });

    it('before the first status arrives', () => {
      const { container } = renderBadge(null);
      expect(container).toBeEmptyDOMElement();
      expect(mockUseStatus).toHaveBeenCalledWith(true);
      expect(mockUseNow).not.toHaveBeenCalled();
    });

    it('when the status is unknown', () => {
      const { container } = renderBadge({ state: 'unknown' });
      expect(container).toBeEmptyDOMElement();
      expect(mockUseNow).not.toHaveBeenCalled();
    });
  });

  it('starts the minute clock once a status is shown', () => {
    renderBadge(expiresIn(HOUR_MS));
    expect(mockUseNow).toHaveBeenCalled();
  });

  it('gives warn and urgent different glyphs, not just different colours', () => {
    const { unmount } = renderBadge(expiresIn(5 * HOUR_MS));
    const warnGlyph = badge().querySelector(
      '[aria-hidden="true"]',
    )?.textContent;
    unmount();
    renderBadge(expiresIn(HOUR_MS));
    const urgentGlyph = badge().querySelector(
      '[aria-hidden="true"]',
    )?.textContent;
    expect(warnGlyph?.trim()).toBe('▲');
    expect(urgentGlyph?.trim()).toBe('◆');
  });

  it('is green with no Re-auth link while more than 24 h remain', () => {
    renderBadge(expiresIn(3 * 24 * HOUR_MS + 5 * HOUR_MS));
    expect(badge()).toHaveAttribute('data-tier', 'ok');
    expect(badge()).toHaveTextContent('Schwab 3d 5h');
    expect(badge()).toHaveStyle({ color: 'var(--color-success)' });
    expect(reauthLink()).toBeNull();
  });

  it('is amber with a Re-auth link at 24 h or less', () => {
    renderBadge(expiresIn(23 * HOUR_MS + 10 * MINUTE_MS));
    expect(badge()).toHaveAttribute('data-tier', 'warn');
    expect(badge()).toHaveTextContent('Schwab 23h 10m');
    expect(badge()).toHaveStyle({ color: 'var(--color-caution)' });
    expect(reauthLink()).toHaveAttribute('href', '/api/auth/init');
  });

  it('is red with a Re-auth link at 2 h or less', () => {
    renderBadge(expiresIn(90 * MINUTE_MS));
    expect(badge()).toHaveAttribute('data-tier', 'urgent');
    expect(badge()).toHaveTextContent('Schwab 1h 30m');
    expect(badge()).toHaveStyle({ color: 'var(--color-danger)' });
    expect(reauthLink()).toBeInTheDocument();
  });

  it('shows minutes only in the last hour', () => {
    renderBadge(expiresIn(42 * MINUTE_MS + 30 * 1000));
    expect(badge()).toHaveTextContent('Schwab 42m');
  });

  it('is red "expired" once past the expiry', () => {
    renderBadge({ state: 'expired', refreshExpiresAt: NOW - HOUR_MS });
    expect(badge()).toHaveAttribute('data-tier', 'expired');
    expect(badge()).toHaveTextContent('Schwab expired');
    expect(badge()).toHaveAttribute(
      'title',
      'Schwab login expired Thu 9:00 AM CT',
    );
    expect(reauthLink()).toBeInTheDocument();
  });

  it('is red "logged out" when no login is stored', () => {
    renderBadge({ state: 'logged_out' });
    expect(badge()).toHaveAttribute('data-tier', 'logged_out');
    expect(badge()).toHaveTextContent('Schwab logged out');
    expect(reauthLink()).toBeInTheDocument();
  });

  it('classifies on the client clock, not the server state', () => {
    // Fetched as "active" with 25 h left; an hour later it is amber.
    mockUseNow.mockReturnValue(NOW + HOUR_MS + MINUTE_MS);
    renderBadge(expiresIn(25 * HOUR_MS));
    expect(badge()).toHaveAttribute('data-tier', 'warn');
  });

  it('counts down as the minute clock advances', () => {
    const { rerender } = renderBadge(expiresIn(3 * HOUR_MS));
    expect(badge()).toHaveTextContent('Schwab 3h 0m');
    mockUseNow.mockReturnValue(NOW + 61 * MINUTE_MS);
    rerender(<SchwabExpiryBadge isOwner reauthPromptShown={false} />);
    expect(badge()).toHaveTextContent('Schwab 1h 59m');
    expect(badge()).toHaveAttribute('data-tier', 'urgent');
  });

  it('hides its own Re-auth link while the 401 prompt is showing', () => {
    renderBadge(expiresIn(HOUR_MS), { reauthPromptShown: true });
    expect(badge()).toBeInTheDocument();
    expect(reauthLink()).toBeNull();
  });

  it('gives the absolute expiry in Central time as its title', () => {
    renderBadge(expiresIn(10 * HOUR_MS)); // Thu 8:00 PM CT
    expect(badge()).toHaveAttribute(
      'title',
      'Schwab login expires Thu 8:00 PM CT',
    );
  });

  describe('does not rely on colour alone (WCAG 1.4.1)', () => {
    it.each([
      [
        'ok',
        expiresIn(3 * 24 * HOUR_MS),
        '●',
        'Login active until Sun 10:00 AM CT.',
      ],
      [
        'warn',
        expiresIn(5 * HOUR_MS),
        '▲',
        'Login expires within 24 hours, at Thu 3:00 PM CT.',
      ],
      [
        'urgent',
        expiresIn(HOUR_MS),
        '◆',
        'Login expires within 2 hours, at Thu 11:00 AM CT.',
      ],
      [
        'expired',
        { state: 'expired', refreshExpiresAt: NOW - MINUTE_MS },
        '✕',
        'Login expired Thu 9:59 AM CT.',
      ],
      [
        'logged_out',
        { state: 'logged_out' },
        '✕',
        'Re-authenticate to restore live data.',
      ],
    ] as const)(
      '%s: a hidden shape glyph plus screen-reader severity text',
      (_tier, status, glyph, srText) => {
        renderBadge(status);
        expect(screen.getByText(glyph)).toHaveAttribute('aria-hidden', 'true');
        expect(badge().querySelector('.sr-only')).toHaveTextContent(srText);
      },
    );

    it('is a timer with no explicit live region (a per-minute countdown would chatter)', () => {
      renderBadge(expiresIn(5 * HOUR_MS));
      // role=timer's implicit aria-live is "off"; nothing may override it.
      expect(badge()).toHaveAttribute('role', 'timer');
      expect(badge()).not.toHaveAttribute('aria-live');
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('labels its Re-auth link for screen readers', () => {
      renderBadge(expiresIn(HOUR_MS));
      expect(reauthLink()).toHaveAccessibleName('Re-auth with Schwab');
    });
  });
});
