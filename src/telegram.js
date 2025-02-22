/**
 * Telegram notification module for OKX trading webhook API
 * Handles formatting and sending of trade notifications to Telegram
 */

const ICONS = {
  SUCCESS: '✅',
  ERROR: '❌',
  CLOSE: '🏁'
};

/**
 * Masks sensitive data for secure logging
 * @private
 */
function maskSensitiveData(text) {
  if (!text) return '';
  const length = text.length;
  if (length <= 8) return text;
  return text.substring(0, 4) + '*'.repeat(length - 8) + text.substring(length - 4);
}

/**
 * Formats a trade execution message for Telegram
 * @param {Object} params Message parameters
 * @returns {Object|null} Formatted message object
 */
function formatTradeMessage({
  symbol,
  side,
  requestId,
  totalAccounts,
  successCount,
  failedAccounts = [],
  totalVolume,
  errors = [],
  pnl = null,
  closePosition = false
}) {
  // Debug input parameters
  console.log('[TG Debug] Input params:', {
    symbol, side, closePosition,
    totalAccounts, successCount,
    hasErrors: errors.length > 0
  });

  if (!symbol || !side || !requestId) {
    console.log('[TG Debug] Missing required params');
    return null;
  }
  
  // Clean and validate the errors array
  errors = Array.isArray(errors)
    ? errors.filter(e => typeof e === 'string' && e.trim() !== '')
    : [];
  
  // Determine message type based on errors and closePosition flag
  let type = errors.length > 0 ? 'ERROR' : 'SUCCESS';
  
  // Debug close position logic
  console.log('[TG Debug] Close position check:', {
    closePosition,
    side: side.toUpperCase(),
    isClose: closePosition || side.toUpperCase() === 'CLOSE' || 
            (side.toUpperCase() === 'SELL' && closePosition)
  });

  // Check for closing position: either explicit CLOSE or sell with closePosition flag
  if (!errors.length && (closePosition || side.toUpperCase() === 'CLOSE' || 
      (side.toUpperCase() === 'SELL' && closePosition))) {
    type = 'CLOSE';
    side = 'CLOSE';
    console.log('[TG Debug] Setting message type to CLOSE');
  }
  
  const icon = ICONS[type];
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  
  // Format heading with WEBHOOK-API prefix and uppercase action
  let message = `${icon} WEBHOOK-API: ${symbol}: ${side.toUpperCase()}\n`;
  message += `Time: ${time}\n`;
  message += `ID: ${maskSensitiveData(requestId)}\n\n`;
  
  if (type === 'ERROR') {
    message += `Errors (${totalAccounts} accounts):\n`;
    const errorCounts = {};
    errors.forEach(error => {
      errorCounts[error] = (errorCounts[error] || 0) + 1;
    });
    Object.entries(errorCounts).forEach(([error, count]) => {
      message += `• ${error}: ${count}\n`;
    });
  } else {
    message += `Results (${totalAccounts} accounts):\n`;
    if (totalVolume) {
      message += `• Executed: ${totalVolume} total\n`;
    }
    message += `• Success: ${successCount} accounts\n`;
    if (failedAccounts.length > 0) {
      message += `• Failed: ${failedAccounts.length} accounts\n`;
    }
    // Add PnL for closing positions if available
    if (type === 'CLOSE' && pnl !== null) {
      const pnlPrefix = parseFloat(pnl) >= 0 ? '+' : '';
      message += `• PnL: ${pnlPrefix}${pnl}\n`;
    }
  }
  
  return { type, message };
}

/**
 * Sends a message to Telegram
 * @param {string} type Message type (SUCCESS or ERROR)
 * @param {string} message Message content
 * @param {Object} env Environment variables containing TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID
 * @returns {Promise<boolean>} True if message was sent successfully
 */
async function sendTelegramMessage(type, message, env) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID || !message || !type) {
      throw new Error('Missing required Telegram parameters');
    }

    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'OKX-Trading-Bot/1.0'
        },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHANNEL_ID,
          text: message,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Telegram API error: ${data.description || response.statusText}`);
    }

    if (!data.ok) {
      throw new Error(`Telegram message failed: ${data.description}`);
    }

    return true;
  } catch (error) {
    throw error; // Let the caller handle the error with proper context
  }
}

export {
  formatTradeMessage,
  sendTelegramMessage
};
