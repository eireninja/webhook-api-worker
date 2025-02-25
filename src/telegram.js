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
  
  let type = errors.length > 0 ? 'ERROR' : 'SUCCESS';
  if (!errors.length && (closePosition || side.toUpperCase() === 'CLOSE')) {
    type = 'CLOSE';
    side = 'CLOSE';
  }

  const icon = ICONS[type];
  let message = 'WEBHOOK\\-API\n\n';
  
  if (type === 'ERROR') {
    message += `${icon} ${failedAccounts.length}/${totalAccounts} orders failed for ${escapeMarkdown(symbol)}\n`;
    message += `📊 Side: ${escapeMarkdown(side.toUpperCase())}\n`;
    message += `⏰ Time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}\n`;
    message += `👥 Accounts: ${totalAccounts}\n`;
    message += `🔍 Request ID: ${escapeMarkdown(maskSensitiveData(requestId))}\n`;
    if (leverage > 1) message += `⚡ Leverage: ${leverage}x\n`;
    message += `💵 Margin Mode: ${escapeMarkdown(marginMode.charAt(0).toUpperCase() + marginMode.slice(1))}\n`;
    if (entryPrice) message += `📈 Entry Price: $${entryPrice}\n`;
    
    message += `\nFailed Orders:\n`;
    failedAccounts.forEach((failedOrder) => {
      const accountId = failedOrder.accountId || 'unknown';
      const errorMsg = escapeMarkdown(failedOrder.error || errors[0] || 'Trade failed');
      message += `• \`${accountId}\`: ${errorMsg}\n`;
    });
  } else if (type === 'CLOSE') {
    message += `${icon} ${successCount}/${totalAccounts} positions closed for ${escapeMarkdown(symbol)}\n`;
    message += `📊 Side: CLOSE\n`;
    message += `⏰ Time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}\n`;
    message += `👥 Accounts: ${totalAccounts}\n`;
    message += `🔍 Request ID: ${escapeMarkdown(maskSensitiveData(requestId))}\n`;
    if (leverage > 1) message += `⚡ Leverage: ${leverage}x\n`;
    message += `💵 Margin Mode: ${escapeMarkdown(marginMode.charAt(0).toUpperCase() + marginMode.slice(1))}\n`;
    if (entryPrice) message += `📈 Entry Price: $${entryPrice}\n`;
    if (pnl !== null) {
      const pnlPrefix = parseFloat(pnl) >= 0 ? '+' : '';
      message += `💰 PnL: ${escapeMarkdown(pnlPrefix + pnl)}\n`;
    }
  } else {
    message += `${icon} ${successCount}/${totalAccounts} orders processed successfully for ${escapeMarkdown(symbol)}\n`;
    message += `📊 Side: ${escapeMarkdown(side.toUpperCase())}\n`;
    message += `⏰ Time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}\n`;
    message += `👥 Accounts: ${totalAccounts}\n`;
    message += `🔍 Request ID: ${escapeMarkdown(maskSensitiveData(requestId))}\n`;
    if (leverage > 1) message += `⚡ Leverage: ${leverage}x\n`;
    message += `💵 Margin Mode: ${escapeMarkdown(marginMode.charAt(0).toUpperCase() + marginMode.slice(1))}\n`;
    if (entryPrice) message += `📈 Entry Price: $${entryPrice}\n`;
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
          parse_mode: 'MarkdownV2',
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
