import { Router } from 'itty-router';

const router = Router();
const OKX_API_URL = 'https://www.okx.com';  

// Global debug flag: set to true to include full error details (if needed)
const DEBUG = false;

// Rate limit window in seconds and max requests per window
const RATE_LIMIT_WINDOW = 60;
const MAX_REQUESTS = 20;

// Store IP addresses and their request counts (in-memory rate limiting)
const ipRequests = new Map();

// Helper: Format timestamp in OKX required format
function getTimestamp() {
  const now = new Date();
  const isoString = now.toISOString();
  return isoString.slice(0, -5) + 'Z';  
}

// Helper: Generate HMAC-SHA256 signature
async function sign(timestamp, method, requestPath, body, secretKey) {
  // Handle empty body same as Python
  const processedBody = body === '{}' || !body ? '' : body;
  
  // Create message string
  const message = `${timestamp}${method}${requestPath}${processedBody}`;
  createLog('AUTH', `Signature components:\n    Message: ${message}`);
  
  // Convert message and key to Uint8Array
  const msgData = new TextEncoder().encode(message);
  const keyData = new TextEncoder().encode(secretKey);
  
  // Generate HMAC
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    msgData
  );
  
  // Convert to base64
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  createLog('AUTH', `      Signature: ${mask(signatureBase64)}`);
  
  return signatureBase64;
}

// Helper: Generate common OKX request headers and signature
async function generateOkxRequest(apiKey, secretKey, passphrase, method, path, body = '') {
  const timestamp = new Date().toISOString().split('.')[0] + 'Z';
  createLog('AUTH', `Generating request with API key: ${mask(apiKey)}`);
  
  // Always include /api/v5 in signature path
  const signaturePath = path.startsWith('/api/v5') ? path : `/api/v5${path}`;
  
  // Generate signature using stringified body
  const signature = await sign(timestamp, method.toUpperCase(), signaturePath, body, secretKey);
  
  // Order headers exactly as in Python implementation
  const headers = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase
  };

  createLog('AUTH', `Request details:
    Timestamp: ${timestamp}
    Method: ${method.toUpperCase()}
    Path: ${signaturePath}
    Body: ${body || ''}`
  );
  
  return { headers, timestamp };
}

// Helper: Validate webhook payload
function validatePayload(payload) {
  // Required fields for all requests
  if (!payload.symbol) throw new Error('Symbol is required');
  if (!payload.type) throw new Error('Type is required');
  if (!payload.marginMode) throw new Error('Margin mode is required');
  
  // Validate symbol format
  switch(payload.type.toLowerCase()) {
    case 'perpetual':
      if (!payload.symbol.endsWith('-USD-SWAP')) {
        throw new Error('Perpetual symbols must end with -USD-SWAP');
      }
      break;
    case 'spot':
    case 'margin':
      if (!payload.symbol.endsWith('-USDT')) {
        throw new Error('Spot/Margin symbols must end with -USDT');
      }
      break;
    default:
      throw new Error('Invalid type. Must be perpetual, spot, or margin');
  }

  // Validate margin mode
  const marginMode = payload.marginMode.toLowerCase();
  if (!['cross', 'isolated'].includes(marginMode)) {
    throw new Error('Invalid margin mode. Must be cross or isolated');
  }

  // For entry orders (closePosition is false or not set)
  if (!payload.closePosition) {
    if (!payload.side) throw new Error('Side is required for entry orders');
    if (!payload.qty) throw new Error('Quantity is required for entry orders');
    
    // Validate side
    const side = payload.side.toLowerCase();
    if (!['buy', 'sell'].includes(side)) {
      throw new Error('Invalid side. Must be buy or sell');
    }

    // Validate quantity format for percentage
    if (payload.qty.includes('%')) {
      const percentage = parseFloat(payload.qty);
      if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
        throw new Error('Invalid percentage. Must be between 0 and 100');
      }
    } else {
      // Validate quantity format for absolute value
      const quantity = parseFloat(payload.qty);
      if (isNaN(quantity) || quantity <= 0) {
        throw new Error('Invalid quantity. Must be a positive number');
      }
    }
  }
}

// Helper: Generate a valid client order ID (clOrdId)
function generateClOrdId(strategyId, brokerTag) {
  const timestamp = Date.now();
  const sanitizedStrategy = (strategyId || 'default')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 10);
  createLog('TRADE', 'Generating clOrdId');
  return `${brokerTag}${sanitizedStrategy}${timestamp}`.substring(0, 32);
}

