# Product Context

## Why This Project Exists

The OKX Trading Webhook API was created to address the need for automated trade execution on the OKX cryptocurrency exchange. It serves as a bridge between trading signal sources (such as TradingView alerts, trading bots, or custom algorithms) and the OKX exchange, enabling automated execution of trading strategies without requiring direct integration between signal sources and the exchange.

Key motivations for the project include:

1. **Automation Gap**: Many trading signal providers don't offer direct integration with OKX
2. **Multi-Account Management**: Need to execute the same trades across multiple accounts simultaneously
3. **Customization**: Requirement for specialized trade parameters not available in off-the-shelf solutions
4. **Security**: Need for a secure, reliable execution layer that protects API credentials

## Problems It Solves

### For Traders and Trading Systems

1. **Signal Execution**: Automatically executes trading signals from any system capable of sending webhook requests
2. **Account Management**: Enables trade execution across multiple accounts with a single request
3. **Position Management**: Simplifies complex position sizing and leverage management
4. **Market Access**: Provides programmatic access to OKX markets without requiring deep API knowledge
5. **Security Barrier**: Creates a secure intermediary between signal sources and exchange credentials

### For Developers

1. **Reduced Complexity**: Abstracts away the complexities of the OKX API
2. **Standardized Interface**: Provides a consistent webhook interface regardless of trade type
3. **Authentication Handling**: Manages the complex authentication requirements of the OKX API
4. **Error Handling**: Implements robust error handling and retry logic
5. **Rate Limit Compliance**: Ensures compliance with OKX API rate limits

## Key Features and Capabilities

### Trading Features
- **Multi-Account Execution**: Execute trades across multiple accounts simultaneously
- **Trade Type Support**: Execute spot trades, USDT perpetual futures, and inverse perpetual futures
- **Position Sizing**: Support for percentage-based and fixed-size positions
- **Leverage Management**: Set and adjust leverage for futures trading

### Security Features
- **IP Validation**: Restrict access to verified TradingView IP addresses
- **Token Authentication**: Require valid authentication token for all requests
- **Input Validation**: Validate all incoming requests for required parameters
- **Rate Limiting**: Implement OKX-compliant rate limits to prevent API abuse

### System Features
- **Logging**: Comprehensive logging for all operations and security events
- **Notifications**: Telegram alerts for trade execution and errors
- **Error Handling**: Graceful error handling with detailed error messages
- **DryRun Testing**: Simulation mode for testing trade execution without placing actual orders
- **Performance**: Scalable architecture handling 80+ requests per second under load

### User Experience
### Reliability

- Every valid webhook request should result in a trade execution or clear error message
- The system should handle network issues gracefully with retries
- Comprehensive logging should provide clear audit trails

### Transparency

- Trade execution status should be clearly communicated
- Notifications should provide detailed information about trades
- Error messages should be descriptive and actionable

### Security

- API credentials should be securely stored and never exposed
- All requests should be properly authenticated
- Input validation should protect against malicious payloads

### Flexibility

- Support for various trade types (spot, futures)
- Support for different position sizing methods (fixed, percentage)
- Support for multiple accounts with a single request

## How It Should Work

### User Perspective

1. User configures their trading signal source to send webhook requests to the API endpoint
2. Each webhook contains trading parameters (symbol, side, size, type, etc.)
3. The API authenticates the request, validates the payload, and executes the trade on OKX
4. The system sends a notification via Telegram with the trade details and status
5. The API returns a response with the execution status and any relevant details

### System Perspective

1. Webhook request is received and authenticated
2. Payload is validated for required parameters and format
3. API keys are retrieved from the database
4. Trade is prepared with appropriate parameters based on trade type
5. Order is executed on OKX via their API
6. Results are logged and notifications are sent
7. Response is returned to the caller

## Integration Points

### Input Integration

- **TradingView Alerts**: Primary source of trading signals via webhook
- **Custom Trading Bots**: Can send webhook requests to execute trades
- **Manual API Calls**: For testing or manual trade execution

### Output Integration

- **OKX Exchange API**: For executing trades and retrieving market data
- **Telegram**: For sending notifications about trade execution and errors
- **Logging**: For diagnostic and audit purposes
