const {
  buildMarketHashNamesForProfile,
  extractSkinBaseName,
  DEFAULT_REQUEST_INTERVALS_MS
} = require('../../../shared/cs2-scanner-core.js');

const FULL_EXPORT_BASE_URL = 'https://market.csgo.com/api/full-export/';
const RETRY_BACKOFF_MS = 700;
const SNAPSHOT_TTL_MS = 25000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    traceHttp() {},
    isHttpTraceEnabled() {
      return false;
    }
  };
}

function normalizePrice(value, currency) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return null;
  }

  if (Number.isInteger(numeric) && numeric >= 100) {
    const upperCurrency = String(currency || '').toUpperCase();
    const divisor = upperCurrency === 'USD' || upperCurrency === 'EUR' ? 1000 : 100;
    return Number((numeric / divisor).toFixed(2));
  }

  return Number(numeric.toFixed(2));
}

function toInteger(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function readJson(response) {
  if (response && typeof response.json === 'function') {
    return response.json();
  }

  if (response && typeof response.text === 'function') {
    return response.text().then((text) => (text ? JSON.parse(text) : null));
  }

  return Promise.resolve(null);
}

function createProviderError(message, code) {
  const error = new Error(message);
  error.code = code || 'provider_error';
  return error;
}

function isAbortError(error) {
  return !!(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function extractQualityFromHashName(hashName) {
  const match = String(hashName || '').match(/\(([^()]+)\)\s*$/);
  return match ? match[1].trim() : null;
}

function buildSnapshotCacheKey(currency, watchMap) {
  const hashNames = Array.from((watchMap && watchMap.keys()) || []).sort();
  return String(currency || '').toUpperCase() + '::' + hashNames.join('||');
}

function summarizeMarketPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      rowCount: payload.length,
      firstRow: Array.isArray(payload[0]) ? payload[0].slice(0, 8) : (payload[0] || null)
    };
  }

  if (payload && typeof payload === 'object' && Array.isArray(payload.format) && Array.isArray(payload.items)) {
    return {
      manifestTime: payload.time || null,
      formatFieldCount: payload.format.length,
      formatFields: payload.format.slice(0, 12),
      shardCount: payload.items.length,
      shardSamples: payload.items.slice(0, 3)
    };
  }

  return payload;
}

function summarizeDecodedRow(decodedRow) {
  return {
    id: decodedRow && (decodedRow.id || null),
    market_hash_name: decodedRow && (decodedRow.market_hash_name || decodedRow.hash_name || decodedRow.name || null),
    price: decodedRow && Object.prototype.hasOwnProperty.call(decodedRow, 'price') ? decodedRow.price : null,
    float: decodedRow && Object.prototype.hasOwnProperty.call(decodedRow, 'float') ? decodedRow.float : null,
    paintseed: decodedRow && Object.prototype.hasOwnProperty.call(decodedRow, 'paintseed') ? decodedRow.paintseed : null,
    paintindex: decodedRow && Object.prototype.hasOwnProperty.call(decodedRow, 'paintindex') ? decodedRow.paintindex : null,
    source: decodedRow && Object.prototype.hasOwnProperty.call(decodedRow, 'source') ? decodedRow.source : null
  };
}

function createRowDecoder(format) {
  const indexes = {};
  (Array.isArray(format) ? format : []).forEach((field, index) => {
    if (typeof field === 'string' && !(field in indexes)) {
      indexes[field] = index;
    }
  });

  return {
    has(field) {
      return Number.isInteger(indexes[field]);
    },
    get(row, field) {
      const index = indexes[field];
      return Number.isInteger(index) ? row[index] : undefined;
    },
    decode(row) {
      const decoded = {};
      Object.entries(indexes).forEach(([field, index]) => {
        decoded[field] = row[index];
      });
      return decoded;
    }
  };
}

class MarketCsgoTmAdapter {
  constructor(fetchImpl, options) {
    this.fetchImpl = fetchImpl || fetch;
    this.logger = Object.assign(createNoopLogger(), options && options.logger ? options.logger : {});
    this.lastRequestAt = 0;
    this.currentRequestDelayMs = DEFAULT_REQUEST_INTERVALS_MS.marketCsgoTm;
    this.snapshotCache = new Map();
  }

