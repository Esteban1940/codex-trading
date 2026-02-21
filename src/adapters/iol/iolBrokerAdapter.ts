import type { BrokerAdapter } from "../../core/interfaces.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../../core/domain/types.js";
import { IolClient } from "./iolClient.js";

interface IolAccountResponse {
  cuentas?: Array<{ total?: number | string; disponible?: number | string }>;
}

interface IolPortfolioAsset {
  titulo?: string;
  cantidad?: number | string;
  precioPromedio?: number | string;
}

interface IolPortfolioResponse {
  activos?: IolPortfolioAsset[];
}

interface IolOrderResponse {
  numeroOperacion?: string | number;
  clOrdId?: string;
  simbolo?: string;
  operacion?: string;
  tipoOrden?: string;
  precio?: number | string;
  cantidad?: number | string;
  cantidadOperada?: number | string;
}

interface IolQuoteResponse {
  puntas?: Array<{ precioCompra?: number | string; precioVenta?: number | string }>;
  ultimoPrecio?: number | string;
}

interface IolHistoryRow {
  fechaHora: string;
  apertura?: number | string;
  maximo?: number | string;
  minimo?: number | string;
  ultimoPrecio?: number | string;
  volumenNominal?: number | string;
}

export class IolBrokerAdapter implements BrokerAdapter {
  constructor(private readonly client: IolClient = new IolClient()) {}

  async getAccount(): Promise<AccountSnapshot> {
    const raw = (await this.client.getAccount()) as IolAccountResponse;
    return {
      equityUsd: Number(raw?.cuentas?.[0]?.total ?? 0),
      cashUsd: Number(raw?.cuentas?.[0]?.disponible ?? 0),
      pnlDayUsd: 0,
      drawdownPct: 0
    };
  }

  async getPositions(): Promise<Position[]> {
    const raw = (await this.client.getPortfolio()) as IolPortfolioResponse;
    const items = Array.isArray(raw?.activos) ? raw.activos : [];
    return items.map((p: IolPortfolioAsset) => ({
      symbol: String(p?.titulo ?? ""),
      quantity: Number(p?.cantidad ?? 0),
      avgPrice: Number(p?.precioPromedio ?? 0),
      market: "iol",
      assetClass: "equities"
    }));
  }

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    const raw = (await this.client.placeOrder({
      simbolo: request.symbol,
      cantidad: request.quantity,
      precio: request.price,
      plazo: "t2"
    })) as IolOrderResponse;

    return {
      id: String(raw?.numeroOperacion ?? crypto.randomUUID()),
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: "new",
      price: request.price,
      quantity: request.quantity,
      filledQuantity: 0,
      ts: Date.now()
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    const raw = (await this.client.getOrder(orderId)) as IolOrderResponse;
    return {
      id: orderId,
      clientOrderId: String(raw?.clOrdId ?? ""),
      symbol: String(raw?.simbolo ?? ""),
      side: raw?.operacion === "Compra" ? "buy" : "sell",
      type: raw?.tipoOrden === "Market" ? "market" : "limit",
      status: "filled",
      price: Number(raw?.precio ?? 0),
      quantity: Number(raw?.cantidad ?? 0),
      filledQuantity: Number(raw?.cantidadOperada ?? 0),
      ts: Date.now()
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const raw = (await this.client.getQuote(symbol)) as IolQuoteResponse;
    return {
      symbol,
      bid: Number(raw?.puntas?.[0]?.precioCompra ?? 0),
      ask: Number(raw?.puntas?.[0]?.precioVenta ?? 0),
      last: Number(raw?.ultimoPrecio ?? 0),
      ts: Date.now()
    };
  }

  async getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]> {
    const rows = (await this.client.getHistory(symbol, from, to, timeframe)) as IolHistoryRow[];
    return rows.map((r: IolHistoryRow) => ({
      ts: new Date(r.fechaHora).getTime(),
      open: Number(r.apertura ?? 0),
      high: Number(r.maximo ?? 0),
      low: Number(r.minimo ?? 0),
      close: Number(r.ultimoPrecio ?? 0),
      volume: Number(r.volumenNominal ?? 0)
    }));
  }
}
