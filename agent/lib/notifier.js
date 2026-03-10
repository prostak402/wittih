function buildTelegramMessage(event) {
  const listing = event.listing || {};
  const lines = [
    '*CS2 Rare Pattern Alert*',
    '',
    '*' + (listing.skinName || 'Rare pattern') + '*',
    'Market: ' + (listing.market || 'unknown'),
    'Tier: ' + (listing.tier || 'n/a'),
    'Pattern: ' + (listing.pattern != null ? ('#' + listing.pattern) : 'n/a'),
    'Price: ' + (listing.price != null ? String(listing.price) + ' ' + (listing.currency || '') : 'n/a')
  ];

  if (listing.float != null) {
    lines.push('Float: ' + listing.float);
  }

  if (listing.listingUrl) {
    lines.push('', '[Open listing](' + listing.listingUrl + ')');
  }

  return lines.join('\n');
}

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

class TelegramNotifier {
  constructor(fetchImpl, logger) {
    this.fetchImpl = fetchImpl || fetch;
    this.logger = logger || createNoopLogger();
  }

  async sendEvent(event, notifications) {
    if (!notifications || !notifications.telegramEnabled) {
      return { telegram: 'disabled' };
    }

    if (!notifications.telegramBotToken || !notifications.telegramChatId) {
      return { telegram: 'misconfigured' };
    }

    const url = 'https://api.telegram.org/bot' + notifications.telegramBotToken + '/sendMessage';
    this.logger.debug('telegram', 'Sending Telegram event notification.', {
      eventId: event.eventId,
      chatId: notifications.telegramChatId
    });

    const response = await this.fetchImpl(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: notifications.telegramChatId,
          text: buildTelegramMessage(event),
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        })
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const errorMessage = payload && payload.description ? payload.description : ('Telegram HTTP ' + response.status);
      this.logger.error('telegram', 'Telegram event notification failed.', {
        eventId: event.eventId,
        status: response.status,
        error: errorMessage
      });
      throw new Error(errorMessage);
    }

    this.logger.info('telegram', 'Telegram event notification sent.', {
      eventId: event.eventId,
      status: response.status
    });
    return { telegram: 'sent' };
  }

  async sendTest(notifications) {
    if (!notifications || !notifications.telegramEnabled) {
      return { telegram: 'disabled' };
    }

    if (!notifications.telegramBotToken || !notifications.telegramChatId) {
      throw new Error('Telegram is enabled but bot token or chat id is missing.');
    }

    const response = await this.fetchImpl(
      'https://api.telegram.org/bot' + notifications.telegramBotToken + '/sendMessage',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: notifications.telegramChatId,
          text: 'CS2 scanner test message from local agent.'
        })
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const errorMessage = payload && payload.description ? payload.description : ('Telegram HTTP ' + response.status);
      this.logger.error('telegram', 'Telegram test message failed.', {
        status: response.status,
        error: errorMessage
      });
      throw new Error(errorMessage);
    }

    this.logger.info('telegram', 'Telegram test message sent.', {
      status: response.status
    });
    return { telegram: 'sent' };
  }
}

module.exports = {
  TelegramNotifier,
  buildTelegramMessage
};
