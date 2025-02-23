import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookHandler } from '../src/services/webhook';
import { Logger } from '../src/utils/logger';
import { TelegramService } from '../src/services/telegram';
import { LogConfig } from '../src/types/config';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ExchangeCredentials, Order } from '../src/types/exchanges';

describe('Webhook Integration', () => {
  let env: any;
  let handler: WebhookHandler;
  let logger: Logger;
  let mockPreparedStatement: D1PreparedStatement;

  beforeEach(() => {
    // Initialize logger with required config
    const logConfig: LogConfig = {
      level: 'debug',
      format: 'json',
      maskSensitiveData: true
    };
    logger = new Logger(logConfig);

    // Mock D1PreparedStatement
    mockPreparedStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({
        success: true,
        results: [{
          exchange: 'okx',
          api_key: 'test-key',
          secret_key: 'test-secret',
          passphrase: 'test-pass'
        }]
      }),
      raw: vi.fn()
    };

    // Mock environment with D1Database
    env = {
      DB: {
        prepare: vi.fn().mockReturnValue(mockPreparedStatement),
        dump: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn()
      } as unknown as D1Database,
      WEBHOOK_AUTH_TOKEN: 'test-auth-token',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_CHANNEL_ID: 'test-channel',
      BROKER_TAG_OKX: 'test-broker'
    };

    // Mock fetch for telegram service
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    });

    // Initialize services
    const telegram = new TelegramService({
      botToken: env.TELEGRAM_BOT_TOKEN,
      channelId: env.TELEGRAM_CHANNEL_ID
    }, logger);

    // Create handler
    handler = new WebhookHandler(env, logger, telegram);
  });

  describe('Full Webhook Flow', () => {
    it('should process a valid spot trade request', async () => {
      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '0.1'
        })
      });

      const response = await handler.handle(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual(expect.objectContaining({
        success: true,
        message: 'Webhook processed successfully'
      }));
    });

    it('should handle invalid auth token', async () => {
      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'invalid-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '0.1'
        })
      });

      const response = await handler.handle(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual(expect.objectContaining({
        success: false,
        error: 'Invalid authorization token'
      }));
    });

    it('should handle missing API keys', async () => {
      // Mock empty API key response
      mockPreparedStatement.all = vi.fn().mockResolvedValue({
        success: true,
        results: []
      });

      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '0.1'
        })
      });

      const response = await handler.handle(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual(expect.objectContaining({
        success: false,
        error: 'No API keys found for exchange: okx'
      }));
    });

    it('should handle database errors', async () => {
      // Mock database error
      mockPreparedStatement.all = vi.fn().mockRejectedValue(new Error('Database connection failed'));

      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '0.1'
        })
      });

      const response = await handler.handle(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual(expect.objectContaining({
        success: false,
        error: expect.stringContaining('Database connection failed')
      }));
    });
  });
});