  async waitTurn() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.currentRequestDelayMs) {
      await sleep(this.currentRequestDelayMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  buildFallbackUrl(state, profile, hashName, listingId) {
    const skin = state.patternLibrary.skins[profile.skinKey];
    if (skin && skin.url) {
      return listingId ? (skin.url + '#listing-' + listingId) : skin.url;
    }

    const baseName = extractSkinBaseName(hashName) || hashName;
    return 'https://market.csgo.com/ru/?search=' + encodeURIComponent(baseName);
  }

  async fetchJson(url, label, context) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        context.throwIfStopped();
        await this.waitTurn();
        context.throwIfStopped();
        this.logger.debug('marketCsgoTm', 'HTTP request started.', {
          url,
          label,
          attempt: attempt + 1,
          requestDelayMs: this.currentRequestDelayMs
        });
        this.logger.traceHttp('marketCsgoTm', 'HTTP request payload.', {
          httpTraceKind: 'request',
          method: 'GET',
          url,
          label,
          attempt: attempt + 1
        });
        const response = await this.fetchImpl(url, {
          signal: context && context.signal ? context.signal : undefined
        });

        if (response.status === 429) {
          this.logger.warn('marketCsgoTm', 'HTTP rate limited.', { url, label, status: response.status });
          throw createProviderError('Market.csgo.tm rate limit hit.', 'provider_rate_limited');
        }

        if (response.status >= 500) {
          this.logger.warn('marketCsgoTm', 'HTTP server error.', { url, label, status: response.status });
          throw createProviderError('Market.csgo.tm ' + label + ' returned HTTP ' + response.status + '.', 'provider_error');
        }

        if (!response.ok) {
          this.logger.warn('marketCsgoTm', 'HTTP request failed.', { url, label, status: response.status });
          throw createProviderError('Market.csgo.tm ' + label + ' returned HTTP ' + response.status + '.', 'provider_error');
        }

        try {
          const payload = await readJson(response);
          this.logger.debug('marketCsgoTm', 'HTTP request finished.', {
            url,
            label,
            status: response.status
          });
          this.logger.traceHttp('marketCsgoTm', 'HTTP response payload.', {
            httpTraceKind: 'response',
            method: 'GET',
            url,
            label,
            status: response.status,
            response: summarizeMarketPayload(payload)
          });
          return payload;
        } catch (error) {
          this.logger.error('marketCsgoTm', 'Invalid JSON in response.', { url, label, error: error.message });
          throw createProviderError('Market.csgo.tm ' + label + ' returned invalid JSON.', 'provider_error');
        }
      } catch (error) {
        if (error.code === 'provider_rate_limited' || error.code === 'scan_stopped') {
          throw error;
        }

        if (isAbortError(error) || (context && typeof context.shouldStop === 'function' && context.shouldStop())) {
          throw createProviderError('Scan stopped by user.', 'scan_stopped');
        }

        lastError = error.code
          ? error
          : createProviderError('Market.csgo.tm ' + label + ' request failed: ' + error.message, 'provider_error');
        if (attempt === 0) {
          this.logger.warn('marketCsgoTm', 'Retrying request after failure.', {
            url,
            label,
            error: lastError.message
          });
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
      }
    }

    throw lastError || createProviderError('Market.csgo.tm request failed.', 'provider_error');
  }

  async fetchManifest(currency, context) {
    const normalizedCurrency = String(currency || 'USD').toUpperCase();
    const manifest = await this.fetchJson(FULL_EXPORT_BASE_URL + normalizedCurrency + '.json', normalizedCurrency + ' manifest', context);

    if (!manifest || !Array.isArray(manifest.format) || !Array.isArray(manifest.items)) {
      throw createProviderError('Market.csgo.tm ' + normalizedCurrency + ' manifest is malformed.', 'provider_error');
    }

    this.logger.info('marketCsgoTm', 'Manifest loaded.', {
      currency: normalizedCurrency,
      manifestTime: manifest.time || null,
      shardCount: manifest.items.length
    });

    return {
      currency: normalizedCurrency,
      time: manifest.time || null,
      format: manifest.format,
      items: manifest.items
    };
  }

  async fetchShard(shardName, context) {
    const shard = await this.fetchJson(FULL_EXPORT_BASE_URL + shardName, 'shard ' + shardName, context);
    if (!Array.isArray(shard)) {
      throw createProviderError('Market.csgo.tm shard ' + shardName + ' is malformed.', 'provider_error');
    }

    this.logger.debug('marketCsgoTm', 'Shard loaded.', {
      shardName,
      rows: shard.length
    });
    return shard;
  }

  decodeRow(format, row) {
    return createRowDecoder(format).decode(row);
  }

  buildListing(state, profile, currency, decodedRow) {
    const marketHashName = decodedRow.market_hash_name || decodedRow.hash_name || decodedRow.name || '';
    const listingId = decodedRow.id || decodedRow.asset || decodedRow.classid || Math.random();

    return {
      market: 'marketCsgoTm',
      listingId: String(listingId),
      skinKey: profile.skinKey,
      skinName: marketHashName,
      price: normalizePrice(decodedRow.price, currency || profile.currency),
      currency: String(currency || profile.currency || '').toUpperCase(),
      pattern: toInteger(decodedRow.paintseed),
      float: toNumber(decodedRow.float),
      quality: extractQualityFromHashName(marketHashName),
      listingUrl: this.buildFallbackUrl(state, profile, marketHashName, listingId),
      raw: decodedRow
    };
  }

  routeDecodedListingToProfiles(watchMap, decodedRow, state, currency, listingsByProfile) {
    const marketHashName = decodedRow.market_hash_name || decodedRow.hash_name || decodedRow.name;
    const linkedProfiles = watchMap.get(marketHashName) || [];

    linkedProfiles.forEach((profile) => {
      if (!listingsByProfile[profile.id]) {
        listingsByProfile[profile.id] = [];
      }

      listingsByProfile[profile.id].push(this.buildListing(state, profile, currency, decodedRow));
    });
  }

  async loadSnapshot(currency, watchMap, context) {
    const cacheKey = buildSnapshotCacheKey(currency, watchMap);
    const cached = this.snapshotCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.logger.debug('marketCsgoTm', 'Using cached snapshot.', {
        currency,
        manifestTime: cached.snapshot.manifestTime
      });
      return cached.snapshot;
    }

    const manifest = await this.fetchManifest(currency, context);
    const decoder = createRowDecoder(manifest.format);

    if (!decoder.has('market_hash_name')) {
      throw createProviderError('Market.csgo.tm ' + manifest.currency + ' manifest is missing market_hash_name.', 'provider_error');
    }

    const snapshot = {
      currency: manifest.currency,
      manifestTime: manifest.time,
      formatHasPaintseed: decoder.has('paintseed'),
      matchedRows: 0,
      matchedRowsWithSeed: 0,
      decodedRows: []
    };

    if (!snapshot.formatHasPaintseed) {
      this.snapshotCache.set(cacheKey, {
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        snapshot
      });
      return snapshot;
    }

    for (const shardName of manifest.items) {
      context.throwIfStopped();
      const shard = await this.fetchShard(shardName, context);
      let shardMatchedRows = 0;
      const matchedSamples = [];

      shard.forEach((row) => {
        if (!Array.isArray(row)) {
          return;
        }

        const marketHashName = decoder.get(row, 'market_hash_name');
        if (!watchMap.has(marketHashName)) {
          return;
        }

        snapshot.matchedRows += 1;
        shardMatchedRows += 1;

        let decodedRow = null;
        if (matchedSamples.length < 2) {
          decodedRow = this.decodeRow(manifest.format, row);
          matchedSamples.push(summarizeDecodedRow(decodedRow));
        }

        const pattern = toInteger(decoder.get(row, 'paintseed'));
        if (pattern == null) {
          return;
        }

        snapshot.matchedRowsWithSeed += 1;
        if (!decodedRow) {
          decodedRow = this.decodeRow(manifest.format, row);
        }
        snapshot.decodedRows.push(decodedRow);
      });

      this.logger.traceHttp('marketCsgoTm', 'Watched shard matches.', {
        httpTraceKind: 'response_sample',
        currency: manifest.currency,
        manifestTime: manifest.time,
        shardName,
        rowCount: shard.length,
        matchedRows: shardMatchedRows,
        sampleWatchedRows: matchedSamples
      });
    }

    this.snapshotCache.set(cacheKey, {
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      snapshot
    });

    this.logger.info('marketCsgoTm', 'Snapshot prepared.', {
      currency: snapshot.currency,
      manifestTime: snapshot.manifestTime,
      matchedRows: snapshot.matchedRows,
      matchedRowsWithSeed: snapshot.matchedRowsWithSeed
    });

    return snapshot;
  }

  buildCurrencyWatchMaps(profiles, state) {
    const watchByCurrency = new Map();

    profiles.forEach((profile) => {
      const currency = String(profile.currency || 'USD').toUpperCase();
      const watchMap = watchByCurrency.get(currency) || new Map();

      buildMarketHashNamesForProfile(state.patternLibrary, profile).forEach((hashName) => {
        if (!watchMap.has(hashName)) {
          watchMap.set(hashName, []);
        }

        watchMap.get(hashName).push(profile);
      });

      watchByCurrency.set(currency, watchMap);
    });

    return watchByCurrency;
  }

  async scanProfiles(profiles, state, context) {
    const runContext = context || { throwIfStopped() {} };
    const result = {
      listingsByProfile: {},
      providerStatus: { status: 'provider_ok', message: 'No due profiles.' }
    };

    if (!profiles.length) {
      return result;
    }

    this.currentRequestDelayMs = Number(
      state && state.scanner && state.scanner.requestIntervalsMs && state.scanner.requestIntervalsMs.marketCsgoTm
    ) || DEFAULT_REQUEST_INTERVALS_MS.marketCsgoTm;

    profiles.forEach((profile) => {
      result.listingsByProfile[profile.id] = [];
    });

    const watchByCurrency = this.buildCurrencyWatchMaps(profiles, state);
    if (!watchByCurrency.size) {
      result.providerStatus = {
        status: 'provider_ok',
        message: 'No market hash names built from active profiles.'
      };
      return result;
    }

    const diagnostics = [];
    let supportedRowsFound = false;
    let unsupportedMetadata = false;
    const unsupportedMessages = [];

    try {
      this.logger.info('marketCsgoTm', 'Market scan started.', {
        profileCount: profiles.length,
        currencies: Array.from(watchByCurrency.keys()),
        requestDelayMs: this.currentRequestDelayMs
      });

      for (const [currency, watchMap] of watchByCurrency.entries()) {
        runContext.throwIfStopped();

        if (!watchMap.size) {
          diagnostics.push(currency + ' watchlist is empty.');
          continue;
        }

        const snapshot = await this.loadSnapshot(currency, watchMap, runContext);
        diagnostics.push(
          currency + ' snapshot ' + (snapshot.manifestTime || 'unknown') +
          ' matched ' + snapshot.matchedRowsWithSeed + '/' + snapshot.matchedRows + ' watched offers with paintseed.'
        );

        if (!snapshot.formatHasPaintseed) {
          unsupportedMetadata = true;
          unsupportedMessages.push(currency + ' manifest format does not expose paintseed.');
          continue;
        }

        if (snapshot.matchedRows > 0 && snapshot.matchedRowsWithSeed === 0) {
          unsupportedMetadata = true;
          unsupportedMessages.push(currency + ' watched offers did not expose paintseed.');
          continue;
        }

        if (snapshot.matchedRowsWithSeed > 0) {
          supportedRowsFound = true;
        }

        snapshot.decodedRows.forEach((decodedRow) => {
          this.routeDecodedListingToProfiles(watchMap, decodedRow, state, currency, result.listingsByProfile);
        });
      }
    } catch (error) {
      this.logger.error('marketCsgoTm', 'Market scan failed.', { error: error.message, code: error.code || null });
      result.providerStatus = {
        status: error.code || 'provider_error',
        message: error.message
      };
      return result;
    }

    if (unsupportedMetadata && !supportedRowsFound) {
      result.providerStatus = {
        status: 'provider_metadata_unsupported',
        message: unsupportedMessages.join(' ')
      };
      this.logger.warn('marketCsgoTm', 'Market scan completed without paintseed metadata.', {
        message: result.providerStatus.message
      });
      return result;
    }

    result.providerStatus = {
      status: 'provider_ok',
      message: 'Market.csgo.tm full-export snapshot ok. ' + diagnostics.join(' ')
    };
    this.logger.info('marketCsgoTm', 'Market scan finished.', {
      message: result.providerStatus.message
    });

    return result;
  }
}

module.exports = {
  MarketCsgoTmAdapter
};
