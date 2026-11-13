import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LiveSaveSwitch } from '../LiveSaveSwitch';
import { setLiveSaveOverride } from '../../../lib/live-save-device';

const STORAGE_KEY = 'sc-live-save-device';
const TOUCH_FIRST_QUERY = '(hover: none) and (pointer: coarse)';
const LABEL = 'Save live snapshots from this browser';

function stubTouchFirst(touchFirst: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: touchFirst && query === TOUCH_FIRST_QUERY,
    })),
  );
}

function getSwitch(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: LABEL });
}

function getDefaultButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Use device default' });
}

describe('LiveSaveSwitch', () => {
  beforeEach(() => {
    localStorage.clear();
    stubTouchFirst(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('state', () => {
    it('is on by default on a computer, with the default noted', () => {
      render(<LiveSaveSwitch />);
      expect(getSwitch()).toBeChecked();
      expect(screen.getByText('Default for this device: on')).toBeVisible();
    });

    it('is off by default on a phone or tablet, with the default noted', () => {
      stubTouchFirst(true);
      render(<LiveSaveSwitch />);
      expect(getSwitch()).not.toBeChecked();
      expect(screen.getByText('Default for this device: off')).toBeVisible();
    });

    it('groups the checkbox and its button under the switch label', () => {
      // The button's own name says nothing about what it clears; the group
      // name tells a screen reader which setting it belongs to.
      render(<LiveSaveSwitch />);
      const group = screen.getByRole('group', { name: LABEL });
      expect(within(group).getByRole('checkbox', { name: LABEL })).toBe(
        getSwitch(),
      );
      expect(
        within(group).getByRole('button', { name: 'Use device default' }),
      ).toBe(getDefaultButton());
    });

    it('announces the note as the control description', () => {
      render(<LiveSaveSwitch />);
      expect(getSwitch()).toHaveAccessibleDescription(
        'Default for this device: on',
      );
    });

    it('shows an override that turns a computer off, and names the default', () => {
      setLiveSaveOverride('off');
      render(<LiveSaveSwitch />);
      expect(getSwitch()).not.toBeChecked();
      expect(getSwitch()).toHaveAccessibleDescription(
        "Overriding this device's default (on)",
      );
      expect(screen.queryByText(/^Default for this device/)).toBeNull();
    });

    it('shows an override that turns a phone on, and names the default', () => {
      stubTouchFirst(true);
      setLiveSaveOverride('on');
      render(<LiveSaveSwitch />);
      expect(getSwitch()).toBeChecked();
      expect(getSwitch()).toHaveAccessibleDescription(
        "Overriding this device's default (off)",
      );
    });

    it('reads a garbage stored value as the device default', () => {
      localStorage.setItem(STORAGE_KEY, 'maybe');
      render(<LiveSaveSwitch />);
      expect(getSwitch()).toBeChecked();
      expect(screen.getByText('Default for this device: on')).toBeVisible();
      expect(getDefaultButton()).toBeDisabled();
    });

    it('follows an override set elsewhere in this tab', () => {
      render(<LiveSaveSwitch />);
      expect(getSwitch()).toBeChecked();
      act(() => setLiveSaveOverride('off'));
      expect(getSwitch()).not.toBeChecked();
      expect(getDefaultButton()).toBeEnabled();
      act(() => setLiveSaveOverride(null));
      expect(getSwitch()).toBeChecked();
      expect(getDefaultButton()).toBeDisabled();
    });
  });

  describe('toggling', () => {
    it('writes off when a computer turns it off, then on when turned back', async () => {
      const user = userEvent.setup();
      render(<LiveSaveSwitch />);

      await user.click(getSwitch());
      expect(localStorage.getItem(STORAGE_KEY)).toBe('off');
      expect(getSwitch()).not.toBeChecked();

      await user.click(getSwitch());
      expect(localStorage.getItem(STORAGE_KEY)).toBe('on');
      expect(getSwitch()).toBeChecked();
    });

    it('writes on when a phone turns it on', async () => {
      stubTouchFirst(true);
      const user = userEvent.setup();
      render(<LiveSaveSwitch />);

      await user.click(getSwitch());
      expect(localStorage.getItem(STORAGE_KEY)).toBe('on');
      expect(getSwitch()).toBeChecked();
    });

    it('flips with the Space key once Tab has focused it', async () => {
      const user = userEvent.setup();
      render(<LiveSaveSwitch />);

      await user.tab();
      expect(getSwitch()).toHaveFocus();
      await user.keyboard(' ');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('off');
      expect(getSwitch()).not.toBeChecked();
    });

    it('stays on the device default when storage refuses the write', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage denied');
      });
      const user = userEvent.setup();
      render(<LiveSaveSwitch />);

      await user.click(getSwitch());
      expect(getSwitch()).toBeChecked();
      expect(screen.getByText('Default for this device: on')).toBeVisible();
    });
  });

  describe('Use device default', () => {
    it('is disabled while no override is stored', () => {
      render(<LiveSaveSwitch />);
      expect(getDefaultButton()).toBeDisabled();
    });

    it('is enabled once an override is stored', () => {
      setLiveSaveOverride('off');
      render(<LiveSaveSwitch />);
      expect(getDefaultButton()).toBeEnabled();
    });

    it('clears the override and returns to the device default', async () => {
      stubTouchFirst(true);
      setLiveSaveOverride('on');
      const user = userEvent.setup();
      render(<LiveSaveSwitch />);
      expect(getSwitch()).toBeChecked();

      await user.click(getDefaultButton());

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(getSwitch()).not.toBeChecked();
      expect(screen.getByText('Default for this device: off')).toBeVisible();
      expect(getDefaultButton()).toBeDisabled();
    });

    it('moves focus to the switch, so a disabled button does not keep it', async () => {
      setLiveSaveOverride('off');
      const user = userEvent.setup();
      render(<LiveSaveSwitch />);

      getDefaultButton().focus();
      await user.keyboard('{Enter}');

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(getSwitch()).toHaveFocus();
    });
  });
});
