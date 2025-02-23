import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateWebhookPayload, WebhookPayload } from '../src/services/webhook';
import { DatabaseService } from '../src/services/database';
import { Logger } from '../src/utils/logger';
import { LogConfig } from '../src/types/config';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

describe('Webhook Validation', () => {
  describe('validateWebhookPayload', () => {
    it('should validate a valid spot payload', () => {
      const payload = {
        symbol: 'BTC-USDT',
        type: 'spot',
        exchange: 'okx',
        side: 'buy',
        qty: '100'
      };
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a valid perps payload', () => {
      const payload = {
        symbol: 'BTC-USDT-SWAP',
        type: 'perps',
        exchange: 'okx',
        side: 'buy',
        qty: '50%',
        leverage: 5,
        marginMode: 'isolated'
      };
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a valid invperps payload', () => {
      const payload = {
        symbol: 'BTC-USD-SWAP',
        type: 'invperps',
        exchange: 'okx',
        side: 'sell',
        qty: '75%',
        leverage: 3,
        marginMode: 'cross'
      };
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate close position without side', () => {
      const payload = {
        symbol: 'BTC-USDT-SWAP',
        type: 'perps',
        exchange: 'okx',
        qty: '100%',
        closePosition: true,
        leverage: 5
      };
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid trading type', () => {
      const payload = {
        symbol: 'BTC-USDT',
        type: 'invalid',
        exchange: 'okx',
        side: 'buy',
        qty: '100'
      } as WebhookPayload;
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid type. Must be spot, perps, or invperps');
    });

    it('should reject missing required fields', () => {
      const payload = {
        symbol: 'BTC-USDT',
        type: 'spot'
      } as WebhookPayload;
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Exchange is required');
      expect(result.errors).toContain('Side is required for entry orders');
    });

    it('should reject invalid leverage value', () => {
      const payload = {
        symbol: 'BTC-USDT-SWAP',
        type: 'perps',
        exchange: 'okx',
        side: 'buy',
        qty: '100',
        leverage: 0
      };
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('leverage must be a positive number');
    });

    it('should reject invalid margin mode', () => {
      const payload = {
        symbol: 'BTC-USDT-SWAP',
        type: 'perps',
        exchange: 'okx',
        side: 'buy',
        qty: '100',
        leverage: 5,
        marginMode: 'invalid'
      } as WebhookPayload;
      const result = validateWebhookPayload(payload);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid margin mode. Must be cross or isolated');
    });
  });
});

describe('Database Service', () => {
  let db: D1Database;
  let logger: Logger;
  let service: DatabaseService;

  beforeEach(() => {
    // Mock D1PreparedStatement
    const mockPreparedStatement: D1PreparedStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(),
      run: vi.fn(),
      all: vi.fn(),
      raw: vi.fn()
    };

    // Mock D1Database
    db = {
      prepare: vi.fn().mockReturnValue(mockPreparedStatement),
      dump: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn()
    };

    // Initialize logger with required config
    const logConfig: LogConfig = {
      level: 'debug',
      format: 'json',
      maskSensitiveData: true
    };
    logger = new Logger(logConfig);

    // Create service instance
    service = new DatabaseService(db, logger);
  });

  describe('getApiKeys', () => {
    it('should handle case-insensitive exchange names', async () => {
      const mockResults = {
        success: true,
        results: [{
          exchange: 'OKX',
          api_key: 'test-key',
          secret_key: 'test-secret',
          passphrase: 'test-pass',
          label: 'test-label'
        }]
      };

      // Mock the all() method to return our test data
      (db.prepare('SELECT * FROM api_keys WHERE LOWER(exchange) = LOWER(?)')
        .bind('okx')
        .all as jest.Mock).mockResolvedValue(mockResults);

      const result = await service.getApiKeys('okx');
      expect(result).toHaveLength(1);
      expect(result[0].exchange).toBe('OKX');
      expect(result[0].apiKey).toBe('test-key');
    });

    it('should handle multiple API keys', async () => {
      const mockResults = {
        success: true,
        results: [
          {
            exchange: 'OKX',
            api_key: 'key1',
            secret_key: 'secret1',
            passphrase: 'pass1',
            label: 'label1'
          },
          {
            exchange: 'OKX',
            api_key: 'key2',
            secret_key: 'secret2',
            passphrase: 'pass2',
            label: 'label2'
          }
        ]
      };

      // Mock the all() method to return our test data
      (db.prepare('SELECT * FROM api_keys WHERE LOWER(exchange) = LOWER(?)')
        .bind('okx')
        .all as jest.Mock).mockResolvedValue(mockResults);

      const result = await service.getApiKeys('okx');
      expect(result).toHaveLength(2);
      expect(result[0].apiKey).toBe('key1');
      expect(result[1].apiKey).toBe('key2');
    });

    it('should handle database errors gracefully', async () => {
      // Mock the all() method to throw an error
      (db.prepare('SELECT * FROM api_keys WHERE LOWER(exchange) = LOWER(?)')
        .bind('okx')
        .all as jest.Mock).mockRejectedValue(new Error('Database error'));

      await expect(service.getApiKeys('okx')).rejects.toThrow('Database error');
    });
  });
});
