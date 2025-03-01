/**
 * Webhook API Worker Stress Test
 * 
 * This script simulates high load on the Webhook API Worker by sending
 * concurrent webhook requests with dryRun=true to prevent actual trades.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Configuration (adjust these values as needed)
const CONFIG = {
  // Connection settings
  workerUrl: '', // Added https:// protocol
  authToken: '', // URL encoded special characters
  
  // Load testing parameters
  concurrentUsers: 20, // Increased to get meaningful data
  requestsPerUser: 50, // Increased to get meaningful data
  delayBetweenRequestsMs: 50, // Decreased to increase load
  
  // Trade simulation parameters
  tradeTypes: ['spot'], // Can include: 'spot', 'perps', 'invperps'
  symbols: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
  actions: ['buy', 'sell'],
  
  // Output settings
  outputFile: './stress-test-results.json',
  logToConsole: true
};

/**
 * Generates a random trade payload
 * @returns {Object} Random trade payload
 */
function generateTradePayload() {
  const symbol = CONFIG.symbols[Math.floor(Math.random() * CONFIG.symbols.length)];
  const action = CONFIG.actions[Math.floor(Math.random() * CONFIG.actions.length)];
  const tradeType = CONFIG.tradeTypes[Math.floor(Math.random() * CONFIG.tradeTypes.length)];
  
  return {
    authToken: CONFIG.authToken,
    symbol: symbol,
    action: action,
    side: action, // Include both for compatibility
    type: tradeType,
    exchange: 'okx',
    qty: Math.random() < 0.2 ? '100%' : `${(Math.random() * 50 + 10).toFixed(2)}%`,
    accounts: ['default'],
    requestId: crypto.randomUUID(), // Unique ID for each request
    dryRun: true // Critical: prevents actual trading
  };
}

/**
 * Sends a single request to the webhook API
 * @returns {Promise<Object>} Response data
 */
function sendRequest() {
  return new Promise((resolve, reject) => {
    const payload = generateTradePayload();
    const data = JSON.stringify(payload);
    
    const url = new URL(CONFIG.workerUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'WebhookAPIStressTest/1.0'
      }
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        let parsedData;
        try {
          parsedData = responseData ? JSON.parse(responseData) : {};
        } catch (error) {
          // If it's not JSON, store as text
          parsedData = { raw: responseData };
        }
        
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsedData,
          rawBody: responseData, // Store raw response body
          requestId: payload.requestId,
          requestTime: new Date().toISOString(),
          requestPayload: payload // Include the request payload for debugging
        });
      });
    });
    
    req.on('error', (error) => {
      reject({
        error: error.message,
        requestId: payload.requestId,
        requestTime: new Date().toISOString(),
        requestPayload: payload
      });
    });
    
    req.write(data);
    req.end();
  });
}

/**
 * Simulates a user sending multiple requests
 * @param {number} userId User identifier
 * @returns {Promise<Array>} Results of user's requests
 */
async function simulateUser(userId) {
  if (CONFIG.logToConsole) {
    console.log(`User ${userId} starting`);
  }
  
  const results = [];
  
  for (let i = 0; i < CONFIG.requestsPerUser; i++) {
    try {
      const result = await sendRequest();
      results.push({
        success: result.statusCode >= 200 && result.statusCode < 300,
        statusCode: result.statusCode,
        requestId: result.requestId,
        responseTime: new Date().toISOString(),
        error: result.error,
        rawBody: result.rawBody, // Include raw response for debugging
        requestPayload: result.requestPayload // Include request payload
      });
      
      // Add delay between requests
      await new Promise(r => setTimeout(r, CONFIG.delayBetweenRequestsMs));
    } catch (error) {
      results.push({
        success: false,
        error: error.message || 'Unknown error',
        requestId: error.requestId,
        responseTime: new Date().toISOString(),
        requestPayload: error.requestPayload
      });
    }
  }
  
  if (CONFIG.logToConsole) {
    console.log(`User ${userId} completed ${results.filter(r => r.success).length}/${results.length} successful requests`);
  }
  
  return results;
}

/**
 * Runs the full stress test with multiple concurrent users
 */
async function runStressTest() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║             WEBHOOK API WORKER STRESS TEST                 ║
╚════════════════════════════════════════════════════════════╝

Starting stress test with the following configuration:
- Concurrent Users: ${CONFIG.concurrentUsers}
- Requests Per User: ${CONFIG.requestsPerUser}
- Total Requests: ${CONFIG.concurrentUsers * CONFIG.requestsPerUser}
- Trade Types: ${CONFIG.tradeTypes.join(', ')}
- Symbols: ${CONFIG.symbols.join(', ')}
- Actions: ${CONFIG.actions.join(', ')}
- Delay Between Requests: ${CONFIG.delayBetweenRequestsMs}ms

All requests will use dryRun=true to prevent actual trades
  `);
  
  const startTime = Date.now();
  
  const userPromises = [];
  for (let i = 0; i < CONFIG.concurrentUsers; i++) {
    userPromises.push(simulateUser(i + 1));
  }
  
  const results = await Promise.all(userPromises);
  const endTime = Date.now();
  
  // Flatten results for analysis
  const flattened = results.flat();
  const successful = flattened.filter(r => r.success).length;
  const failed = flattened.length - successful;
  const durationSeconds = (endTime - startTime) / 1000;
  const requestsPerSecond = (flattened.length / durationSeconds).toFixed(2);
  
  // Group results by status code
  const statusCodes = {};
  flattened.forEach(result => {
    if (result.statusCode) {
      statusCodes[result.statusCode] = (statusCodes[result.statusCode] || 0) + 1;
    }
  });
  
  // Format status code distribution
  const statusCodeDistribution = Object.entries(statusCodes)
    .map(([code, count]) => `${code}: ${count} (${((count / flattened.length) * 100).toFixed(1)}%)`)
    .join('\n    ');
  
  // Prepare detailed results
  const detailedResults = {
    config: CONFIG,
    summary: {
      totalRequests: flattened.length,
      successful,
      failed,
      durationSeconds,
      requestsPerSecond,
      statusCodes
    },
    timestamp: new Date().toISOString(),
    results: flattened
  };
  
  // Save results to file
  fs.writeFileSync(
    CONFIG.outputFile,
    JSON.stringify(detailedResults, null, 2),
    'utf8'
  );
  
  // Print summary
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    STRESS TEST RESULTS                     ║
╚════════════════════════════════════════════════════════════╝

- Test Duration: ${durationSeconds.toFixed(2)} seconds
- Total Requests: ${flattened.length}
- Successful: ${successful} (${((successful / flattened.length) * 100).toFixed(2)}%)
- Failed: ${failed} (${((failed / flattened.length) * 100).toFixed(2)}%)
- Requests/Second: ${requestsPerSecond}

Status Code Distribution:
    ${statusCodeDistribution}

Detailed results saved to: ${CONFIG.outputFile}
  `);
}

// Run the test
runStressTest().catch(error => {
  console.error('Stress test failed:', error);
  process.exit(1);
});
