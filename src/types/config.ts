/**
 * Configuration type definitions
 */

export interface BaseExchangeConfig {
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  testnet?: boolean;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';
export type LogFormat = 'json' | 'text';
export type LogCategory = 'trade' | 'position' | 'balance' | 'system' | 'security';

export interface LogConfig {
  level: LogLevel;
  format?: LogFormat;
  maskSensitiveData?: boolean;
}

export interface TelegramConfig {
  botToken: string;
  channelId: string;
}

export interface WebhookConfig {
  authToken: string;
}

export interface GlobalConfig {
  log: LogConfig;
  telegram: TelegramConfig;
  webhook: WebhookConfig;
}
