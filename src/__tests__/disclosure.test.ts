import { describe, it, expect } from 'vitest';
import { disclosureA11yProps } from '../components/ui/disclosure';

describe('disclosureA11yProps', () => {
  it('expanded → aria-expanded true, panel visible, ids wired', () => {
    const { triggerProps, panelProps } = disclosureA11yProps(true, 'panel-1');
    expect(triggerProps).toEqual({
      type: 'button',
      'aria-expanded': true,
      'aria-controls': 'panel-1',
    });
    expect(panelProps).toEqual({ id: 'panel-1', hidden: false });
  });

  it('collapsed → aria-expanded false, panel hidden (kept mounted, not unmounted)', () => {
    const { triggerProps, panelProps } = disclosureA11yProps(false, 'panel-1');
    expect(triggerProps['aria-expanded']).toBe(false);
    // panelProps.hidden true (node stays in the DOM so aria-controls resolves).
    expect(panelProps).toEqual({ id: 'panel-1', hidden: true });
  });

  it('aria-controls always matches the panel id (no dangling reference)', () => {
    for (const expanded of [true, false]) {
      const { triggerProps, panelProps } = disclosureA11yProps(expanded, 'x');
      expect(triggerProps['aria-controls']).toBe(panelProps.id);
    }
  });
});
