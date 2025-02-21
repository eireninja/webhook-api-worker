# Technology Stack

## Core Infrastructure

### Serverless Platform
- **Cloudflare Workers**
  - Runtime: V8 JavaScript engine
  - Edge deployment for low latency
  - Workers KV for data storage

### Build System
- **Webpack** (v5.98.0)
  - Production mode optimization
  - Minimal configuration
- **Wrangler** (v3.107.3)
  - Cloudflare Workers CLI tool
  - Local development support
  - Production deployment management

## Database & Storage

### D1 Database
- Used for API key storage
- SQL-based queries
- Integrated with Cloudflare Workers

### KV Storage
- AUTH_STORAGE_PROD namespace
- Used for authentication tokens
- Fast, edge-replicated storage

## External APIs

### OKX Trading API
- REST API integration
- WebSocket support (future consideration)
- Multiple instrument types support:
  - Spot trading
  - Regular perpetual futures
  - Inverse perpetual futures

### Telegram Integration
- Webhook-based notifications
- Error reporting
- Trade execution updates

## Development Tools

### Version Control
- Git for source control
- GitHub for repository hosting

### Testing
- Local development environment
- Webhook testing tools
- Manual integration testing

## Security

### Authentication
- Token-based webhook authentication
- HMAC signature validation
- API key encryption

### Rate Limiting
- Basic implementation
- Future enhancement planned

## Architectural Decisions

### Why Cloudflare Workers?
- Global edge deployment
- Low latency execution
- Built-in KV and D1 database support
- Cost-effective scaling

### Why Webpack?
- Efficient bundling
- Tree shaking
- Modern JavaScript support
- Small output bundle size

### Future Considerations
- WebSocket implementation
- Enhanced rate limiting
- Additional exchange support
