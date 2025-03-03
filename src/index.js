/**
 * @fileoverview Webhook API Worker for handling trading operations across multiple exchanges
 * This module provides endpoints and utilities for executing trades, managing positions,
 * and handling webhook requests for cryptocurrency trading operations.
 */

import { Router } from 'itty-router';
import { formatTradeMessage, sendTelegramMessage } from './telegram.js';

//=============================================================================
// [INIT] Initialization and Constants
//=============================================================================

const router = Router();
const OKX_API_URL = 'https://www.okx.com';  

//=============================================================================
// [SECURITY] Security Functions
//=============================================================================

/**
 * Validates if the client IP is in the TradingView whitelist
 * @param {string} clientIp - Client IP address
 * @returns {boolean} True if IP is allowed, false otherwise
 */
function isAllowedIp(clientIp) {
  const allowedIps = [
    '52.89.214.238',
    '34.212.75.30',
    '54.218.53.128',
    '52.32.178.7',
    '91.148.238.131'
  ];
  
  return allowedIps.includes(clientIp);
}

//=============================================================================
// [VALIDATION] Input Validation Functions
//=============================================================================

/**
 * Validates the webhook payload for required fields and correct values
 * @param {Object} payload - The webhook payload to validate
 * @param {string} payload.symbol - Trading symbol (e.g., 'BTC-USDT')
 * @param {string} payload.type - Trade type ('spot', 'perps', or 'invperps')
 * @param {string} payload.exchange - Exchange name ('okx' or 'bybit')
 * @throws {Error} If any required field is missing or invalid
 */
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

  // Validate side
  if (!payload.closePosition && !payload.side) {
    throw new Error('Side is required for entry orders');
  }
  if (payload.side && !['buy', 'sell'].includes(payload.side.toLowerCase())) {
    throw new Error('Invalid side. Must be buy or sell');
  }

  // Validate quantity format for percentage
  if (payload.qty && payload.qty.includes('%')) {
    const percentage = parseFloat(payload.qty);
    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error('Invalid percentage. Must be between 0 and 100');
    }
  } else if (payload.qty) {
    // Validate quantity format for absolute value
    const quantity = parseFloat(payload.qty);
    if (isNaN(quantity) || quantity <= 0) {
      throw new Error('Invalid quantity. Must be a positive number');
    }
  }
}

/**
 * Validates broker tag format and content
 * @param {string} tag - Broker tag to validate
 * @throws {Error} If tag format is invalid
 * @returns {boolean} True if tag is valid
 */
function validateBrokerTag(tag) {
  if (!tag || typeof tag !== 'string' || tag.length === 0) {
    throw new Error('BROKER_TAG environment variable is required');
  }

  if (!/^[a-zA-Z0-9_-]{8,32}$/.test(tag)) {
    throw new Error('Invalid broker tag format: use 8-32 characters (letters, numbers, underscore, hyphen)');
  }
}

/**
 * Validates authentication token from the request
 * @param {Object} payload - Request payload containing the token
 * @param {Object} env - Environment variables containing auth settings
 * @param {string} requestId - Request identifier
 * @throws {Error} If token is invalid or missing
 * @returns {boolean} True if token is valid
 */
function validateAuthToken(payload, env, requestId = 'unknown') {
  if (!env?.WEBHOOK_AUTH_TOKEN) {
    throw new Error('Server configuration error: missing authentication token');
  }

  const { authToken } = payload;
  if (!authToken) {
    createLog('AUTH', {
      operation: 'Authentication',
      status: 'failed',
      details: {
        reason: 'Missing token'
      }
    }, requestId);
    throw new Error('Missing authentication token');
  }

  // Constant-time comparison to prevent timing attacks
  if (authToken !== env.WEBHOOK_AUTH_TOKEN) {
    createLog('AUTH', {
      operation: 'Authentication',
      status: 'failed',
      details: {
        reason: 'Invalid token'
      }
    }, requestId);
    throw new Error('Invalid authentication token');
  }
  
  // Log successful authentication
  createLog('AUTH', {
    operation: 'Authentication',
    status: 'success'
  }, requestId);
}

//=============================================================================
// [UTILS] Utility Functions
//=============================================================================

/**
 * Generates ISO timestamp in OKX required format
 * @returns {string} Formatted timestamp string
 */
function getTimestamp() {
  const now = new Date();
  const isoString = now.toISOString();
  return isoString.slice(0, -5) + 'Z';  
}

/**
 * Generates HMAC-SHA256 signature for API authentication
 * @param {string} timestamp - Current timestamp
 * @param {string} method - HTTP method
 * @param {string} requestPath - API endpoint path
 * @param {string} body - Request body
 * @param {string} secretKey - API secret key
 * @param {string} requestId - Request identifier
 * @returns {string} Generated signature
 */
async function sign(timestamp, method, requestPath, body, secretKey, requestId) {
  try {
    // Handle empty body same as Python
    const processedBody = body === '{}' || !body ? '' : body;
    
    // Create message string
    const message = `${timestamp}${method}${requestPath}${processedBody}`;
    
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
    
    // Create a single structured log with all signature information
    createLog('AUTH', {
      operation: 'Signature Generation',
      status: 'success',
      details: {
        signature: mask(signatureBase64),
        message: message,
        timestamp: timestamp,
        method: method,
        path: requestPath
      }
    }, requestId);
    
    return signatureBase64;
  } catch (error) {
    // Log signature generation error
    createLog('ERROR', {
      operation: 'Signature Generation',
      status: 'failed',
      details: {
        error: error.message,
        timestamp: timestamp,
        method: method,
        path: requestPath
      }
    }, requestId);
    
    // Re-throw to allow error handling in calling functions
    throw new Error(`Signature generation failed: ${error.message}`);
  }
}

/**
 * Generates a valid client order ID (clOrdId)
 * @param {string} strategyId - Strategy identifier
 * @param {string} brokerTag - Broker identification tag
 * @param {string} [batchIndex=''] - Optional batch index for batch orders
 * @param {string} [requestId='unknown'] - Request identifier
 * @returns {string} Generated client order ID
 */
function generateClOrdId(strategyId, brokerTag, batchIndex = '', requestId = 'unknown') {
  const timestamp = Date.now().toString().slice(-6); // Use last 6 digits of timestamp
  const sanitizedStrategy = (strategyId || 'default')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 6); // Shorter strategy ID
  
  createLog('TRADE', {
    operation: 'Generating client order ID',
    details: {
      strategy: strategyId,
      broker: brokerTag,
      batch: batchIndex || 'N/A'
    }
  }, requestId);
  
  // Ensure total length is under 32 chars
  return `${brokerTag}${sanitizedStrategy}${timestamp}${batchIndex}`.substring(0, 32);
}

/**
 * Parses trading pair into base and quote currencies
 * @param {string} symbol - Trading pair symbol (e.g., 'BTC-USDT')
 * @returns {Object} Object containing base and quote currencies
 */
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

/**
 * Formats trading pair based on trade type and margin type
 * @param {string} symbol - Trading pair symbol
 * @param {string} type - Trade type ('spot', 'perps', 'invperps')
 * @param {string} marginType - Margin type, defaults to 'USD'
 * @returns {string} Formatted trading pair
 */
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

/**
 * Rounds size to specified lot size
 * @param {number} size - Original size
 * @param {number} lotSize - Minimum lot size
 * @returns {number} Size rounded to lot size
 */
function roundToLotSize(size, lotSize) {
  const precision = -Math.log10(lotSize);
  const multiplier = Math.pow(10, precision);
  return Math.floor(size * multiplier) / multiplier;
}

