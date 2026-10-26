/**
 * LazyPanelPrefsModal — mounts PanelPrefsModal only while it is open.
 *
 * The modal and @dnd-kit (~115 KB before minification) load as their own
 * chunk on the first gear click instead of with the entry bundle. Closing
 * unmounts the modal, which runs its effect cleanup and so still returns
 * focus to the gear button.
 *
 * Own Suspense and ErrorBoundary: App renders this outside every section
 * boundary, so a chunk that fails to load must not reach the top-level
 * boundary and blank the page.
 */

import { lazy, Suspense, type ComponentProps } from 'react';
import ErrorBoundary from '../ErrorBoundary';
import { handleStaleChunk } from '../../utils/handle-stale-chunk';
import type { PanelPrefsModal as PanelPrefsModalComponent } from './PanelPrefsModal';

const PanelPrefsModal = lazy(() =>
  import('./PanelPrefsModal')
    .then((m) => ({ default: m.PanelPrefsModal }))
    .catch(handleStaleChunk),
);

type Props = ComponentProps<typeof PanelPrefsModalComponent>;

export function LazyPanelPrefsModal(props: Props) {
  if (!props.isOpen) return null;
  return (
    <ErrorBoundary label="Panel preferences">
      <Suspense fallback={null}>
        <PanelPrefsModal {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
