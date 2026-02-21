export function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function std(values: number[], period: number): number {
  const mean = sma(values, period);
  const sample = values.slice(-period);
  const variance = sample.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (sample.length || 1);
  return Math.sqrt(variance);
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const relevant = values.slice(values.length - period - 1);
  for (let i = 1; i < relevant.length; i += 1) {
    const diff = relevant[i] - relevant[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
