import { Logger, LogCategory } from '../utils/logger';

interface TelegramConfig {
  botToken: string;
  channelId: string;
}

interface TelegramMessage {
  type: 'INFO' | 'ERROR' | 'WARN';
  symbol: string;
  side?: 'buy' | 'sell';
  requestId: string;
  message?: string;
  error?: string;
  totalAccounts?: number;
}

export class TelegramService {
  private baseUrl: string;

  constructor(
    private config: TelegramConfig,
    private logger: Logger
  ) {
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  async sendMessage(msg: TelegramMessage): Promise<void> {
    try {
      const text = this.formatMessage(msg);
      const url = `${this.baseUrl}/sendMessage`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: this.config.channelId,
          text,
          parse_mode: 'HTML'
        })
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
      }

      this.logger.debug('Sent Telegram message', {
        operation: 'send_telegram',
        category: 'system' as LogCategory,
        type: msg.type,
        symbol: msg.symbol,
        requestId: msg.requestId
      });

    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error sending telegram message');
      this.logger.error('Failed to send Telegram message', err, {
        operation: 'send_telegram',
        category: 'system' as LogCategory,
        type: msg.type,
        symbol: msg.symbol,
        requestId: msg.requestId,
        error: err.message
      });
      throw err;
    }
  }

  private formatMessage(msg: TelegramMessage): string {
    const emoji = this.getEmoji(msg.type);
    const header = `${emoji} <b>${msg.type}</b> | ${msg.symbol}`;
    
    if (msg.type === 'ERROR') {
      return `${header}\n\n❌ Error: ${msg.error}\n🔍 Request ID: ${msg.requestId}`;
    }

    const accounts = msg.totalAccounts ? `\n👥 Accounts: ${msg.totalAccounts}` : '';
    const side = msg.side ? `\n📊 Side: ${msg.side.toUpperCase()}` : '';
    
    return `${header}\n\n✅ ${msg.message}${side}${accounts}\n🔍 Request ID: ${msg.requestId}`;
  }

  private getEmoji(type: TelegramMessage['type']): string {
    switch (type) {
      case 'INFO':
        return '📢';
      case 'ERROR':
        return '🚨';
      case 'WARN':
        return '⚠️';
      default:
        return '💬';
    }
  }
}
