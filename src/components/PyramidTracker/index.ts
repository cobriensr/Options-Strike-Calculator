/**
 * Public surface of the Pyramid Trade Tracker feature.
 *
 * Only the top-level section is re-exported — internal components
 * (ChainCard, ChainList, LegTable, ProgressCounter, ExportCSVButton,
 * CompletenessMeter, ChainFormModal, LegFormModal, PyramidTrackerModal,
 * pyramid-form-helpers) stay internal to keep the droppable surface tight:
 * `rm -rf src/components/PyramidTracker` removes the entire experiment when
 * it's over.
 */

export { default as PyramidTrackerSection } from './PyramidTrackerSection';
