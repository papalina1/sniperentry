/**
 * Telegram notification service.
 *
 * Fire-and-forget: errors are swallowed so Telegram issues never affect
 * the bot's trading logic.
 *
 * Required env vars (both must be set; if either is missing, all sends are
 * silently skipped):
 *   TELEGRAM_BOT_TOKEN  — token from @BotFather
 *   TELEGRAM_CHAT_ID    — your personal chat ID (get via @userinfobot)
 */

import axios from 'axios';
import { config } from '../../config';

function enabled(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
}

/**
 * Send an HTML-formatted message to the configured Telegram chat.
 * Never throws — Telegram is non-critical infrastructure.
 */
export async function sendTelegram(message: string): Promise<void> {
  if (!enabled()) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      },
      { timeout: 8_000 }
    );
  } catch {
    // Non-critical — swallow silently
  }
}
