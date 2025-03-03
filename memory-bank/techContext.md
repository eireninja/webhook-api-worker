# Technical Context

## Technologies Used

### Core Technologies
- **JavaScript**: Primary programming language for the API logic
- **Cloudflare Workers**: Serverless computing platform for hosting the API
- **D1 Database**: Cloudflare's SQL database for storing API keys and configuration
- **Fetch API**: For making requests to the OKX trading API
- **Crypto API**: For cryptographic operations required by OKX authentication
- **itty-router**: Lightweight router for handling HTTP requests with middleware support

### Development Tools
- **Wrangler**: CLI tool for building and deploying Cloudflare Workers
- **npm**: Package manager for JavaScript dependencies
- **Git**: Version control system for code management
- **k6**: Open-source load testing tool used for stress testing the API
- **autocannon**: Node.js-based HTTP benchmarking tool for performance testing

## Development Setup

### Local Development
- Wrangler for local development and testing
- Environment variables for configuration settings
- Local testing using Wrangler's miniflare

### Deployment
- Deployment via Wrangler to Cloudflare Workers
- Environment variables configured in wrangler.toml and Cloudflare Workers dashboard

## Technical Constraints

### OKX API Limitations
- Rate limits: 
  - Trade endpoints: 60 requests per second with burst to 120
  - Account endpoints: 10 requests per second
  - Market data: 20 requests per second
- Authentication requirements: API key, secret key, and passphrase
- Timestamps must be within 30 seconds of server time
- Realistic error rates in simulation:
  - Trade endpoints: 5% error rate
  - Other endpoints: 2% error rate
- Realistic latency simulation:
  - Trade endpoints: 50-200ms
  - Other endpoints: 20-100ms

### Cloudflare Workers Limitations
- Execution time: Maximum of 30ms CPU time in free tier (50ms in paid)
- Memory: Limited to 128MB
- Environment variables: Maximum size and number restrictions

## Operation Tracking & Logging System

### Core Components
1. **Log Levels**:
   ```javascript
   const LOG_LEVEL = {
     ERROR: 'ERROR',
     INFO: 'INFO', 
     DEBUG: 'DEBUG',
     TRADE: 'TRADE',
     TRACE: 'TRACE',
     API: 'API'
   };
   ```

2. **Operation Tracking Functions**:
   - `startOperation`: Creates operation context with unique ID and timing
   - `endOperation`: Finalizes operation with timing and status
   - Operations support parent-child relationships for traceability

3. **Structured Logging**:
   - `createLog`: Core logging function with consistent formatting
   - Supports masking of sensitive information
   - Correlation through request IDs and operation IDs

### Implementation Details
- All operations start with a unique operation ID
- Child operations receive parent operation IDs
- Operations track execution time automatically
- All logging follows consistent JSON structure
- Security events logged with appropriate severity

### Diagnostic Capabilities
- Trace request flow through the entire system
- Identify performance bottlenecks
- Correlate related operations
- Track API request success/failure
- Monitor execution times

## Dependencies

### External Dependencies
- None listed in package.json (self-contained)

### Internal Dependencies
- itty-router: Lightweight router for handling HTTP requests and middleware
- Custom modules for logging, authentication, and trade execution

## Required Environment Variables
- `WEBHOOK_AUTH_TOKEN`: For webhook authentication
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID`: For logging notifications
- `BROKER_TAG_OKX`: For order tracking

## Security Considerations
- Universal IP validation middleware as the first line of defense for all routes and HTTP methods
- Whitelist of authorized TradingView IP addresses with 403 Forbidden responses for unauthorized IPs
- API keys stored securely in D1 database
- Authentication token required for webhook access
- Multi-layered security approach (IP validation middleware + token authentication)
- Comprehensive security event logging with detailed information about unauthorized access attempts
- Input validation for all incoming requests
- Error handling designed to prevent information leakage
- Rate limiting to prevent abuse
- Middleware-based security implementation ensures consistent validation across all endpoints