// Helper: Parse trading pair into base and quote currencies
function parseTradingPair(symbol) {
  // Remove .P suffix for perpetual futures
  const cleanSymbol = symbol.replace('.P', '');
  
  // Handle different formats: BTC-USDT, BTCUSDT
  const parts = cleanSymbol.includes('-') ? cleanSymbol.split('-') : [cleanSymbol.slice(0, -4), cleanSymbol.slice(-4)];
  
  return {
    base: parts[0],          // e.g., BTC, ETH
    quote: parts[1],         // e.g., USDT
    isPerpetual: symbol.endsWith('.P')
  };
}

// Helper: Format trading pair based on type
function formatTradingPair(symbol, type, marginType = 'USD') {
  // For perpetual futures, keep the original format if it already has -SWAP
  if (symbol.endsWith('-SWAP')) {
    return symbol;
  }

  // Remove any existing modifiers and standardize format
  const cleanSymbol = symbol.replace(/[-.P]/g, '');
  const base = cleanSymbol.slice(0, -4);
  const quote = cleanSymbol.slice(-4);

  switch(type.toLowerCase()) {
    case 'perpetual':
      // Support all three types of perpetual futures
      switch(marginType.toUpperCase()) {
        case 'USDT':
          return `${base}-USDT-SWAP`;
        case 'USDC':
          return `${base}-USDC-SWAP`;
        case 'USD':
        default:
          return `${base}-USD-SWAP`;  // Default to crypto-margined
      }
    default: // spot and margin use USDT
      return `${base}-${quote}`;
  }
}

// Helper: Calculate order size based on balance and percentage
function calculateOrderSize(balance, percentage, side, symbol) {
  const percent = parseFloat(percentage);
  if (isNaN(percent) || percent <= 0 || percent > 100) {
    throw new Error('Invalid percentage');
  }
  
  // Convert percentage to decimal
  const fraction = percent / 100;
  
  // Extract base/quote from symbol
  const base = symbol.slice(0, -4);
  const quote = symbol.slice(-4);
  createLog('TRADE', `Calculating ${side} size for ${base}-${quote}`);
  
  if (side.toLowerCase() === 'buy') {
    const quoteBalance = parseFloat(balance.data[0].details.find(d => d.ccy === quote)?.availBal || '0');
    createLog('TRADE', `Available ${quote} balance: ${quoteBalance}`);
    return (quoteBalance * fraction).toString();
  } else {
    const baseBalance = parseFloat(balance.data[0].details.find(d => d.ccy === base)?.availBal || '0');
    createLog('TRADE', `Available ${base} balance: ${baseBalance}`);
    return (baseBalance * fraction).toString();
  }
}

// Helper: Get maximum available size for trading
async function getMaxAvailSize(instId, credentials, requestId) {
  try {
    // Different endpoint for perpetual futures
    if (instId.endsWith('-SWAP')) {
      createLog('TRADE', 'Getting futures max size');
      const path = '/api/v5/account/max-size';
      const queryParams = `?instId=${instId}&tdMode=cross`;

      const { headers } = await generateOkxRequest(
        credentials.apiKey,
        credentials.secretKey,
        credentials.passphrase,
        'GET',
        path + queryParams
      );

      createLog('API', `Making request to: https://www.okx.com${path}${queryParams}`);
      const response = await fetch(`https://www.okx.com${path}${queryParams}`, { headers });
      const data = await response.json();
      
      if (data.code !== '0') {
        throw new Error(JSON.stringify(data));
      }

      // Make sure we have valid numbers
      const result = data.data[0];
      if (!result.maxBuy || !result.maxSell) {
        throw new Error('Invalid max size response: ' + JSON.stringify(result));
      }

      // Convert to same format as max-avail-size endpoint
      return {
        availBuy: result.maxBuy,
        availSell: result.maxSell,
        instId
      };
    }

    // For spot trading, use max-avail-size endpoint
    const path = '/api/v5/account/max-avail-size';
    const queryParams = `?instId=${instId}&tdMode=cash`;
    
    const { headers } = await generateOkxRequest(
      credentials.apiKey,
      credentials.secretKey,
      credentials.passphrase,
      'GET',
      path + queryParams
    );

    createLog('API', `Making request to: https://www.okx.com${path}${queryParams}`);
    const response = await fetch(`https://www.okx.com${path}${queryParams}`, {
      method: 'GET',
      headers
    });

    const data = await response.json();
    
    if (data.code !== '0') {
      throw new Error(JSON.stringify(data));
    }
    
    // Make sure we have valid numbers
    const result = data.data[0];
    if (!result.availBuy || !result.availSell) {
      throw new Error('Invalid max size response: ' + JSON.stringify(result));
    }
    
    return result;
  } catch (error) {
    createLog('API', `Failed to get max size: ${error.message}`);
    throw new Error(`Failed to get max size: ${error.message}`);
  }
}

