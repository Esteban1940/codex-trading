export interface InstrumentInfo {
  symbol: string;
  market: "BCBA";
  currency: "ARS" | "USD";
  assetClass: "equities";
}

const symbolMap = new Map<string, InstrumentInfo>([
  ["AAPL", { symbol: "AAPL", market: "BCBA", currency: "ARS", assetClass: "equities" }],
  ["MSFT", { symbol: "MSFT", market: "BCBA", currency: "ARS", assetClass: "equities" }],
  ["MELI", { symbol: "MELI", market: "BCBA", currency: "ARS", assetClass: "equities" }]
]);

export class InstrumentResolver {
  resolve(symbol: string): InstrumentInfo {
    const item = symbolMap.get(symbol.toUpperCase());
    if (!item) throw new Error(`Unknown IOL symbol: ${symbol}`);
    return item;
  }
}

export class SymbolMap {
  static fromVenue(symbol: string): string { return symbol.toUpperCase(); }
  static toVenue(symbol: string): string { return symbol.toUpperCase(); }
}
