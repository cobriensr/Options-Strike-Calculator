/**
 * Shared a11y contract for a heading-style disclosure (collapsible section).
 *
 * Returns the trigger button's aria wiring + the panel's id/hidden — the
 * genuinely-shared, error-prone part of a disclosure (a dangling
 * `aria-controls` already bit us once). It is PURE: it owns no state and
 * dictates no markup or styling, so it fits both controlled callers
 * (LotteryFinder / SilentBoom ticker groups, where the expand state lives in
 * the parent) and self-contained callers (ReignitionSection). Callers keep
 * their own button content, chevron styling, and onClick.
 *
 * Always render the panel and toggle the HTML `hidden` attribute (rather than
 * unmounting) so `aria-controls` resolves to a live node and per-row state /
 * in-flight fetches survive a collapse cycle.
 *
 * Usage:
 *   const { triggerProps, panelProps } = disclosureA11yProps(expanded, panelId);
 *   <button {...triggerProps} onClick={toggle} className="...">{label}</button>
 *   <div {...panelProps} className="...">{body}</div>
 */
export function disclosureA11yProps(expanded: boolean, panelId: string) {
  return {
    triggerProps: {
      type: 'button' as const,
      'aria-expanded': expanded,
      'aria-controls': panelId,
    },
    panelProps: {
      id: panelId,
      hidden: !expanded,
    },
  };
}
