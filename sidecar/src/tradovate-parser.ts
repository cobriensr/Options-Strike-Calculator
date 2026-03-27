export type TradovateFrame =
  | { type: 'open' }
  | { type: 'heartbeat' }
  | { type: 'close'; code: number; reason: string }
  | { type: 'data'; messages: TradovateMessage[] }
  | { type: 'unknown'; raw: string };

export interface TradovateMessage {
  e?: string;
  d?: Record<string, unknown>;
  s?: number;
  i?: number;
}

export function parseFrame(raw: string): TradovateFrame {
  if (!raw || raw.length === 0) return { type: 'unknown', raw: '' };

  const prefix = raw[0];

  switch (prefix) {
    case 'o':
      return { type: 'open' };

    case 'h':
      return { type: 'heartbeat' };

    case 'c': {
      try {
        const arr = JSON.parse(raw.slice(1)) as [number, string];
        return { type: 'close', code: arr[0], reason: arr[1] };
      } catch {
        return { type: 'close', code: 0, reason: raw.slice(1) };
      }
    }

    case 'a': {
      try {
        const outerArray = JSON.parse(raw.slice(1)) as unknown[];
        const messages: TradovateMessage[] = outerArray.map((item) => {
          // Tradovate sends either JSON strings (double-encoded) or objects directly
          if (typeof item === 'string') {
            return JSON.parse(item) as TradovateMessage;
          }
          return item as TradovateMessage;
        });
        return { type: 'data', messages };
      } catch {
        return { type: 'unknown', raw };
      }
    }

    default:
      return { type: 'unknown', raw };
  }
}

export function buildMessage(
  endpoint: string,
  requestId: number,
  body: Record<string, unknown>,
): string {
  return `${endpoint}\n${requestId}\n\n${JSON.stringify(body)}`;
}
