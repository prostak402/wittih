class RuntimeLog {
  constructor(options) {
    const settings = options || {};
    this.maxEntries = Number(settings.maxEntries) > 0 ? Number(settings.maxEntries) : 400;
    this.entries = [];
    this.cursor = 0;
    this.onEntry = typeof settings.onEntry === 'function' ? settings.onEntry : null;
    this.httpTraceEnabled = !!settings.httpTraceEnabled;
  }

  normalizeDetails(details) {
    if (details == null) {
      return null;
    }

    const preserveLargeStrings = !!(details && typeof details === 'object' && details.httpTrace);

    try {
      const json = JSON.stringify(details, (key, value) => {
        const lowerKey = String(key || '').toLowerCase();
        if (lowerKey.includes('authorization') || lowerKey.includes('token') || lowerKey.includes('apikey') || lowerKey === 'api_key') {
          return '[redacted]';
        }

        if (!preserveLargeStrings && typeof value === 'string' && value.length > 500) {
          return value.slice(0, 497) + '...';
        }
        return value;
      });
      return JSON.parse(json);
    } catch (error) {
      return { note: 'Could not serialize log details.', error: error.message };
    }
  }

  setHttpTraceEnabled(enabled) {
    this.httpTraceEnabled = !!enabled;
    return this.httpTraceEnabled;
  }

  isHttpTraceEnabled() {
    return !!this.httpTraceEnabled;
  }

  buildTraceDetails(details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return {
        httpTrace: true,
        value: details == null ? null : details
      };
    }

    return Object.assign({ httpTrace: true }, details);
  }

  write(level, source, message, details) {
    this.cursor += 1;
    const entry = {
      cursor: this.cursor,
      entryId: 'log_' + this.cursor,
      createdAt: new Date().toISOString(),
      level: String(level || 'info'),
      source: String(source || 'agent'),
      message: String(message || ''),
      details: this.normalizeDetails(details)
    };

    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, this.maxEntries);

    if (this.onEntry) {
      try {
        this.onEntry(entry);
      } catch (error) {
        // Logging must never crash the scanner.
      }
    }

    return entry;
  }

  debug(source, message, details) {
    return this.write('debug', source, message, details);
  }

  info(source, message, details) {
    return this.write('info', source, message, details);
  }

  warn(source, message, details) {
    return this.write('warn', source, message, details);
  }

  error(source, message, details) {
    return this.write('error', source, message, details);
  }

  traceHttp(source, message, details) {
    if (!this.isHttpTraceEnabled()) {
      return null;
    }

    return this.write('debug', source, message, this.buildTraceDetails(details));
  }

  getAfter(cursor) {
    const numericCursor = Number(cursor || 0);
    return this.entries.filter((entry) => Number(entry.cursor || 0) > numericCursor).slice().reverse();
  }

  getRecent(limit) {
    const numericLimit = Number(limit || 50);
    return this.entries.slice(0, Math.max(0, numericLimit)).slice().reverse();
  }
}

module.exports = {
  RuntimeLog
};