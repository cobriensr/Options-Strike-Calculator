// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  getLiveSaveOverride,
  isLiveSaveDevice,
  isTouchFirstDevice,
  setLiveSaveOverride,
} from '../lib/live-save-device';

// Where there is no `window` (a worker, a server render), nothing here may
// throw a ReferenceError: the device reads as a computer, which saves.
describe('live-save-device without a window', () => {
  it('has no window, so the cases below are the no-window path', () => {
    expect(typeof window).toBe('undefined');
  });

  it('reads as a computer, not touch-first, without throwing', () => {
    expect(isTouchFirstDevice()).toBe(false);
  });

  it('saves live snapshots by default without throwing', () => {
    expect(isLiveSaveDevice()).toBe(true);
  });

  it('reads no override when there is no storage', () => {
    expect(getLiveSaveOverride()).toBeNull();
  });

  it('does not throw on a set when there is no storage', () => {
    expect(() => setLiveSaveOverride('off')).not.toThrow();
    expect(() => setLiveSaveOverride(null)).not.toThrow();
  });
});
