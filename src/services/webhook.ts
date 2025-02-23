import { Env } from '../types/env';
import { Logger, LogCategory } from '../utils/logger';
import { TelegramService } from './telegram';
import { DatabaseService } from './database';
import { ExchangeFactory } from '../exchanges';
import { Order } from '../types/exchanges';

export interface WebhookPayload {
  authToken?: string;
  exchange: string;
  symbol: string;
  type: 'spot' | 'perps' | 'invperps';
  marginMode?: 'cross' | 'isolated';
  leverage?: number;
  side?: 'buy' | 'sell';
  qty?: string;
  closePosition?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  payload: WebhookPayload | null;
}

export function validateWebhookPayload(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      errors: ['Invalid payload: expected an object'],
      payload: null
    };
  }

  const input = data as Record<string, unknown>;
  const payload: Partial<WebhookPayload> = {};

  // Required fields
  if (!input.symbol || typeof input.symbol !== 'string') {
    errors.push('Symbol is required');
  } else {
    payload.symbol = input.symbol;
  }

  if (!input.type || typeof input.type !== 'string') {
    errors.push('Type is required');
  } else {
    const type = input.type.toLowerCase();
    if (!['spot', 'perps', 'invperps'].includes(type)) {
      errors.push('Invalid type. Must be spot, perps, or invperps');
    } else {
      payload.type = type as WebhookPayload['type'];

      // Validate symbol format based on type
      switch (type) {
        case 'invperps':
          if (!payload.symbol?.endsWith('-USD-SWAP')) {
            errors.push('Inverse perpetual symbols must end with -USD-SWAP');
          }
          if (!input.leverage) {
            errors.push('Leverage is required for perpetual futures');
          }
          break;
        case 'perps':
          if (!payload.symbol?.endsWith('-USDT-SWAP') && !payload.symbol?.endsWith('-USDC-SWAP')) {
            errors.push('USDT/USDC perpetual symbols must end with -USDT-SWAP or -USDC-SWAP');
          }
          if (!input.leverage) {
            errors.push('Leverage is required for perpetual futures');
          }
          break;
        case 'spot':
          if (!payload.symbol?.endsWith('-USDT')) {
            errors.push('Spot symbols must end with -USDT');
          }
          break;
      }
    }
  }

  if (!input.exchange || typeof input.exchange !== 'string') {
    errors.push('Exchange is required');
  } else {
    const exchange = input.exchange.toLowerCase();
    if (!['okx', 'bybit'].includes(exchange)) {
      errors.push('Invalid exchange. Must be okx or bybit');
    } else {
      payload.exchange = exchange;
    }
  }

  // Optional fields with validation
  if (input.marginMode !== undefined) {
    if (typeof input.marginMode !== 'string') {
      errors.push('marginMode must be a string');
    } else {
      const marginMode = input.marginMode.toLowerCase();
      if (!['cross', 'isolated'].includes(marginMode)) {
        errors.push('Invalid margin mode. Must be cross or isolated');
      } else {
        payload.marginMode = marginMode as 'cross' | 'isolated';
      }
    }
  }

  if (input.leverage !== undefined) {
    if (typeof input.leverage !== 'number' || input.leverage <= 0) {
      errors.push('leverage must be a positive number');
    } else {
      payload.leverage = input.leverage;
    }
  }

  if (input.closePosition !== undefined) {
    if (typeof input.closePosition !== 'boolean') {
      errors.push('closePosition must be a boolean');
    } else {
      payload.closePosition = input.closePosition;
    }
  }

  // Side validation
  if (!input.closePosition) {
    if (!input.side) {
      errors.push('Side is required for entry orders');
    } else if (typeof input.side === 'string') {
      const side = input.side.toLowerCase();
      if (!['buy', 'sell'].includes(side)) {
        errors.push('Invalid side. Must be buy or sell');
      } else {
        payload.side = side as 'buy' | 'sell';
      }
    } else {
      errors.push('side must be a string');
    }
  }

  // Quantity validation
  if (input.qty !== undefined) {
    if (typeof input.qty !== 'string') {
      errors.push('qty must be a string');
    } else {
      if (input.qty.includes('%')) {
        const percentage = parseFloat(input.qty);
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
          errors.push('Invalid percentage. Must be between 0 and 100');
        } else {
          payload.qty = input.qty;
        }
      } else {
        const quantity = parseFloat(input.qty);
        if (isNaN(quantity) || quantity <= 0) {
          errors.push('Invalid quantity. Must be a positive number');
        } else {
          payload.qty = input.qty;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, payload: null };
  }

  // At this point, we know we have all required fields and they're valid
  return {
    valid: true,
    errors: [],
    payload: payload as WebhookPayload // Safe because we've validated all required fields
  };
}

