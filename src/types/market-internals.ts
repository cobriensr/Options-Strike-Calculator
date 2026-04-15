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
