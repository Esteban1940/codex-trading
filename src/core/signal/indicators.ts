export function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const arr = values.slice(-period);
  return arr.reduce((s, v) => s + v, 0) / period;
}

export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let current = values[0] ?? 0;
  for (let i = 1; i < values.length; i += 1) {
    current = (values[i] ?? 0) * k + current * (1 - k);
  }
  return current;
}

export function std(values: number[], period: number): number {
  const sample = values.slice(-period);
  if (sample.length === 0) return 0;
  const mean = sample.reduce((s, v) => s + v, 0) / sample.length;
  const variance = sample.reduce((s, v) => s + (v - mean) ** 2, 0) / sample.length;
  return Math.sqrt(variance);
}

export function rsi(values: number[], period: number): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const window = values.slice(-period - 1);
  for (let i = 1; i < window.length; i += 1) {
    const diff = (window[i] ?? 0) - (window[i - 1] ?? 0);
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function roc(values: number[], period: number): number {
  if (values.length <= period) return 0;
  const prev = values[values.length - period - 1] ?? values[0] ?? 1;
  const last = values[values.length - 1] ?? prev;
  if (prev === 0) return 0;
  return ((last - prev) / prev) * 100;
}

export function atr(highs: number[], lows: number[], closes: number[], period: number): number {
  if (highs.length <= period || lows.length <= period || closes.length <= period) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i += 1) {
    const h = highs[i] ?? 0;
    const l = lows[i] ?? 0;
    const pc = closes[i - 1] ?? closes[i] ?? 0;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}
