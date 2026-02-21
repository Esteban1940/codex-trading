import { logger } from "./logger.js";

export function auditDecision(payload: {
  strategy: string;
  symbol: string;
  inputs: Record<string, number | string | boolean>;
  rule: string;
  action: string;
}): void {
  logger.info({ event: "strategy_decision", ...payload });
}
