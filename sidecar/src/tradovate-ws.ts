import WebSocket from 'ws';
import { parseFrame, buildMessage, type TradovateMessage } from './tradovate-parser.js';
import logger from './logger.js';

const HEARTBEAT_INTERVAL_MS = 2_500;

export interface WsCallbacks {
  onQuote: (quote: TradovateQuote) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
}

export interface TradovateQuote {
  timestamp: string;
  contractId: number;
  entries: Record<string, { price?: number; size?: number }>;
}

export class TradovateWsClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private requestId = 0;
  private readonly wsUrl: string;
  private readonly callbacks: WsCallbacks;
  private subscribedSymbol: string | null = null;

  constructor(wsUrl: string, callbacks: WsCallbacks) {
    this.wsUrl = wsUrl;
    this.callbacks = callbacks;
  }

  connect(accessToken: string, symbol: string): void {
    this.subscribedSymbol = symbol;
    logger.info({ url: this.wsUrl, symbol }, 'Connecting to Tradovate WebSocket');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString();
      const frame = parseFrame(raw);

      // Log every frame for debugging (truncate large payloads)
      logger.debug(`WS frame: ${raw.slice(0, 200)}`);

      switch (frame.type) {
        case 'open':
          logger.info('WebSocket open, sending authorization');
          // Tradovate authorize expects the raw token as body, not JSON
          this.send(`authorize\n${this.nextId()}\n\n${accessToken}`);
          this.startHeartbeat();
          break;
        case 'heartbeat':
          break;
        case 'data':
          logger.info(`WS data: ${JSON.stringify(frame.messages).slice(0, 300)}`);
          this.handleMessages(frame.messages, symbol);
          break;
        case 'close':
          logger.warn(`WS close frame: code=${frame.code} reason=${frame.reason}`);
          this.cleanup();
          this.callbacks.onDisconnected(frame.reason);
          break;
        case 'unknown':
          logger.warn(`WS unknown frame: ${raw.slice(0, 200)}`);
          break;
      }
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.cleanup();
      this.callbacks.onDisconnected(reason.toString() || `code ${code}`);
    });
  }

  private handleMessages(messages: TradovateMessage[], symbol: string): void {
    for (const msg of messages) {
      if (msg.s !== undefined) {
        if (msg.s === 200) {
          logger.info('Authorized, subscribing to quotes');
          this.send(buildMessage('md/subscribeQuote', this.nextId(), { symbol }));
          this.callbacks.onConnected();
        } else {
          logger.error({ status: msg.s, data: msg.d }, 'Auth/subscribe failed');
        }
        continue;
      }
      if (msg.e === 'shutdown') {
        const reasonCode = (msg.d as Record<string, string>)?.reasonCode ?? 'unknown';
        logger.warn({ reasonCode }, 'Tradovate shutdown event');
        this.cleanup();
        this.callbacks.onDisconnected(`shutdown: ${reasonCode}`);
        return;
      }
      if (msg.e === 'md' && msg.d) {
        const quotes = (msg.d as { quotes?: TradovateQuote[] }).quotes;
        if (quotes) {
          for (const quote of quotes) {
            this.callbacks.onQuote(quote);
          }
        }
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('[]');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private send(message: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect(): void {
    if (this.subscribedSymbol && this.ws?.readyState === WebSocket.OPEN) {
      this.send(
        buildMessage('md/unsubscribeQuote', this.nextId(), { symbol: this.subscribedSymbol }),
      );
    }
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
