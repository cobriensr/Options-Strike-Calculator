export interface ThresholdDelta {
  readonly label: string;
  readonly pct: number;
  readonly pts: number;
  readonly putDelta: number;
  readonly callDelta: number;
  readonly purpose: string;
  readonly importance: 'primary' | 'secondary';
}
