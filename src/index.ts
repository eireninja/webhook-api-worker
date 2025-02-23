/**
 * Main entry point for the Cloudflare Worker
 */

import { Env, ExecutionContext } from './types/env';
import { Logger } from './utils/logger';
import { TelegramService } from './services/telegram';
import { WebhookHandler } from './services/webhook';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize services
    const logger = new Logger({
      level: 'debug',
      format: 'json',
      maskSensitiveData: true
    });

    const telegram = new TelegramService({
      botToken: env.TELEGRAM_BOT_TOKEN,
      channelId: env.TELEGRAM_CHANNEL_ID
    }, logger);

    const webhookHandler = new WebhookHandler(env, logger, telegram);

    try {
      // Handle OPTIONS for CORS
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400'
          }
        });
      }

      // Only allow POST requests
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      // Handle the webhook
      return await webhookHandler.handle(request);

    } catch (error) {
      logger.error('Unhandled error in worker', error as Error);
      
      return new Response(JSON.stringify({
        success: false,
        error: 'Internal server error'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  }
};
