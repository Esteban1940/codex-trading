import { readFileSync } from "node:fs";
import type { Candle } from "../core/domain/types.js";

export function loadCandlesFromCsv(path: string): Candle[] {
  const text = readFileSync(path, "utf-8");
  const lines = text.trim().split(/\r?\n/);
  lines.shift();

  return lines.map((line) => {
    const [ts, open, high, low, close, volume] = line.split(",");
    return { ts: Number(ts), open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  });
}
