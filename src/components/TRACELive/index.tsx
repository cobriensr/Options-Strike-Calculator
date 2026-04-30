/**
 * TRACE Live dashboard — collapsible section that surfaces the latest
 * Sonnet-4.6 analysis of gamma / charm / delta heatmaps captured by the
 * (eventually) market-hours daemon. Live mode polls every 60 s and chimes
 * on each new capture; historical mode lets the user scrub back to any
 * recorded tick from the date picker + timestamp dropdown.
 *
 * Composition:
 *   - useTraceLiveData orchestrates list + detail fetches
 *   - useTraceLiveCountdown derives the next-capture timer
 *   - useTraceLiveChime fires a half-second tone on each new capturedAt
 *
 * Phase 2c will add the synthesis panel + countdown badge in the header
 * right slot. For now the synthesis appears as a compact summary.
 */

import { memo, useState } from 'react';
import { SectionBox } from '../ui';
import { useTraceLiveData } from './hooks/useTraceLiveData';
import { useTraceLiveCountdown } from './hooks/useTraceLiveCountdown';
import { useTraceLiveChime } from './hooks/useTraceLiveChime';
import TRACELiveHeader from './TRACELiveHeader';
import TRACELiveControls from './TRACELiveControls';
import TRACELiveTabs from './TRACELiveTabs';
import TRACELiveTabPanel from './TRACELiveTabPanel';
import TRACELiveSynthesisPanel from './TRACELiveSynthesisPanel';
import TRACELiveAnalogsPanel from './TRACELiveAnalogsPanel';
import TRACELiveCalibrationPanel from './TRACELiveCalibrationPanel';
import type { TraceChart } from './types';

interface Props {
  readonly marketOpen: boolean;
}

function TRACELiveDashboard({ marketOpen }: Props) {
  const {
    list,
    listLoading,
    listError,
    detail,
    detailLoading,
    detailError,
    selectedDate,
    setSelectedDate,
    selectedId,
    setSelectedId,
    isLive,
    refresh,
  } = useTraceLiveData(marketOpen);

  const [activeChart, setActiveChart] = useState<TraceChart>('gamma');

  const latestCapturedAt = detail?.capturedAt ?? null;
  const countdown = useTraceLiveCountdown(latestCapturedAt);
  useTraceLiveChime(latestCapturedAt, isLive);

  return (
    <SectionBox label="TRACE Live" collapsible>
      <TRACELiveHeader
        detail={detail}
        isLive={isLive}
        countdown={countdown}
        loading={detailLoading || listLoading}
        onRefresh={refresh}
      />

      <TRACELiveControls
        list={list}
        listLoading={listLoading}
        listError={listError}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        selectedId={selectedId}
        onSelectId={setSelectedId}
        isLive={isLive}
      />

      <TRACELiveTabs activeChart={activeChart} onSelect={setActiveChart} />

      <TRACELiveTabPanel
        chart={activeChart}
        detail={detail}
        loading={detailLoading}
        error={detailError}
      />

      <TRACELiveSynthesisPanel detail={detail} />

      <TRACELiveAnalogsPanel detail={detail} />

      <TRACELiveCalibrationPanel />
    </SectionBox>
  );
}

export default memo(TRACELiveDashboard);
