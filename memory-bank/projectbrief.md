# OKX Trading Webhook API Project Brief

## Project Overview
The OKX Trading Webhook API is a high-performance, secure service built on Cloudflare Workers that facilitates automated trading on the OKX exchange through webhook requests. It serves as a bridge between trading signals (from external systems like TradingView) and the OKX exchange, enabling seamless execution of trading strategies.

## Core Requirements

### Functional Requirements
- Execute trades across multiple accounts simultaneously
- Support various trading types (spot, USDT perpetual futures, inverse perpetual futures)
- Manage positions with flexible sizing options
- Control leverage settings for futures trading
- Place market orders with automatic price discovery
- Provide comprehensive logging and notifications
- Support testing mode with dry run capabilities for order validation
- Implement an operation tracking and logging system to monitor and analyze trade executions

### Non-Functional Requirements
- **Security**: Implement robust middleware-based authentication, IP validation, and data protection
- **Performance**: Optimize for low latency to ensure timely trade execution
- **Reliability**: Ensure consistent operation and proper error handling
- **Scalability**: Handle high request volumes during market volatility
- **Testing**: Support comprehensive testing with simulated trade execution
- **Observability**: Provide detailed logging and performance metrics

## Project Goals
1. Provide a secure and efficient webhook API for automated trading on OKX
2. Ensure proper handling of different trade types and account configurations
3. Maintain comprehensive logging and notifications for trade monitoring
4. Implement robust security measures with multi-layered protection
5. Comply with OKX API rate limits and specifications
6. Develop an operation tracking and logging system to monitor and analyze trade executions

## Project Scope
### In Scope
- Webhook API endpoints for trade execution
- Universal IP validation middleware for all routes
- Authentication and validation mechanisms
- Integration with OKX Trading API
- Multi-account support
- Telegram notifications
- Comprehensive logging
- Operation tracking and logging system

### Out of Scope
- User interface for configuration
- Historical data analysis
- Strategy development tools
- Direct integration with trading platforms beyond webhook support

## Success Criteria
- Successful trade execution across multiple accounts
- Proper handling of different trade types
- Accurate position management
- Reliable notification delivery
- Efficient error handling and logging
- Complete security for all API endpoints 
- Compliance with OKX rate limits
- Effective operation tracking and logging system
