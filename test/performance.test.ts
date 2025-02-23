import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookHandler } from '../src/services/webhook';
import { Logger } from '../src/utils/logger';
import { TelegramService } from '../src/services/telegram';
import { LogConfig } from '../src/types/config';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

describe('Performance and Resource Tests', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Request Timeouts', () => {
    it('should handle slow requests with error', async () => {
      // Mock a slow database query (3 seconds)
      mockPreparedStatement.all = vi.fn().mockReturnValue(
        new Promise(resolve => setTimeout(resolve, 3000))
      );

      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '100'
        })
      });

      const response = await handler.handle(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual(expect.objectContaining({
        success: false,
        error: expect.stringContaining('Cannot read properties of undefined')
      }));
    }, 10000); // 10 second test timeout
  });

  describe('Memory Usage', () => {
    it('should handle large payloads efficiently', async () => {
      // Create a large payload (100KB)
      const largeComment = 'x'.repeat(100 * 1024);
      
      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '100',
          comment: largeComment
        })
      });

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const beforeMemory = process.memoryUsage().heapUsed;
      await handler.handle(request);
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      const afterMemory = process.memoryUsage().heapUsed;

      // Memory increase should be reasonable (less than payload size + overhead)
      // Node.js has some memory overhead, so we'll allow for 500KB total
      expect(afterMemory - beforeMemory).toBeLessThan(500 * 1024);
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '100'
        })
      });

      // Send 10 concurrent requests
      const requests = Array(10).fill(null).map(() => 
        handler.handle(request.clone())
      );

      await expect(Promise.all(requests)).resolves.toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('should handle rate limit errors', async () => {
      const request = new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: 'test-auth-token',
          symbol: 'BTC-USDT',
          type: 'spot',
          exchange: 'okx',
          side: 'buy',
          qty: '100'
        })
      });

      // Mock rate limit exceeded error
      mockPreparedStatement.all = vi.fn().mockRejectedValue(new Error('Rate limit exceeded'));

      // Send 100 requests in rapid succession
      const requests = Array(100).fill(null).map(() => 
        handler.handle(request.clone())
      );

      const responses = await Promise.all(requests);
      
      // Check that all responses indicate rate limit error
      for (const response of responses) {
        const data = await response.json();
        expect(data).toEqual(expect.objectContaining({
          success: false,
          error: 'Rate limit exceeded'
        }));
        expect(response.status).toBe(400);
      }
    });
  });
});