/**
 * Calculates order size based on balance and percentage
 * @param {number} maxQty - Maximum available quantity
 * @param {string} requestedQty - Requested quantity
 * @param {number} lotSize - Lot size for trading pair
 * @returns {string} Calculated order size
 */
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

/**
 * Masks sensitive data in strings
 * @param {string} value - String to mask
 * @param {number} visible - Number of visible characters
 * @returns {string} Masked string
 */
function mask(value, visible = 4) {
  if (!value) return '';
  return value.substring(0, visible) + '...';
}

/**
 * Redacts sensitive data from objects
 * @param {Object} obj - Object containing sensitive data
 * @returns {Object} Object with sensitive data redacted
 */
function redactSensitiveData(obj) {
  if (!obj) return obj;
  
  const copy = { ...obj };
  if (copy.authToken) {
    copy.authToken = copy.authToken.substring(0, 4) + '***';
  }
  return copy;
}

/**
 * Retrieves and validates exchange credentials from environment variables.
 * 
 * @param {string} exchange - The name of the exchange (e.g., 'okx', 'binance').
 * @param {Object} env - The environment object containing API credentials.
 * @returns {Object} An object containing the API key, secret key, and passphrase.
 * @throws {Error} If any of the required credentials are missing.
 * 
 * @example
 * const credentials = getExchangeCredentials('okx', process.env);
 * // Returns: { apiKey: '...', secretKey: '...', passphrase: '...' }
 */
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

//=============================================================================
// [OKX] OKX API Integration Functions
//=============================================================================

/**
 * Makes a request to OKX API with automatic retry and rate limiting handling
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - API endpoint path
 * @param {string} body - Request body for POST requests
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} API response
 */
async function makeOkxApiRequest(method, path, body, credentials, requestId, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 2000;
  const rateLimitCodes = ['50011', '50061'];
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { headers } = await generateOkxRequest(method, path, body, credentials, requestId);
      
      const requestOptions = {
        method,
        headers
      };
      
      if (body && method !== 'GET') {
        requestOptions.body = body;
      }
      
      const url = `${OKX_API_URL}${path}`;
      const response = await fetch(url, requestOptions);
      const data = await response.json();
      
      // Check for rate limit errors
      if (rateLimitCodes.includes(data.code)) {
        const delay = data.code === '50061'
          ? baseDelay * Math.pow(2, attempt) // Sub-account limit: longer delays
          : baseDelay * Math.pow(1.5, attempt); // General rate limit: shorter delays
        
        await createLog(LOG_LEVEL.WARN,
          `Rate limit hit (${data.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          requestId,
          credentials?.apiKey
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Check for other errors in sub-data
      if (data.data && data.data[0] && rateLimitCodes.includes(data.data[0].sCode) && attempt < maxRetries - 1) {
        const delay = data.data[0].sCode === '50061'
          ? baseDelay * Math.pow(2, attempt)
          : baseDelay * Math.pow(1.5, attempt);
        
        await createLog(LOG_LEVEL.WARN,
          `API request failed with retryable error: ${data.data[0].sMsg}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          requestId,
          credentials?.apiKey
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      return data;
    } catch (error) {
      // Retry on network errors
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await createLog(LOG_LEVEL.WARN,
          `Network error: ${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          requestId,
          credentials?.apiKey
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error('Max retries exceeded');
}

/**
 * Generates common OKX request headers and signature
 * @param {string} method - HTTP method
 * @param {string} path - API endpoint path
 * @param {string} body - Request body
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @returns {Object} Headers and signed request body
 */
async function generateOkxRequest(method, path, body, credentials, requestId = 'unknown') {
  const timestamp = new Date().toISOString().split('.')[0] + 'Z';
  
  // Always include /api/v5 in signature path
  const signaturePath = path.startsWith('/api/v5') ? path : `/api/v5${path}`;
  
  // Generate signature using stringified body
  const signature = await sign(timestamp, method.toUpperCase(), signaturePath, body, credentials.secretKey, requestId);
  
  // Order headers exactly as in Python implementation
  const headers = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': credentials.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase
  };

  // No need to duplicate logging here as the sign function now provides comprehensive logs
  
  return { headers, timestamp };
}

/**
 * Gets maximum available size for trading
 * @param {string} instId - Instrument ID
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @param {Object} payload - Trade payload
 * @returns {Promise<number>} Maximum available size
 */
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
      createLog('TRADE', 'Getting futures max size', requestId);
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
        'GET',
        path + queryParams,
        '',
        credentials,
        requestId
      );

      createLog('API', `Making request to: https://www.okx.com${path}${queryParams}`, requestId);
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
    
    try {
      const data = await makeOkxApiRequest('GET', `${path}${queryParams}`, '', credentials, requestId);
      
      if (!data.data || !data.data[0]) {
        throw new Error(`No instrument data found for ${instId}`);
      }
      
      return data.data[0];
    } catch (error) {
      createLog('API', `Failed to get instrument info: ${error.message}`, requestId);
      throw error;
    }
  } catch (error) {
    createLog('API', `Failed to get max size: ${error.message}`, requestId);
    throw new Error(`Failed to get max size: ${error.message}`);
  }
}

/**
 * Gets account balance information
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @returns {Promise<Object>} Account balance details
 */
async function getAccountBalance(credentials, requestId) {
  try {
    const path = '/api/v5/account/balance';
    const { headers } = await generateOkxRequest(
      'GET',
      path,
      '',
      credentials,
      requestId
    );

    createLog('API', `Making request to: https://www.okx.com${path}`, requestId);
    createLog('API', `Headers: ${JSON.stringify(headers, null, 2)}`, requestId);

    const response = await fetch(`https://www.okx.com${path}`, {
      method: 'GET',
      headers
    });

    const text = await response.text();
    createLog('API', `Response: ${text}`, requestId);

    const data = JSON.parse(text);
    if (!response.ok || data.code === '1') {
      throw new Error(`Failed to get account balance: ${text}`);
    }

    return data.data[0];
  } catch (error) {
    createLog('API', `Failed to get account balance: ${error.message}`, requestId);
    throw error;
  }
}

/**
 * Gets instrument information
 * @param {string} instId - Instrument ID
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @returns {Promise<Object>} Instrument details
 */
async function getInstrumentInfo(instId, credentials, requestId) {
  createLog('TRADE', {
    operation: 'Getting instrument info',
    details: {
      instrument: instId,
      type: instId.includes('-SWAP') ? 'SWAP' : 'SPOT'
    }
  }, requestId);
  const path = '/api/v5/public/instruments';
  const queryParams = `?instType=${instId.includes('-SWAP') ? 'SWAP' : 'SPOT'}&instId=${instId}`;
  
  try {
    const data = await makeOkxApiRequest('GET', `${path}${queryParams}`, '', credentials, requestId);
    
    if (!data.data || !data.data[0]) {
      throw new Error(`No instrument data found for ${instId}`);
    }
    
    return data.data[0];
  } catch (error) {
    createLog('ERROR', {
      operation: 'Instrument info retrieval',
      status: 'Failed',
      details: {
        instrument: instId,
        error: error.message
      }
    }, requestId);
    throw error;
  }
}

/**
 * Gets current position information
 * @param {string} instId - Instrument ID
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @returns {Promise<Object>} Position details
 */
async function getCurrentPosition(instId, credentials, requestId) {
  try {
    const path = '/api/v5/account/positions';
    const { headers } = await generateOkxRequest(
      'GET',
      path,
      '',
      credentials,
      requestId
    );

    createLog('API', `Making request to: https://www.okx.com${path}`, requestId);
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

    createLog('TRADE', {
      operation: 'Current position',
      details: {
        instrument: instId,
        size: position.pos,
        entryPrice: position.avgPx || 'unknown',
        markPrice: position.markPx || 'unknown',
        pnl: position.pnl || '0'
      }
    }, requestId);
    return position;
  } catch (error) {
    createLog('API', `Failed to get position: ${error.message}`, requestId);
    throw error;
  }
}

/**
 * Fetches maximum size from OKX API
 * @param {string} instId - Instrument ID
 * @param {string} tdMode - Trading mode
 * @param {string} posSide - Position side
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request identifier
 * @returns {Promise<Object>} Maximum size information
 */
async function fetchMaxSize(instId, tdMode, posSide, credentials, requestId) {
  createLog('TRADE', {
    operation: 'Getting max size',
    details: {
      instrument: instId,
      mode: tdMode,
      positionSide: posSide
    }
  }, requestId);
  const path = '/api/v5/account/max-size';
  let queryParams = `?instId=${instId}&tdMode=${tdMode}`;
  
  if (posSide) {
    queryParams += `&posSide=${posSide}`;
    createLog('TRADE', `Using ${tdMode} margin with ${posSide} position`, requestId);
  }

  try {
    const data = await makeOkxApiRequest('GET', `${path}${queryParams}`, '', credentials, requestId);
    
    const maxBuy = data.data?.[0]?.maxBuy;
    const maxSell = data.data?.[0]?.maxSell;
    
    if (!maxBuy || !maxSell) {
      throw new Error(`Invalid max size response: ${JSON.stringify(data)}`);
    }
    
    createLog('TRADE', {
      operation: 'Max size response',
      details: {
        instrument: instId,
        buy: maxBuy,
        sell: maxSell
      }
    }, requestId);
    return { maxBuy, maxSell };
  } catch (error) {
    createLog('API', `Failed to get max size: ${error.message}`, requestId);
    throw error;
  }
}


//=============================================================================
// [TRADE] Trade Execution Functions
//=============================================================================

/**
 * Main trade execution router
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @returns {Promise<Object>} Trade execution response
 */
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

/**
 * Executes spot market trades
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Spot trade execution response
 */
async function executeSpotTrade(payload, credentials, brokerTag, requestId, env, dryRun = false) {
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
    createLog('TRADE', {
      operation: 'Getting instrument info',
      details: {
        instrument: instId,
        type: 'SPOT'
      }
    }, requestId);
    const instInfo = await getInstrumentInfo(instId, credentials, requestId);
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
      createLog('ERROR', {
        operation: 'Order size calculation',
        status: 'failed',
        details: {
          accountKey: mask(credentials.apiKey),
          error: sizeError.message,
          instrument: instId
        }
      }, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }
    
    // Prepare order data
    const orderData = {
      instId: instId,
      tdMode: 'cash',
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag, '', requestId),
      side: payload.side.toLowerCase(),
      sz: orderSize,
      tgtCcy: isBuy ? 'base_ccy' : 'quote_ccy'  // base_ccy for buys, quote_ccy for sells
    };

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Check both API-level and order-level success
    if (!result.successful || result.failed > 0) {
      createLog('ERROR', {
        operation: 'Spot order placement',
        status: 'failed',
        details: {
          accountKey: mask(credentials.apiKey),
          instrument: instId,
          size: orderSize,
          side: payload.side
        }
      }, requestId);
      return { successful: 0, failed: 1, sz: orderSize };
    }

    // Return explicit success with size information
    createLog('TRADE', {
      operation: 'Spot order',
      status: 'success',
      details: {
        accountKey: mask(credentials.apiKey),
        instrument: instId,
        action: payload.side.toUpperCase(),
        size: orderSize,
        maxSize: maxQty,
        mode: 'cash',
        tgtCcy: isBuy ? 'base_ccy' : 'quote_ccy',
        qty: payload.qty
      }
    }, requestId);
    return { successful: 1, failed: 0, sz: orderSize };
  } catch (error) {
    // Log unexpected errors
    createLog('ERROR', {
      operation: 'Spot order execution',
      status: 'failed',
      details: {
        accountKey: mask(credentials.apiKey),
        error: error.message,
        stack: DEBUG ? error.stack : undefined
      }
    }, requestId);
    return { successful: 0, failed: 1, sz: 0 };
  }
}

