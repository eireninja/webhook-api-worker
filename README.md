# Exchange API Wrapper Worker

A Cloudflare Worker that handles webhook requests for cryptocurrency trading operations.

## Features

- Webhook endpoint for trade execution
- Support for OKX and Bybit exchanges (Bybit coming soon)
- Telegram notifications for trade events
- Robust error handling and validation
- Secure authentication

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
# Login to Cloudflare
wrangler login

# Set secrets for production
wrangler secret put TELEGRAM_BOT_TOKEN --env production
wrangler secret put TELEGRAM_CHANNEL_ID --env production
wrangler secret put BROKER_TAG_OKX --env production
wrangler secret put WEBHOOK_AUTH_TOKEN --env production

# Set secrets for development (optional)
wrangler secret put TELEGRAM_BOT_TOKEN --env development
wrangler secret put TELEGRAM_CHANNEL_ID --env development
wrangler secret put BROKER_TAG_OKX --env development
wrangler secret put WEBHOOK_AUTH_TOKEN --env development
```

## Development

Start local development server:
```bash
npm start
```

Format code:
```bash
npm run format
```

Lint code:
```bash
npm run lint
```

## Deployment

Deploy to development:
```bash
npm run deploy
```

Deploy to production:
```bash
npm run deploy:production
```

## Webhook API

### POST /

Execute a trade operation.

#### Request Body

```typescript
{
  "symbol": string,          // Trading pair (e.g., "BTC-USDT")
  "type": string,           // "spot" | "perps" | "invperps"
  "exchange": string,       // "okx" | "bybit"
  "side": string,          // "buy" | "sell"
  "qty": string,           // Amount (can be percentage with %)
  "leverage"?: number,     // Required for perpetual futures
  "marginMode"?: string,   // "cross" | "isolated"
  "closePosition"?: boolean, // True to close position
  "authToken": string      // Authentication token
}
```

#### Response

Success:
```json
{
  "success": true,
  "message": "Webhook processed successfully",
  "data": {
    "requestId": "uuid",
    "timestamp": "ISO-8601"
  }
}
```

Error:
```json
{
  "success": false,
  "message": "Error processing webhook",
  "error": "Error details"
}
```
