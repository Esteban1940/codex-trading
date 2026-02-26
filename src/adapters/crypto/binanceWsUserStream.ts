import { logger } from "../../infra/logger.js";

interface ListenKeyResponse {
  listenKey?: string;
}

export class BinanceWsUserStream {
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private listenKey = "";

  constructor(
    private readonly cfg: {
      apiKey: string;
      restBaseUrl: string;
      wsBaseUrl: string;
      reconnectMs: number;
      keepaliveMs: number;
    }
  ) {}

  async start(): Promise<void> {
    const WsCtor = globalThis.WebSocket;
    if (!WsCtor) {
      logger.warn({
        event: "binance_ws_user_stream_unavailable",
        reason: "WebSocket runtime not available"
      });
      return;
    }

    try {
      this.listenKey = await this.createListenKey();
      this.connect(WsCtor);
      this.startKeepaliveLoop();
    } catch (error) {
      logger.warn({
        event: "binance_ws_user_stream_start_failed",
        reason: error instanceof Error ? error.message : String(error)
      });
      this.scheduleReconnect(WsCtor);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = undefined;
    this.keepaliveTimer = undefined;
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private connect(WsCtor: typeof WebSocket): void {
    if (!this.listenKey || this.stopped) return;
    const base = this.cfg.wsBaseUrl.replace(/\/+$/, "");
    const wsBase = base.endsWith("/stream") ? base.slice(0, -"/stream".length) : base;
    const wsUrl = `${wsBase}/ws/${this.listenKey}`;

    this.ws = new WsCtor(wsUrl);
    this.ws.onopen = () => {
      logger.info({ event: "binance_ws_user_stream_connected" });
    };
    this.ws.onmessage = (event) => {
      this.handleUserEvent(String(event.data ?? ""));
    };
    this.ws.onerror = (event) => {
      logger.warn({
        event: "binance_ws_user_stream_error",
        detail: String((event as { message?: unknown }).message ?? "unknown")
      });
    };
    this.ws.onclose = () => {
      this.ws = undefined;
      logger.warn({ event: "binance_ws_user_stream_closed" });
      this.scheduleReconnect(WsCtor);
    };
  }

  private startKeepaliveLoop(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      void this.keepAlive();
    }, Math.max(60_000, this.cfg.keepaliveMs));
  }

  private async keepAlive(): Promise<void> {
    if (!this.listenKey || this.stopped) return;
    await fetch(`${this.cfg.restBaseUrl.replace(/\/+$/, "")}/api/v3/userDataStream?listenKey=${encodeURIComponent(this.listenKey)}`, {
      method: "PUT",
      headers: {
        "X-MBX-APIKEY": this.cfg.apiKey
      }
    });
  }

  private async createListenKey(): Promise<string> {
    const response = await fetch(`${this.cfg.restBaseUrl.replace(/\/+$/, "")}/api/v3/userDataStream`, {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": this.cfg.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Unable to create listenKey: ${response.status}`);
    }

    const payload = (await response.json()) as ListenKeyResponse;
    const key = String(payload.listenKey ?? "").trim();
    if (!key) throw new Error("Empty listenKey from Binance");
    return key;
  }

  private handleUserEvent(raw: string): void {
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const eventType = String(payload.e ?? payload.eventType ?? "");
      if (!eventType) return;

      if (eventType === "executionReport") {
        logger.info({
          event: "binance_user_execution_report",
          symbol: payload.s,
          orderStatus: payload.X,
          side: payload.S,
          clientOrderId: payload.c
        });
        return;
      }

      if (eventType === "outboundAccountPosition" || eventType === "balanceUpdate") {
        logger.info({
          event: "binance_user_account_update",
          type: eventType
        });
      }
    } catch {
      // Ignore malformed payloads.
    }
  }

  private scheduleReconnect(WsCtor: typeof WebSocket): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        this.listenKey = await this.createListenKey();
        this.connect(WsCtor);
      } catch (error) {
        logger.warn({
          event: "binance_ws_user_stream_reconnect_failed",
          reason: error instanceof Error ? error.message : String(error)
        });
        this.scheduleReconnect(WsCtor);
      }
    }, Math.max(1000, this.cfg.reconnectMs));
  }
}
