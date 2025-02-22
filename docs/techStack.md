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
- Local development environment
- Webhook testing tools
- Manual integration testing
- Regular functionality verification

## Security

### Authentication
- Token-based webhook authentication
- HMAC signature validation
- API key encryption
- Account ID masking in logs

### Rate Limiting
- Basic implementation
- Future enhancement planned
- Per-account consideration

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

### Future Considerations
- WebSocket implementation
- Enhanced rate limiting
- Additional exchange support
- Advanced parallel execution
- Performance optimization
