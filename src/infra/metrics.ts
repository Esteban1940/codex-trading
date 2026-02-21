export type MetricValue = number;

const metricsStore = new Map<string, MetricValue>();

export function setMetric(name: string, value: MetricValue): void {
  metricsStore.set(name, value);
}

export function snapshotMetrics(): Record<string, MetricValue> {
  return Object.fromEntries(metricsStore.entries());
}
