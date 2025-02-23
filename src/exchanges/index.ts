import { Logger } from '../utils/logger';
import { ExchangeAdapter, ExchangeConfig } from '../types/exchanges';

// Temporary mock exchange adapter for testing core infrastructure
class MockExchange implements ExchangeAdapter {
  constructor(
    private config: ExchangeConfig,
    private logger: Logger
  ) {}

  async placeOrder(order: any): Promise<any> {
    this.logger.debug('Mock exchange: place order', { order });
    return { success: true, orderId: 'mock-order-id' };
  }

  async getPosition(symbol: string): Promise<any> {
    this.logger.debug('Mock exchange: get position', { symbol });
    return { symbol, size: '0', side: 'net' };
  }

  async getBalance(currency: string): Promise<any> {
    this.logger.debug('Mock exchange: get balance', { currency });
    return { total: '0', available: '0', frozen: '0', currency };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    this.logger.debug('Mock exchange: cancel order', { orderId, symbol });
    return true;
  }

  async cancelAllOrders(symbol?: string): Promise<boolean> {
    this.logger.debug('Mock exchange: cancel all orders', { symbol });
    return true;
  }
}

export class ExchangeFactory {
  static create(
    exchange: string,
    config: ExchangeConfig,
    logger: Logger
  ): ExchangeAdapter {
    // For now, return mock exchange for testing
    logger.debug('Creating mock exchange adapter', {
      operation: 'create_exchange',
      exchange
    });
    return new MockExchange(config, logger);
  }
}
