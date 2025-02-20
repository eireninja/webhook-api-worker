# OKX Trading Webhook API

A high-performance, secure webhook API built on Cloudflare Workers for executing trades. This service accepts webhook requests and executes trades across multiple accounts simultaneously, supporting spot trading, USDT perpetual futures, and inverse perpetual futures trading.

## Features

- **Multi-Account Support**: Execute trades across multiple accounts simultaneously
- **Trade Types**: Support for spot trading, USDT perpetuals, and inverse perpetuals
- **Position Management**: Open and close positions with percentage-based sizing
- **Leverage Control**: Set custom leverage for perpetual futures trading
- **Market Orders**: Quick execution with market orders
- **Secure**: Built-in security features and API key management
- **Logging**: Comprehensive logging with Telegram notifications for real-time monitoring
- **Rate Limiting**: Smart handling of OKX API rate limits for parallel execution
- **Percentage-Based Trading**: Trade with exact percentages of your available balance

## Trade Types and Sizing

### 1. Spot Trading
- Base/Quote currency pairs (e.g., BTC-USDT)
- Percentage or absolute quantity
- Respects minimum lot sizes
- Automatic balance calculation
- Market orders only

### 2. USDT Perpetual Futures (USDT-SWAP)
- USDT-margined contracts
- Contract-based position sizing
- Cross and isolated margin modes
- Customizable leverage
- Position side management (long/short)
- Percentage-based sizing of available margin

### 3. Inverse Perpetual Futures (USD-SWAP)
- USD-margined contracts (e.g., BTC-USD-SWAP)
- Fixed contract sizes ($100 for BTC-USD-SWAP)
- Cross and isolated margin modes
- Customizable leverage
- Position side management (long/short)
- Percentage-based sizing of available margin

## Position Sizing Logic

### Spot Trading
- Lot size in base currency (e.g., 0.00001 BTC)
- Uses `/api/v5/account/max-avail-size` endpoint
- Supports both base and quote currency targets

### USDT Perpetuals
- Contract-based lot sizes
- Uses `/api/v5/account/max-size` endpoint
- Size returned in contracts

### Inverse Perpetuals
- Fixed contract sizes ($100 USD for BTC-USD-SWAP)
- Uses `/api/v5/account/max-size` endpoint
- Size returned directly in contracts

## Webhook Examples

### 1. Spot Trading
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "50%"
  }'
```

### 2. USDT Perpetual
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT-SWAP",
    "type": "perps",
    "side": "buy",
    "qty": "75%",
    "marginMode": "cross",
    "leverage": "10"
  }'
```

### 3. Inverse Perpetual
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "invperps",
    "qty": "100%",
    "side": "buy",
    "marginMode": "cross",
    "leverage": "1"
  }'
```

## Required Parameters

| Parameter    | Description                                           | Required |
|-------------|-------------------------------------------------------|----------|
| authToken   | Authentication token for webhook                       | Yes      |
| symbol      | Trading pair (e.g., BTC-USDT, BTC-USD-SWAP)          | Yes      |
| type        | Trade type: "spot", "perps", or "invperps"           | Yes      |
| qty         | Quantity as percentage ("50%") or absolute value      | Yes*     |
| side        | Trade side: "buy" or "sell"                          | Yes**    |
| marginMode  | For futures: "cross" or "isolated"                    | Yes***   |
| leverage    | For futures: leverage value ("1" to "125")           | Yes***   |

\* Not required if closePosition=true
\** Not required if closePosition=true
\*** Only required for perpetual futures trades

## Error Handling

The API implements thorough error handling with detailed logging:

1. **Input Validation**
   - Parameter validation
   - Symbol format checking
   - Quantity validation
   - Leverage limits

2. **Trading Errors**
   - Insufficient balance
   - Invalid lot sizes
   - Position size limits
   - Leverage restrictions

3. **API Errors**
   - Rate limits
   - Authentication issues
   - Network errors

All errors are logged and sent via Telegram notifications if configured.

## Environment Variables

Required environment variables:

1. **Authentication**
   - `WEBHOOK_AUTH_TOKEN`: For webhook authentication

2. **Telegram Logging**
   - `TELEGRAM_BOT_TOKEN`: Telegram bot token
   - `TELEGRAM_CHANNEL_ID`: Channel for notifications

3. **Broker Tags**
   - `BROKER_TAG_OKX`: OKX broker tag for order tracking

## Implementation Details

### Position Size Calculation

1. **Spot Trading**
   - Gets max available size in base/quote currency
   - Rounds to instrument's lot size
   - Validates against minimum trade size

2. **USDT Perpetuals**
   - Gets max contracts available
   - Applies leverage
   - Rounds to contract lot size

3. **Inverse Perpetuals**
   - Gets max contracts directly from API
   - No additional conversion needed
   - Validates against minimum contract size

### Order Generation

All orders are market orders with:
- Unique client order IDs (clOrdId)
- Broker tags for tracking
- Position side management for futures
- Automatic lot size rounding
