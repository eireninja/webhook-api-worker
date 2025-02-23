/**
 * Enhanced logging utility specifically designed for trading operations
 */

import { LogLevel, LogFormat, LogConfig, LogCategory } from '../types/config';

export { LogCategory };  // Re-export LogCategory

// Constants mapping to LogLevel type
export const LOG_LEVEL: Record<string, LogLevel> = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  VERBOSE: 'verbose'
};

// Default log level from environment or INFO
export const DEFAULT_LOG_LEVEL: LogLevel = 
  (process?.env?.LOG_LEVEL as LogLevel) || 'info';

interface LogMetadata {
  requestId: string;
  operation: string;
  category?: LogCategory;
  [key: string]: any;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  metadata: LogMetadata;
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
}

interface ErrorInfo {
  message: string;
  name: string;
  stack?: string;
  code?: string;
  cause?: ErrorInfo;
}

interface TradeContext {
  symbol: string;
  side: string;
  type: string;
  quantity?: string;
  leverage?: number;
  marginMode?: string;
  closePosition?: boolean;
}

interface AccountContext {
  accountId: string;    // Masked account identifier
  brokerTag?: string;
  exchange: string;
}

export class Logger {
  private config: LogConfig;

  constructor(config: LogConfig) {
    // Override config level with environment variable if present
    const envLogLevel = process?.env?.LOG_LEVEL || 'info';
    
    if (envLogLevel && Object.values(LOG_LEVEL).includes(envLogLevel as LogLevel)) {
      this.config = {
        ...config,
        level: envLogLevel as LogLevel
      };
    } else {
      this.config = config;
    }
  }

  private formatError(error: Error): ErrorInfo {
    const errorInfo: ErrorInfo = {
      message: error.message,
      name: error.name,
      stack: error.stack
    };

    if ('code' in error) {
      errorInfo.code = (error as any).code;
    }

    if ('cause' in error && error.cause instanceof Error) {
      errorInfo.cause = this.formatError(error.cause);
    }

    return errorInfo;
  }

  /**
   * Masks sensitive data in log entries
   * @param data - Object containing potentially sensitive data
   * @returns Object with sensitive data masked
   * 
   * Masking patterns:
   * - API Keys: Preserves prefix (ak-prod-) and last 4 chars
   * - Wallet Addresses: Preserves 0x prefix, first 4 and last 4 chars
   * - Other sensitive fields: Preserves first 4 and last 4 chars
   */
  private maskSensitiveData(data: Record<string, any>): Record<string, any> {
    if (!this.config.maskSensitiveData) return data;
    
    const masked = { ...data };
    for (const [key, value] of Object.entries(masked)) {
      if (typeof value === 'string') {
        if (key.toLowerCase().includes('key')) {
          if (value.startsWith('ak-prod-')) {
            // Format: ak-prod-1234....abcd
            masked[key] = value.replace(/^(ak-prod-\d{4}).*([a-f0-9]{4})$/, '$1....$2');
          } else if (value.startsWith('sk_')) {
            // Format: sk_t....abcd
            masked[key] = value.replace(/^(sk_[a-z]{1,4}).*([a-f0-9]{4})$/, '$1....$2');
          } else {
            // Format: abcd....wxyz
            masked[key] = value.replace(/^([a-zA-Z0-9-]{4}).*([a-zA-Z0-9-]{4})$/, '$1....$2');
          }
        } else if (key.toLowerCase().includes('address')) {
          // Format: 0x1234....5678
          masked[key] = value.replace(/^(0x[0-9a-f]{4}).*([0-9a-f]{4})$/i, '$1....$2');
        } else if (
          key.toLowerCase().includes('secret') || 
          key.toLowerCase().includes('password') ||
          key.toLowerCase().includes('token')
        ) {
          // Format: abcd....wxyz
          masked[key] = value.replace(/^(.{4}).*(.{4})$/, '$1....$2');
        }
      } else if (value && typeof value === 'object') {
        masked[key] = this.maskSensitiveData(value);
      }
    }
    return masked;
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    error?: Error,
    metadata: Partial<LogMetadata> = {}
  ): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata: {
        requestId: metadata.requestId || crypto.randomUUID(),
        operation: metadata.operation || 'unknown',
        ...metadata
      }
    };

    if (error) {
      entry.error = this.formatError(error);
    }

    if (this.config.maskSensitiveData) {
      entry.metadata = this.maskSensitiveData(entry.metadata) as LogMetadata;
    }

    return JSON.stringify(entry);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['error', 'warn', 'info', 'debug', 'verbose'];
    const currentIdx = levels.indexOf(this.config.level);
    const targetIdx = levels.indexOf(level);
    return targetIdx <= currentIdx;
  }

  /**
   * Log trade execution start
   */
  tradingStart(context: TradeContext & Pick<AccountContext, 'accountId'>, metadata?: Partial<LogMetadata>): void {
    this.info('Trade execution started', {
      ...metadata,
      category: 'trade' as LogCategory,
      trade: context,
      step: 'start'
    });
  }

  /**
   * Log trade execution result
   */
  tradingComplete(
    success: boolean,
    context: TradeContext & Pick<AccountContext, 'accountId'>,
    error?: Error,
    metadata?: Partial<LogMetadata>
  ): void {
    if (success) {
      this.info('Trade execution completed', {
        ...metadata,
        category: 'trade' as LogCategory,
        trade: context,
        step: 'complete'
      });
    } else {
      this.error('Trade execution failed', error, {
        ...metadata,
        category: 'trade' as LogCategory,
        trade: context,
        step: 'failed'
      });
    }
  }

  /**
   * Log position update
   */
  positionUpdate(symbol: string, size: string, pnl: string, metadata?: Partial<LogMetadata>): void {
    this.info('Position updated', {
      ...metadata,
      category: 'position' as LogCategory,
      position: { symbol, size, pnl }
    });
  }

  /**
   * Log balance update
   */
  balanceUpdate(currency: string, amount: string, metadata?: Partial<LogMetadata>): void {
    this.debug('Balance updated', {
      ...metadata,
      category: 'balance' as LogCategory,
      balance: { currency, amount }
    });
  }

  error(message: string, error?: Error, metadata?: Partial<LogMetadata>): void {
    if (this.shouldLog('error')) {
      console.error(this.createLogEntry('error', message, error, metadata));
    }
  }

  warn(message: string, metadata?: Partial<LogMetadata>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.createLogEntry('warn', message, undefined, metadata));
    }
  }

  info(message: string, metadata?: Partial<LogMetadata>): void {
    if (this.shouldLog('info')) {
      console.info(this.createLogEntry('info', message, undefined, metadata));
    }
  }

  debug(message: string, metadata?: Partial<LogMetadata>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.createLogEntry('debug', message, undefined, metadata));
    }
  }

  verbose(message: string, metadata?: Partial<LogMetadata>): void {
    if (this.shouldLog('verbose')) {
      console.debug(this.createLogEntry('verbose', message, undefined, metadata));
    }
  }
}
