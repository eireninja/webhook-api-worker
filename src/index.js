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
 * @throws {Error} If token is invalid or missing
 * @returns {boolean} True if token is valid
 */
function validateAuthToken(payload, env) {
  if (!env?.WEBHOOK_AUTH_TOKEN) {
    throw new Error('Server configuration error: missing authentication token');
  }

  const { authToken } = payload;
  if (!authToken) {
    throw new Error('Missing authentication token');
  }

  // Constant-time comparison to prevent timing attacks
  if (authToken !== env.WEBHOOK_AUTH_TOKEN) {
    createLog('AUTH', 'Authentication failed', '', '');
    throw new Error('Invalid authentication token');
  }
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
 * @returns {string} Generated signature
 */
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

/**
 * Generates a valid client order ID (clOrdId)
 * @param {string} strategyId - Strategy identifier
 * @param {string} brokerTag - Broker identification tag
 * @param {string} [batchIndex=''] - Optional batch index for batch orders
 * @returns {string} Generated client order ID
 */
function generateClOrdId(strategyId, brokerTag, batchIndex = '') {
  const timestamp = Date.now().toString().slice(-6); // Use last 6 digits of timestamp
  const sanitizedStrategy = (strategyId || 'default')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 6); // Shorter strategy ID
  createLog('TRADE', 'Generating clOrdId');
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
 * Generates common OKX request headers and signature
 * @param {string} method - HTTP method
 * @param {string} path - API endpoint path
 * @param {Object} body - Request body
 * @param {Object} credentials - API credentials
 * @returns {Object} Headers and signed request body
 */
async function generateOkxRequest(method, path, body, credentials) {
  const timestamp = new Date().toISOString().split('.')[0] + 'Z';
  createLog('AUTH', `Generating request with API key: ${mask(credentials.apiKey)}`);
  
  // Always include /api/v5 in signature path
  const signaturePath = path.startsWith('/api/v5') ? path : `/api/v5${path}`;
  
  // Generate signature using stringified body
  const signature = await sign(timestamp, method.toUpperCase(), signaturePath, body, credentials.secretKey);
  
  // Order headers exactly as in Python implementation
  const headers = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': credentials.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase
  };

  const authLog = formatAuthLogMessage(method, path, {
    Method: method,
    Path: path,
    Timestamp: timestamp,
    ...JSON.parse(body || '{}')
  });
  createLog('AUTH', authLog);
  
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
        'GET',
        path + queryParams,
        '',
        credentials
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
      'GET',
      path + queryParams,
      '',
      credentials
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
      credentials
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

/**
 * Gets instrument information
 * @param {string} instId - Instrument ID
 * @param {Object} credentials - API credentials
 * @returns {Promise<Object>} Instrument details
 */
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

/**
 * Gets current position information
 * @param {string} instId - Instrument ID
 * @param {Object} credentials - API credentials
 * @returns {Promise<Object>} Position details
 */
async function getCurrentPosition(instId, credentials) {
  try {
    const path = '/api/v5/account/positions';
    const { headers } = await generateOkxRequest(
      'GET',
      path,
      '',
      credentials
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
  createLog('TRADE', 'Getting max size');
  const path = '/api/v5/account/max-size';
  let queryParams = `?instId=${instId}&tdMode=${tdMode}`;
  
  if (posSide) {
    queryParams += `&posSide=${posSide}`;
    createLog('TRADE', `Using ${tdMode} margin with ${posSide} position`, requestId);
  }

  const { headers } = await generateOkxRequest(
    'GET',
    path + queryParams,
    '',
    credentials
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

  createLog('TRADE', `Max size for ${instId}: Buy=${maxBuy} contracts, Sell=${maxSell} contracts`, requestId);
  return { maxBuy, maxSell };
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

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Check both API-level and order-level success
    if (!result.successful || result.failed > 0) {
      createLog('TRADE', `Order placement failed`, requestId);
      return { successful: 0, failed: 1, sz: orderSize };
    }

    // Return explicit success with size information
    const markPrice = await getMarkPrice(instId, credentials);
    createLog('TRADE', formatTradeLogMessage(
      'SPOT',
      payload.side.toUpperCase(),
      {
        symbol: instId,
        size: orderSize,
        price: markPrice,
        maxSize: maxQty,
        mode: 'cash',
        tgtCcy: isBuy ? 'base_ccy' : 'quote_ccy',
        qty: payload.qty
      }
    ), requestId, credentials.apiKey);
    return { successful: 1, failed: 0, sz: orderSize };
  } catch (error) {
    // Log unexpected errors
    createLog('TRADE', `Unexpected error in spot trade execution: ${error.message}`, requestId, credentials.apiKey, env);
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
    createLog('TRADE', `Getting instrument info for ${instId}`, requestId);
    const instInfo = await getInstrumentInfo(instId, credentials);
    
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
    
    if (payload.qty.includes('%')) {
      orderSize = calculateOrderSize(maxQty, payload.qty, instInfo.lotSz);
    } else {
      orderSize = roundToLotSize(parseFloat(payload.qty), instInfo.lotSz).toString();
    }

    // Validate final order size
    if (isNaN(parseFloat(orderSize)) || parseFloat(orderSize) <= 0) {
      throw new Error(`Invalid order size: ${orderSize}`);
    }

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

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Return success with size information
    const markPrice = await getMarkPrice(instId, credentials);
    createLog('TRADE', formatTradeLogMessage(
      'PERP',
      'Open Position',
      {
        symbol: instId,
        size: orderSize,
        price: markPrice,
        maxSize: maxQty,
        mode: payload.marginMode,
        leverage: payload.leverage,
        qty: payload.qty
      }
    ), requestId, credentials.apiKey);
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

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    
    // Return success with size information
    const markPrice = await getMarkPrice(instId, credentials);
    createLog('TRADE', formatTradeLogMessage(
      'PERP_CLOSE',
      'Close Position',
      {
        symbol: instId,
        size: orderSize,
        price: markPrice,
        mode: payload.marginMode
      },
      position
    ), requestId, credentials.apiKey);
    return { successful: result.successful, failed: result.failed, sz: orderSize };
  } catch (error) {
    // Only log errors that haven't been logged before
    if (!error.logged && !error.message.includes('Order placed')) {
      createLog('ERROR', `Failed to close position: ${error.message}`, requestId, credentials.apiKey, env);
      error.logged = true;
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
    const instInfo = await getInstrumentInfo(instId, credentials);
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
      createLog('TRADE', `Order size calculation failed: ${sizeError.message}`, requestId);
      return { successful: 0, failed: 1, sz: 0 };
    }

    // Prepare order data
    const orderData = {
      instId: instId,
      tdMode: payload.marginMode,
      ordType: 'market',
      tag: brokerTag,
      clOrdId: generateClOrdId(payload.strategyId, brokerTag),
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
    const markPrice = await getMarkPrice(instId, credentials);
    createLog('TRADE', formatTradeLogMessage(
      'INV_PERP',
      'Open Position',
      {
        symbol: instId,
        size: orderSize,
        price: markPrice,
        maxSize: maxQty,
        mode: payload.marginMode,
        leverage: payload.leverage,
        qty: payload.qty
      }
    ), requestId, credentials.apiKey);
    return { successful: result.successful, failed: result.failed, sz: orderSize };
  } catch (error) {
    // Log unexpected errors
    createLog('TRADE', `Unexpected error in inverse perpetual position opening: ${error.message}`, requestId, credentials.apiKey, env);
    return { successful: 0, failed: 1, sz: 0 };
  }
}

/**
 * Closes an inverse perpetual position
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

    // If dryRun, return the order data without executing
    if (dryRun) {
      return { orderData };
    }

    // Place single order
    const result = await placeOrder(orderData, credentials, requestId, env);
    const markPrice = await getMarkPrice(instId, credentials);
    createLog('TRADE', formatTradeLogMessage(
      'INV_PERP_CLOSE',
      'Close Position',
      {
        symbol: instId,
        size: orderSize,
        price: markPrice,
        mode: payload.marginMode
      },
      position
    ), requestId, credentials.apiKey);
    return { result: null, successful: result.successful, failed: result.failed };
  } catch (error) {
    createLog('ERROR', `Failed to close inverse perpetual position: ${error.message}`, requestId, credentials.apiKey);
    return { result: null, successful: 0, failed: 1 };  // Return failure result instead of throwing
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
  const path = '/api/v5/trade/order';
  const body = JSON.stringify(orderData);
  const maxRetries = 3;
  const baseDelay = 2000; // 2 second base delay to match OKX rate window
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { headers } = await generateOkxRequest('POST', path, body, credentials);
      const response = await fetch(`${OKX_API_URL}${path}`, {
        method: 'POST',
        headers,
        body
      });

      const data = await response.json();
      await createLog(LOG_LEVEL.DEBUG, `Response (attempt ${attempt + 1}): ${JSON.stringify(data)}`, requestId);
      
      // Check for rate limit errors
      if (data.code === '50011' || data.code === '50061') {
        // Calculate delay based on error type
        const delay = data.code === '50061' 
          ? baseDelay * Math.pow(2, attempt) // Sub-account limit: longer delays
          : baseDelay * Math.pow(1.5, attempt); // General rate limit: shorter delays
        
        await createLog(LOG_LEVEL.WARN,
          `Rate limit hit (${data.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          requestId,
          credentials.apiKey
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
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
          // Only retry on specific error codes
          if ((result.sCode === '50011' || result.sCode === '50061') && attempt < maxRetries - 1) {
            const delay = data.code === '50061' 
              ? baseDelay * Math.pow(2, attempt) // Sub-account limit: longer delays
              : baseDelay * Math.pow(1.5, attempt); // General rate limit: shorter delays
            
            await createLog(LOG_LEVEL.WARN,
              `Order failed with retryable error: ${result.sMsg}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
              requestId,
              credentials.apiKey
            );
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
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
      // Retry on network errors
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await createLog(LOG_LEVEL.WARN,
          `Network error: ${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          requestId,
          credentials.apiKey
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      await createLog(LOG_LEVEL.ERROR,
        `Order placement failed after ${maxRetries} attempts: ${error.message}`,
        requestId,
        credentials.apiKey
      );
      return { successful: 0, failed: 1, error: error.message };
    }
  }
  
  return { successful: 0, failed: 1, error: 'Max retries exceeded' };
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
    credentials
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
    
    createLog('TRADE', `Starting multi-account trade execution for ${apiKeys.length} accounts`, requestId);
    
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
        createLog('ERROR', `Invalid credentials for account: missing required fields`, requestId);
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
          allOrders.push({ order: result.orderData, credentials });
          createLog('TRADE', `Order prepared successfully for account ${result.orderData.accountId}`, requestId);
        } else {
          throw new Error('Order preparation failed: no order data returned');
        }
      } catch (error) {
        const accountId = credentials.apiKey.substring(0, 4);
        createLog('ERROR', `Failed to prepare order for account ${accountId}: ${error.message}`, requestId);
        totalFailed++;
      }
    }

    if (allOrders.length === 0) {
      createLog('TRADE', 'No valid orders to execute', requestId);
      return { successful: 0, failed: totalFailed, sz: 0 };
    }

    createLog('TRADE', `Executing ${allOrders.length} prepared orders`, requestId);

    // Execute each order individually
    for (const orderObj of allOrders) {
      try {
        const result = await placeOrder(orderObj.order, orderObj.credentials, requestId, env);
        if (result.successful) {
          totalSuccessful++;
          totalSize += parseFloat(orderObj.order.sz || 0);
          createLog('TRADE', `Order executed successfully for account ${orderObj.order.accountId}`, requestId);
          allOrders[allOrders.indexOf(orderObj)].success = true;
        } else {
          totalFailed++;
          const errorMsg = result.error || 'Unknown error';
          createLog('ERROR', `[ReqID=${requestId}][Account=${orderObj.order.accountId}...] Order failed: ${errorMsg}`, requestId);
          allOrders[allOrders.indexOf(orderObj)].success = false;
          allOrders[allOrders.indexOf(orderObj)].error = errorMsg;
        }
      } catch (error) {
        createLog('ERROR', `[ReqID=${requestId}][Account=${orderObj.order.accountId}...] Trade failed: ${error.message}`, requestId);
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

    createLog('TRADE', formatTradeLogMessage(
      'MULTI_ACCOUNT',
      'Trade Summary',
      summary
    ), requestId);

    const result = {
      successful: totalSuccessful,
      failed: totalFailed,
      sz: totalSize.toFixed(8)
    };

    // Send Telegram notification
    try {
      const telegramMsg = formatTradeMessage({
        symbol: payload.symbol,
        side: payload.closePosition ? 'CLOSE' : (payload.side || 'SELL'), // Set side explicitly for close positions
        requestId,
        totalAccounts: apiKeys.length,
        successCount: totalSuccessful,
        failedAccounts: allOrders.filter(o => !o.success).map(o => ({ id: o.order.accountId, error: o.error })),
        totalVolume: totalSize.toFixed(8),
        errors: totalSuccessful === apiKeys.length ? [] : ['Trade partially failed'],
        closePosition: !!payload.closePosition  // Ensure boolean
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
        failedAccounts: allOrders.filter(o => !o.success).map(o => ({ id: o.order.accountId, error: o.error })),
        errors: [error.message],
        closePosition: !!payload.closePosition  // Ensure boolean
      });

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
 * @param {string} message - Log message
 * @param {string} requestId - Request identifier
 * @param {string} [apiKey] - Optional API key
 * @param {Object} [env] - Environment variables
 */
async function createLog(level, message, requestId, apiKey = '', env = null) {
  try {
    const timestamp = new Date().toISOString()
      .slice(0, 19)
      .replace('T', '..')
      .replace(/-/g, '.');
    
    const reqIdStr = requestId ? `[ReqID=${requestId.slice(0, 8)}...]` : '';
    const accountStr = apiKey ? `[Account=${apiKey.slice(0, 4)}...]` : '';
    
    // Format multi-line messages with proper indentation
    const formattedMessage = (message || '').toString().split('\n')
      .map((line, i) => i === 0 ? line : '  ' + line)
      .join('\n');

    console.log(`[${timestamp}][${level}]${reqIdStr}${accountStr} ${formattedMessage}`);
  } catch (error) {
    console.error(`Logging error: ${error.message}`);
  }
}

/**
 * Logs details of a trade operation
 * @param {string} operation - Operation type (e.g., 'Opening', 'Closing')
 * @param {Object} position - Position details
 * @param {string} requestId - Request identifier
 * @param {string} apiKey - API key
 */
async function logTradeOperation(operation, position, requestId, apiKey) {
  try {
    if (!position || typeof position !== 'object') {
      throw new Error('Invalid position object');
    }

    const { instId, posSide, sz, avgPx } = position;
    const details = [
      `${operation} ${posSide || ''} position:`,
      `  Symbol: ${instId || 'Unknown'}`,
      `  Size: ${sz || 0} contracts`,
      avgPx ? `  Price: $${avgPx}` : ''
    ].filter(Boolean).join('\n');

    await createLog(LOG_LEVEL.TRADE, details, requestId, apiKey);
  } catch (error) {
    await createLog(LOG_LEVEL.ERROR, 
      `Failed to log trade operation: ${error.message}`, 
      requestId, 
      apiKey
    );
  }
}

//=============================================================================
// [ROUTER] API Route Handlers
//=============================================================================

/**
 * Health check endpoint handler
 * @returns {Response} Health check response
 */
router.get('/', async (request) => {
  try {
    const health = await generateHealthCheck();
    return new Response(JSON.stringify(health), {
      status: health.status === 'healthy' ? 200 : 
              health.status === 'degraded' ? 206 : 500,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error) {
    return handleError(error);
  }
});

/**
 * Favicon handler
 * @returns {Response} Favicon response
 */
router.get('/favicon.ico', () => new Response(null, { status: 204 }));

/**
 * Main webhook endpoint handler
 * @returns {Response} Webhook processing response
 */
router.post('/', async (request, env) => {
  const requestId = crypto.randomUUID();
  const clientIp = request.headers.get('cf-connecting-ip');
  
  await createLog(LOG_LEVEL.INFO, `Received webhook request from ${clientIp}`, requestId, null, env);
  
  try {
    const payload = await request.json();
    await createLog(LOG_LEVEL.INFO, `Received payload: ${JSON.stringify(redactSensitiveData(payload))}`, requestId, null, env);
    
    // Token validation as the first step
    validateAuthToken(payload, env);

    // Validate payload
    validatePayload(payload);

    // Get API keys from database
    const apiKeys = await getApiKeys(env, requestId, payload.exchange);
    await createLog(LOG_LEVEL.INFO, `Processing trades for ${apiKeys.length} accounts`, requestId, null, env);
    
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
    
    return new Response(JSON.stringify({
      message: `Processed ${results.successful} successful and ${results.failed} failed trades`,
      requestId: requestId,
      successful: results.successful,
      failed: results.failed
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await createLog(LOG_LEVEL.ERROR, `Error: ${error.message}`, requestId, null, env);
    
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