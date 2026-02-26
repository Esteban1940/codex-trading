import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Sends a high-priority runtime alert.
 * Tries Telegram first; if Telegram is not configured or fails, falls back to generic webhook.
 */
export async function sendAlert(event: string, payload: Record<string, unknown>): Promise<void> {
  const telegramSent = await sendTelegramAlert(event, payload);
  if (telegramSent) return;

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

/**
 * Serializes payloads for alert messages and caps size to avoid API rejections.
 */
function toCompactJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 3000 ? `${serialized.slice(0, 3000)}...` : serialized;
  } catch {
    return String(value);
  }
}

/**
 * Escapes MarkdownV2 special chars so Telegram renders alert content safely.
 */
function escapeTelegramMarkdown(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Sends a Telegram message to the configured chat/topic.
 * Returns true only when delivery succeeds.
 */
async function sendTelegramAlert(event: string, payload: Record<string, unknown>): Promise<boolean> {
  const botToken = config.TELEGRAM_BOT_TOKEN.trim();
  const chatId = config.TELEGRAM_CHAT_ID.trim();
  if (!botToken || !chatId) return false;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: [
      "*Codex Trading Alert*",
      `event: \`${escapeTelegramMarkdown(event)}\``,
      `payload: \`${escapeTelegramMarkdown(toCompactJson(payload))}\``
    ].join("\n"),
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true
  };

  const threadId = Number(config.TELEGRAM_THREAD_ID);
  if (Number.isFinite(threadId) && threadId > 0) {
    body.message_thread_id = threadId;
  }

  const timeoutMs = Math.max(500, config.ALERT_WEBHOOK_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      logger.warn({
        event: "telegram_alert_failed",
        alertEvent: event,
        status: response.status
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn({
      event: "telegram_alert_exception",
      alertEvent: event,
      reason: error instanceof Error ? error.message : String(error)
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
