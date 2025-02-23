import { Logger, LogCategory } from '../utils/logger';
import type { D1Database } from '@cloudflare/workers-types';
import { ExchangeCredentials } from '../types/exchanges';

interface ApiKeyRow {
  id: string;
  user_id: string;
  api_key: string;
  secret_key: string;
  passphrase?: string;
  label?: string;
  exchange: string;
  created_at: string;
}

export class DatabaseService {
  constructor(
    private db: D1Database,
    private logger: Logger
  ) {}

  /**
   * Helper method to handle database errors consistently
   */
  private handleDatabaseError(error: unknown, context: {
    operation: string;
    requestId: string;
    category?: LogCategory;
    exchange?: string;
    keyId?: string;
  }): never {
    const err = error instanceof Error ? error : new Error('Unknown database error occurred');
    
    this.logger.error(`Database error while ${context.operation}`, err, {
      requestId: context.requestId,
      operation: context.operation,
      category: context.category || 'system',
      ...(context.exchange && { exchange: context.exchange }),
      ...(context.keyId && { keyId: context.keyId }),
      error: err.message
    });
    
    throw err;
  }

  /**
   * Retrieve API keys for a specific exchange
   */
  async getApiKeys(exchange: string, requestId: string): Promise<ExchangeCredentials[]> {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM api_keys WHERE LOWER(exchange) = LOWER(?)'
      );
      const result = await stmt.bind(exchange).all<ApiKeyRow>();

      if (!result.success) {
        throw new Error('Failed to retrieve API keys');
      }

      const keys = result.results;
      this.logger.debug('Retrieved API keys', {
        requestId,
        operation: 'get_api_keys',
        category: 'security',
        exchange,
        count: keys.length
      });

      return keys.map(row => ({
        exchange: row.exchange,
        apiKey: row.api_key,
        secretKey: row.secret_key,
        passphrase: row.passphrase,
        label: row.label
      }));
    } catch (error) {
      this.handleDatabaseError(error, {
        operation: 'get_api_keys',
        requestId,
        category: 'security',
        exchange
      });
    }
  }

  /**
   * Get a specific API key by its ID
   */
  async getApiKeyById(id: string, requestId: string): Promise<ExchangeCredentials | null> {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM api_keys WHERE id = ?'
      );
      const result = await stmt.bind(id).first<ApiKeyRow>();

      if (!result) {
        this.logger.warn('API key not found', {
          requestId,
          operation: 'get_api_key',
          category: 'security',
          keyId: id
        });
        return null;
      }

      this.logger.debug('Retrieved API key', {
        requestId,
        operation: 'get_api_key',
        category: 'security',
        exchange: result.exchange,
        keyId: id
      });

      return {
        exchange: result.exchange,
        apiKey: result.api_key,
        secretKey: result.secret_key,
        passphrase: result.passphrase,
        label: result.label
      };
    } catch (error) {
      this.handleDatabaseError(error, {
        operation: 'get_api_key',
        requestId,
        category: 'security',
        keyId: id
      });
    }
  }
}
