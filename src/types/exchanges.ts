import { AccountBalance, OrderSide, OrderType, MarginMode, PositionSide, TradeResult } from './common';

export interface Order {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  price?: string;
  leverage?: number;
  marginMode?: MarginMode;
  positionSide?: PositionSide;
}

export interface Position {
  symbol: string;
  side: PositionSide;
  size: string;
  entryPrice: string;
  markPrice: string;
  leverage: number;
  marginMode: MarginMode;
  unrealizedPnl: string;
}

export interface ExchangeConfig {
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  testnet?: boolean;
}

export interface ExchangeCredentials {
  exchange: string;
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  label?: string;
}

export interface ExchangeAdapter {
  placeOrder(order: Order): Promise<TradeResult>;
  getPosition(symbol: string): Promise<Position>;
  getBalance(currency: string): Promise<AccountBalance>;
  cancelOrder(orderId: string, symbol: string): Promise<boolean>;
  cancelAllOrders(symbol?: string): Promise<boolean>;
}
