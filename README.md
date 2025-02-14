# OKX Trading Webhook API

A high-performance, secure webhook API built on Cloudflare Workers for executing trades on OKX. This service accepts webhook requests and executes trades across multiple OKX accounts simultaneously, supporting spot trading and perpetual futures trading.

## Table of Contents
- [Features](#features)
- [Architecture](#architecture)
- [Security](#security)
- [Trading Features](#trading-features)
- [Webhook Examples](#webhook-examples)
- [Request Flow](#request-flow)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Detailed API Reference](#detailed-api-reference)
- [Implementation Details](#implementation-details)
- [Deployment](#deployment)
- [Testing](#testing)
- [Security Considerations](#security-considerations)
- [Maintenance](#maintenance)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

## Features

- **Multi-Account Support**: Execute trades across multiple OKX accounts simultaneously
- **Trade Types**: Support for spot trading, and perpetual futures
- **Position Management**: Open and close positions with percentage-based sizing
- **Leverage Control**: Set custom leverage for perpetual futures trading
- **Market Orders**: Quick execution with market orders
- **Secure**: Built-in security features and API key management
- **Logging**: Comprehensive logging with Telegram notifications for real-time monitoring
- **Rate Limiting**: Smart handling of OKX API rate limits for parallel execution
- **Percentage-Based Trading**: Trade with exact percentages of your available balance

## Architecture

### Technology Stack
- **Runtime**: Cloudflare Workers (Edge Computing)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **Language**: JavaScript
- **Dependencies**: itty-router for routing
- **Notifications**: Telegram Bot API for real-time alerts

### Key Components
1. **Router**: Handles incoming HTTP requests
2. **Validator**: Validates webhook payloads
3. **Auth Manager**: Manages API key retrieval and signature generation
4. **Trade Executor**: Executes trades on OKX
5. **Logger**: Comprehensive logging system with Telegram integration
6. **Rate Limiter**: Smart handling of API rate limits

## Security

### API Key Management
- API keys are stored securely in Cloudflare D1 database
- Only the first 4 characters of API keys are logged for traceability
- Keys are retrieved fresh for each request

### Request Authentication
- HMAC-SHA256 signature generation for OKX API requests
- Secure handling of API secrets and passphrases
- All sensitive data is handled in memory only

## Trading Features

### Supported Trade Types
1. **Spot Trading**
   - Buy/Sell with USDT pairs
   - Percentage-based quantity support (e.g., "50%" uses half of available balance)
   - Market orders
   - Automatic balance calculation

2. **Perpetual Futures**
   - Inverse perpetuals (BTC-USD-SWAP)
   - USDT-margined perpetuals
   - Position opening and closing
   - Automatic position side management
   - Customizable leverage settings (1x to 125x depending on the pair)
   - Cross and isolated margin modes
   - Percentage-based position sizing

### Position Sizing
- Percentage-based sizing (e.g., "100%", "50%")
- Automatic maximum size calculation
- Balance-aware sizing for spot, and futures

### Rate Limit Management
- Smart chunking of multi-account trades
- Respects OKX's 1000 orders/2s sub-account limit
- Per-instrument rate limit compliance
- Parallel execution within limits

## Webhook Examples

### 1. Spot Trading

#### Buy 50% of Available Balance
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "marginMode": "cross",
    "side": "buy",
    "qty": "50%"
  }'
```

#### Sell 75% of Available Balance
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "marginMode": "cross",
    "side": "sell",
    "qty": "75%"
  }'
```

### 3. Perpetual Futures

#### Open Long Position with 10x Leverage Using 25% of Available Balance
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "side": "buy",
    "qty": "25%",
    "marginMode": "cross",
    "leverage": 10
  }'
```

#### Open Short Position with Isolated Margin
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "side": "sell",
    "qty": "50%",
    "marginMode": "isolated",
    "leverage": 5
  }'
```

#### Close Position
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "marginMode": "isolated",
    "closePosition": true
  }'
```

### Example Responses

#### Successful Trade
```json
{
  "message": "Successfully processed trades",
  "results": {
    "successful": [
      {
        "accountId": "abcd****",
        "status": "success",
        "ordId": "12345678",
        "clOrdId": "1b1564346dbaBCDE1707261846000",
        "tag": "1b1564346dbaBCDE"
      }
    ],
    "failed": []
  }
}
```

#### Failed Trade
```json
{
  "message": "Some trades failed",
  "results": {
    "successful": [],
    "failed": [
      {
        "accountId": "abcd****",
        "status": "rejected",
        "error": "Detailed error message"
      }
    ]
  }
}
```

## Request Flow

1. **Webhook Received**
   - Validate request payload
   - Authenticate request

2. **Trade Preparation**
   - Retrieve API keys
   - Set leverage if specified
   - Calculate position sizes

3. **Trade Execution**
   - Group trades by instrument
   - Execute in parallel within rate limits
   - Handle responses and errors

4. **Response**
   - Return results for all accounts
   - Include success/failure status
   - Masked account identifiers

## Error Handling

- **Rate Limits**: Smart retry with backoff
- **Invalid Parameters**: Clear error messages
- **Network Issues**: Proper error propagation
- **Account Issues**: Individual account failure handling

## Configuration

### Environment Variables
- `WEBHOOK_AUTH_TOKEN`: Authentication token for webhook requests
- `BROKER_TAG`: Broker identification tag for OKX orders
- `TELEGRAM_BOT_TOKEN`: Telegram bot token for notifications
- `TELEGRAM_CHANNEL_ID`: Target Telegram channel ID for notifications

### Telegram Notifications
The webhook API sends real-time notifications to Telegram for important events:

#### Notification Types
1. **Webhook Receipt**
```
📥 New Webhook
Time: HH:MM:SS
Request ID: xxx...
```

2. **Trade Execution**
```
📈 TRADE EXECUTION - BTC-USD-SWAP
Time: HH:MM:SS
Request ID: xxx...
Action: BUY
API Key: abcd...
Exchange: OKX
```

3. **Trade Success**
```
✅ TRADE SUCCESS - BTC-USD-SWAP
Time: HH:MM:SS
Request ID: xxx...
API Key: abcd...
Exchange: OKX
```

4. **Position Close**
```
📉 POSITION CLOSE - BTC-USD-SWAP
Time: HH:MM:SS
Request ID: xxx...
API Key: abcd...
Exchange: OKX
```

5. **Trade Errors**
```
❌ TRADE ERROR
Time: HH:MM:SS
Request ID: xxx...
API Key: abcd...
Error: Invalid order size
Exchange: OKX
```

#### Features
- Real-time trade monitoring
- Request ID tracking for debugging
- Masked API keys for security
- Clear status indicators with emojis
- Grouped notifications for multi-account trades

## Detailed API Reference

### Base URL
```
https://webhook.quantmarketintelligence.com/
```

### Endpoints

#### 1. Health Check
```http
GET /
```
Returns service health status and timestamp.

**Response**
```json
{
  "status": "healthy",
  "timestamp": "2025-02-09T18:09:01Z"
}
```

#### 2. Trade Execution
```http
POST /
Content-Type: application/json
```

**Request Format**
```json
{
  "authToken": string,      // Authentication token
  "symbol": string,         // Trading pair (e.g., "BTC-USDT" or "BTC-USD-SWAP")
  "type": string,           // "spot" or "perpetual"
  "marginMode": string,     // "cross" or "isolated"
  "side": string,           // Required for opening positions: "buy" or "sell"
  "qty": string,            // Required for opening positions: amount or percentage (e.g., "0.1" or "50%")
  "leverage": number,       // Optional: leverage for perpetual trades
  "closePosition": bool     // Optional: set to true to close position (perpetual only)
}
```

**Success Response**
```json
{
  "message": "Successfully processed trades",
  "results": {
    "successful": [
      {
        "accountId": "abcd****",
        "status": "success",
        "ordId": "12345678",
        "clOrdId": "1b1564346dbaBCDE1707261846000",
        "tag": "1b1564346dbaBCDE"
      }
    ],
    "failed": []
  }
}
```

**Error Response**
```json
{
  "message": "Some trades failed",
  "results": {
    "successful": [],
    "failed": [
      {
        "accountId": "abcd****",
        "status": "rejected",
        "error": "Detailed error message"
      }
    ]
  }
}
```

## Request Parameters

### Required Parameters
[Previous required parameters remain unchanged]

### Optional Parameters
- `side` (string): Trade side, "buy" or "sell" (required unless closing position)
- `qty` (string): Trade quantity, can be fixed amount or percentage (e.g., "0.1" or "50%")
- `closePosition` (boolean): Whether to close an existing position (perpetual only)
- `leverage` (number): Leverage multiplier for perpetual trades (e.g., 3 for 3x leverage)
- `marginMode` (string): Margin mode for leveraged trades, "cross" or "isolated" (default: "cross")

### Parameter Notes

1. **Quantity Specification**
   - Percentage Format: "X%" (e.g., "50%", "100%")
   - For spot trading:
     - Buy: Percentage of available quote currency (e.g., USDT)
     - Sell: Percentage of available base currency (e.g., BTC)
   - For perpetual:
     - Percentage of available margin balance
   - Maximum allowed: "100%"
   - Minimum: Greater than 0%

2. **Spot Trading**
   [Previous spot trading notes remain unchanged]

3. **Perpetual Trading**
   - Uses specified margin mode (cross/isolated)
   - Supports leverage settings from 1x to 125x (pair dependent)
   - Leverage must be set before trade execution
   - Supports position closing with `closePosition: true`
   - Automatically handles position sides (long/short)
   - Supports percentage-based quantities
   - Rounds quantities to contract lot sizes

## Security Considerations

### Authentication
All webhook requests must include an authentication token in the payload. This token must match the pre-shared token configured in the Cloudflare Worker.

Example of an authenticated request:
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{"authToken":"YOUR_AUTH_TOKEN","symbol":"BTC-USDT","type":"spot","side":"buy","qty":"100%","marginMode":"cross"}'
```

If the token is missing or invalid, the API will return a 401 Unauthorized response:
```json
{
  "status": "error",
  "message": "Unauthorized",
  "requestId": "unique-request-id"
}
```

### API Key Management
- API keys are stored securely in Cloudflare D1 database
- Only the first 4 characters of API keys are logged for traceability
- Keys are retrieved fresh for each request

## Implementation Details

### Order ID Generation
The system generates unique client order IDs (clOrdId) that follow OKX requirements:
- Starts with a letter
- Maximum 32 characters
- Contains only alphanumeric characters
- Unique across pending orders

Format: `<broker_tag><timestamp>`

### Position Side Handling
For perpetual futures:
1. **Inverse Futures (BTC-USD-SWAP)**
   - Opening: posSide = 'long' for buy, 'short' for sell
   - Closing: posSide matches current position

2. **USDT/USDC Futures**
   - Always uses posSide = 'net'

### Size Calculation
- Percentage quantities (e.g., "100%", "50%") are calculated based on:
  - Available balance for spot trades
  - Maximum position size for perpetual trades
- All sizes are automatically rounded to the instrument's lot size
- Zero or invalid sizes are rejected with appropriate error messages

## Maintenance

### Monitoring
1. **Key Metrics**
   - Request latency
   - Success/failure rates
   - Balance utilization
   - Position sizes

2. **Alerts**
   - Failed trade notifications
   - Balance threshold alerts
   - Error rate monitoring

### Troubleshooting
1. **Common Issues**
   - Invalid API key or secret
   - Network connectivity issues
   - Rate limit exceeded
   - Invalid request format
   - Insufficient balance

2. **Resolution Steps**
   - Check logs with request ID
   - Verify API key permissions
   - Confirm balance availability
   - Review rate limits

## Contributing

### Development Setup
1. Clone the repository
2. Install dependencies
3. Configure local environment
4. Run tests

## License

MIT License. See [LICENSE](LICENSE) for details.
