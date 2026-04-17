/**
 * Overlay toggles (charm/vanna/dex), view-mode selector (OI/VOL/DIR),
 * and the bottom-legend row rendered above the strikes chart.
 *
 * Kept as a single component because all three chunks share the same
 * visibility state and their visual alignment (flex row + legend below)
 * is intentional — splitting would reintroduce awkward prop threading.
 */

import { theme } from '../../themes';
import { CHARM_POS, VANNA_POS, DEX_POS } from './colors';
import type { ViewMode } from './mode';

interface Props {
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  showCharm: boolean;
  showVanna: boolean;
  showDex: boolean;
  onToggleCharm: () => void;
  onToggleVanna: () => void;
  onToggleDex: () => void;
}

const MODES: ReadonlyArray<{
  mode: ViewMode;
  label: string;
  title: string;
}> = [
  { mode: 'oi', label: 'OI', title: 'Open Interest — standing positions' },
  { mode: 'vol', label: 'VOL', title: "Volume — today's fresh flow" },
  {
    mode: 'dir',
    label: 'DIR',
    title: 'Directionalized — MM-side bid/ask proxy (gamma only)',
  },
];

export function OverlayControls({
  viewMode,
  onViewModeChange,
  showCharm,
  showVanna,
  showDex,
  onToggleCharm,
  onToggleVanna,
  onToggleDex,
}: Readonly<Props>) {
  const overlays = [
    {
      key: 'charm',
      label: 'CHARM',
      color: CHARM_POS,
      active: showCharm,
      toggle: onToggleCharm,
    },
    {
      key: 'vanna',
      label: 'VANNA',
      color: VANNA_POS,
      active: showVanna,
      toggle: onToggleVanna,
    },
    {
      key: 'dex',
      label: 'DEX',
      color: DEX_POS,
      active: showDex,
      toggle: onToggleDex,
    },
  ] as const;

  return (
    <>
      <div className="text-muted mb-2 flex items-center gap-3 font-mono text-[10px]">
        <span className="text-[9px] tracking-wider uppercase">Overlays</span>
        {overlays.map((o) => (
          <button
            key={o.key}
            onClick={o.toggle}
            className="cursor-pointer rounded px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide transition-all"
            style={{
              background: o.active ? `${o.color}15` : 'transparent',
              border: `1px solid ${o.active ? o.color + '40' : 'rgba(255,255,255,0.06)'}`,
              color: o.active ? o.color : theme.textMuted,
            }}
          >
            {o.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {MODES.map((m) => (
            <button
              key={m.mode}
              onClick={() => onViewModeChange(m.mode)}
              title={m.title}
              className="cursor-pointer rounded px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide"
              style={{
                background:
                  viewMode === m.mode
                    ? 'rgba(255,255,255,0.06)'
                    : 'transparent',
                border: `1px solid ${viewMode === m.mode ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)'}`,
                color: viewMode === m.mode ? theme.text : theme.textMuted,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="text-muted mb-2 flex items-center gap-5 font-mono text-[10px]">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: theme.green }}
          />
          <span>+Gamma</span>
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: theme.red }}
          />
          <span>-Gamma</span>
        </span>
        {showCharm && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-[3px] w-2 rounded-sm"
              style={{ background: CHARM_POS }}
            />
            <span>Charm</span>
          </span>
        )}
        {showVanna && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full border"
              style={{
                background: `${VANNA_POS}22`,
                borderColor: VANNA_POS,
              }}
            />
            <span>Vanna</span>
          </span>
        )}
        {showDex && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rotate-45 border"
              style={{
                background: `${DEX_POS}22`,
                borderColor: DEX_POS,
              }}
            />
            <span>DEX</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-px"
            style={{ background: theme.accent }}
          />
          <span>SPOT</span>
        </span>
      </div>
    </>
  );
}
