import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger } from '../src/utils/logger';
import { TelegramService } from '../src/services/telegram';
import { LogConfig } from '../src/types/config';

describe('Telegram Service', () => {
  let telegram: TelegramService;
  let logger: Logger;

  beforeEach(() => {
    // Initialize logger with required config
    const logConfig: LogConfig = {
      level: 'debug',
      format: 'json',
      maskSensitiveData: true
    };
    logger = new Logger(logConfig);

    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    });

    telegram = new TelegramService({
      botToken: process.env.TELEGRAM_BOT_TOKEN || 'test-token',
      channelId: process.env.TELEGRAM_CHANNEL_ID || 'test-channel'
    }, logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendMessage', () => {
    it('should send a message successfully', async () => {
      const message = {
        type: 'INFO' as const,
        symbol: 'TEST-USDT',
        side: 'buy' as const,
        requestId: 'test-123',
        message: 'Test message',
        totalAccounts: 1
      };

      await expect(telegram.sendMessage(message)).resolves.not.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('test-token'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.any(String)
        })
      );
    });

    it('should handle error messages', async () => {
      const message = {
        type: 'ERROR' as const,
        symbol: 'TEST-USDT',
        requestId: 'test-123',
        error: 'Test error message'
      };

      await expect(telegram.sendMessage(message)).resolves.not.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle warning messages', async () => {
      const message = {
        type: 'WARN' as const,
        symbol: 'TEST-USDT',
        requestId: 'test-123',
        message: 'Test warning message'
      };

      await expect(telegram.sendMessage(message)).resolves.not.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle multi-account trade messages', async () => {
      const message = {
        type: 'INFO' as const,
        symbol: 'TEST-USDT',
        side: 'buy' as const,
        requestId: 'test-123',
        message: 'Multi-account trade',
        totalAccounts: 3
      };

      await expect(telegram.sendMessage(message)).resolves.not.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle API errors', async () => {
      // Mock fetch to return an error
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      const message = {
        type: 'INFO' as const,
        symbol: 'TEST-USDT',
        side: 'buy' as const,
        requestId: 'test-123',
        message: 'Test message',
        totalAccounts: 1
      };

      await expect(telegram.sendMessage(message)).rejects.toThrow('Telegram API error: 404 Not Found');
    });
  });
});