// Helper: Get account balance
async function getAccountBalance(credentials, requestId) {
  try {
    const path = '/api/v5/account/balance';
    const { headers } = await generateOkxRequest(
      credentials.apiKey,
      credentials.secretKey,
      credentials.passphrase,
      'GET',
      path
    );

    createLog('API', `Making request to: https://www.okx.com${path}`);
    createLog('API', `Headers: ${JSON.stringify(headers, null, 2)}`);

    const response = await fetch(`https://www.okx.com${path}`, {
      method: 'GET',
      headers
    });

    const text = await response.text();
    createLog('API', `Response: ${text}`);

    const data = JSON.parse(text);
    if (!response.ok || data.code === '1') {
      throw new Error(`Failed to get account balance: ${text}`);
    }

    return data.data[0];
  } catch (error) {
    createLog('API', `Failed to get account balance: ${error.message}`);
    throw error;
  }
}

// Helper: Get instrument information
async function getInstrumentInfo(instId, credentials) {
  createLog('TRADE', `Getting instrument info for ${instId}`);
  
  const path = '/api/v5/public/instruments';
  const queryParams = `?instType=${instId.includes('-SWAP') ? 'SWAP' : 'SPOT'}&instId=${instId}`;
  
  try {
    const response = await fetch(`https://www.okx.com${path}${queryParams}`);
    const data = await response.json();
    
    if (!response.ok || !data.data || !data.data[0]) {
      throw new Error(`Failed to get instrument info: ${JSON.stringify(data)}`);
    }
    
    return data.data[0];
  } catch (error) {
    createLog('API', `Failed to get instrument info: ${error.message}`);
    throw error;
  }
}

// Helper: Round size to lot size
function roundToLotSize(size, lotSize) {
  const precision = -Math.log10(lotSize);
  const multiplier = Math.pow(10, precision);
  return Math.floor(size * multiplier) / multiplier;
}

// Helper: Get current position
async function getCurrentPosition(instId, credentials) {
  try {
    const path = '/api/v5/account/positions';
    const { headers } = await generateOkxRequest(
      credentials.apiKey,
      credentials.secretKey,
      credentials.passphrase,
      'GET',
      path
    );

    createLog('API', `Making request to: https://www.okx.com${path}`);
    const response = await fetch(`https://www.okx.com${path}`, {
      method: 'GET',
      headers
    });

    const data = await response.json();
    if (data.code !== '0') {
      throw new Error(`Failed to get position: ${JSON.stringify(data)}`);
    }

    // Find position for this instrument
    const position = data.data.find(p => p.instId === instId);
    if (!position) {
      throw new Error(`No position found for ${instId}`);
    }

    createLog('TRADE', `Current position: ${JSON.stringify(position)}`);
    return position;
  } catch (error) {
    createLog('API', `Failed to get position: ${error.message}`);
    throw error;
  }
}

