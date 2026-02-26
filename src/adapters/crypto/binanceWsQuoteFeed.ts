import { logger } from "../../infra/logger.js";

type SupportedSymbol = "BTC/USDT" | "ETH/USDT";

interface WsBookTickerPayload {
  s?: string;
  b?: string;
  a?: string;
}

interface CombinedStreamPayload {
  stream?: string;
  data?: WsBookTickerPayload;
}

interface QuoteSnapshot {
  bid: number;
  ask: number;
  last: number;
  ts: number;
}

function toSymbol(pair: string): SupportedSymbol | undefined {
  const normalized = pair.toUpperCase();
  if (normalized === "BTCUSDT") return "BTC/USDT";
  if (normalized === "ETHUSDT") return "ETH/USDT";
  return undefined;
}

function parsePayload(raw: string): CombinedStreamPayload | undefined {
  try {
    return JSON.parse(raw) as CombinedStreamPayload;
  } catch {
    return undefined;
  }
}

export class BinanceWsQuoteFeed {
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly quotes = new Map<SupportedSymbol, QuoteSnapshot>();

  constructor(
    private readonly cfg: {
      url: string;
      reconnectMs: number;
    }
  ) {}

  start(): void {
    const WsCtor = globalThis.WebSocket;
    if (!WsCtor) {
      logger.warn({
        event: "binance_ws_quotes_unavailable",
        reason: "WebSocket runtime not available; falling back to REST polling"
      });
      return;
    }

    const streams = ["btcusdt@bookTicker", "ethusdt@bookTicker"].join("/");
    const base = this.cfg.url.replace(/\/+$/, "");
    const wsUrl = `${base}?streams=${streams}`;
    this.connect(wsUrl, WsCtor);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  getQuote(symbol: SupportedSymbol): QuoteSnapshot | undefined {
    return this.quotes.get(symbol);
  }

  private connect(url: string, WsCtor: typeof WebSocket): void {
    if (this.stopped) return;

    try {
      this.ws = new WsCtor(url);
    } catch (error) {
      logger.warn({
        event: "binance_ws_quotes_connect_failed",
        reason: error instanceof Error ? error.message : String(error)
      });
      this.scheduleReconnect(url, WsCtor);
      return;
    }

    this.ws.onopen = () => {
      logger.info({ event: "binance_ws_quotes_connected", url });
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const payload = parsePayload(String(event.data ?? ""));
      const marketSymbol = toSymbol(String(payload?.data?.s ?? ""));
      if (!marketSymbol) return;

      const bid = Number(payload?.data?.b ?? 0);
      const ask = Number(payload?.data?.a ?? 0);
      const last = bid > 0 && ask > 0 ? (bid + ask) / 2 : Math.max(bid, ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || last <= 0) return;

      this.quotes.set(marketSymbol, {
        bid,
        ask,
        last,
        ts: Date.now()
      });
    };

    this.ws.onerror = (event: Event) => {
      logger.warn({
        event: "binance_ws_quotes_error",
        detail: String((event as { message?: unknown }).message ?? "unknown")
      });
    };

    this.ws.onclose = () => {
      this.ws = undefined;
      logger.warn({ event: "binance_ws_quotes_closed" });
      this.scheduleReconnect(url, WsCtor);
    };
  }

  private scheduleReconnect(url: string, WsCtor: typeof WebSocket): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(url, WsCtor);
    }, Math.max(500, this.cfg.reconnectMs));
  }
}
