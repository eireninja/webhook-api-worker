# Webhook API Worker Stress Testing

This document describes how to perform stress testing on the Webhook API Worker to determine resource usage and scalability requirements.

## Overview

The `stress-test.js` script simulates high traffic loads against your Webhook API Worker by sending multiple concurrent webhook requests with `dryRun=true` to prevent actual trade execution while exercising the API's full processing pipeline.

## Requirements

- Node.js 14+ installed on your machine
- Your IP address whitelisted in the Webhook API Worker (for passing IP validation)
- Valid authentication token

## How It Works

The stress test:

1. Simulates multiple concurrent users sending webhook requests
2. Each user sends multiple requests with small delays between them
3. All requests include `dryRun: true` to prevent actual trades
4. The test measures response times, success rates, and throughput
5. Results are saved to a JSON file and displayed in the console

## Configuration

Before running the test, edit the `stress-test.js` file to configure these parameters:

```javascript
const CONFIG = {
  // Connection settings
  workerUrl: 'https://YOUR-WORKER-URL.workers.dev', // REPLACE THIS
  authToken: 'YOUR-AUTH-TOKEN',                     // REPLACE THIS
  
  // Load testing parameters
  concurrentUsers: 50,  // Number of simultaneous users
  requestsPerUser: 20,  // Number of requests each user sends
  delayBetweenRequestsMs: 100,  // Milliseconds between requests per user
  
  // Trade simulation parameters
  tradeTypes: ['spot'],  // Can include: 'spot', 'perps', 'invperps'
  symbols: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
  actions: ['buy', 'sell'],
  
  // Output settings
  outputFile: './stress-test-results.json',
  logToConsole: true
};
```

## Running the Test

1. Install required dependencies:
   ```bash
   npm install
   ```

2. Run the stress test:
   ```bash
   node stress-test.js
   ```

3. Review the results in the console and in the output file (`stress-test-results.json` by default)

## Interpreting Results

The test generates a detailed report with:

- Total number of requests processed
- Success and failure rates
- Requests per second (throughput)
- Distribution of HTTP status codes
- Duration of the test

## Tips for Effective Testing

1. **Start small and scale up**: Begin with smaller values for `concurrentUsers` and `requestsPerUser`, then gradually increase them.

2. **Monitor Cloudflare dashboard**: Keep the Cloudflare dashboard open to monitor CPU time, memory usage, and other metrics during the test.

3. **Vary trade types**: Test with different combinations of trade types, symbols, and actions to simulate real-world usage patterns.

4. **Run multiple tests**: Run the test multiple times with different configurations to get a comprehensive understanding of performance under various conditions.

5. **Test during low-traffic periods**: To avoid impacting real users, run tests during periods of low activity.

## Determining Worker Tier Requirements

Based on the stress test results, you can determine if you need to upgrade your Cloudflare Worker tier:

- **CPU time**: If you're approaching the CPU time limits of your current tier
- **Memory usage**: If memory usage spikes are close to the limit
- **Error rates**: If error rates increase significantly under load
- **Response times**: If response times become unacceptably high

## Example Worker Tier Limits

| Tier | CPU Time | Memory |
|------|----------|--------|
| Free | 10ms/request | 128MB |
| Paid | 50ms/request | 128MB |
| Unbound | Pay per ms | 128MB - 1GB |

The test results will help you evaluate if your current tier is sufficient or if you need to upgrade for better performance and reliability.