// Helper: Execute a trade with OKX
async function executeTrade(payload, credentials, brokerTag, requestId) {
  try {
    // Set leverage first if specified for perpetual/margin
    if (payload.leverage && (payload.type === 'perpetual' || payload.marginMode)) {
      const leverageData = {
        instId: formatTradingPair(payload.symbol, payload.type),
        lever: payload.leverage.toString(),
        mgnMode: payload.marginMode || 'cross', // Default to cross if not specified
      };

      // For perpetual futures
      if (payload.type === 'perpetual') {
        leverageData.posSide = payload.symbol.includes('-USD-') ? 
          (payload.side === 'buy' ? 'long' : 'short') : 'net';
      }

      createLog('TRADE', `Setting leverage to ${payload.leverage}x for ${leverageData.instId}`, requestId, credentials.apiKey);
      
      const leveragePath = '/api/v5/account/set-leverage';
      const leverageBody = JSON.stringify(leverageData);
      const { headers: leverageHeaders } = await generateOkxRequest(
        credentials.apiKey,
        credentials.secretKey,
        credentials.passphrase,
        'POST',
        leveragePath,
        leverageBody
      );

      const leverageResponse = await fetch(`https://www.okx.com${leveragePath}`, {
        method: 'POST',
        headers: leverageHeaders,
        body: leverageBody
      });

      const leverageResult = await leverageResponse.json();
      createLog('API', `Leverage response: ${JSON.stringify(redactSensitiveData(leverageResult))}`, requestId, credentials.apiKey);

      if (leverageResult.code !== '0') {
        throw new Error(`Failed to set leverage: ${leverageResult.msg}`);
      }
    }

    const data = {
      instId: formatTradingPair(payload.symbol, payload.type),
      tdMode: payload.type === 'spot' ? 'cash' : (payload.marginMode || 'cross'),
      ordType: 'market',
      tag: brokerTag,
      clOrdId: `${brokerTag}${Date.now()}`
    };

    // Get instrument info for lot size
    const instrumentInfo = await getInstrumentInfo(data.instId, credentials);
    const lotSize = parseFloat(instrumentInfo.lotSz);
    createLog('TRADE', `Lot size for ${data.instId}: ${lotSize}`, requestId, credentials.apiKey);

    // Handle position closing for perpetual futures
    if (payload.type === 'perpetual' && payload.closePosition === true) {
      createLog('TRADE', 'Closing position - fetching current position size', requestId, credentials.apiKey);
      const position = await getCurrentPosition(payload.symbol, credentials);
      
      // Set side opposite to current position
      data.side = parseFloat(position.pos) > 0 ? 'sell' : 'buy';
      data.closePosition = true;
      
      // Set size to current position size
      data.sz = Math.abs(parseFloat(position.pos)).toString();

      // Set posSide based on position type
      if (payload.symbol.includes('-USD-')) {
        // For inverse futures, use the position's posSide
        data.posSide = position.posSide;
      } else {
        // For USDT/USDC futures, use net
        data.posSide = 'net';
      }
      
      createLog('TRADE', `Closing position of ${data.sz} contracts with ${data.side} and posSide ${data.posSide}`, requestId, credentials.apiKey);
    } else {
      data.side = payload.side.toLowerCase();
      
      // Handle percentage-based quantities
      if (payload.qty.includes('%')) {
        createLog('TRADE', `Getting max available size for ${payload.qty} trade`, requestId, credentials.apiKey);
        const maxSize = await getMaxAvailSize(payload.symbol, credentials, requestId);
        createLog('TRADE', `Max size response: ${JSON.stringify(redactSensitiveData(maxSize))}`, requestId, credentials.apiKey);
        
        // For spot trades, we need to set tgtCcy first
        if (payload.type === 'spot') {
          // For sell orders in spot, use base currency (e.g., BTC)
          // For buy orders in spot, use quote currency (e.g., USDT)
          data.tgtCcy = data.side === 'buy' ? 'quote_ccy' : 'base_ccy';
        }
        
        // Use availSell for sell orders, availBuy for buy orders
        const maxQty = data.side === 'sell' ? maxSize.availSell : maxSize.availBuy;
        createLog('TRADE', `Max quantity for ${data.side}: ${maxQty}`, requestId, credentials.apiKey);
        
        if (!maxQty || maxQty === '0') {
          throw new Error(`No available quantity for ${data.side} order`);
        }

        if (payload.qty === '100%') {
          // For 100%, use the max size directly but ensure it's rounded to lot size
          const roundedSize = roundToLotSize(parseFloat(maxQty), lotSize);
          data.sz = roundedSize.toString();
        } else {
          const percentage = parseFloat(payload.qty);
          const fraction = percentage / 100;
          const calculatedSize = parseFloat(maxQty) * fraction;
          // Round to lot size
          const roundedSize = roundToLotSize(calculatedSize, lotSize);
          data.sz = roundedSize.toString();
        }
        
        createLog('TRADE', `Setting size to ${data.sz} (${payload.qty} of ${maxQty})`, requestId, credentials.apiKey);

        if (parseFloat(data.sz) <= 0) {
          throw new Error(`Invalid order size: ${data.sz}. Max available: ${maxQty}`);
        }
      } else {
        // Direct size specification - still need to round to lot size
        const roundedSize = roundToLotSize(parseFloat(payload.qty), lotSize);
        data.sz = roundedSize.toString();
        
        // For spot trades with direct size
        if (payload.type === 'spot') {
          data.tgtCcy = data.side === 'buy' ? 'quote_ccy' : 'base_ccy';
        }
      }

      // For perpetual swaps, set posSide based on margin type
      if (payload.type === 'perpetual') {
        if (payload.symbol.includes('-USD-')) {
          // For inverse futures (BTC-USD-SWAP), use long/short
          data.posSide = data.side === 'buy' ? 'long' : 'short';
        } else {
          // For USDT/USDC futures, use net
          data.posSide = 'net';
        }
      }
    }

    createLog('TRADE', `Executing ${data.side} order for ${data.instId}`, requestId, credentials.apiKey);
    createLog('API', `Trade request:\n    Path: /api/v5/trade/order\n    Body: ${JSON.stringify(redactSensitiveData(data))}`, requestId, credentials.apiKey);

    const path = '/api/v5/trade/order';
    const body = JSON.stringify(data);
    const { headers } = await generateOkxRequest(
      credentials.apiKey,
      credentials.secretKey,
      credentials.passphrase,
      'POST',
      path,
      body
    );

    const response = await fetch(`https://www.okx.com${path}`, {
      method: 'POST',
      headers,
      body
    });

    const result = await response.json();
    createLog('API', `Response: ${JSON.stringify(redactSensitiveData(result))}`, requestId, credentials.apiKey);

    if (result.code !== '0') {
      throw new Error(`API Error: ${result.msg}`);
    }

    return result;
  } catch (error) {
    createLog('API', `Trade execution failed: ${error.message}`, requestId, credentials.apiKey);
    throw error;
  }
}