/**
 * Main perpetual futures execution function
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Perpetual futures execution response
 */
async function executePerpsOrder(payload, credentials, brokerTag, requestId, env, dryRun = false) {
  try {
    // Execute the appropriate operation based on payload
    const result = payload.closePosition
      ? await closePerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun)
      : await openPerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun);
    
    return result;
  } catch (error) {
    // Log the error at this level only if it hasn't been logged before
    if (!error.logged) {
      createLog('ERROR', `Perpetual trade execution failed: ${error.message}`, requestId, credentials.apiKey, env);
    }
    return { successful: 0, failed: 1, sz: 0 };
  }
}

/**
 * Opens a perpetual futures position
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Position opening response
 */
async function openPerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun = false) {
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
    createLog('TRADE', {
      operation: 'Getting instrument info',
      details: {
        instrument: instId,
        type: 'PERPS'
      }
    }, requestId);
    const instInfo = await getInstrumentInfo(instId, credentials, requestId);
    
    if (!instInfo || !instInfo.lotSz) {
      throw new Error(`Failed to get lot size for ${instId}`);
    }

    // Set leverage for opening position
    const posSide = payload.side.toLowerCase() === 'buy' ? 'long' : 'short';
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
    
    try {
      if (payload.qty.includes('%')) {
        orderSize = calculateOrderSize(maxQty, payload.qty, instInfo.lotSz);
      } else {
        orderSize = roundToLotSize(parseFloat(payload.qty), instInfo.lotSz).toString();
      }

      if (isNaN(parseFloat(orderSize)) || parseFloat(orderSize) <= 0) {
        throw new Error(`Invalid order size: ${orderSize}`);
      }
    } catch (sizeError) {
      createLog('ERROR', {
        operation: 'Order size calculation',
        status: 'failed',
        details: {
          accountKey: mask(credentials.apiKey),
          error: sizeError.message,
          instrument: instId
        }
      }, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }
    
    // Prepare order data
    const orderData = {
      instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag, '', requestId),
      posSide: posSide,
      side: payload.side.toLowerCase(),
      sz: orderSize
    };

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Return success with size information
    createLog('TRADE', {
      operation: 'Perps order',
      status: 'success',
      details: {
        accountKey: mask(credentials.apiKey),
        instrument: instId,
        action: 'Open Position',
        size: orderSize,
        maxSize: maxQty,
        mode: payload.marginMode,
        leverage: payload.leverage,
        qty: payload.qty
      }
    }, requestId);
    return { successful: result.successful, failed: result.failed, sz: orderSize };
  } catch (error) {
    createLog('ERROR', `Failed to open USDT Perpetual position: ${error.message}`, requestId, credentials.apiKey, env);
    throw error;
  }
}

/**
 * Closes a perpetual futures position
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Position closing response
 */
