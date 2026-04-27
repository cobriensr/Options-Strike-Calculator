/**
 * useUpdateAvailable — React surface over sw-update.ts.
 * Returns `{ available, applyUpdate }` so a banner component can render
 * conditionally and call the reload action on click.
 */

import { useEffect, useState } from 'react';
import {
  applyUpdate,
  getNeedsRefresh,
  subscribeToUpdateState,
} from '../lib/sw-update';

export interface UpdateAvailableState {
  available: boolean;
  applyUpdate: () => void;
}

export function useUpdateAvailable(): UpdateAvailableState {
  const [available, setAvailable] = useState<boolean>(() => getNeedsRefresh());

  useEffect(() => {
    return subscribeToUpdateState(() => setAvailable(getNeedsRefresh()));
  }, []);

  return { available, applyUpdate };
}
