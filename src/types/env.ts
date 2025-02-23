/**
 * Environment variables interface for the Cloudflare Worker
 */

import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';

export { ExecutionContext };

export interface Env {
  // Telegram Configuration
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;

  // Webhook Authentication
  WEBHOOK_AUTH_TOKEN: string;

  // Broker Tag
  BROKER_TAG_OKX: string;

  // D1 Database
  DB: D1Database;
}
