# OKX Trading Webhook API

## Overview

The OKX Trading Webhook API is a high-performance, secure service built on Cloudflare Workers. It facilitates automated trading by processing webhook requests to execute trades across multiple accounts on the OKX exchange. The API supports spot trading, USDT perpetual futures, and inverse perpetual futures, with robust error handling, rate limiting, and logging capabilities.

## Features

- **Multi-Account Support**: Execute trades across multiple accounts simultaneously with per-account rate limiting.
- **Trade Types**: Supports spot trading, USDT/USDC perpetuals, and inverse perpetuals.
- **Position Management**: Open and close positions with percentage-based sizing.
- **Leverage Control**: Set custom leverage for perpetuals and inverse perpetuals futures trading.
- **Market Orders**: Quick execution with market orders.
- **Security**: Enhanced security features including IP-based validation, token-based authentication, input validation, and sensitive data masking.
- **Logging**: Comprehensive logging with Telegram notifications for real-time monitoring.
- **Rate Limiting**: OKX-compliant rate limits with burst support.
- **Percentage-Based Trading**: Trade with exact percentages of your available balance.

## Architecture

### Codebase Structure

- **JavaScript**: Main language used for the API logic and execution.
- **Python**: Utilized for additional scripting and integration tasks.
- **Cloudflare Workers**: Serverless environment for deploying the API.
- **Wrangler**: Tool for building and deploying Cloudflare Workers.

### Key Modules and Functions

- **Payload Validation**: Ensures that incoming webhook requests contain all necessary fields and adhere to expected formats.
- **Trade Execution**: Manages the logic for executing trades, including opening and closing positions for different trade types.
- **Request Generation**: Handles the creation of signed requests for the OKX API, ensuring secure communication.
- **Rate Limiting**: Implements OKX-compliant rate limits (60/s trade, 10/s account, 20/s market data).
- **Authentication**: Validates webhook requests using token-based authentication.
- **Error Handling**: Structured error responses with sanitized information to prevent data leakage.

### Configuration

- **wrangler.toml**: Defines environment-specific settings for production and development, including database and KV namespace bindings.
- **package.json**: Specifies dependencies and scripts for building, developing, and deploying the API.

## Webhook Flow

1. **Incoming Webhook Request**: Received from external systems, containing trade details such as symbol, type, quantity, and side.
2. **IP Validation**: Validates that the request originates from an authorized TradingView IP address.
3. **Authentication & Rate Check**: Validates authentication token and checks rate limits.
4. **Payload Validation**: Validates the request payload to ensure all required fields are present and correctly formatted.
5. **Order Processing**: Transforms the validated payload into orders for the OKX API, calculating order sizes based on available resources.
6. **Rate Limit Check**: Verifies endpoint-specific rate limits before execution.
7. **API Interaction**: Sends orders to OKX, handling responses and logging outcomes.
8. **Position Management**: Manages open and close operations for positions, ensuring accurate execution and reporting.

## Error Handling and Logging

- **Validation Errors**: Caught early in the process, with detailed messages logged and sent via Telegram if configured.
- **Trading Errors**: Includes checks for insufficient balance, invalid lot sizes, and leverage restrictions.
- **API Errors**: Handles rate limits (with retry-after), authentication issues, and network errors.
- **Rate Limit Errors**: Returns 429 status with retry-after header when limits exceeded.
- **Sensitive Data Masking**: All logs and error messages have sensitive data like account IDs and tokens masked.

### Key Security Implementations

- **IP-Based Validation**: Restricts webhook access to authorized TradingView IP addresses, rejecting unauthorized requests with a 403 Forbidden response.
- **Input Validation**: Comprehensive validation of all webhook payload fields with type checking and format validation.
- **Authentication**: Token-based authentication with proper error handling for authentication failures.
- **Data Protection**: Sensitive data masking in logs, notifications, and error messages.
- **Error Sanitization**: Structured error responses that avoid leaking sensitive information.
- **Rate Limiting**: Protection against brute force attacks with proper rate limiting.

## Security Architecture

The API implements a multi-layered security approach to protect against unauthorized access:

### 1. IP-Based Validation (Outer Layer)
- Validates that incoming requests originate from whitelisted TradingView IP addresses
- Rejects unauthorized IPs with a 403 Forbidden response before any payload processing
- Provides comprehensive logging for both successful and failed validation attempts

### 2. Token-Based Authentication (Inner Layer)
- Validates the authentication token included in the request payload
- Uses constant-time comparison to prevent timing attacks
- Returns a 401 Unauthorized response for invalid tokens

### 3. Payload Validation
- Validates the structure and content of the webhook payload
- Ensures all required fields are present and have valid values
- Prevents processing of malformed or potentially malicious payloads

### 4. Rate Limiting
- OKX-compliant implementation with specific limits
- Per-account tracking with burst limit support
- Returns 429 Too Many Requests with Retry-After header when limits are exceeded
- Protects against brute force attacks and API abuse

This multi-layered approach follows security best practices by implementing defense in depth, with each layer providing protection even if other layers are compromised.

## Rate Limiting

### OKX API Limits
- **Trade Endpoints**: 60 requests per second with burst up to 120
- **Account/Position**: 10 requests per second
- **Market Data**: 20 requests per second

### Implementation
- Per-account request tracking
- Burst limit support for trade endpoints
- Retry-after header on rate limit errors
- Clean error messages and logging
- Token bucket algorithm for efficient rate tracking

## Environment Variables

- **Authentication**: `WEBHOOK_AUTH_TOKEN` for webhook authentication.
- **Telegram Logging**: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` for notifications.
- **Broker Tags**: `BROKER_TAG_OKX` for order tracking.

## Conclusion

The OKX Trading Webhook API provides a robust, scalable solution for automated trading on the OKX platform. Its modular architecture, comprehensive error handling, and multi-account support make it an ideal choice for traders looking to automate their strategies efficiently. With enhanced security features and comprehensive rate limiting, the API ensures safe and reliable trading operations.

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
    "qty": "50%",
    "exchange": "okx"
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
    "leverage": "10",
    "exchange": "okx"
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
    "leverage": "1",
    "exchange": "okx"
  }'
```

## Close Position Examples

### 1. Inverse Perpetual Close (BTC-USD-SWAP)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "invperps",
    "marginMode": "isolated",
    "closePosition": true,
    "exchange": "okx",
    "leverage": "1"
  }'
```

### 2. USDT Perpetual Close (ETH-USDT-SWAP)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "ETH-USDT-SWAP",
    "type": "perps",
    "marginMode": "cross",
    "closePosition": true,
    "exchange": "okx",
    "leverage": "1"
  }'
```

### 3. Spot Sell (BTC-USDT)
```bash
curl -X POST "https://webhook.quantmarketintelligence.com/" \
-H "Content-Type: application/json" \
-d '{
  "authToken": "YOUR_AUTH_TOKEN",
  "type": "spot",
  "marginMode": "cross",
  "symbol": "BTC-USDT",
  "exchange": "okx",
  "side": "sell",
  "qty": "100%"
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
| exchange    | Exchange name (e.g., "okx")                           | Yes      |

\* Not required if closePosition=true
\** Not required if closePosition=true
\*** Only required for perpetual futures trades
