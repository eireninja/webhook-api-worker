# System Patterns

## System Architecture

### Overview
The OKX Trading Webhook API employs a serverless architecture built on Cloudflare Workers, providing a lightweight, scalable solution for handling webhook requests and executing trades.

### Core Components
1. **API Router**: Handles incoming HTTP requests and routes them to appropriate handlers
2. **Security Layer**: Multi-layered security with IP validation and token-based authentication
3. **Validation Module**: Ensures payload correctness and prevents malformed requests
4. **Trade Execution Engine**: Processes trade requests and communicates with OKX API
5. **Database Interface**: Retrieves API keys and credentials from D1 database
6. **Logging System**: Records detailed information about requests, security events, and execution status
7. **Notification Service**: Sends alerts and trade information to Telegram

## Key Technical Decisions

### Serverless Architecture
- **Decision**: Use Cloudflare Workers for hosting the API
- **Rationale**: Provides low latency, global distribution, and simplified scaling without server management

### Multi-Layered Security
- **Decision**: Implement defense-in-depth with IP validation and token-based authentication
- **Rationale**: Provides multiple security barriers to protect against unauthorized access

### Token-Based Authentication
- **Decision**: Implement simple token-based authentication for webhooks
- **Rationale**: Balances security requirements with the simplicity needed for integration with various systems

### IP-Based Validation
- **Decision**: Restrict access to known TradingView IP addresses
- **Rationale**: Prevents unauthorized access attempts from unknown sources

### Multi-Account Support
- **Decision**: Design for executing trades across multiple accounts simultaneously
- **Rationale**: Enables portfolio-wide strategy implementation and risk distribution

### Asynchronous Processing
- **Decision**: Use asynchronous JavaScript for handling concurrent operations
- **Rationale**: Improves performance by allowing parallel processing of multi-account trades

## Design Patterns

### Factory Pattern
- Used for generating appropriate trade order types based on the payload configuration

### Strategy Pattern
- Implements different trading strategies (spot, futures) with a consistent interface

### Retry Pattern
- Implements automatic retries with exponential backoff for resilient API communication

### Adapter Pattern
- Normalizes different account credential formats to a consistent interface

### Defense-in-Depth Pattern
- Implements multiple layers of security that operate independently

## Component Relationships

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Webhook Client │──────▶  API Router     │──────▶ IP Validation   │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                 │                          │
                                 ▼                          ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  OKX API        │◀─────▶ Trade Execution │◀─────▶ Authentication  │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                 │                          │
                                 ▼                          ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Telegram API   │◀─────▶ Notification    │◀─────▶ Logging         │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                 │
                                 ▼
                         ┌─────────────────┐
                         │ Database (D1)   │
                         └─────────────────┘
```

## Security Architecture

### Multi-Layered Security Approach
1. **IP Validation (Outer Layer)**
   - Validates client IP against TradingView IP whitelist
   - Rejects unauthorized IPs with 403 Forbidden response
   - Logs security events for monitoring

2. **Token Authentication (Inner Layer)**
   - Validates webhook authentication token
   - Uses constant-time comparison to prevent timing attacks
   - Returns 401 Unauthorized for invalid tokens

3. **Payload Validation**
   - Validates structure and content of webhook payload
   - Prevents processing of malformed requests
   - Returns 400 Bad Request with specific error details

4. **Rate Limiting**
   - OKX-compliant implementation (Trade: 60 req/s, Account: 10 req/s, Market Data: 20 req/s)
   - Per-account tracking
   - Burst limit support
   - Retry-after header
   - Protection against brute force attacks

## Error Handling Strategy

1. **Security Errors**:
   - IP Validation: Return 403 Forbidden with minimal information
   - Authentication Errors: Return 401 Unauthorized with minimal information

2. **Validation Errors**: Return 400 Bad Request with detailed error message
3. **Database Errors**: Log detailed error internally, return generic message to client
4. **OKX API Errors**: Implement retries, then log detailed error and notify via Telegram
5. **Unexpected Errors**: Catch all exceptions, log details, return 500 Internal Server Error
6. **Rate Limit Errors**: Return 429 Too Many Requests with Retry-After header

## Rate Limiting Implementation

- Complies with OKX API limits:
  - Trade endpoints: 60 requests per second with burst to 120
  - Account endpoints: 10 requests per second
  - Market data: 20 requests per second
- Implements request tracking to avoid exceeding limits
- Uses sequential processing for multi-account trades to control request rate
- Adds burst limit support with proper tracking
- Includes Retry-After headers for rate limit responses
