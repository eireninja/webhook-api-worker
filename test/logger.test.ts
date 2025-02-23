import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/utils/logger';
import { LogConfig } from '../src/types/config';

describe('Logger', () => {
  let logger: Logger;
  const testRequestId = 'test-123';

  beforeEach(() => {
    const config: LogConfig = {
      level: 'debug',
      format: 'json',
      maskSensitiveData: true
    };
    logger = new Logger(config);
    // Reset environment variables
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should log info messages', () => {
    const spy = vi.spyOn(console, 'info');
    logger.info('Test info message', {
      requestId: testRequestId,
      operation: 'test',
      category: 'system'
    });

    expect(spy).toHaveBeenCalled();
    const logEntry = JSON.parse(spy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'info',
      message: 'Test info message',
      metadata: {
        requestId: testRequestId,
        operation: 'test',
        category: 'system'
      }
    });
  });

  it('should log errors with stack traces', () => {
    const spy = vi.spyOn(console, 'error');
    const error = new Error('Test error');
    
    logger.error('Test error occurred', error, {
      requestId: testRequestId,
      operation: 'test'
    });

    expect(spy).toHaveBeenCalled();
    const logEntry = JSON.parse(spy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'error',
      message: 'Test error occurred',
      error: {
        message: 'Test error',
        name: 'Error'
      },
      metadata: {
        requestId: testRequestId,
        operation: 'test'
      }
    });
    expect(logEntry.error.stack).toBeDefined();
  });

  it('should log trade events', () => {
    const spy = vi.spyOn(console, 'info');
    
    logger.tradingStart({
      symbol: 'BTC-USDT',
      side: 'buy',
      type: 'market',
      quantity: '0.1',
      accountId: 'test-account'
    }, {
      requestId: 'trade-123',
      operation: 'test_trade'
    });

    expect(spy).toHaveBeenCalled();
    const logEntry = JSON.parse(spy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'info',
      message: 'Trade execution started',
      metadata: {
        requestId: 'trade-123',
        operation: 'test_trade',
        category: 'trade',
        trade: {
          symbol: 'BTC-USDT',
          side: 'buy',
          type: 'market',
          quantity: '0.1',
          accountId: 'test-account'
        },
        step: 'start'
      }
    });
  });

  it('should mask sensitive data', () => {
    const spy = vi.spyOn(console, 'info');
    
    logger.info('Testing API key masking', {
      requestId: testRequestId,
      operation: 'test',
      category: 'security',
      apiKey: 'ak-prod-1234567890abcdef',
      secretKey: 'sk_test_1234567890abcdef',
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
    });

    expect(spy).toHaveBeenCalled();
    const logEntry = JSON.parse(spy.mock.calls[0][0]);
    
    // API key should preserve ak-prod- prefix and 4 chars
    expect(logEntry.metadata.apiKey).toMatch(/^ak-prod-\d{4}....[a-f0-9]{4}$/);
    
    // Secret key should preserve sk_test and 4 chars
    expect(logEntry.metadata.secretKey).toMatch(/^sk_test....[a-f0-9]{4}$/);
    
    // Wallet address should preserve 0x prefix and hex chars
    expect(logEntry.metadata.walletAddress).toMatch(/^0x[0-9a-f]{4}....[0-9a-f]{4}$/i);
  });

  it('should respect log levels', () => {
    const logger = new Logger({ level: 'info' });
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');
    const infoSpy = vi.spyOn(console, 'info');
    const debugSpy = vi.spyOn(console, 'debug');

    logger.error('Error message');
    logger.warn('Warning message');
    logger.info('Info message');
    logger.debug('Debug message');
    logger.verbose('Verbose message');

    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled(); // debug and verbose shouldn't log
  });

  it('should handle position updates', () => {
    const spy = vi.spyOn(console, 'info');
    
    logger.positionUpdate('BTC-USDT', '0.1', '100', {
      requestId: testRequestId,
      operation: 'position_update'
    });

    expect(spy).toHaveBeenCalled();
    const logEntry = JSON.parse(spy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'info',
      message: 'Position updated',
      metadata: {
        category: 'position',
        position: {
          symbol: 'BTC-USDT',
          size: '0.1',
          pnl: '100'
        }
      }
    });
  });

  it('should handle balance updates', () => {
    const spy = vi.spyOn(console, 'debug');
    
    logger.balanceUpdate('BTC', '0.1', {
      requestId: testRequestId,
      operation: 'balance_update'
    });

    expect(spy).toHaveBeenCalled();
    const logEntry = JSON.parse(spy.mock.calls[0][0]);
    expect(logEntry).toMatchObject({
      level: 'debug',
      message: 'Balance updated',
      metadata: {
        category: 'balance',
        balance: {
          currency: 'BTC',
          amount: '0.1'
        }
      }
    });
  });

  it('should handle log categories correctly', () => {
    const spy = vi.spyOn(console, 'info');
    
    // Test different categories
    logger.info('Trade executed', {
      requestId: testRequestId,
      operation: 'execute_trade',
      category: 'trade',
      symbol: 'BTC-USDT'
    });

    logger.info('Position updated', {
      requestId: testRequestId,
      operation: 'update_position',
      category: 'position',
      symbol: 'BTC-USDT'
    });

    logger.info('Balance changed', {
      requestId: testRequestId,
      operation: 'update_balance',
      category: 'balance',
      currency: 'BTC'
    });

    expect(spy).toHaveBeenCalledTimes(3);
    const logs = spy.mock.calls.map(call => JSON.parse(call[0]));
    
    expect(logs[0].metadata.category).toBe('trade');
    expect(logs[1].metadata.category).toBe('position');
    expect(logs[2].metadata.category).toBe('balance');
  });

  it('should include category in all log levels', () => {
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');
    const infoSpy = vi.spyOn(console, 'info');
    const debugSpy = vi.spyOn(console, 'debug');

    const metadata = {
      requestId: testRequestId,
      operation: 'test',
      category: 'system'
    };

    logger.error('Error message', null, metadata);
    logger.warn('Warning message', metadata);
    logger.info('Info message', metadata);
    logger.debug('Debug message', metadata);

    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();

    const errorLog = JSON.parse(errorSpy.mock.calls[0][0]);
    const warnLog = JSON.parse(warnSpy.mock.calls[0][0]);
    const infoLog = JSON.parse(infoSpy.mock.calls[0][0]);
    const debugLog = JSON.parse(debugSpy.mock.calls[0][0]);

    expect(errorLog.metadata.category).toBe('system');
    expect(warnLog.metadata.category).toBe('system');
    expect(infoLog.metadata.category).toBe('system');
    expect(debugLog.metadata.category).toBe('system');
  });
});
