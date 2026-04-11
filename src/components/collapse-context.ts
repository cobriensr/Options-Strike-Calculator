import { createContext } from 'react';

/**
 * Broadcast signal for "collapse all" / "expand all".
 * `version` increments on every button press so SectionBox detects each
 * click even when the target `collapsed` state is unchanged.
 */
export interface CollapseSignal {
  version: number;
  collapsed: boolean;
}

export const CollapseAllContext = createContext<CollapseSignal>({
  version: 0,
  collapsed: false,
});
