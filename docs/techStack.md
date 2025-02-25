# Technology Stack

## Core Infrastructure

### Serverless Platform
- **Cloudflare Workers**
  - Runtime: V8 JavaScript engine
  - Edge deployment for low latency
  - Workers KV for data storage
  - Efficient request handling

### Build System
- **Webpack** (v5.98.0)
  - Production mode optimization
  - Minimal configuration
  - Known Issues:
    - Async/await compatibility needs configuration
    - Module parsing for async functions
  - Required Updates:
    - Add appropriate loader for async/await
    - Configure mode explicitly
    - Fix module parsing issues
- **Wrangler** (v3.107.3)
  - Cloudflare Workers CLI tool
  - Local development support
  - Production deployment management

## Database & Storage

### D1 Database
- Used for API key storage
- SQL-based queries
- Integrated with Cloudflare Workers
- Secure credential storage

### KV Storage
- AUTH_STORAGE_PROD namespace
- Used for authentication tokens
- Fast, edge-replicated storage
- Efficient token validation

## External APIs

### OKX Trading API
- REST API integration
- WebSocket support (future consideration)
- Multiple instrument types support:
  - Spot trading
  - Regular perpetual futures
  - Inverse perpetual futures
- Individual order execution
- Proper error handling
- Rate Limits:
  - Trade: 60 req/s (burst to 120)
  - Account: 10 req/s
  - Market Data: 20 req/s

### Telegram Integration
- Webhook-based notifications
- Error reporting
- Trade execution updates
- Clean message formatting
- Account ID masking
- Non-redundant notifications

## Development Tools

### Version Control
- Git for source control
- GitHub for repository hosting

### Testing
- Mock server for API simulation
- OKX-like rate limiting
- Realistic error rates:
  - Trade endpoints: 5%
  - Other endpoints: 2%
- Realistic latencies:
  - Trade: 50-200ms
  - Other: 20-100ms

## Security

### Authentication
- Token-based webhook authentication
- HMAC signature validation
- API key encryption
- Account ID masking in logs

### Rate Limiting
- OKX-compliant implementation
- Per-account tracking
- Burst limit support
- Retry-after header

## Architectural Decisions

### Why Cloudflare Workers?
- Global edge deployment
- Low latency execution
- Built-in KV and D1 database support
- Cost-effective scaling
- Efficient request handling

### Why Individual Order Execution?
- Better error tracking
- Cleaner logging
- Improved accountability
- More reliable execution
- Easier debugging
