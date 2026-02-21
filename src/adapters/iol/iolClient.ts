import { config } from "../../infra/config.js";
import { withRetry } from "../../infra/retry.js";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export class IolClient {
  private token: string | null = null;
  private tokenExpiryMs = 0;

  private get baseUrl(): string {
    return config.IOL_USE_SANDBOX ? config.IOL_SANDBOX_BASE_URL : config.IOL_BASE_URL;
  }

  async authenticate(): Promise<void> {
    if (!config.IOL_USERNAME || !config.IOL_PASSWORD) throw new Error("Missing IOL credentials in .env.");

    const response = await withRetry(() =>
      fetch(`${this.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: config.IOL_USERNAME,
          password: config.IOL_PASSWORD,
          grant_type: "password"
        })
      })
    );

    if (!response.ok) throw new Error(`IOL auth failed: ${response.status}`);

    const body = (await response.json()) as TokenResponse;
    this.token = body.access_token;
    this.tokenExpiryMs = Date.now() + body.expires_in * 1000 - 10_000;
  }

  private async ensureToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiryMs) await this.authenticate();
    return this.token as string;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.ensureToken();
    const response = await withRetry(() =>
      fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {})
        }
      })
    );

    if (!response.ok) throw new Error(`IOL request failed (${response.status}) ${path}`);
    return (await response.json()) as T;
  }

  getQuote(symbol: string): Promise<unknown> {
    return this.request(`/api/v2/Cotizaciones/${encodeURIComponent(symbol)}`);
  }

  getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<unknown> {
    return this.request(`/api/v2/bcba/titulos/${encodeURIComponent(symbol)}/cotizacion/seriehistorica/${timeframe}/${from.toISOString()}/${to.toISOString()}`);
  }

  getPortfolio(): Promise<unknown> {
    return this.request(`/api/v2/portafolio/argentina`);
  }

  getAccount(): Promise<unknown> {
    return this.request(`/api/v2/estadocuenta`);
  }

  placeOrder(payload: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v2/operar/Comprar`, { method: "POST", body: JSON.stringify(payload) });
  }

  cancelOrder(orderId: string): Promise<unknown> {
    return this.request(`/api/v2/operaciones/${orderId}`, { method: "DELETE" });
  }

  getOrder(orderId: string): Promise<unknown> {
    return this.request(`/api/v2/operaciones/${orderId}`);
  }
}