async function closePerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun = false) {
  // Validate required parameters for closing position
  if (!payload.symbol || !payload.marginMode) {
    throw new Error('Missing required parameters: symbol and marginMode are required for closing position');
  }

  // Validate margin mode
  if (!['cross', 'isolated'].includes(payload.marginMode)) {
    throw new Error('Invalid marginMode: must be either cross or isolated');
  }

  // Trade logging messages to collect for group log
  const tradeLogMessages = [];
  const instId = payload.symbol;

  try {
    // Get current position details
    tradeLogMessages.push(`Retrieving current position for ${instId}`);
    const position = await getCurrentPosition(instId, credentials, requestId);
    
    if (!position || !position.pos) {
      // No position to close is a success case (idempotency)
      tradeLogMessages.push(`No open position found for ${instId}`);
      logGroup('TRADE', `Position Closing - ${instId} (No Position)`, tradeLogMessages, requestId, credentials.apiKey);
      return { successful: 1, failed: 0, sz: 0 };
    }

    // Determine close order parameters based on position side
    const positionSize = parseFloat(position.pos);
    const isLong = position.posSide === 'long';
    const side = isLong ? 'sell' : 'buy';
    
    tradeLogMessages.push(`Closing ${isLong ? 'long' : 'short'} position of size ${Math.abs(positionSize)} with ${side} order`);
    
    // Use raw contract size directly from position (absolute value)
    const orderSize = Math.abs(positionSize).toString();

    tradeLogMessages.push(`Closing ${position.posSide} position for ${instId} with size ${orderSize} using ${side} order`);
    tradeLogMessages.push(`Entry price: ${position.avgPx || 'unknown'}, Mark price: ${position.markPx || 'unknown'}, PnL: ${position.pnl || '0'}`);

    // Log the grouped messages for position retrieval and preparation
    logGroup('TRADE', `Position Closing - ${instId} (Preparation)`, tradeLogMessages, requestId, credentials.apiKey);

    // Prepare close order data
    const orderData = {
      instId: instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag, '', requestId),
      posSide: position.posSide,
      side: side,
      sz: orderSize,
      closePosition: true
    };

    // If dryRun, return the order data without executing
    if (dryRun) {
      createLog('TRADE', `DRY RUN - order data prepared but not executed for ${instId}`, requestId);
      return { orderData };
    }

    // Place single order
    createLog('TRADE', `Executing order to close ${position.posSide} position for ${instId}`, requestId);
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Return success with size information
    createLog('TRADE', formatTradeLogMessage(
      'PERP_CLOSE',
      'Close Position',
      {
        symbol: instId,
        size: orderSize,
        mode: payload.marginMode
      },
      position
    ), requestId, credentials.apiKey);
    
    // Log successful order placement
    logGroup('TRADE', `Position Closing - ${instId} (Success)`, [
      `Position closed successfully`,
      `Order size: ${orderSize}`,
      `Position side: ${position.posSide}`,
      `Order side: ${side}`,
      `Result: ${JSON.stringify(result)}`
    ], requestId, credentials.apiKey);
    
    return { successful: result.successful, failed: result.failed, sz: orderSize };
  } catch (error) {
    // Only log errors that haven't been logged before
    if (!error.logged && !error.message.includes('Order placed')) {
      createLog('ERROR', `Failed to close position: ${error.message}`, requestId, credentials.apiKey, env);
      error.logged = true;
      
      // Group log for error case
      logGroup('ERROR', `Position Closing Error - ${instId}`, [
        ...tradeLogMessages,
        `Error: ${error.message}`
      ], requestId, credentials.apiKey);
    }
    return { successful: 0, failed: 1 };
  }
}

/**
 * Main inverse perpetual execution function
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Inverse perpetual execution response
 */
async function executeInvPerpsOrder(payload, credentials, brokerTag, requestId, env, dryRun = false) {
  try {
    if (payload.closePosition) {
      return closeInvPerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun);
    }
    return openInvPerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun);
  } catch (error) {
    createLog('ERROR', `Inverse perpetual trade execution failed: ${error.message}`, requestId, credentials.apiKey, env);
    throw error;
  }
}

/**
 * Opens an inverse perpetual position
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Position opening response
 */
