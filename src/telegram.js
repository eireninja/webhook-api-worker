/**
 * Telegram notification module for OKX trading webhook API
 * Handles formatting and sending of trade notifications to Telegram
 */

const ICONS = {
  SUCCESS: '✅',
  ERROR: '❌',
  CLOSE: '🏁',
  PARTIAL_SUCCESS: '⚠️',
  PARTIAL_CLOSE: '⚠️'
};

/**
 * Masks sensitive data for secure logging
 * @private
 */
function maskSensitiveData(text) {
  if (!text) return '';
  const length = text.length;
  if (length <= 8) return text;
  
  // Always show first 4 and last 4 characters with exactly 4 asterisks in between
  return text.substring(0, 4) + '****' + text.substring(length - 4);
}

/**
 * Escapes special characters for HTML format
 * @private
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes special characters for Telegram MarkdownV2 format
 * @private
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
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
  errors = [],
  pnl = null,
  closePosition = false,
  leverage = 1,
  marginMode = 'cash',
  entryPrice = null
}) {
  if (!symbol || !side || !requestId) {
    return null;
  }
  
  // Determine message type based on success/failure counts
  let type;
  const isCloseOperation = closePosition || side.toUpperCase() === 'CLOSE';
  
  if (successCount === 0) {
    // All orders failed
    type = 'ERROR';
  } else if (failedAccounts.length > 0) {
    // Some orders succeeded, some failed (partial success)
    type = isCloseOperation ? 'PARTIAL_CLOSE' : 'PARTIAL_SUCCESS';
  } else if (isCloseOperation) {
    // All orders succeeded and it was a close operation
    type = 'CLOSE';
  } else {
    // All orders succeeded and it was a regular trade
    type = 'SUCCESS';
  }
  
  // If it's a close operation, normalize the side
  if (isCloseOperation) {
    side = 'CLOSE';
  }

  // Determine status text and emoji
  let statusText, statusEmoji;
  if (type === 'ERROR') {
    statusText = "FAILED";
    statusEmoji = "❌";
  } else if (type === 'PARTIAL_SUCCESS' || type === 'PARTIAL_CLOSE') {
    statusText = "PARTIAL SUCCESS";
    statusEmoji = "⚠️";
  } else if (type === 'CLOSE') {
    statusText = "CLOSED";
    statusEmoji = "✅";
  } else {
    statusText = "SUCCESS";
    statusEmoji = "✅";
  }
  
  // Get local time with timezone information
  const now = new Date();
  const timeWithZone = now.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit', 
    hour12: false,
    timeZoneName: 'short' 
  });
  
  // Build the message - HTML format is much simpler to work with
  let message = `<b>📢🚨TRADE EXECUTION ALERT!!🚨</b>\n\n`;
  
  // Add a dedicated action line with large text and bold action
  message += `<b>⚡️ ACTION ➜➜</b> ${escapeHtml(side.toUpperCase())}\n`;
  message += `<b>📈 PAIR ➜➜</b> ${escapeHtml(symbol)}\n`;
  message += `<b>🔔 STATUS ➜➜</b> ${statusText} ${statusEmoji}\n\n`;
  
  // Success/failure ratio
  message += `✅ <b>${successCount}/${totalAccounts}</b> orders executed successfully\n`;
  if (failedAccounts.length > 0) {
    message += `❌ <b>${failedAccounts.length}/${totalAccounts}</b> orders failed\n`;
  }
  
  // Details section
  message += `\n📋 <b>DETAILS:</b>\n`;
  message += `—————————————\n`;

  message += `• ⏰ Time: ${timeWithZone}\n`;
  message += `• 🔍 Request ID: <code>${escapeHtml(maskSensitiveData(requestId))}</code>\n`;
  if (leverage > 1) message += `• 🚀 Leverage: ${leverage}x\n`;
  message += `• 💵 Margin: ${escapeHtml(marginMode.charAt(0).toUpperCase() + marginMode.slice(1))}\n`;
  
  // Add PnL for close operations
  if ((type === 'CLOSE' || type === 'PARTIAL_CLOSE') && pnl !== null) {
    const pnlPrefix = parseFloat(pnl) >= 0 ? '+' : '';
    message += `• PnL: ${escapeHtml(pnlPrefix + pnl)}\n`;
  }
  
  // Show failures
  if (failedAccounts && failedAccounts.length > 0) {
    message += `\n❌ <b>FAILURES:</b>\n`;
    failedAccounts.forEach((failedOrder) => {
      const accountId = failedOrder.id || 'unknown';
      const errorMsg = escapeHtml(failedOrder.error || errors[0] || 'Trade failed');
      message += `• <code>${accountId}</code>: ${errorMsg}\n`;
    });
    
    // Add action suggestions based on error patterns
    message += `\n📝 <b>Action required:</b> `;
    
    // Look for common error patterns and suggest actions
    const errorTexts = failedAccounts.map(fa => fa.error?.toLowerCase() || '');
    if (errorTexts.some(e => e.includes('passphrase') || e.includes('credential') || e.includes('key'))) {
      message += `Check API credentials for account(s) with authentication errors\n`;
    } else if (errorTexts.some(e => e.includes('position'))) {
      message += `Verify position exists before attempting to close\n`;
    } else if (errorTexts.some(e => e.includes('balance') || e.includes('insufficient'))) {
      message += `Check account balance is sufficient for this trade\n`;
    } else {
      message += `Review error details and take appropriate action\n`;
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
          parse_mode: 'HTML',
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