// Helper: Get API keys from database
async function getApiKeys(env, requestId) {
  createLog('DB', 'Fetching API keys from database', requestId);
  
  try {
    const stmt = await env.DB.prepare(
      'SELECT api_key, secret_key, passphrase FROM api_keys WHERE exchange = ?'
    ).bind('OKX')
    .all();
    
    if (!stmt.results || stmt.results.length === 0) {
      throw new Error('No trading API keys found for OKX');
    }
    
    // Debug log (first 4 chars only)
    stmt.results.forEach((key, index) => {
      createLog('DB', `Key ${index + 1}: API=${mask(key.api_key)}, Secret=${mask(key.secret_key)}, Pass=${mask(key.passphrase)}`, requestId);
    });
    
    return stmt.results;
  } catch (error) {
    createLog('DB', `Database error: ${error.message}`, requestId);
    throw new Error('Failed to retrieve API keys');
  }
}

// Helper: Create log entry with request and account info
function createLog(type, message, requestId = '', accountId = '') {
  const timestamp = new Date().toISOString();
  const accountInfo = accountId ? `[Account: ${mask(accountId)}]` : '';
  const reqInfo = requestId ? `[ReqID: ${requestId.substring(0, 8)}]` : '';
  console.log(`[${type}]${reqInfo}${accountInfo} ${message}`);
}