async function openInvPerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun = false) {
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
    const instInfo = await getInstrumentInfo(instId, credentials, requestId);
    if (!instInfo || !instInfo.lotSz) {
      createLog('TRADE', `Failed to get instrument info for ${instId}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    // Set leverage for opening position
    const posSide = payload.side.toLowerCase() === 'buy' ? 'long' : 'short';
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
      createLog('ERROR', {
        operation: 'Order size calculation',
        status: 'failed',
        details: {
          accountKey: mask(credentials.apiKey),
          error: sizeError.message,
          instrument: instId
        }
      }, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    // Prepare order data
    const orderData = {
      instId: instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag, '', requestId),
      posSide: posSide,
      side: payload.side.toLowerCase(),
      sz: orderSize
    };

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Return success with size information
    createLog('TRADE', {
      operation: 'InvPerps order',
      status: 'success',
      details: {
        accountKey: mask(credentials.apiKey),
        instrument: instId,
        action: 'Open Position',
        size: orderSize,
        maxSize: maxQty,
        mode: payload.marginMode,
        leverage: payload.leverage,
        qty: payload.qty
      }
    }, requestId);
    return { successful: result.successful, failed: result.failed, sz: orderSize };
  } catch (error) {
    // Log unexpected errors
    createLog('TRADE', `Unexpected error in inverse perpetual position opening: ${error.message}`, requestId, credentials.apiKey, env);
    return { successful: 0, failed: 1, sz: 0 };
  }
}

/**
 * Closes an inverse perpetual futures position
 * @param {Object} payload - Trade payload
 * @param {Object} credentials - API credentials
 * @param {string} brokerTag - Broker identification tag
 * @param {string} requestId - Request identifier
 * @param {Object} env - Environment variables
 * @param {boolean} [dryRun=false] - If true, return order data without executing
 * @returns {Promise<Object>} Position closing response
 */
async function closeInvPerpsPosition(payload, credentials, brokerTag, requestId, env, dryRun = false) {
  // Validate required parameters
  if (!payload.symbol || !payload.marginMode) {
    createLog('TRADE', 'Missing required parameters: symbol and marginMode are required', requestId);
    return { successful: 0, failed: 1, sz: 0 };
  }

  // Trade logging messages to collect for group log
  const tradeLogMessages = [];
  // Format the instId outside the try block to ensure it's in scope for the entire function
  const instId = formatTradingPair(payload.symbol, 'invperps');

  try {
    // Get current position details
    tradeLogMessages.push(`Retrieving current position for ${instId}`);
    const position = await getCurrentPosition(instId, credentials, requestId);
    
    if (!position || !position.pos) {
      tradeLogMessages.push(`No open position found for ${instId}`);
      logGroup('TRADE', `Position Closing - ${instId} (No Position)`, tradeLogMessages, requestId, credentials.apiKey);
      return { successful: 1, failed: 0, sz: 0 }; // Return success for idempotency
    }

    // For inverse perpetual contracts:
    // - To close a long position (posSide='long'): use side='sell'
    // - To close a short position (posSide='short'): use side='buy'
    const side = position.posSide === 'long' ? 'sell' : 'buy';
    const orderSize = Math.abs(parseFloat(position.pos)).toString();

    tradeLogMessages.push(`Closing ${position.posSide === 'long' ? 'long' : 'short'} position of size ${orderSize} with ${side} order`);
    tradeLogMessages.push(`Closing ${position.posSide} position for ${instId} with size ${orderSize} using ${side} order`);
    tradeLogMessages.push(`Entry price: ${position.avgPx || 'unknown'}, Mark price: ${position.markPx || 'unknown'}, PnL: ${position.pnl || '0'}`);

    // Log the grouped messages for position details
    logGroup('TRADE', `Position Closing - ${instId}`, tradeLogMessages, requestId, credentials.apiKey);

    // Prepare close order data
    const orderData = {
      instId: instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag, '', requestId),
      posSide: position.posSide,
      side: side,
      sz: orderSize,
      closePosition: true
    };

    // If dryRun, return the order data without executing
    if (dryRun) {
      logGroup('TRADE', `Position Closing - ${instId} (DRY RUN)`, [
        ...tradeLogMessages,
        `DRY RUN - no order executed`
      ], requestId, credentials.apiKey);
      return { orderData };
    }

    // Place single order
    createLog('TRADE', `Executing ${side} order to close position`, requestId);
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Log success group
    logGroup('TRADE', `Position Closing - ${instId} (Success)`, [
      ...tradeLogMessages,
      `Order executed successfully: ${JSON.stringify(result)}`
    ], requestId, credentials.apiKey);

    // Log using consistent format with masked API key
    createLog('TRADE', formatTradeLogMessage(
      'INV_PERP_CLOSE',
      'Close Position',
      {
        symbol: instId,
        size: orderSize,
        mode: payload.marginMode
      },
      position
    ), requestId, credentials.apiKey);
    
    // Use original return format
    return { result: null, successful: result.successful, failed: result.failed };
  } catch (error) {
    // Log error
    createLog('ERROR', `Failed to close inverse perpetual position: ${error.message}`, requestId, credentials.apiKey);
    
    // Add grouped error log if we've collected messages
    logGroup('ERROR', `Position Closing Error - ${instId}`, [
      ...tradeLogMessages,
      `Error: ${error.message}`
    ], requestId, credentials.apiKey);
    
    // Return original format for errors instead of throwing
    return { result: null, successful: 0, failed: 1 };
  }
}

/**
 * Place a single order
 * @param {Object} orderData - Order data
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request ID
 * @param {Object} env - Environment variables
 * @returns {Promise<Object>} Order result
 */
async function placeOrder(orderData, credentials, requestId, env) {
  // Check if this is a dry run by examining the orderData object
  if (orderData.dryRun) {
    await createLog(LOG_LEVEL.INFO, `DRY RUN: Would place order: ${JSON.stringify(orderData)}`, requestId, credentials.apiKey);
    return { successful: 1, failed: 0, dryRun: true };
  }
  
  const path = '/api/v5/trade/order';
  const body = JSON.stringify(orderData);
  
  try {
    const data = await makeOkxApiRequest('POST', path, body, credentials, requestId);
    
    if (data.data && data.data[0]) {
      const result = data.data[0];
      if (result.sCode === '0') {
        await createLog(LOG_LEVEL.TRADE,
          `Order successful: ${orderData.sz} contracts`,
          requestId,
          credentials.apiKey
        );
        return { successful: 1, failed: 0 };
      } else {
        await createLog(LOG_LEVEL.ERROR,
          `Order failed: ${result.sMsg}`,
          requestId,
          credentials.apiKey
        );
        return { successful: 0, failed: 1, error: result.sMsg };
      }
    }
    return { successful: 0, failed: 1, error: 'No response data' };
  } catch (error) {
    await createLog(LOG_LEVEL.ERROR,
      `Order placement failed: ${error.message}`,
      requestId,
      credentials.apiKey
    );
    return { successful: 0, failed: 1, error: error.message };
  }
}

/**
 * Trade response validation
 * @param {Object} response - Trade response
 * @returns {Object} Validation result
 */
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

/**
 * Leverage setting
 * @param {Object} data - Leverage configuration
 * @param {Object} credentials - API credentials
 * @param {string} requestId - Request ID
 * @param {Object} env - Environment variables
 * @returns {void}
 */
async function setLeverage(data, credentials, requestId, env) {
  await createLog(LOG_LEVEL.INFO, `Setting leverage to ${data.lever}x for ${data.instId}`, requestId, credentials.apiKey, env);
  
  const path = '/api/v5/account/set-leverage';
  const body = JSON.stringify(data);
  const { headers } = await generateOkxRequest(
    'POST',
    path,
    body,
    credentials,
    requestId
  );

  const response = await fetch(`${OKX_API_URL}${path}`, {
    method: 'POST',
    headers,
    body
  });

  const result = await response.json();
  await createLog(LOG_LEVEL.DEBUG, `Leverage response: ${JSON.stringify(redactSensitiveData(result))}`, requestId, credentials.apiKey, env);

  if (result.code !== '0') {
    throw new Error(`Failed to set leverage: ${result.msg}`);
  }
}

/**
 * Multi-account trade execution
 * @param {Object} payload - Trade payload
 * @param {Array} apiKeys - API keys for accounts
 * @param {string} brokerTag - Broker tag
 * @param {string} requestId - Request ID
 * @param {Object} env - Environment variables
 * @returns {Promise<Object>} Trade execution result
 */
async function executeMultiAccountTrades(payload, apiKeys, brokerTag, requestId, env) {
  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalSize = 0;
  let allOrders = [];  // Move allOrders declaration to outer scope

  try {
    const preparedOrders = [];
    
    createLog('TRADE', {
      operation: 'Starting multi-account trade execution',
      details: { accounts: apiKeys.length }
    }, requestId);
    
    // First, collect all orders using dryRun
    for (const account of apiKeys) {
      // Map database credential format to expected format
      const credentials = {
        apiKey: account.api_key || account.apiKey,
        secretKey: account.secret_key || account.secretKey,
        passphrase: account.passphrase
      };

  // Validate credentials
  if (!credentials.apiKey || !credentials.secretKey || !credentials.passphrase) {
    const accountId = credentials.apiKey ? credentials.apiKey.substring(0, 4) : 'unknown';
    const errorMsg = 'Invalid credentials: missing required fields';
    createLog('ERROR', {
      operation: 'Credential validation',
      status: 'failed',
      details: {
        accountKey: mask(credentials.apiKey),
        reason: errorMsg
      }
    }, requestId);
    
    // Add failed order to allOrders for credential issues
    allOrders.push({
      success: false,
      order: {
        accountId,
        symbol: payload.symbol
      },
      credentials,
      error: errorMsg
    });
    
    totalFailed++;
    continue;
  }

      let result;
      try {
        // Prepare order based on trade type
        if (payload.type === 'spot') {
          result = await executeSpotTrade(payload, credentials, brokerTag, requestId, env, true);
        } else if (payload.type === 'perps') {
          result = await executePerpsOrder(payload, credentials, brokerTag, requestId, env, true);
        } else if (payload.type === 'invperps') {
          result = await executeInvPerpsOrder(payload, credentials, brokerTag, requestId, env, true);
        } else {
          throw new Error(`Unsupported trade type: ${payload.type}`);
        }

        if (result && result.orderData) {
          // Add account info to order data for logging
          result.orderData.accountId = credentials.apiKey.substring(0, 4);
          // Add dryRun flag to the order data if it exists in the payload
          if (payload.dryRun) {
            result.orderData.dryRun = true;
          }
          allOrders.push({ order: result.orderData, credentials, success: true });
          createLog('TRADE', {
            operation: 'Order preparation',
            status: 'success',
            details: {
              accountKey: mask(credentials.apiKey),
              size: result.orderData.sz || '0'
            }
          }, requestId);
        } else {
          const accountId = credentials.apiKey.substring(0, 4);
          const errorMsg = 'Order preparation failed: no order data returned';
          createLog('ERROR', {
            operation: 'Order preparation',
            status: 'failed',
            details: {
              accountKey: mask(credentials.apiKey),
              reason: errorMsg
            }
          }, requestId);
          
          // Add failed order to allOrders
          allOrders.push({
            success: false,
            order: {
              accountId,
              symbol: payload.symbol
            },
            credentials,
            error: errorMsg
          });
          
          totalFailed++;
        }
      } catch (error) {
        const accountId = credentials.apiKey.substring(0, 4);
        createLog('ERROR', {
          operation: 'Order preparation',
          status: 'failed',
          details: {
            accountKey: mask(credentials.apiKey),
            reason: error.message
          }
        }, requestId);
        
        // Add failed order to allOrders for proper tracking
        allOrders.push({
          success: false,
          order: {
            accountId,
            symbol: payload.symbol
          },
          credentials,
          error: error.message
        });
        
        totalFailed++;
      }
    }

    if (allOrders.length === 0) {
      createLog('TRADE', {
        operation: 'Order execution',
        status: 'skipped',
        details: { reason: 'No valid orders to execute' }
      }, requestId);
      return { successful: 0, failed: totalFailed, sz: 0 };
    }

    createLog('TRADE', {
      operation: 'Executing orders',
      details: { count: allOrders.length }
    }, requestId);

    // Execute each order individually
    for (const orderObj of allOrders) {
      try {
        const result = await placeOrder(orderObj.order, orderObj.credentials, requestId, env);
        
        if (result.successful) {
          totalSuccessful++;
          totalSize += parseFloat(orderObj.order.sz || 0);
          createLog('TRADE', {
            operation: 'Order execution',
            status: 'success',
            details: {
              accountKey: mask(orderObj.credentials.apiKey),
              size: orderObj.order.sz || '0'
            }
          }, requestId);
          allOrders[allOrders.indexOf(orderObj)].success = true;
        } else {
          totalFailed++;
          const errorMsg = result.error || 'Unknown error';
          createLog('ERROR', {
            operation: 'Order execution',
            status: 'failed',
            details: {
              accountKey: mask(orderObj.credentials.apiKey),
              reason: errorMsg
            }
          }, requestId);
          allOrders[allOrders.indexOf(orderObj)].success = false;
          allOrders[allOrders.indexOf(orderObj)].error = errorMsg;
        }
      } catch (error) {
        createLog('ERROR', {
          operation: 'Order execution',
          status: 'failed',
          details: {
            accountKey: mask(orderObj.credentials.apiKey),
            reason: error.message
          }
        }, requestId);
        totalFailed++;
        allOrders[allOrders.indexOf(orderObj)].success = false;
        allOrders[allOrders.indexOf(orderObj)].error = error.message;
      }
    }

    // Create detailed summary
    const summary = {
      'Total Accounts': apiKeys.length,
      'Successful Orders': totalSuccessful,
      'Failed Orders': totalFailed,
      'Total Size': totalSize.toFixed(8),
      Type: payload.type.toUpperCase(),
      Symbol: payload.symbol
    };

    createLog('TRADE', {
      operation: 'Trade summary',
      status: 'success',
      details: summary
    }, requestId);

    const result = {
      successful: totalSuccessful,
      failed: totalFailed,
      sz: totalSize.toFixed(8)
    };

    // Send Telegram notification
    try {
      const failedOrders = allOrders.filter(o => !o.success);
      createLog('DEBUG', `Found ${failedOrders.length} failed orders for request ${requestId}`, requestId);
      
      const telegramMsg = formatTradeMessage({
        symbol: payload.symbol,
        side: payload.closePosition ? 'CLOSE' : (payload.side || 'SELL'), // Set side explicitly for close positions
        requestId,
        totalAccounts: apiKeys.length,
        successCount: totalSuccessful,
        failedAccounts: failedOrders.map(order => ({
          id: order.order.accountId,
          error: order.error
        })),
        totalVolume: totalSize.toFixed(8),
        errors: totalSuccessful === apiKeys.length ? [] : ['Trade partially failed'],
        closePosition: !!payload.closePosition,  // Ensure boolean
        leverage: payload.leverage || 1,
        marginMode: payload.marginMode || 'cash',
        entryPrice: allOrders[0]?.order?.px || null,
        pnl: null  // Simplest fix: just pass null for now
      });
      
      if (telegramMsg) {
        await sendTelegramMessage(telegramMsg.type, telegramMsg.message, env);
      }
    } catch (error) {
      createLog('ERROR', `Failed to send notification: ${error.message}`, requestId);
    }

    return result;
  } catch (error) {
    const result = {
      successful: totalSuccessful,
      failed: totalFailed,
      sz: totalSize.toFixed(8)
    };

    // Send Telegram notification for error
    try {
      const telegramMsg = formatTradeMessage({
        symbol: payload.symbol,
        side: payload.closePosition ? 'CLOSE' : (payload.side || 'SELL'), // Set side explicitly for close positions
        requestId,
        totalAccounts: apiKeys.length,
        successCount: totalSuccessful,
        failedAccounts: allOrders.filter(o => !o.success).map(order => ({
          id: order.order.accountId,
          error: order.error
        })),
        errors: [error.message],
        closePosition: !!payload.closePosition,  // Ensure boolean
        leverage: payload.leverage || 1,
        marginMode: payload.marginMode || 'cash',
        entryPrice: allOrders[0]?.order?.px || null
      });
      const failedOrders = allOrders.filter(o => !o.success).map(order => ({
        id: order.order.accountId,
        error: order.error
      }));
      if (telegramMsg) {
        await sendTelegramMessage(telegramMsg.type, telegramMsg.message, env);
      }
    } catch (telegramError) {
      createLog('ERROR', `Failed to send error notification: ${telegramError.message}`, requestId);
    }

    return result;
  }
}

//=============================================================================
// [DB] Database Functions
//=============================================================================

/**
 * Retrieves API keys from database
 * @param {Object} env - Environment variables
 * @param {string} requestId - Request ID
 * @param {string} exchange - Exchange name
 * @returns {Array} API keys
 */
async function getApiKeys(env, requestId, exchange) {
  if (!exchange) {
    await createLog(LOG_LEVEL.INFO, 'No exchange provided to getApiKeys', requestId, null, env);
    throw new Error('Exchange parameter is required');
  }

  // Normalize exchange name to uppercase
  const normalizedExchange = exchange.toUpperCase();
  await createLog(LOG_LEVEL.INFO, `Fetching API keys for ${normalizedExchange} from database`, requestId, null, env);
  
  try {
    const stmt = await env.DB.prepare(
      'SELECT api_key, secret_key, passphrase FROM api_keys WHERE exchange = ?'
    ).bind(normalizedExchange)
    .all();
    
    if (!stmt.results || stmt.results.length === 0) {
      const error = `No trading API keys found for ${normalizedExchange}`;
      await createLog(LOG_LEVEL.INFO, error, requestId, null, env);
      throw new Error(error);
    }
    
    // Debug log (first 4 chars only)
    for (const [index, key] of stmt.results.entries()) {
      await createLog(LOG_LEVEL.INFO, 
        `Key ${index + 1}: API=${mask(key.api_key)}, Secret=${mask(key.secret_key)}, Pass=${mask(key.passphrase)}`, 
        requestId, 
        null, 
        env
      );
    }
    
    return stmt.results;
  } catch (error) {
    const errorMsg = error.message.includes('No trading API keys') 
      ? error.message 
      : `Database error while fetching ${normalizedExchange} keys: ${error.message}`;
    await createLog(LOG_LEVEL.INFO, errorMsg, requestId, null, env);
    throw new Error(errorMsg);
  }
}

//=============================================================================
// [LOGGING] Logging Functions
//=============================================================================

/**
 * Log levels enum for consistent level usage
 * @readonly
 * @enum {string}
 */
const LOG_LEVEL = {
  ERROR: 'ERROR',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  TRADE: 'TRADE'
};

/**
 * Format number with thousands separator
 * @param {number} num Number to format
 * @returns {string} Formatted number
 */
function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Get base and quote currency from symbol
 * @param {string} symbol Trading symbol (e.g., BTC-USDT)
 * @returns {Object} Object containing base and quote currencies
 */
function parseSymbol(symbol) {
  const [base, quote] = symbol.split('-');
  return { base, quote };
}

/**
 * Formats trade details based on trade type
 * @param {string} type Trade type (SPOT, PERP, INV_PERP)
 * @param {Object} details Trade details
 * @returns {Object} Formatted trade details
 */
function formatTradeDetails(type, details) {
  // If dealing with a multi-account summary, return details as is
  if (type === 'MULTI_ACCOUNT') {
    return details;
  }

  // Safely retrieve the symbol from details (support both lowercase and uppercase keys)
  const sym = details.symbol || details.Symbol;
  if (!sym) return details;
  
  const { base, quote } = parseSymbol(sym);

  // Provide fallback values to avoid undefined variables
  const size = details.size || 0;
  const price = details.price || 0;
  const maxSize = details.maxSize || 1; // Avoid division by zero
  const percentageUsed = details.qty?.includes('%') ? 
    details.qty : 
    `${(parseFloat(size) / parseFloat(maxSize) * 100).toFixed(2)}%`;

  switch(type) {
    case 'SPOT': {
      const isBaseSize = details.tgtCcy === 'base_ccy';
      const baseAmount = isBaseSize ? size : (price ? size / price : 0);
      const quoteAmount = isBaseSize ? (price ? size * price : 0) : size;
      
      return {
        Symbol: sym,
        Amount: isBaseSize ? 
          `${formatNumber(baseAmount)} ${base}` :
          `${formatNumber(quoteAmount)} ${quote}`,
        Price: `${formatNumber(price)} ${quote}`,
        Value: isBaseSize ?
          `~${formatNumber(quoteAmount)} ${quote}` :
          `~${formatNumber(baseAmount)} ${base}`,
        'Max Available': isBaseSize ?
          `${formatNumber(maxSize)} ${base}` :
          `${formatNumber(maxSize)} ${quote}`,
        'Percentage Used': percentageUsed,
        Mode: details.mode
      };
    }
    case 'PERP': {
      const leverage = details.leverage || 1;  // Safe fallback for leverage
      const notionalValue = size * price;
      const requiredMargin = notionalValue / leverage;
      
      return {
        Symbol: sym,
        'Position Size': `${formatNumber(size)} contracts (1x = 1 ${base})`,
        'Notional Value': `~${formatNumber(notionalValue)} ${quote}`,
        Leverage: leverage ? `${leverage}x` : 'cross',
        'Required Margin': `~${formatNumber(requiredMargin)} ${quote}`,
        Mode: details.mode
      };
    }
    case 'INV_PERP': {
      const contractValue = 100; // USD per contract
      const leverage = details.leverage || 1;  // Safe fallback for leverage
      const notionalUsd = size * contractValue;
      const btcMargin = price ? (notionalUsd / price) / leverage : 0;
      
      return {
        Symbol: sym,
        'Position Size': `${formatNumber(size)} contracts (1x = ${contractValue} USD)`,
        'Notional Value': `~${formatNumber(notionalUsd)} USD`,
        Leverage: leverage ? `${leverage}x` : 'cross',
        'Required Margin': `~${formatNumber(btcMargin)} ${base}`,
        Mode: details.mode
      };
    }
    default:
      return details;
  }
}

/**
 * Formats authentication log message
 * @param {string} method - HTTP method
 * @param {string} path - API endpoint path
 * @param {Object} params - Request parameters
 * @returns {string} Formatted authentication log message
 */
function formatAuthLogMessage(method, path, params) {
  // Only log essential auth details
  return `\n  Request: ${method} ${path}${
    Object.keys(params).length ? 
    `\n  Essential Params: ${['instId', 'tdMode', 'side', 'sz'].map(key => 
      params[key] ? `${key}=${params[key]}` : null
    ).filter(Boolean).join(', ')}` : 
    ''
  }`;
}

/**
 * Formats a trade log message with improved details
 * @param {string} type Trade type
 * @param {string} action Trade action
 * @param {Object} details Trade details
 * @param {Object} [position=null] Position details
 * @returns {string} Formatted trade log message
 */
function formatTradeLogMessage(type, action, details, position = null) {
  let message = `\n  ${type} ${action}:`;
  
  if (position) {
    const { base, quote } = parseSymbol(details.symbol);
    const currency = type === 'INV_PERP' ? base : quote;
    
    message += `
    Position:
    - Size: ${formatNumber(position.pos, 4)} contracts
    - Entry Price: ${formatNumber(position.avgPx, 2)} ${currency}
    - Mark Price: ${formatNumber(position.markPx, 2)} ${currency}
    - PnL: ${formatNumber(position.pnl, 4)} ${currency}`;
  }

  const formattedDetails = formatTradeDetails(type.replace('_CLOSE', ''), details);
  message += `\n    Details:`;
  Object.entries(formattedDetails).forEach(([key, value]) => {
    message += `\n    - ${key}: ${value}`;
  });
  
  return message;
}

/**
 * Creates a standardized log entry with proper formatting
 * @param {LOG_LEVEL} level - Log level (INFO, TRADE, ERROR, etc.)
 * @param {string|Object} message - Log message or structured log object
 * @param {string} requestId - Request identifier
 * @param {string} [apiKey] - Optional API key
 * @param {Object} [env] - Environment variables
 * @returns {Object} The log object that was created
 */
function createLog(level, message, requestId, apiKey = '', env = null) {
  const shortRequestId = requestId ? requestId.substring(0, 8) : '--------';
  
  // Add transaction path for easier tracing
  let transactionPath = '';
  
  // First check the type of message to avoid calling string methods on objects
  if (typeof message === 'object' && message !== null && !(message instanceof Error)) {
    // For object messages, try to extract transaction path from operation field
    const { operation = '' } = message;
    
    if (operation.includes('instrument info')) {
      transactionPath = 'FETCH_INSTRUMENT';
    } else if (operation.includes('max size')) {
      transactionPath = 'FETCH_MAX_SIZE';
    } else if (operation.includes('request')) {
      transactionPath = 'AUTH_REQUEST';
    } else if (operation.includes('Order') && !operation.includes('successful')) {
      transactionPath = 'ORDER_PROCESS';
    } else if (operation.includes('executed successfully')) {
      transactionPath = 'ORDER_SUCCESS';
    } else if (operation.includes('failed')) {
      transactionPath = 'ORDER_FAILURE';
    } else if (operation.includes('validation')) {
      transactionPath = 'VALIDATION';
    } else if (operation.includes('Received')) {
      transactionPath = 'REQUEST_RECEIVED';
    }
  } else if (typeof message === 'string') {
    // Extract transaction path from string message
    if (message.includes('Getting instrument info')) {
      transactionPath = 'FETCH_INSTRUMENT';
    } else if (message.includes('Getting max size')) {
      transactionPath = 'FETCH_MAX_SIZE';
    } else if (message.includes('Generating request')) {
      transactionPath = 'AUTH_REQUEST';
    } else if (message.includes('Order') && !message.includes('successful')) {
      transactionPath = 'ORDER_PROCESS';
    } else if (message.includes('executed successfully')) {
      transactionPath = 'ORDER_SUCCESS';
    } else if (message.includes('failed')) {
      transactionPath = 'ORDER_FAILURE';
    } else if (message.includes('validation')) {
      transactionPath = 'VALIDATION';
    } else if (message.includes('Received')) {
      transactionPath = 'REQUEST_RECEIVED';
    }
  }
  
  // Add API key context if available
  let apiContext = '';
  if (apiKey) {
    apiContext = `[${apiKey.substring(0, 4)}...]`;
  }
  
  const pathInfo = transactionPath ? `[${transactionPath}]` : '';
  
  // Handle object messages for structured logging
  let formattedMessage;
  if (typeof message === 'object' && message !== null && !(message instanceof Error)) {
    const { operation, status, details = {} } = message;
    let baseMessage = `${operation || 'Operation'}${status ? ` ${status}` : ''}`;
    
    // Add details as indented key-value pairs if present
    if (Object.keys(details).length > 0) {
      baseMessage += ':\n  - ' + Object.entries(details)
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join('\n  - ');
    }
    formattedMessage = `[${level}][${shortRequestId}]${pathInfo}${apiContext} ${baseMessage}`;
  } else {
    formattedMessage = `[${level}][${shortRequestId}]${pathInfo}${apiContext} ${message}`;
  }
  
  // Create structured log object
  const logObject = {
    timestamp: new Date().toISOString(),
    level,
    message: formattedMessage,
    requestId: requestId || 'unknown',
    context: {}
  };
  
  // Add API key if provided (with masking)
  if (apiKey) {
    logObject.context.apiKey = mask(apiKey);
  }
  
  // Add environment-specific fields if available
  if (env) {
    if (env.BROKER_TAG_OKX) {
      logObject.context.brokerTag = env.BROKER_TAG_OKX;
    }
    
    // Try to extract request info if available in current execution context
    try {
      if (env.executionCtx && env.executionCtx.request) {
        const request = env.executionCtx.request;
        logObject.context.ip = request.headers.get('cf-connecting-ip');
        logObject.context.userAgent = request.headers.get('user-agent');
        logObject.context.url = request.url;
        logObject.context.method = request.method;
      }
    } catch (e) {
      // Silently continue if we can't access execution context
    }
  }
  
  // For error logs, try to extract stack trace if available
  if (level === 'ERROR' && message instanceof Error) {
    logObject.context.errorName = message.name;
    logObject.message = `[${level}][${shortRequestId}]${pathInfo} ${message.message}`;
    logObject.context.stack = message.stack;
  }
  
  // Output as JSON string
  const logString = JSON.stringify(logObject);
  
  // Use appropriate console method based on level
  if (level === 'ERROR') {
    console.error(logString);
  } else {
    console.log(logString);
  }
  
  // Return the object for potential further processing
  return logObject;
}

/**
 * Groups related log messages into a single structured log entry
 * @param {LOG_LEVEL} level - Log level (INFO, TRADE, ERROR, etc.)
 * @param {string} groupTitle - Title for the group of messages
 * @param {string[]} messages - Array of related messages
 * @param {string} requestId - Request identifier
 * @param {string} [apiKey] - Optional API key
 * @param {Object} [env] - Environment variables
 * @returns {Object} The log object that was created
 */
function logGroup(level, groupTitle, messages, requestId = 'unknown', apiKey = '', env = null) {
  const formattedMessages = messages
    .map(msg => `  - ${msg}`)
    .join('\n');
  
  return createLog(level, `${groupTitle}:\n${formattedMessages}`, requestId, apiKey, env);
}

//=============================================================================
// [ROUTER] API Route Handlers
//=============================================================================

// IP validation middleware - MUST BE FIRST!
router.all('*', async (request, env) => {
  // Generate a request ID and store it in the request object for later handlers
  const requestId = crypto.randomUUID();
  // Store in a custom property for downstream handlers
  request.ctx = request.ctx || {};
  request.ctx.requestId = requestId;
  
  const clientIp = request.headers.get('cf-connecting-ip');
  
  // Log the incoming request
  await createLog(LOG_LEVEL.INFO, {
    operation: 'Webhook request',
    status: 'received',
    details: {
      clientIp,
      userAgent: request.headers.get('user-agent') || 'unknown'
    }
  }, requestId, null, env);
  
  // IP validation as the first step before any processing
  const ipAllowed = isAllowedIp(clientIp);
  
  // Log the IP validation result
  await createLog(
    ipAllowed ? LOG_LEVEL.INFO : LOG_LEVEL.ERROR,
    {
      operation: 'IP validation',
      status: ipAllowed ? 'passed' : 'failed',
      details: {
        clientIp
      }
    },
    requestId,
    null,
    env
  );
  
  if (!ipAllowed) {
    // Log additional security details
    await createLog(LOG_LEVEL.ERROR, 
      {
        operation: 'Security alert',
        status: 'Unauthorized access attempt',
        details: {
          clientIp,
          userAgent: request.headers.get('user-agent')
        }
      },
      requestId,
      null,
      env
    );
    
    return new Response(JSON.stringify({
      status: 'error',
      message: 'Forbidden: IP not authorized',
      requestId
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // If IP is allowed, continue to the next handler
  return null;
});

/**
 * Main webhook endpoint handler
 * @returns {Response} Webhook processing response
 */
router.post('/', async (request, env) => {
  // Use the requestId from the middleware
  const requestId = request.ctx?.requestId || crypto.randomUUID();
  
  try {
    const payload = await request.json();
    await createLog(LOG_LEVEL.INFO, {
      operation: 'Webhook payload',
      status: 'processing',
      details: redactSensitiveData(payload)
    }, requestId, null, env);
    
    // Token validation as the second step
    validateAuthToken(payload, env, requestId);

    // Validate payload
    validatePayload(payload);
    
    // Get API keys from database
    const apiKeys = await getApiKeys(env, requestId, payload.exchange);
    await createLog(LOG_LEVEL.INFO, {
      operation: 'Processing trades for multiple accounts',
      details: { accounts: apiKeys.length }
    }, requestId, null, env);
    
    // Select broker tag based on exchange
    const brokerTag = payload.exchange.toLowerCase() === 'okx' ? 
      env.BROKER_TAG_OKX : 
      payload.exchange.toLowerCase() === 'bybit' ? 
        env.BROKER_TAG_BYBIT : 
        'default';

    // Check if this is a dry run
    const isDryRun = !!payload.dryRun;
    if (isDryRun) {
      await createLog(LOG_LEVEL.INFO, `DRY RUN MODE: No actual trades will be executed`, requestId, null, env);
      // Add dryRun flag to the payload which will propagate to all order objects
      payload.dryRun = true;
    }

    // Execute trades for all accounts
    const results = await executeMultiAccountTrades(
      payload, 
      apiKeys, 
      brokerTag,
      requestId,
      env
    );
    
    return new Response(JSON.stringify({
      message: `Processed ${results.successful} successful and ${results.failed} failed trades${isDryRun ? ' (DRY RUN)' : ''}`,
      requestId: requestId,
      successful: results.successful,
      failed: results.failed,
      dryRun: isDryRun
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await createLog(LOG_LEVEL.ERROR, {
      operation: 'Webhook processing',
      status: 'failed',
      details: {
        error: error.message,
        stack: DEBUG ? error.stack : undefined
      }
    }, requestId, null, env);
    
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
});

// Catch-all handler for other methods
router.all('*', () => new Response('Method not allowed', { status: 405 }));

// Export the router handler
export default {
  fetch: router.handle
};