export class WebhookHandler {
  private database: DatabaseService;

  constructor(
    private env: Env,
    private logger: Logger,
    private telegram: TelegramService
  ) {
    this.database = new DatabaseService(env.DB, logger);
  }

  async handle(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    let payload: WebhookPayload | null = null;

    try {
      // Parse payload first to check for authToken
      const rawPayload = await request.json() as Record<string, unknown>;
      this.logger.debug('Received webhook payload', {
        requestId,
        operation: 'webhook_received',
        category: 'system' as LogCategory,
        hasAuthToken: typeof rawPayload.authToken === 'string'
      });

      // Check auth token from header or payload
      const headerToken = request.headers.get('Authorization')?.replace('Bearer ', '');
      const payloadToken = typeof rawPayload.authToken === 'string' ? rawPayload.authToken : undefined;
      const token = headerToken || payloadToken;

      if (!token) {
        throw new Error('Missing authorization token');
      }

      if (token !== this.env.WEBHOOK_AUTH_TOKEN) {
        throw new Error('Invalid authorization token');
      }

      // Validate payload
      const validationResult = validateWebhookPayload(rawPayload);
      if (!validationResult.valid || !validationResult.payload) {
        throw new Error(`Invalid payload: ${validationResult.errors.join(', ')}`);
      }

      payload = validationResult.payload;

      // Get API keys for the exchange
      const apiKeys = await this.database.getApiKeys(payload.exchange, requestId);
      if (apiKeys.length === 0) {
        throw new Error(`No API keys found for exchange: ${payload.exchange}`);
      }

      this.logger.info('Processing webhook', {
        requestId,
        operation: 'process_webhook',
        category: 'trade' as LogCategory,
        symbol: payload.symbol,
        type: payload.type,
        side: payload.side
      });

      // Process order for each API key
      for (const apiKey of apiKeys) {
        const exchange = ExchangeFactory.create(
          payload.exchange,
          {
            apiKey: apiKey.apiKey,
            secretKey: apiKey.secretKey,
            passphrase: apiKey.passphrase
          },
          this.logger
        );

        const order: Order = {
          symbol: payload.symbol,
          // For close position, we need to determine the side based on current position
          // For now, we'll use 'sell' as default for closing
          side: payload.closePosition ? 'sell' : (payload.side || 'buy'),
          // Convert type to OrderType
          type: 'market', // We'll use market orders for now
          quantity: payload.qty || '0',
          leverage: payload.leverage,
          marginMode: payload.marginMode
        };

        await exchange.placeOrder(order);
      }

      // Send success notification
      await this.telegram.sendMessage({
        type: 'INFO',
        symbol: payload.symbol,
        side: payload.side,
        requestId,
        message: `Successfully placed ${payload.type} order for ${payload.symbol}`,
        totalAccounts: apiKeys.length
      });

      // Return success response
      return new Response(JSON.stringify({
        success: true,
        requestId,
        message: 'Webhook processed successfully'
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });

    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown webhook error');
      this.logger.error('Webhook processing failed', err, {
        requestId,
        operation: 'process_webhook',
        category: 'system' as LogCategory,
        symbol: payload?.symbol,
        type: payload?.type,
        side: payload?.side,
        error: err.message
      });

      // Notify about the error
      if (payload) {
        await this.telegram.sendMessage({
          type: 'ERROR',
          symbol: payload.symbol,
          side: payload.side,
          requestId,
          message: `Error: ${err.message}`
        }).catch(err => {
          this.logger.error('Failed to send error notification', err as Error, { 
            requestId,
            operation: 'send_notification',
            category: 'system' as LogCategory,
            error: err.message 
          });
        });
      }

      // Return error response
      return new Response(JSON.stringify({
        success: false,
        requestId,
        error: err.message
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  }
}
