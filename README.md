# OKX Trading Webhook API

A high-performance, secure webhook API built on Cloudflare Workers for executing trades on OKX. This service accepts webhook requests and executes trades across multiple OKX accounts simultaneously, supporting both spot and perpetual futures trading.

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
- **Trade Types**: Support for spot trading and perpetual futures
- **Position Management**: Open and close positions with percentage-based sizing
- **Market Orders**: Quick execution with market orders
- **Secure**: Built-in security features and API key management
- **Logging**: Comprehensive logging for debugging and auditing

## Architecture

### Technology Stack
- **Runtime**: Cloudflare Workers (Edge Computing)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **Language**: JavaScript
- **Dependencies**: itty-router for routing

### Key Components
1. **Router**: Handles incoming HTTP requests
2. **Validator**: Validates webhook payloads
3. **Auth Manager**: Manages API key retrieval and signature generation
4. **Trade Executor**: Executes trades on OKX
5. **Logger**: Comprehensive logging system

## Security

### API Key Management
- API keys are stored securely in Cloudflare D1 database
- Only the first 4 characters of API keys are logged for traceability
- Keys are retrieved fresh for each request
- Support for multiple API keys with different permissions

### Request Authentication
- HMAC-SHA256 signature generation for OKX API requests
- Secure handling of API secrets and passphrases
- All sensitive data is handled in memory only

## Trading Features

### Supported Trade Types
1. **Spot Trading**
   - Buy/Sell with USDT pairs
   - Percentage-based quantity support
   - Market orders

2. **Perpetual Futures**
   - Inverse perpetuals (BTC-USD-SWAP)
   - USDT-margined perpetuals
   - Position opening and closing
   - Automatic position side management

### Position Sizing
- Percentage-based sizing (e.g., "100%", "50%")
- Automatic maximum size calculation
- Balance-aware sizing for both spot and futures

## Webhook Examples

### 1. Spot Trading

#### Buy Spot (Minimal)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "100%",
    "marginMode": "cross"
  }'
```

#### Sell Spot (Minimal)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "sell",
    "qty": "100%",
    "marginMode": "cross"
  }'
```

#### Buy Spot (Fixed Amount)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "0.1",
    "marginMode": "cross"
  }'
```

### 2. Perpetual Futures

#### Open Long Position (Minimal)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "side": "buy",
    "qty": "100%",
    "marginMode": "cross"
  }'
```

#### Open Short Position
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "side": "sell",
    "qty": "50%",
    "marginMode": "cross"
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
    "marginMode": "cross",
    "closePosition": true
  }'
```

#### Close Position (Partial)
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "marginMode": "cross",
    "closePosition": true,
    "qty": "50%"
  }'
```

### Example Responses

#### Successful Trade
```json
{
  "message": "Successfully processed 1 trade",
  "results": [
    {
      "status": "success",
      "ordId": "12345678",
      "clOrdId": "1b1564346dbaBCDE1707261846000",
      "tag": "1b1564346dbaBCDE"
    }
  ]
}
```

#### Failed Trade
```json
{
  "message": "Processed 0 successful and 1 failed trades",
  "results": [
    {
      "status": "rejected",
      "error": "Error message here"
    }
  ]
}
```

### Testing Examples

#### Local Testing
```bash
# Test spot buy
curl -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "0.001",
    "marginMode": "cross"
  }'

# Test perpetual close
curl -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USD-SWAP",
    "type": "perpetual",
    "marginMode": "cross",
    "closePosition": true
  }'
```

### Using with Other Tools

#### Python Example
```python
import requests
import json

url = "https://webhook.quantmarketintelligence.com/"
headers = {"Content-Type": "application/json"}
payload = {
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "100%",
    "marginMode": "cross"
}

response = requests.post(url, headers=headers, json=payload)
print(json.dumps(response.json(), indent=2))
```

#### Node.js Example
```javascript
const fetch = require('node-fetch');

const url = 'https://webhook.quantmarketintelligence.com/';
const payload = {
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "100%",
    "marginMode": "cross"
};

fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
})
.then(res => res.json())
.then(json => console.log(JSON.stringify(json, null, 2)));
```

## Request Flow

1. **Request Reception**
   - Validates Content-Type and request method
   - Generates unique request ID

2. **Payload Validation**
   - Required fields:
     - `authToken`: Authentication token
     - `symbol`: Trading pair (e.g., "BTC-USDT" or "BTC-USD-SWAP")
     - `type`: Trade type ("spot" or "perpetual")
     - `marginMode`: Margin mode ("cross" or "isolated")
   - Conditional fields:
     - For opening positions:
       - `side`: Trade direction ("buy" or "sell")
       - `qty`: Order size (number or percentage)
     - For closing positions:
       - `closePosition`: Set to true

3. **Trade Processing**
   - Retrieves API keys from database
   - Calculates order size based on available balance
   - Determines correct position side for futures
   - Executes trades in parallel across all accounts

4. **Response Generation**
   - Returns success/failure count
   - Includes detailed error messages if any
   - Provides trade execution details

## Request Parameters

### Required Parameters
- `authToken` (string): Your authentication token for the webhook API
- `symbol` (string): Trading pair (e.g., "BTC-USDT" for spot, "BTC-USD-SWAP" for perpetual)
- `type` (string): Trade type, either "spot" or "perpetual"
- `marginMode` (string): Margin mode, "cross" or "isolated"

