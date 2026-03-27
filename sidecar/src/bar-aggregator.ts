export interface Tick {
  price: number;
  cumulativeVolume: number;
  timestamp: Date;
}

export interface Bar {
  symbol: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickCount: number;
}

type FlushCallback = (bar: Bar) => void;

function minuteFloor(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

export class BarAggregator {
  private currentBar: Bar | null = null;
  private currentMinute: number = 0;
  private barStartCumVolume: number = 0;
  private lastCumVolume: number = 0;
  private readonly onFlush: FlushCallback;
  private readonly symbol: string;

  constructor(onFlush: FlushCallback, symbol = 'ES') {
    this.onFlush = onFlush;
    this.symbol = symbol;
  }

  onTick(tick: Tick): void {
    const minuteTs = minuteFloor(tick.timestamp).getTime();

    if (this.currentBar && minuteTs !== this.currentMinute) {
      this.currentBar.volume = this.lastCumVolume - this.barStartCumVolume;
      this.onFlush(this.currentBar);
      this.currentBar = null;
    }

    if (!this.currentBar) {
      const isReset =
        this.lastCumVolume > 0 && tick.cumulativeVolume < this.lastCumVolume;

      this.currentMinute = minuteTs;
      this.barStartCumVolume = isReset
        ? 0
        : this.lastCumVolume || tick.cumulativeVolume;
      this.currentBar = {
        symbol: this.symbol,
        ts: minuteFloor(tick.timestamp),
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 0,
        tickCount: 1,
      };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, tick.price);
      this.currentBar.low = Math.min(this.currentBar.low, tick.price);
      this.currentBar.close = tick.price;
      this.currentBar.tickCount++;
    }

    this.lastCumVolume = tick.cumulativeVolume;
  }

  flush(): void {
    if (!this.currentBar) return;
    this.currentBar.volume = this.lastCumVolume - this.barStartCumVolume;
    this.onFlush(this.currentBar);
    this.currentBar = null;
  }

  getCurrentBar(): Bar | null {
    return this.currentBar;
  }
}
