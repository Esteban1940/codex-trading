import { config } from "./config.js";
import { logger } from "./logger.js";

export async function sendAlert(event: string, payload: Record<string, unknown>): Promise<void> {
  const webhook = config.ALERT_WEBHOOK_URL.trim();
  if (!webhook) return;

  const controller = new AbortController();
  const timeoutMs = Math.max(500, config.ALERT_WEBHOOK_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "codex-trading-bot",
        ts: new Date().toISOString(),
        event,
        payload
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      logger.warn({
        event: "alert_delivery_failed",
        alertEvent: event,
        status: response.status,
        statusText: response.statusText
      });
    }
  } catch (error) {
    logger.warn({
      event: "alert_delivery_exception",
      alertEvent: event,
      reason: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
}
