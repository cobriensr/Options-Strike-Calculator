export type InternalSymbol = '$TICK' | '$ADD' | '$VOLD' | '$TRIN';

export interface InternalBar {
  ts: string; // ISO timestamp
  symbol: InternalSymbol;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type InternalBandState = 'neutral' | 'elevated' | 'extreme' | 'blowoff';

export type RegimeType = 'range' | 'trend' | 'neutral';

export interface RegimeResult {
  regime: RegimeType;
  confidence: number; // 0-1
  evidence: string[];
  scores: { range: number; trend: number; neutral: number };
}

export interface ExtremeEvent {
  ts: string;
  symbol: InternalSymbol;
  value: number;
  band: InternalBandState;
  label: string;
  pinned: boolean;
}
