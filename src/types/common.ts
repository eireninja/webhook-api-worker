/**
 * Common type definitions shared across the application
 */

export interface RequestMetadata {
  requestId: string;
  timestamp: string;
  source?: string;
}

export interface TradeResult {
  success: boolean;
  orderId?: string;
  symbol: string;
  side: string;
  quantity: string;
  price?: string;
  error?: Error;
  metadata?: RequestMetadata;
}

export interface AccountBalance {
  total: string;
  available: string;
  frozen: string;
  currency: string;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type MarginMode = 'cross' | 'isolated';
export type PositionSide = 'long' | 'short' | 'net';
