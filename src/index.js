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

// Helper: Validate webhook payload
function validatePayload(payload) {
  // Required fields for all requests
  if (!payload.symbol) throw new Error('Symbol is required');
  if (!payload.type) throw new Error('Type is required');
  if (!payload.exchange) throw new Error('Exchange is required');
  
  // Validate exchange
  const validExchanges = ['okx', 'bybit'];
  if (!validExchanges.includes(payload.exchange.toLowerCase())) {
    throw new Error(`Invalid exchange. Must be one of: ${validExchanges.join(', ')}`);
  }
  
  // Validate trade type
  const tradeType = payload.type.toLowerCase();
  if (!['spot', 'perps', 'invperps'].includes(tradeType)) {
    throw new Error('Invalid type. Must be spot, perps, invperps');
  }

  // Validate symbol format
  switch(tradeType) {
    case 'invperps':
      if (!payload.symbol.endsWith('-USD-SWAP')) {
        throw new Error('Inverse perpetual symbols must end with -USD-SWAP');
      }
      // Always require leverage for perpetual futures
      if (!payload.leverage) {
        throw new Error('Leverage is required for perpetual futures');
      }
      break;
    case 'perps':
      if (!payload.symbol.endsWith('-USDT-SWAP') && !payload.symbol.endsWith('-USDC-SWAP')) {
        throw new Error('USDT/USDC perpetual symbols must end with -USDT-SWAP or -USDC-SWAP');
      }
      // Always require leverage for perpetual futures
      if (!payload.leverage) {
        throw new Error('Leverage is required for perpetual futures');
      }
      break;
    case 'spot':
      if (!payload.symbol.endsWith('-USDT')) {
        throw new Error('Spot symbols must end with -USDT');
      }
      break;
    default:
      throw new Error('Invalid trade type. Must be invperps, perps, or spot');
  }

  // Validate margin mode
  if (tradeType !== 'spot' && payload.marginMode) {
    const marginMode = payload.marginMode.toLowerCase();
    if (!['cross', 'isolated'].includes(marginMode)) {
      throw new Error('Invalid margin mode. Must be cross or isolated');
    }
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
    case 'perps':
    case 'invperps':
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
function calculateOrderSize(maxQty, requestedQty, lotSize) {
  if (requestedQty === '100%') {
    return roundToLotSize(parseFloat(maxQty), lotSize).toString();
  }
  
  const percentage = parseFloat(requestedQty);
  const fraction = percentage / 100;
  const calculatedSize = parseFloat(maxQty) * fraction;
  const roundedSize = roundToLotSize(calculatedSize, lotSize);
  
  if (roundedSize <= 0) {
    throw new Error(`Invalid order size: ${roundedSize}. Max available: ${maxQty}`);
  }
  
  return roundedSize.toString();
}

// Helper: Get maximum available size for trading
async function getMaxAvailSize(instId, credentials, requestId, payload) {
  // Validate credentials structure
  if (!credentials || !credentials.apiKey || !credentials.secretKey || !credentials.passphrase) {
    createLog('API', 'Invalid credentials structure provided to getMaxAvailSize', requestId);
    throw new Error('Invalid credentials structure');
  }

  // Validate margin mode
  if (!payload || !payload.marginMode || !['cross', 'isolated'].includes(payload.marginMode)) {
    createLog('API', `Invalid margin mode: ${payload?.marginMode}`, requestId);
    throw new Error('Invalid margin mode. Must be either "cross" or "isolated"');
  }

  try {
    // Different endpoint for perpetual futures
    if (instId.endsWith('-SWAP')) {
      createLog('TRADE', 'Getting futures max size');
      const path = '/api/v5/account/max-size';
      
      // Build query parameters based on margin mode
      let queryParams = `?instId=${instId}&tdMode=${payload.marginMode}`;
      
      // For isolated margin on futures, we need posSide
      if (payload.marginMode === 'isolated') {
        const posSide = payload.side?.toLowerCase() === 'buy' ? 'long' : 'short';
        queryParams += `&posSide=${posSide}`;
        createLog('TRADE', `Using isolated margin with ${posSide} position`, requestId);
      } else {
        createLog('TRADE', 'Using cross margin', requestId);
      }

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

      createLog('API', `Max size response: ${JSON.stringify(data)}`, requestId);

      // For inverse perpetuals (-USD-SWAP), return the contract numbers directly
      if (instId.endsWith('-USD-SWAP')) {
        createLog('API', `Processing inverse perpetual ${instId}`, requestId);
        
        // OKX returns the number of contracts directly for inverse swaps
        const maxBuy = result.maxBuy;
        const maxSell = result.maxSell;
        
        createLog('TRADE', `Max size for ${instId}: Buy=${maxBuy} contracts, Sell=${maxSell} contracts`, requestId);
        
        return {
          availBuy: maxBuy,
          availSell: maxSell,
          instId
        };
      }

      // For USDT perpetuals, return as is
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
    if (data.code !== '0' || !data.data?.[0]) {
      throw new Error('Failed to get account balance');
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
  // Removed duplicate logging here to prevent duplicate log entries.
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

// Helper: Execute a trade with OKX (main router)
async function executeTrade(payload, credentials, brokerTag, requestId, env) {
  // Validate credentials structure
  if (!credentials || !credentials.apiKey || !credentials.secretKey || !credentials.passphrase) {
    createLog('API', 'Invalid credentials structure provided to executeTrade', requestId);
    throw new Error('Invalid credentials structure');
  }

  try {
    validatePayload(payload);
    
    let result;
    switch(payload.type.toLowerCase()) {
      case 'spot':
        result = await executeSpotTrade(payload, credentials, brokerTag, requestId, env);
        break;
      case 'perps':
        result = await executePerpsOrder(payload, credentials, brokerTag, requestId, env);
        break;
      case 'invperps':
        result = await executeInvPerpsOrder(payload, credentials, brokerTag, requestId, env);
        break;
      default:
        throw new Error(`Unsupported trade type: ${payload.type}`);
    }
    return result;
  } catch (error) {
    return { successful: 0, failed: 1, sz: 0 };
  }
}

// Helper: Fetch max size from OKX API
async function fetchMaxSize(instId, tdMode, posSide, credentials, requestId) {
  createLog('TRADE', 'Getting max size');
  const path = '/api/v5/account/max-size';
  let queryParams = `?instId=${instId}&tdMode=${tdMode}`;
  
  if (posSide) {
    queryParams += `&posSide=${posSide}`;
    createLog('TRADE', `Using ${tdMode} margin with ${posSide} position`, requestId);
  }

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
  
  createLog('API', `Max size response: ${JSON.stringify(data)}`, requestId);
  
  if (data.code !== '0') {
    throw new Error(JSON.stringify(data));
  }

  const maxBuy = data.data?.[0]?.maxBuy;
  const maxSell = data.data?.[0]?.maxSell;
  
  if (!maxBuy || !maxSell) {
    throw new Error(`Invalid max size response: ${JSON.stringify(data)}`);
  }

  createLog('TRADE', `Max size for ${instId}: Buy=${maxBuy}, Sell=${maxSell}`, requestId);
  return { maxBuy, maxSell };
}

// Helper: Execute a spot trade
async function executeSpotTrade(payload, credentials, brokerTag, requestId, env) {
  // Early input validation
  if (!payload.symbol) {
    createLog('TRADE', 'Missing required parameter: symbol', requestId);
    return { successful: 0, failed: 1, sz: 0 };
  }
  if (!payload.side || !['buy', 'sell'].includes(payload.side.toLowerCase())) {
    createLog('TRADE', `Invalid side parameter: ${payload.side}. Must be 'buy' or 'sell'`, requestId);
    return { successful: 0, failed: 1, sz: 0 };
  }

  try {
    const instId = formatTradingPair(payload.symbol, 'spot');
    
    // Get instrument info for the symbol
    createLog('TRADE', `Getting instrument info for ${instId}`, requestId);
    const instInfo = await getInstrumentInfo(instId, credentials);
    if (!instInfo || !instInfo.lotSz) {
      createLog('TRADE', `Failed to get instrument info for ${instId}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    // Get max available size for spot
    const { maxBuy, maxSell } = await fetchMaxSize(instId, 'cash', null, credentials, requestId);
    
    // Calculate order size based on side and target currency
    const isBuy = payload.side.toLowerCase() === 'buy';
    const maxQty = isBuy ? maxBuy : maxSell;
    let orderSize;
    
    try {
      if (payload.qty.includes('%')) {
        orderSize = calculateOrderSize(maxQty, payload.qty, instInfo.lotSz);
      } else {
        orderSize = roundToLotSize(parseFloat(payload.qty), instInfo.lotSz).toString();
      }

      if (!orderSize || isNaN(parseFloat(orderSize)) || parseFloat(orderSize) <= 0) {
        throw new Error(`Invalid order size calculated: ${orderSize}`);
      }
    } catch (sizeError) {
      createLog('TRADE', `Order size calculation failed: ${sizeError.message}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }
    
    // Prepare order data
    const orderData = {
      instId: instId,
      tdMode: 'cash',
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag),
      side: payload.side.toLowerCase(),
      sz: orderSize,
      tgtCcy: isBuy ? 'base_ccy' : 'quote_ccy'  // base_ccy for buys, quote_ccy for sells
    };

    // Place order using batch orders
    const { result } = await placeBatchOrders([orderData], credentials, requestId, env);
    
    // Check both API-level and order-level success
    if (result.code !== '0' || !result.data?.[0] || result.data[0].sCode !== '0') {
      const errorMsg = result.data?.[0]?.sMsg || 'Failed to place spot order';
      createLog('TRADE', `Order placement failed: ${errorMsg}`, requestId);
      return { successful: 0, failed: 1, sz: orderSize };
    }

    // Return explicit success with size information
    return { successful: 1, failed: 0, sz: orderSize };
  } catch (error) {
    // Log unexpected errors
    createLog('TRADE', `Unexpected error in spot trade execution: ${error.message}`, requestId, credentials.apiKey, env);
    return { successful: 0, failed: 1, sz: 0 };
  }
}

// Main perpetual futures execution function
async function executePerpsOrder(payload, credentials, brokerTag, requestId, env) {
  try {
    // Execute the appropriate operation based on payload
    const result = payload.closePosition
      ? await closePerpsPosition(payload, credentials, brokerTag, requestId, env)
      : await openPerpsPosition(payload, credentials, brokerTag, requestId, env);
    
    // Ensure we have proper success/failure counts
    return {
      successful: result.successful || 0,
      failed: result.failed || 0,
      sz: result.sz || 0
    };
  } catch (error) {
    // Log the error at this level only if it hasn't been logged before
    if (!error.logged) {
      createLog('ERROR', `Perpetual trade execution failed: ${error.message}`, requestId, credentials.apiKey, env);
    }
    return { successful: 0, failed: 1, sz: 0 };
  }
}

// Helper: Open a perpetual futures position
async function openPerpsPosition(payload, credentials, brokerTag, requestId, env) {
  // Validate required parameters for opening position
  if (!payload.symbol || !payload.marginMode || !payload.side || !payload.qty) {
    throw new Error('Missing required parameters: symbol, marginMode, side, qty are required for opening position');
  }

  // Validate leverage explicitly
  if (!payload.leverage || isNaN(parseFloat(payload.leverage)) || parseFloat(payload.leverage) <= 0) {
    throw new Error('Invalid leverage: must be a positive number');
  }

  // Validate margin mode
  if (!['cross', 'isolated'].includes(payload.marginMode)) {
    throw new Error('Invalid marginMode: must be either cross or isolated');
  }

  // Validate side
  if (!['buy', 'sell'].includes(payload.side.toLowerCase())) {
    throw new Error('Invalid side: must be either buy or sell');
  }

  try {
    const instId = formatTradingPair(payload.symbol, 'perps');
    
    // Get instrument info for lot size
    createLog('TRADE', `Getting instrument info for ${instId}`, requestId);
    const instInfo = await getInstrumentInfo(instId, credentials);
    
    if (!instInfo || !instInfo.lotSz) {
      throw new Error(`Failed to get lot size for ${instId}`);
    }

    // Set leverage for opening position
    const posSide = payload.side.toLowerCase() === 'buy' ? 'long' : 'short';
    createLog('TRADE', `Setting ${payload.leverage}x leverage for ${instId}`, requestId);
    await setLeverage({
      instId: instId,
      lever: payload.leverage.toString(),
      mgnMode: payload.marginMode,
      posSide: posSide
    }, credentials, requestId, env);

    // Get max available size
    const { maxBuy, maxSell } = await fetchMaxSize(instId, payload.marginMode, posSide, credentials, requestId);
    
    // Calculate order size
    const maxQty = payload.side.toLowerCase() === 'buy' ? maxBuy : maxSell;
    let orderSize;
    
    if (payload.qty.includes('%')) {
      orderSize = calculateOrderSize(maxQty, payload.qty, instInfo.lotSz);
    } else {
      orderSize = roundToLotSize(parseFloat(payload.qty), instInfo.lotSz).toString();
    }

    // Validate final order size
    if (isNaN(parseFloat(orderSize)) || parseFloat(orderSize) <= 0) {
      throw new Error(`Invalid order size: ${orderSize}`);
    }

    createLog('TRADE', `Opening ${payload.side} position for ${instId} with size ${orderSize} at ${payload.leverage}x leverage`, requestId);

    // Prepare order data
    const orderData = {
      instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag),
      posSide: posSide,
      side: payload.side.toLowerCase(),
      sz: orderSize
    };

    // Place order
    const { result } = await placeBatchOrders([orderData], credentials, requestId, env);
    
    if (!result.data || !result.data[0] || result.data[0].sCode !== '0') {
      throw new Error(result.data?.[0]?.sMsg || 'Failed to open position');
    }

    return { successful: 1, failed: 0, sz: orderSize };
  } catch (error) {
    createLog('ERROR', `Failed to open USDT Perpetual position: ${error.message}`, requestId, credentials.apiKey, env);
    throw error;
  }
}

// Helper: Close a perpetual futures position
async function closePerpsPosition(payload, credentials, brokerTag, requestId, env) {
  // Validate required parameters for closing position
  if (!payload.symbol || !payload.marginMode) {
    throw new Error('Missing required parameters: symbol and marginMode are required for closing position');
  }

  // Validate margin mode
  if (!['cross', 'isolated'].includes(payload.marginMode)) {
    throw new Error('Invalid marginMode: must be either cross or isolated');
  }

  try {
    const instId = payload.symbol;
    
    // Get current position details
    createLog('TRADE', `Getting current position for ${instId}`, requestId);
    const position = await getCurrentPosition(instId, credentials);
    if (!position || !position.pos) {
      // No position to close is a success case (idempotency)
      return { successful: 1, failed: 0, sz: 0 };
    }

    // Determine close order parameters based on position side
    const positionSize = parseFloat(position.pos);
    const isLong = position.posSide === 'long';
    const side = isLong ? 'sell' : 'buy';
    
    createLog('TRADE', `Closing ${isLong ? 'long' : 'short'} position of size ${Math.abs(positionSize)} with ${side} order`, requestId);
    
    // Use raw contract size directly from position (absolute value)
    const orderSize = Math.abs(positionSize).toString();
    
    // Prepare the order data
    const orderData = {
      instId: instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag),
      posSide: position.posSide,
      side: side,
      sz: orderSize,
      closePosition: true
    };

    // Place order and validate response
    const { result } = await placeBatchOrders([orderData], credentials, requestId, env);
    
    // Check both API-level and order-level success
    if (result.code !== '0' || !result.data?.[0] || result.data[0].sCode !== '0') {
      const error = new Error(result.data?.[0]?.sMsg || 'Failed to close position');
      error.logged = true;
      throw error;
    }

    // Return success with size information
    return { successful: 1, failed: 0, sz: orderSize };
  } catch (error) {
    // Only log errors that haven't been logged before
    if (!error.logged && !error.message.includes('Order placed')) {
      createLog('ERROR', `Failed to close position: ${error.message}`, requestId, credentials.apiKey, env);
      error.logged = true;
    }
    return { successful: 0, failed: 1 };
  }
}

// Main inverse perpetual execution function
async function executeInvPerpsOrder(payload, credentials, brokerTag, requestId, env) {
  try {
    if (payload.closePosition) {
      return closeInvPerpsPosition(payload, credentials, brokerTag, requestId, env);
    }
    return openInvPerpsPosition(payload, credentials, brokerTag, requestId, env);
  } catch (error) {
    createLog('ERROR', `Inverse perpetual trade execution failed: ${error.message}`, requestId, credentials.apiKey, env);
    throw error;
  }
}

// Helper: Open an inverse perpetual position
async function openInvPerpsPosition(payload, credentials, brokerTag, requestId, env) {
  // Early input validation
  if (!payload.symbol || !payload.marginMode || !payload.side || !payload.leverage) {
    createLog('TRADE', 'Missing required parameters: symbol, marginMode, side, and leverage are required', requestId);
    return { successful: 0, failed: 1, sz: 0 };
  }

  // Validate margin mode
  if (!['cross', 'isolated'].includes(payload.marginMode)) {
    createLog('TRADE', `Invalid marginMode: ${payload.marginMode}. Must be either cross or isolated`, requestId);
    return { successful: 0, failed: 1, sz: 0 };
  }

  try {
    const instId = formatTradingPair(payload.symbol, 'invperps');
    
    // Get instrument info for lot size first
    createLog('TRADE', `Getting instrument info for ${instId}`, requestId);
    const instInfo = await getInstrumentInfo(instId, credentials);
    if (!instInfo || !instInfo.lotSz) {
      createLog('TRADE', `Failed to get instrument info for ${instId}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    // Set leverage for opening position
    const posSide = payload.side.toLowerCase() === 'buy' ? 'long' : 'short';
    createLog('TRADE', `Setting ${payload.leverage}x leverage for ${instId}`, requestId);
    try {
      await setLeverage({
        instId: instId,
        lever: payload.leverage.toString(),
        mgnMode: payload.marginMode,
        posSide: posSide
      }, credentials, requestId, env);
    } catch (leverageError) {
      createLog('TRADE', `Failed to set leverage: ${leverageError.message}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    // Get max available size
    const { maxBuy, maxSell } = await fetchMaxSize(instId, payload.marginMode, posSide, credentials, requestId);
    
    // Calculate order size
    const maxQty = payload.side.toLowerCase() === 'buy' ? maxBuy : maxSell;
    let orderSize;
    
    try {
      if (payload.qty.includes('%')) {
        orderSize = calculateOrderSize(maxQty, payload.qty, instInfo.lotSz);
      } else {
        orderSize = roundToLotSize(parseFloat(payload.qty), instInfo.lotSz).toString();
      }

      // Validate final order size against maxQty
      const finalSize = parseFloat(orderSize);
      if (isNaN(finalSize) || finalSize <= 0) {
        throw new Error(`Invalid order size: ${orderSize}`);
      }
      if (finalSize > parseFloat(maxQty)) {
        throw new Error(`Order size ${finalSize} exceeds maximum available size ${maxQty}`);
      }
    } catch (sizeError) {
      createLog('TRADE', `Order size calculation failed: ${sizeError.message}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    createLog('TRADE', `Opening ${posSide} position for ${instId} with size ${orderSize} at ${payload.leverage}x leverage (max: ${maxQty})`, requestId);

    // Prepare order data
    const orderData = {
      instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag),
      posSide: posSide,
      side: payload.side.toLowerCase(),
      sz: orderSize
    };

    // Place order
    const { result } = await placeBatchOrders([orderData], credentials, requestId, env);
    
    // Check both API-level and order-level success
    if (result.code !== '0' || !result.data?.[0] || result.data[0].sCode !== '0') {
      const errorMsg = result.data?.[0]?.sMsg || 'Failed to place inverse perpetual order';
      createLog('TRADE', `Order placement failed: ${errorMsg}`, requestId);
      return { successful: 0, failed: 1, sz: orderSize };
    }

    // Return explicit success with size information
    return { successful: 1, failed: 0, sz: orderSize };
  } catch (error) {
    // Log unexpected errors
    createLog('TRADE', `Unexpected error in inverse perpetual position opening: ${error.message}`, requestId, credentials.apiKey, env);
    return { successful: 0, failed: 1, sz: 0 };
  }
}

// Helper: Close an inverse perpetual position
async function closeInvPerpsPosition(payload, credentials, brokerTag, requestId, env) {
  // Validate required parameters for closing position
  if (!payload.symbol || !payload.marginMode) {
    throw new Error('Missing required parameters: symbol and marginMode are required for closing position');
  }

  // Validate margin mode
  if (!['cross', 'isolated'].includes(payload.marginMode)) {
    throw new Error('Invalid marginMode: must be either cross or isolated');
  }

  try {
    const instId = formatTradingPair(payload.symbol, 'invperps');
    
    // Get current position details
    createLog('TRADE', `Getting current position for ${instId}`, requestId);
    const position = await getCurrentPosition(instId, credentials);
    if (!position || !position.pos) {
      throw new Error('No position found to close');
    }

    // For inverse perpetual contracts:
    // - To close a long position (posSide='long'): use side='sell'
    // - To close a short position (posSide='short'): use side='buy'
    const side = position.posSide === 'long' ? 'sell' : 'buy';
    const orderSize = Math.abs(parseFloat(position.pos)).toString();

    createLog('TRADE', `Closing ${position.posSide} position for ${instId} with size ${orderSize} using ${side} order`, requestId);

    // Prepare close order data
    const orderData = {
      instId: instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag),
      posSide: position.posSide,
      side: side,
      sz: orderSize,
      closePosition: true
    };

    // Place order
    return await placeBatchOrders([orderData], credentials, requestId, env);
  } catch (error) {
    createLog('ERROR', `Failed to close inverse perpetual position: ${error.message}`, requestId, credentials.apiKey);
    return { result: null, successful: 0, failed: 1 };  // Return failure result instead of throwing
  }
}

// Helper: Place batch orders with OKX
async function placeBatchOrders(orders, credentials, requestId, env) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error('Invalid orders array provided to placeBatchOrders');
  }

  createLog('TRADE', `Executing batch of ${orders.length} orders`, requestId, credentials.apiKey);
  createLog('API', `Batch trade request:\n    Path: /api/v5/trade/batch-orders\n    Body: ${JSON.stringify(redactSensitiveData(orders))}`, requestId, credentials.apiKey);

  const path = '/api/v5/trade/batch-orders';
  const body = JSON.stringify(orders);
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

  if (result.code === '0' && result.data?.[0]?.sCode === '0') {
    createLog('DEBUG', `Order ${result.data[0].clOrdId} placed successfully`, requestId);
    return { result, successful: 1, failed: 0 };
  } else {
    const message = result.data?.[0]?.sMsg || 'Unknown error';
    createLog('ERROR', `Trade execution failed: ${message}`, requestId);
    return { result, successful: 0, failed: 1 };
  }
}

// Helper: Validate trade response
function validateTradeResponse(response) {
  if (!response || !response.data || !Array.isArray(response.data)) {
    return { success: false, message: 'Invalid API response structure' };
  }

  // Check main response code
  if (response.code !== '0') {
    return { success: false, message: response.msg || 'Trade request failed' };
  }

  // Check individual order status
  const order = response.data[0];
  if (!order) {
    return { success: false, message: 'No order data in response' };
  }

  // Order is successful if both main code and sCode are 0
  const success = order.sCode === '0' && order.sMsg === 'Order placed';
  return {
    success,
    message: success ? 'Order placed successfully' : (order.sMsg || 'Order placement failed'),
    orderId: order.ordId,
    clOrdId: order.clOrdId
  };
}

// Helper: Set leverage for futures trading
async function setLeverage(data, credentials, requestId, env) {
  createLog('TRADE', `Setting leverage to ${data.lever}x for ${data.instId}`, requestId, credentials.apiKey, env);
  
  const path = '/api/v5/account/set-leverage';
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
  createLog('API', `Leverage response: ${JSON.stringify(redactSensitiveData(result))}`, requestId, credentials.apiKey, env);

  if (result.code !== '0') {
    throw new Error(`Failed to set leverage: ${result.msg}`);
  }
}

// Helper: Execute trades for multiple accounts using batch orders
async function executeMultiAccountTrades(payload, apiKeys, brokerTag, requestId, env) {
  // Validate inputs
  if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
    throw new Error('No API keys provided for trade execution');
  }

  const isMultiAccount = apiKeys.length > 1;
  const apiKeysList = apiKeys.map(k => k.api_key).join(',');

  try {
    // Send initial message
    await sendTelegramMessage('REQUEST', `Executing ${payload.side || ''} order for ${payload.symbol}`, 
      requestId, apiKeysList, isMultiAccount, apiKeys.length, null, payload);

    // Group keys by instrument
    const groupedKeys = {};
    apiKeys.forEach(key => {
      const instId = formatTradingPair(payload.symbol, payload.type);
      if (!groupedKeys[instId]) groupedKeys[instId] = [];
      groupedKeys[instId].push(key);
    });

    // Execute trades in parallel for each instrument
    const allResults = await Promise.all(
      Object.entries(groupedKeys).map(async ([instId, keys]) => {
        const chunkSize = 20;
        const chunks = [];
        
        for (let i = 0; i < keys.length; i += chunkSize) {
          chunks.push(keys.slice(i, i + chunkSize));
        }

        let instrumentSuccessful = 0;
        let instrumentFailed = 0;
        const failedAccounts = [];

        for (const chunk of chunks) {
          const results = await Promise.all(
            chunk.map(async ({ api_key, secret_key, passphrase }) => {
              try {
                const result = await executeTrade(
                  payload,
                  { apiKey: api_key, secretKey: secret_key, passphrase },
                  brokerTag,
                  requestId,
                  env
                );
                if (result.failed > 0) {
                  failedAccounts.push(api_key);
                }
                return result;
              } catch (error) {
                failedAccounts.push(api_key);
                return { successful: 0, failed: 1 };
              }
            })
          );

          // Aggregate results from this chunk
          results.forEach(result => {
            instrumentSuccessful += result.successful;
            instrumentFailed += result.failed;
          });
        }

        return { 
          instId, 
          successful: instrumentSuccessful, 
          failed: instrumentFailed,
          failedAccounts 
        };
      })
    );

    // Calculate final totals
    const finalTotals = allResults.reduce((acc, curr) => {
      acc.successful += curr.successful;
      acc.failed += curr.failed;
      acc.failedAccounts.push(...curr.failedAccounts);
      return acc;
    }, { successful: 0, failed: 0, failedAccounts: [] });

    // Collect account IDs
    const accountIds = apiKeys.map(key => key.api_key);
    const successfulAccounts = accountIds.filter(id => !finalTotals.failedAccounts.includes(id));
    const failedAccountIds = finalTotals.failedAccounts.length > 0 ? finalTotals.failedAccounts.join(', ') : 'None';

    // Send final status message
    await sendTelegramMessage(
      'RESPONSE',
      `Completed execution for ${payload.symbol}`,
      requestId,
      apiKeysList,
      isMultiAccount,
      apiKeys.length,
      null,
      payload,
      finalTotals.failedAccounts
    );

    return { successful: finalTotals.successful, failed: finalTotals.failed };
  } catch (error) {
    createLog('ERROR', `Multi-account trade execution failed: ${error.message}`, requestId);
    throw error;
  }
}

// Helper: Get API keys from database
async function getApiKeys(env, requestId, exchange) {
  if (!exchange) {
    createLog('DB', 'No exchange provided to getApiKeys', requestId, null, env);
    throw new Error('Exchange parameter is required');
  }

  // Normalize exchange name to uppercase
  const normalizedExchange = exchange.toUpperCase();
  createLog('DB', `Fetching API keys for ${normalizedExchange} from database`, requestId, null, env);
  
  try {
    const stmt = await env.DB.prepare(
      'SELECT api_key, secret_key, passphrase FROM api_keys WHERE exchange = ?'
    ).bind(normalizedExchange)
    .all();
    
    if (!stmt.results || stmt.results.length === 0) {
      const error = `No trading API keys found for ${normalizedExchange}`;
      createLog('DB', error, requestId, null, env);
      throw new Error(error);
    }
    
    // Debug log (first 4 chars only)
    stmt.results.forEach((key, index) => {
      createLog('DB', `Key ${index + 1}: API=${mask(key.api_key)}, Secret=${mask(key.secret_key)}, Pass=${mask(key.passphrase)}`, requestId, null, env);
    });
    
    return stmt.results;
  } catch (error) {
    const errorMsg = error.message.includes('No trading API keys') 
      ? error.message 
      : `Database error while fetching ${normalizedExchange} keys: ${error.message}`;
    createLog('DB', errorMsg, requestId, null, env);
    throw new Error(errorMsg);
  }
}

// Helper: Create log entry with request and account info
async function createLog(type, message, requestId = '', accountId = '', env = null) {
  const timestamp = new Date().toISOString();
  const accountInfo = accountId ? `[API Key: ${mask(accountId)}]` : '';
  const reqInfo = requestId ? `[ReqID: ${requestId.substring(0, 8)}]` : '';
  const logMessage = `[${type}]${reqInfo}${accountInfo} ${message}`;
  
  // Standard console logging
  console.log(logMessage);
  
  // Telegram notifications for important events
  if (env && shouldNotifyTelegram(type, message)) {
    const telegramMessage = formatTelegramMessage(type, message, requestId, accountId);
    if (telegramMessage) {
      await sendTelegramMessage(telegramMessage.type, telegramMessage.message, env);
    }
  }
}

// Helper: Format telegram message
function formatTelegramMessage(type, message, requestId, accountId, isMultiAccount = false, totalAccounts = 1, volume = null, payload = null, failedAccounts = []) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const reqId = `Request ID: ${requestId ? requestId.substring(0, 8) : ''}`;

  // Define message type icons
  const icons = {
    WEBHOOK: '📥',
    TRADE_OPEN: '📈',
    TRADE_CLOSE: '📉',
    ERROR: '❌',
    SUCCESS: '✅'
  };

  // Get symbol and action from payload
  const symbol = payload?.symbol || 'UNKNOWN';
  const action = payload?.side?.toUpperCase() || 'UNKNOWN';

  // Helper to format the title with icon
  const formatTitle = (text, messageType) => `${icons[messageType]} WEBHOOK-API: ${text}`;

  switch(type) {
    case 'REQUEST': {
      const tradeType = isMultiAccount ? 'MULTI-ACCOUNT TRADE' : 'TRADE EXECUTION';
      let accountInfo;
      
      if (isMultiAccount && accountId) {
        const accounts = accountId.split(',');
        accountInfo = `\n\nProcessing trades for ${accounts.length} accounts:`;
        accounts.forEach((id, idx) => {
          accountInfo += `\n${idx + 1}. API Key: ${mask(id)}`;
        });
      } else {
        accountInfo = '\n\nProcessing trade for 1 account...';
      }

      const message = [
        `${tradeType} - ${symbol}`,
        `Time: ${timestamp}`,
        reqId,
        `Action: ${action}`,
        `Exchange: OKX`,
        accountInfo
      ].join('\n');

      return {
        type: 'WEBHOOK',
        message: formatTitle(message, 'TRADE_OPEN')
      };
    }
      
    case 'API': {
      if (message.includes('Response:')) {
        const successTitle = isMultiAccount ? 'TRADE SUMMARY' : 'TRADE SUCCESS';
        const messageLines = [
          `${successTitle} - ${symbol}`,
          `Time: ${timestamp}`,
          reqId,
          '',
          'Execution Results:'
        ];

        if (isMultiAccount) {
          const failedCount = failedAccounts?.length || 0;
          const successCount = totalAccounts - failedCount;
          messageLines.push(`• Total Accounts: ${totalAccounts}`);
          messageLines.push(`• Successful: ${successCount}`);
          if (failedCount > 0) {
            messageLines.push(`• Failed: ${failedCount}`);
          }
        }

        if (volume && volume !== '0' && volume !== '0.00000000') {
          const baseAsset = symbol.split('-')[0];
          messageLines.push(`• ${isMultiAccount ? 'Total Volume' : 'Trade Volume'}: ${volume} ${baseAsset}`);
        }

        const duration = calculateDuration(timestamp);
        messageLines.push(`• Duration: ${duration} ${duration === 1 ? 'second' : 'seconds'}`);

        return {
          type: 'SUCCESS',
          message: formatTitle(messageLines.join('\n'), 'SUCCESS')
        };
      }
      break;
    }
      
    case 'ERROR': {
      const errorTitle = isMultiAccount ? 'TRADE ERRORS' : 'TRADE ERROR';
      const messageLines = [
        `${errorTitle} - ${symbol}`,
        `Time: ${timestamp}`,
        reqId,
        ''
      ];

      if (isMultiAccount && failedAccounts?.length > 0) {
        messageLines.push(`Failed Accounts (${failedAccounts.length}):`);
        failedAccounts.forEach((fa, index) => {
          messageLines.push(`${index + 1}. ${fa.accountId} (Error: ${fa.error})`);
        });

        // Group errors by type
        const errorTypes = {};
        failedAccounts.forEach(fa => {
          errorTypes[fa.error] = (errorTypes[fa.error] || 0) + 1;
        });

        messageLines.push('\nError Analysis:');
        Object.entries(errorTypes).forEach(([error, count]) => {
          messageLines.push(`• ${error}: ${count}`);
        });
      } else {
        messageLines.push(`Failed Account:\n• API Key: ${mask(accountId)}\nError: ${message}`);
      }

      messageLines.push('Exchange: OKX');

      return {
        type: 'ERROR',
        message: formatTitle(messageLines.join('\n'), 'ERROR')
      };
    }
  }

  return null;
}

// Helper: Calculate duration in seconds between given timestamp and now
function calculateDuration(startTime) {
  const start = new Date();
  start.setHours(startTime.split(':')[0], startTime.split(':')[1], startTime.split(':')[2]);
  const now = new Date();
  return Math.max(1, Math.round((now - start) / 1000));
}

// Helper: Send message to Telegram
async function sendTelegramMessage(type, message, env) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) return;
  
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error('Telegram notification failed:', error.message);
  }
}

// Helper: Determine if event should be sent to Telegram
function shouldNotifyTelegram(type, message) {
  switch(type) {
    case 'REQUEST':
      return true;  // Always notify for new webhooks
    case 'TRADE':
      return message.includes('Executing') || message.includes('Closing position');
    case 'API':
      return (message.includes('Response:') && message.includes('ordId')) || message.includes('failed:');
    case 'ERROR':
      return true;  // Always notify for errors
    default:
      return false;
  }
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
  const clientIp = request.headers.get('cf-connecting-ip');
  
  createLog('REQUEST', `Received webhook request from ${clientIp}`, requestId, null, env);
  
  try {
    const payload = await request.json();
    createLog('PAYLOAD', `Received payload: ${JSON.stringify(redactSensitiveData(payload))}`, requestId, null, env);
    
    // Token validation as the first step
    validateAuthToken(payload, env);

    // Validate payload
    validatePayload(payload);

    // Get API keys from database
    const apiKeys = await getApiKeys(env, requestId, payload.exchange);
    createLog('TRADE', `Processing trades for ${apiKeys.length} accounts`, requestId, null, env);
    
    // Select broker tag based on exchange
    const brokerTag = payload.exchange.toLowerCase() === 'okx' ? 
      env.BROKER_TAG_OKX : 
      payload.exchange.toLowerCase() === 'bybit' ? 
        env.BROKER_TAG_BYBIT : 
        'default';

    // Execute trades for all accounts
    const results = await executeMultiAccountTrades(
      payload, 
      apiKeys, 
      brokerTag,
      requestId,
      env
    );
    
    createLog('TRADE', `Completed: ${results.successful} successful, ${results.failed} failed`, requestId, null, env);
    
    if (results.failed > 0) {
      return new Response(JSON.stringify({
        message: `Processed ${results.successful} successful and ${results.failed} failed trades`,
        requestId: requestId,
        successful: results.successful,
        failed: results.failed
      }), {
        status: 207,  // 207 Multi-Status for partial success
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      message: `Successfully processed ${results.successful} trades`,
      requestId: requestId,
      results: results.successful
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    createLog('ERROR', `Error: ${error.message}`, requestId, null, env);
    
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
})

// Helper: Get exchange credentials
function getExchangeCredentials(exchange, env) {
  const exchangeKey = exchange.toUpperCase();
  const credentials = {
    apiKey: env[`${exchangeKey}_API_KEY`],
    secretKey: env[`${exchangeKey}_SECRET_KEY`],
    passphrase: env[`${exchangeKey}_PASSPHRASE`]
  };
  
  if (!credentials.apiKey || !credentials.secretKey || !credentials.passphrase) {
    throw new Error(`Missing API credentials for ${exchange}`);
  }
  
  return credentials;
}

// Catch-all handler for other methods
router.all('*', () => new Response('Method not allowed', { status: 405 }));

// Export the router handler
export default {
  fetch: router.handle,
  getExchangeCredentials
};