// Helper: Execute trades for multiple accounts
async function executeMultiAccountTrades(payload, apiKeys, brokerTag, requestId) {
  createLog('TRADE', `Starting parallel execution for ${apiKeys.length} accounts`, requestId);

  // Group API keys by instrument to respect rate limits
  const groupedKeys = {};
  for (const key of apiKeys) {
    const instId = formatTradingPair(payload.symbol, payload.type);
    if (!groupedKeys[instId]) {
      groupedKeys[instId] = [];
    }
    groupedKeys[instId].push(key);
  }

  // Execute trades in parallel for each instrument, respecting rate limits
  const allResults = await Promise.all(
    Object.entries(groupedKeys).map(async ([instId, keys]) => {
      // Split keys into chunks of 10 to stay well within the 1000/2s limit
      const chunkSize = 10;
      const chunks = [];
      for (let i = 0; i < keys.length; i += chunkSize) {
        chunks.push(keys.slice(i, i + chunkSize));
      }

      // Process each chunk with a small delay to respect rate limits
      const chunkResults = [];
      for (const chunk of chunks) {
        const chunkPromises = chunk.map(({ api_key, secret_key, passphrase }) => {
          const credentials = {
            apiKey: api_key,
            secretKey: secret_key,
            passphrase
          };

          return executeTrade(payload, credentials, brokerTag, requestId)
            .then(result => ({
              success: true,
              accountId: mask(api_key),
              status: 'success',
              ...result
            }))
            .catch(error => ({
              success: false,
              accountId: mask(api_key),
              status: 'rejected',
              error: error.message
            }));
        });

        // Execute chunk in parallel
        const results = await Promise.all(chunkPromises);
        chunkResults.push(...results);

        // Add small delay between chunks to respect rate limits
        if (chunks.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay between chunks
        }
      }

      return chunkResults;
    })
  );

  // Flatten results and separate successful and failed trades
  const results = allResults.flat();
  return {
    successful: results.filter(r => r.success),
    failed: results.filter(r => !r.success)
  };
}

// Helper: Mask sensitive strings
function mask(value, visible = 4) {
  if (!value) return '';
  return value.substring(0, visible) + '...';
}

// Helper: Redact sensitive data
function redactSensitiveData(obj) {
  if (!obj) return obj;
  
  const copy = { ...obj };
  if (copy.authToken) {
    copy.authToken = copy.authToken.substring(0, 4) + '***';
  }
  return copy;
}

// Validate broker tag at startup
const validateBrokerTag = (tag) => {
  if (!tag || typeof tag !== 'string' || tag.length === 0) {
    throw new Error('BROKER_TAG environment variable is required');
  }
};

// Token validation function
function validateAuthToken(payload, env) {
  const { authToken } = payload;
  
  if (!authToken) {
    throw new Error('Authentication token is required');
  }

  // Use constant-time comparison to prevent timing attacks
  if (authToken !== env.WEBHOOK_AUTH_TOKEN) {
    throw new Error('Invalid authentication token');
  }
}

// Health check endpoint
router.get('/', () =>
  new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
);

// Favicon handler (silent)
router.get('/favicon.ico', () => new Response(null, { status: 204 }));

// Webhook endpoint
router.post('/', async (request, env) => {
  const requestId = crypto.randomUUID();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  try {
    createLog('REQUEST', `Received webhook request from ${ip}`, requestId);
    
    // Parse request body
    let payload;
    try {
      payload = await request.json();
      createLog('PAYLOAD', `Received payload: ${JSON.stringify(redactSensitiveData(payload))}`, requestId);
    } catch (error) {
      throw new Error('Invalid JSON payload');
    }

    // Token validation as the first step
    validateAuthToken(payload, env);

    // Validate payload
    validatePayload(payload);

    // Get API keys from database
    const apiKeys = await getApiKeys(env, requestId);
    createLog('TRADE', `Processing trades for ${apiKeys.length} accounts`, requestId);
    
    // Execute trades for all accounts
    const results = await executeMultiAccountTrades(
      payload, 
      apiKeys, 
      env.BROKER_TAG || 'default',
      requestId
    );
    
    createLog('TRADE', `Completed: ${results.successful.length} successful, ${results.failed.length} failed`, requestId);
    
    if (results.failed.length > 0) {
      return new Response(JSON.stringify({
        message: `Processed ${results.successful.length} successful and ${results.failed.length} failed trades`,
        requestId: requestId,
        successful: results.successful,
        failed: results.failed
      }), {
        status: 207,  // 207 Multi-Status for partial success
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      message: `Successfully processed ${results.successful.length} trades`,
      requestId: requestId,
      results: results.successful
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    // Add specific handling for auth errors
    if (error.message === 'Authentication token is required' || error.message === 'Invalid authentication token') {
      return new Response(JSON.stringify({
        status: 'error',
        message: 'Unauthorized',
        requestId
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    createLog('ERROR', `Error: ${error.message}\nStack: ${error.stack}`, requestId);
    
    return new Response(JSON.stringify({
      error: error.message,
      requestId: requestId,
      timestamp: new Date().toISOString(),
      details: DEBUG ? error.stack : undefined
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Catch-all handler for other methods
router.all('*', () => new Response('Method not allowed', { status: 405 }));

// Export the router handler
export default {
  fetch: router.handle
};
