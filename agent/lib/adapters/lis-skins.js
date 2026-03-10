const {
  DEFAULT_REQUEST_INTERVALS_MS,
  buildLisSearchNamesForProfile
} = require('../../../shared/cs2-scanner-core.js');

const SEARCH_ENDPOINT = 'https://api.lis-skins.com/v1/market/search';
const LISTING_BASE_URL = 'https://lis-skins.com/ru/market/csgo/';
const MAX_NAMES_PER_BATCH = 25;
const MAX_PAGES_PER_BATCH = 3;
const ONLY_UNLOCKED = 1;
const SORT_BY = 'newest';
const MAX_UNRELATED_SAMPLES = 5;

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

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSkinNameKey(value) {
  return collapseWhitespace(value)
    .replace(/[\u2605\u2606]/g, '')
    .replace(/[\u2122\u00AE]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function chunkArray(values, size) {
  const items = Array.isArray(values) ? values : [];
  const chunkSize = Math.max(1, Number(size) || 1);
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function extractPattern(item) {
  const parsed = parseInt(item && item.item_paint_seed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractFloat(item) {
  const candidates = [item && item.item_float, item && item.float];

  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function normalizePrice(item) {
  const candidates = [item && item.price, item && item.price_usd, item && item.amount];
  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (parsed != null) {
      return parsed;
    }
  }
  return null;
}

function extractItems(payload) {
  if (Array.isArray(payload && payload.data)) {
    return payload.data;
  }

  if (payload && payload.data && Array.isArray(payload.data.items)) {
    return payload.data.items;
  }

  if (Array.isArray(payload && payload.items)) {
    return payload.items;
  }

  return [];
}

function extractNextCursor(payload) {
  const nextCursor = payload && payload.meta && payload.meta.next_cursor;
  return nextCursor ? String(nextCursor) : null;
}

function summarizeSearchItem(item) {
  return {
    id: item && (item.id || item.item_id || item.item_asset_id || item.asset_id || null),
    name: extractItemName(item) || null,
    price: normalizePrice(item),
    currency: String(item && (item.currency || item.currency_code || '') || '').toUpperCase() || null,
    item_paint_seed: item && Object.prototype.hasOwnProperty.call(item, 'item_paint_seed') ? item.item_paint_seed : null,
    item_paint_index: item && Object.prototype.hasOwnProperty.call(item, 'item_paint_index') ? item.item_paint_index : null,
    item_float: extractFloat(item),
    unlock_at: item && item.unlock_at ? item.unlock_at : null
  };
}

function summarizeSearchPayload(payload) {
  const items = extractItems(payload);
  return {
    itemCount: items.length,
    nextCursor: extractNextCursor(payload),
    meta: payload && payload.meta ? {
      perPage: payload.meta.per_page != null ? payload.meta.per_page : null,
      nextCursorPresent: !!payload.meta.next_cursor
    } : null,
    sampleItems: items.slice(0, 3).map((item) => summarizeSearchItem(item)),
    error: payload && payload.error ? payload.error : null
  };
}

function buildRequestTraceDetails(url, batch, cursor) {
  return {
    httpTraceMode: 'full',
    httpTraceKind: 'request',
    method: 'GET',
    url,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer [redacted]'
    },
    query: {
      game: 'csgo',
      sortBy: SORT_BY,
      onlyUnlocked: ONLY_UNLOCKED,
      cursor: cursor || null,
      priceTo: batch.maxPrice != null ? String(batch.maxPrice) : null,
      names: batch.names.slice()
    }
  };
}

function buildResponseTraceDetails(url, response, payload) {
  return {
    httpTraceMode: 'full',
    httpTraceKind: 'response',
    method: 'GET',
    url,
    status: response && response.status,
    responsePreview: summarizeSearchPayload(payload),
    responseRaw: payload
  };
}

function hasOfficialPatternField(item) {
  return !!item && Object.prototype.hasOwnProperty.call(item, 'item_paint_seed');
}

function extractQualityFromName(name) {
  const match = String(name || '').match(/\(([^()]+)\)\s*$/);
  return match ? match[1].trim() : null;
}

function extractItemName(item) {
  const candidates = [
    item && item.name,
    item && item.market_hash_name,
    item && item.full_name,
    item && item.item_name
  ];

  for (const candidate of candidates) {
    const normalized = collapseWhitespace(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function buildLisSlug(name) {
  return collapseWhitespace(name)
    .replace(/[\u2122\u00AE]/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\|/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/[\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\u2605']+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildLisListingUrl(item, skinName) {
  const candidates = [
    item && item.url,
    item && item.link,
    item && item.market_url,
    item && item.item_url,
    item && item.offer_url
  ];

  for (const candidate of candidates) {
    const value = collapseWhitespace(candidate);
    if (!value) {
      continue;
    }

    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    if (value.startsWith('/')) {
      return 'https://lis-skins.com' + value;
    }
  }

  const slug = buildLisSlug(skinName);
  return slug ? (LISTING_BASE_URL + encodeURIComponent(slug) + '/') : LISTING_BASE_URL;
}

class LisSkinsAdapter {
  constructor(fetchImpl, options) {
    this.fetchImpl = fetchImpl || fetch;
    this.logger = Object.assign(createNoopLogger(), options && options.logger ? options.logger : {});
    this.lastRequestAt = 0;
    this.currentRequestDelayMs = DEFAULT_REQUEST_INTERVALS_MS.lisSkins;
  }

  async waitTurn() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.currentRequestDelayMs) {
      await sleep(this.currentRequestDelayMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  buildFallbackUrl(searchName) {
    return buildLisListingUrl(null, searchName);
  }

  buildBatches(profiles, state, result) {
    const groups = new Map();

    profiles.forEach((profile) => {
      result.listingsByProfile[profile.id] = [];
      const hashNames = buildLisSearchNamesForProfile(state.patternLibrary, profile);
      if (!hashNames.length) {
        return;
      }

      const currencyKey = String(profile.currency || '').trim().toUpperCase();
      let group = groups.get(currencyKey);
      if (!group) {
        group = {
          currency: currencyKey,
          namesToProfiles: new Map()
        };
        groups.set(currencyKey, group);
      }

      hashNames.forEach((hashName) => {
        const nameKey = normalizeSkinNameKey(hashName);
        if (!nameKey) {
          return;
        }

        let entry = group.namesToProfiles.get(nameKey);
        if (!entry) {
          entry = {
            name: collapseWhitespace(hashName),
            profiles: []
          };
          group.namesToProfiles.set(nameKey, entry);
        }

        if (!entry.profiles.some((candidate) => candidate.id === profile.id)) {
          entry.profiles.push(profile);
        }
      });
    });

    const batches = [];
    groups.forEach((group) => {
      const names = Array.from(group.namesToProfiles.values())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'));

      chunkArray(names, MAX_NAMES_PER_BATCH).forEach((chunk) => {
        const profilesByName = new Map();
        let maxPrice = null;
        const profileIds = new Set();

        chunk.forEach((name) => {
          const entry = group.namesToProfiles.get(normalizeSkinNameKey(name));
          if (!entry) {
            return;
          }

          profilesByName.set(normalizeSkinNameKey(name), {
            name: entry.name,
            profiles: entry.profiles.slice()
          });
          entry.profiles.forEach((profile) => {
            profileIds.add(profile.id);
            if (profile.maxPrice !== '' && profile.maxPrice != null && !Number.isNaN(Number(profile.maxPrice))) {
              const numericMaxPrice = Number(profile.maxPrice);
              maxPrice = maxPrice == null ? numericMaxPrice : Math.max(maxPrice, numericMaxPrice);
            }
          });
        });

        batches.push({
          currency: group.currency,
          names: chunk,
          profilesByName,
          maxPrice,
          profileCount: profileIds.size
        });
      });
    });

    return batches;
  }

  async fetchSearchPage(batch, apiKey, cursor, context) {
    const params = new URLSearchParams();
    params.set('game', 'csgo');
    params.set('sort_by', SORT_BY);
    params.set('only_unlocked', String(ONLY_UNLOCKED));

    if (batch.maxPrice != null) {
      params.set('price_to', String(batch.maxPrice));
    }

    batch.names.forEach((name) => {
      params.append('names[]', name);
    });

    if (cursor) {
      params.set('cursor', cursor);
    }

    const url = SEARCH_ENDPOINT + '?' + params.toString();

    context.throwIfStopped();
    await this.waitTurn();
    context.throwIfStopped();
    this.logger.debug('lisSkins', 'HTTP request started.', {
      url,
      names: batch.names.length,
      cursor: cursor || null,
      requestDelayMs: this.currentRequestDelayMs,
      maxPrice: batch.maxPrice,
      onlyUnlocked: ONLY_UNLOCKED
    });
    this.logger.traceHttp('lisSkins', 'HTTP request payload.', buildRequestTraceDetails(url, batch, cursor));

    let response = null;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        signal: context && context.signal ? context.signal : undefined
      });
    } catch (error) {
      if (isAbortError(error) || (context && typeof context.shouldStop === 'function' && context.shouldStop())) {
        throw createProviderError('Scan stopped by user.', 'scan_stopped');
      }
      throw error;
    }

    let payload = {};
    try {
      payload = await readJson(response);
    } catch (error) {
      this.logger.error('lisSkins', 'Invalid JSON in response.', { url, error: error.message });
      throw createProviderError('LIS-SKINS search returned invalid JSON.', 'provider_error');
    }

    this.logger.debug('lisSkins', 'HTTP request finished.', {
      url,
      status: response.status,
      cursor: cursor || null,
      names: batch.names.length
    });
    this.logger.traceHttp('lisSkins', 'HTTP response payload.', buildResponseTraceDetails(url, response, payload));

    if (response.status === 401 || response.status === 403) {
      throw createProviderError(payload && payload.error ? payload.error : 'LIS-SKINS authorization failed.', 'provider_auth_error');
    }

    if (response.status === 429) {
      throw createProviderError('LIS-SKINS rate limit hit.', 'provider_rate_limited');
    }

    if (!response.ok) {
      throw createProviderError(
        payload && payload.error ? payload.error : ('LIS-SKINS HTTP ' + response.status),
        'provider_error'
      );
    }

    return payload || {};
  }

  async scanBatch(batch, apiKey, context) {
    const items = [];
    let cursor = null;
    let nextCursor = null;
    let pagesFetched = 0;
    let metadataFieldObserved = false;

    do {
      context.throwIfStopped();
      const payload = await this.fetchSearchPage(batch, apiKey, cursor, context);
      const pageItems = extractItems(payload);
      pagesFetched += 1;
      metadataFieldObserved = metadataFieldObserved || pageItems.some((item) => hasOfficialPatternField(item));
      items.push(...pageItems);
      nextCursor = extractNextCursor(payload);

      this.logger.info('lisSkins', 'Search page processed.', {
        currency: batch.currency || null,
        page: pagesFetched,
        names: batch.names.length,
        items: pageItems.length,
        nextCursor: nextCursor ? 'present' : 'none',
        maxPrice: batch.maxPrice
      });

      cursor = nextCursor;
      if (!pageItems.length || !nextCursor) {
        break;
      }
    } while (pagesFetched < MAX_PAGES_PER_BATCH);

    const truncated = Boolean(nextCursor);
    if (truncated) {
      this.logger.warn('lisSkins', 'Stopped paginating after newest-first page cap.', {
        currency: batch.currency || null,
        names: batch.names.length,
        pagesFetched,
        maxPagesPerBatch: MAX_PAGES_PER_BATCH
      });
    }

    return {
      items,
      pagesFetched,
      truncated,
      metadataFieldObserved
    };
  }

  routeBatchItems(batch, batchResult, result, stats) {
    batchResult.items.forEach((item) => {
      const itemName = extractItemName(item);
      if (!itemName) {
        return;
      }

      const matchEntry = batch.profilesByName.get(normalizeSkinNameKey(itemName));
      if (!matchEntry || !Array.isArray(matchEntry.profiles) || !matchEntry.profiles.length) {
        stats.skippedUnrelated += 1;
        if (stats.unrelatedSamples.length < MAX_UNRELATED_SAMPLES) {
          stats.unrelatedSamples.push(itemName);
        }
        return;
      }

      const canonicalItemName = itemName;
      const matchingProfiles = matchEntry.profiles;
      const pattern = extractPattern(item);
      if (pattern != null) {
        stats.paintSeedValuesFound += 1;
      }

      matchingProfiles.forEach((profile) => {
        result.listingsByProfile[profile.id].push({
          market: 'lisSkins',
          listingId: String(item.id || item.item_id || item.item_asset_id || item.asset_id || Math.random()),
          skinKey: profile.skinKey,
          skinName: canonicalItemName,
          price: normalizePrice(item),
          currency: String(item.currency || item.currency_code || profile.currency || '').toUpperCase(),
          pattern,
          float: extractFloat(item),
          quality: extractQualityFromName(canonicalItemName),
          listingUrl: buildLisListingUrl(item, canonicalItemName),
          raw: item
        });
      });

      stats.routedOffers += matchingProfiles.length;
    });
  }

  async scanProfiles(profiles, state, context) {
    const runContext = context || { throwIfStopped() {} };
    const credentials = state.integrations.marketplaceCredentials.lisSkins;
    const result = {
      listingsByProfile: {},
      providerStatus: { status: 'provider_ok', message: 'No due profiles.' }
    };

    if (!profiles.length) {
      return result;
    }

    this.currentRequestDelayMs = Number(
      state && state.scanner && state.scanner.requestIntervalsMs && state.scanner.requestIntervalsMs.lisSkins
    ) || DEFAULT_REQUEST_INTERVALS_MS.lisSkins;

    if (!credentials.apiKey) {
      result.providerStatus = {
        status: 'provider_auth_error',
        message: 'LIS-SKINS API key is missing.'
      };
      return result;
    }

    const batches = this.buildBatches(profiles, state, result);
    const stats = {
      pagesFetched: 0,
      offersSeen: 0,
      routedOffers: 0,
      truncatedBatches: 0,
      metadataFieldObserved: false,
      paintSeedValuesFound: 0,
      skippedUnrelated: 0,
      unrelatedSamples: []
    };

    try {
      this.logger.info('lisSkins', 'LIS scan started.', {
        profileCount: profiles.length,
        batchCount: batches.length,
        requestDelayMs: this.currentRequestDelayMs,
        mode: 'official_search'
      });

      for (const batch of batches) {
        runContext.throwIfStopped();
        const batchResult = await this.scanBatch(batch, credentials.apiKey, runContext);
        stats.pagesFetched += batchResult.pagesFetched;
        stats.offersSeen += batchResult.items.length;
        stats.metadataFieldObserved = stats.metadataFieldObserved || batchResult.metadataFieldObserved;
        if (batchResult.truncated) {
          stats.truncatedBatches += 1;
        }

        this.routeBatchItems(batch, batchResult, result, stats);
      }
    } catch (error) {
      this.logger.error('lisSkins', 'LIS scan failed.', { error: error.message, code: error.code || null });
      result.providerStatus = {
        status: error.code || 'provider_error',
        message: error.message
      };
      return result;
    }

    if (stats.offersSeen > 0 && !stats.metadataFieldObserved) {
      result.providerStatus = {
        status: 'provider_metadata_unsupported',
        message: 'Official LIS-SKINS search response did not expose item_paint_seed.'
      };
    } else {
      const messageParts = [
        'Official /v1/market/search ok.',
        'batches=' + batches.length + '.',
        'pages=' + stats.pagesFetched + '.',
        'offers=' + stats.offersSeen + '.'
      ];

      if (stats.paintSeedValuesFound > 0) {
        messageParts.push('paintSeeds=' + stats.paintSeedValuesFound + '.');
      } else if (stats.offersSeen > 0) {
        messageParts.push('Current watched offers have no paint seeds.');
      }

      if (stats.truncatedBatches > 0) {
        messageParts.push('Newest-first pagination capped at ' + MAX_PAGES_PER_BATCH + ' pages for ' + stats.truncatedBatches + ' batch(es).');
      }

      if (stats.skippedUnrelated > 0) {
        messageParts.push('Skipped ' + stats.skippedUnrelated + ' unrelated result(s).');
      }

      result.providerStatus = {
        status: 'provider_ok',
        message: messageParts.join(' ')
      };
    }

    this.logger.info('lisSkins', 'LIS scan finished.', {
      status: result.providerStatus.status,
      message: result.providerStatus.message,
      offersSeen: stats.offersSeen,
      routedOffers: stats.routedOffers,
      paintSeedValuesFound: stats.paintSeedValuesFound,
      truncatedBatches: stats.truncatedBatches,
      skippedUnrelated: stats.skippedUnrelated,
      unrelatedSamples: stats.unrelatedSamples
    });

    return result;
  }
}

module.exports = {
  LisSkinsAdapter,
  buildLisListingUrl,
  buildLisSlug,
  normalizeSkinNameKey
};