### Optional Parameters
- `side` (string): Trade side, "buy" or "sell" (required unless closing position)
- `qty` (string): Trade quantity, can be fixed amount or percentage (e.g., "0.1" or "100%")
- `closePosition` (boolean): Whether to close an existing position (perpetual only)

### Parameter Notes
1. **Spot Trading**
   - Uses cash mode by default
   - Supports percentage-based quantities
   - Automatically handles quote/base currency for buy/sell

2. **Perpetual Trading**
   - Uses cross margin by default
   - Supports position closing with `closePosition: true`
   - Automatically handles position sides (long/short)
   - Supports percentage-based quantities
   - Rounds quantities to contract lot sizes

### Size Calculation
- Percentage quantities (e.g., "100%", "50%") are calculated based on:
  - Available balance for spot trades
  - Maximum position size for perpetual trades
- All sizes are automatically rounded to the instrument's lot size
- Zero or invalid sizes are rejected with appropriate error messages

## Error Handling

### Common Errors

1. **Validation Errors**
   - Invalid symbol format
   - Missing required fields
   - Invalid quantity format
   - Unsupported trade type

2. **Balance Errors**
   - Insufficient balance
   - Invalid position size
   - No position found (for closing)

3. **API Errors**
   - Rate limiting
   - Invalid API credentials
   - OKX API errors

### Error Response Format
```json
{
  "message": "Processed 0 successful and 1 failed trades",
  "results": [
    {
      "status": "rejected",
      "error": "Error message here"
    }
  ]
}
```

## Configuration

### Environment Variables
- `BROKER_TAG`: Tag for identifying trades
- Database credentials (managed by Cloudflare)
- Debug mode flag

### Database Schema
```sql
CREATE TABLE api_keys (
  api_key TEXT PRIMARY KEY,
  secret_key TEXT NOT NULL,
  passphrase TEXT NOT NULL,
  exchange TEXT NOT NULL,
  permissions TEXT NOT NULL
);
```

## Rate Limiting
- 60-second window
- Maximum 20 requests per window
- Implemented at the edge

## Best Practices

1. **Always verify your symbol format**
   - Spot: Must end with "-USDT"
   - Perpetual: Must end with "-USD-SWAP"

2. **Use percentage-based sizing**
   - More reliable than absolute sizes
   - Automatically adjusts to available balance
   - Use "100%" for maximum available

3. **Check API Responses**
   - Monitor the response status
   - Check for error messages
   - Verify trade execution details

4. **Monitor Logs**
   - Each request has a unique ID
   - Logs are categorized by component
   - Debug mode provides additional details

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
  "closePosition": bool     // Optional: set to true to close position (perpetual only)
}
```

**Success Response**
```json
{
  "message": "Successfully processed 1 trade",
  "results": [
    {
      "status": "success",
      "ordId": "12345678",
      "clOrdId": "1b1564346dbaBCDE1707261846000",
      "tag": "1b1564346dbaBCDE"
    }
  ]
}
```

**Error Response**
```json
{
  "message": "Processed 0 successful and 1 failed trades",
  "results": [
    {
      "status": "rejected",
      "error": "Detailed error message"
    }
  ]
}
```

## Security Considerations

### Authentication
All webhook requests must include an authentication token in the payload. This token must match the pre-shared token configured in the Cloudflare Worker.

Example of an authenticated request:
```bash
curl -X POST https://webhook.quantmarketintelligence.com/ \
  -H "Content-Type: application/json" \
  -d '{
    "authToken": "YOUR_AUTH_TOKEN",
    "symbol": "BTC-USDT",
    "type": "spot",
    "side": "buy",
    "qty": "100%",
    "marginMode": "cross"
  }'
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
- Support for multiple API keys with different permissions

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

## Deployment

### Prerequisites
1. **Cloudflare Account**
   - Workers subscription
   - D1 database access
   - API tokens with appropriate permissions

2. **Environment Setup**
   ```bash
   # Install Wrangler CLI
   npm install -g wrangler

   # Login to Cloudflare
   wrangler login
   ```

3. **Database Setup**
   ```sql
   -- Create API keys table
   CREATE TABLE api_keys (
     api_key TEXT PRIMARY KEY,
     secret_key TEXT NOT NULL,
     passphrase TEXT NOT NULL,
     exchange TEXT NOT NULL,
     permissions TEXT NOT NULL
   );
   ```

### Configuration
1. **wrangler.toml**
   ```toml
   name = "webhook-api"
   main = "src/index.js"
   compatibility_date = "2024-02-09"

   [vars]
   BROKER_TAG = "your_broker_tag"
   ```

2. **Environment Variables**
   ```bash
   # Set required secrets
   wrangler secret put BROKER_TAG
   ```

### Deployment Steps
```bash
# Deploy to Cloudflare
wrangler deploy

# Tail logs
wrangler tail
```

## Testing

### Local Testing
```bash
# Start local development server
wrangler dev

# Test health check
curl http://localhost:8787/

# Test trade execution
curl -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{"authToken":"YOUR_AUTH_TOKEN","symbol":"BTC-USDT","type":"spot","side":"buy","qty":"100%","marginMode":"cross"}'
```

### Production Testing
Always test with small amounts first:
1. Start with minimal spot trades
2. Test percentage-based sizing
3. Verify position management
4. Monitor execution times

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
   - Invalid API credentials
   - Insufficient balances
   - Rate limiting
   - Network timeouts

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
