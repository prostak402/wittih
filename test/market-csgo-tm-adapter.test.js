const test = require('node:test');
const assert = require('node:assert/strict');

const { MarketCsgoTmAdapter } = require('../agent/lib/adapters/market-csgo-tm.js');
const {
  createDefaultState,
  normalizeSkinConfig,
  normalizeScanProfile
} = require('../shared/cs2-scanner-core.js');

function buildState(profileOverrides) {
  const state = createDefaultState();
  const skinKey = 'https://market.csgo.com|skin|ak-47 | case hardened';
  state.patternLibrary.skins[skinKey] = normalizeSkinConfig(skinKey, {
    url: 'https://market.csgo.com/ru/Rifle/AK-47/AK-47%20%7C%20Case%20Hardened%20%28Factory%20New%29',
    name: 'AK-47 | Case Hardened',
    tiers: [
      { name: 'Tier 1', patterns: [123, 321] }
    ]
  });

  state.scanProfiles = profileOverrides.map((profile) => normalizeScanProfile(Object.assign({
    skinKey,
    markets: ['marketCsgoTm'],
    tiers: ['Tier 1'],
    qualities: ['Factory New'],
    maxPrice: 500,
    cooldownSec: 30,
    enabled: true
  }, profile), state));

  return { state, skinKey };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function createFetch(routeMap) {
  const calls = [];

  async function fetchStub(url) {
    calls.push(url);

    if (!(url in routeMap)) {
      throw new Error('Unexpected URL: ' + url);
    }

    const route = routeMap[url];
    if (Array.isArray(route)) {
      const next = route.shift();
      if (!next) {
        throw new Error('No response left for URL: ' + url);
      }
      if (next.throw) {
        throw next.throw;
      }
      return jsonResponse(next.status, next.body);
    }

    if (route && route.throw) {
      throw route.throw;
    }

    return jsonResponse(route.status, route.body);
  }

  fetchStub.calls = calls;
  return fetchStub;
}

function buildAdapter(fetchStub) {
  const adapter = new MarketCsgoTmAdapter(fetchStub);
  adapter.waitTurn = async () => undefined;
  return adapter;
}

test('market adapter uses full-export snapshots per currency and does not require API key', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' },
    { id: 'profile_rub', name: 'RUB profile', currency: 'RUB' }
  ]);

  const format = ['price', 'id', 'market_hash_name', 'float', 'paintseed', 'source'];
  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 200,
      body: { time: 1001, format, items: ['usd-1.json'] }
    },
    'https://market.csgo.com/api/full-export/usd-1.json': {
      status: 200,
      body: [
        [1526, 501, 'AK-47 | Case Hardened (Factory New)', '0.1234', '123', 'STEAM'],
        [9900, 999, 'Desert Eagle | Blaze (Factory New)', '0.0100', '555', 'STEAM']
      ]
    },
    'https://market.csgo.com/api/full-export/RUB.json': {
      status: 200,
      body: { time: 2002, format, items: ['rub-1.json'] }
    },
    'https://market.csgo.com/api/full-export/rub-1.json': {
      status: 200,
      body: [
        [12345, 601, 'AK-47 | Case Hardened (Factory New)', '0.4567', '321', 'STEAM']
      ]
    }
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_ok');
  assert.equal(fetchStub.calls.length, 4);
  assert.equal(result.listingsByProfile.profile_usd.length, 1);
  assert.equal(result.listingsByProfile.profile_rub.length, 1);
  assert.equal(result.listingsByProfile.profile_usd[0].price, 1.53);
  assert.equal(result.listingsByProfile.profile_rub[0].price, 123.45);
  assert.equal(result.listingsByProfile.profile_usd[0].pattern, 123);
  assert.equal(result.listingsByProfile.profile_rub[0].pattern, 321);
  assert.equal(result.listingsByProfile.profile_usd[0].quality, 'Factory New');
  assert.equal(result.listingsByProfile.profile_usd[0].raw.source, 'STEAM');
  assert.match(result.providerStatus.message, /full-export snapshot ok/i);
});

test('market adapter reports metadata unsupported when manifest format has no paintseed column', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' }
  ]);

  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 200,
      body: {
        time: 1001,
        format: ['price', 'id', 'market_hash_name', 'float', 'source'],
        items: ['usd-1.json']
      }
    }
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_metadata_unsupported');
  assert.equal(result.listingsByProfile.profile_usd.length, 0);
  assert.match(result.providerStatus.message, /paintseed/i);
});

test('market adapter reports metadata unsupported when watched offers have no paintseed values', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' }
  ]);

  const format = ['price', 'id', 'market_hash_name', 'float', 'paintseed', 'source'];
  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 200,
      body: { time: 1001, format, items: ['usd-1.json'] }
    },
    'https://market.csgo.com/api/full-export/usd-1.json': {
      status: 200,
      body: [
        [1526, 501, 'AK-47 | Case Hardened (Factory New)', '0.1234', '', 'STEAM']
      ]
    }
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_metadata_unsupported');
  assert.equal(result.listingsByProfile.profile_usd.length, 0);
  assert.match(result.providerStatus.message, /watched offers/i);
});

test('market adapter fails the whole snapshot when any shard keeps failing', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' }
  ]);

  const format = ['price', 'id', 'market_hash_name', 'float', 'paintseed', 'source'];
  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 200,
      body: { time: 1001, format, items: ['usd-1.json', 'usd-2.json'] }
    },
    'https://market.csgo.com/api/full-export/usd-1.json': {
      status: 200,
      body: [
        [1526, 501, 'AK-47 | Case Hardened (Factory New)', '0.1234', '123', 'STEAM']
      ]
    },
    'https://market.csgo.com/api/full-export/usd-2.json': [
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } }
    ]
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_error');
  assert.equal(result.listingsByProfile.profile_usd.length, 0);
});

test('market adapter maps HTTP 429 to provider_rate_limited', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' }
  ]);

  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 429,
      body: { error: 'slow down' }
    }
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_rate_limited');
});

test('market adapter reuses cached snapshot for repeated scans with the same watchlist', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' }
  ]);

  const format = ['price', 'id', 'market_hash_name', 'float', 'paintseed', 'source'];
  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 200,
      body: { time: 1001, format, items: ['usd-1.json'] }
    },
    'https://market.csgo.com/api/full-export/usd-1.json': {
      status: 200,
      body: [
        [1526, 501, 'AK-47 | Case Hardened (Factory New)', '0.1234', '123', 'STEAM']
      ]
    }
  });

  const adapter = buildAdapter(fetchStub);
  const first = await adapter.scanProfiles(state.scanProfiles, state);
  const second = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(first.providerStatus.status, 'provider_ok');
  assert.equal(second.providerStatus.status, 'provider_ok');
  assert.equal(fetchStub.calls.length, 2);
});

test('market adapter emits compact HTTP trace previews when trace logging is enabled', async () => {
  const { state } = buildState([
    { id: 'profile_usd', name: 'USD profile', currency: 'USD' }
  ]);

  const traces = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    isHttpTraceEnabled() {
      return true;
    },
    traceHttp(source, message, details) {
      traces.push({ source, message, details });
    }
  };

  const format = ['price', 'id', 'market_hash_name', 'float', 'paintseed', 'paintindex', 'source'];
  const fetchStub = createFetch({
    'https://market.csgo.com/api/full-export/USD.json': {
      status: 200,
      body: { time: 1001, format, items: ['usd-1.json'] }
    },
    'https://market.csgo.com/api/full-export/usd-1.json': {
      status: 200,
      body: [
        [1526, 501, 'AK-47 | Case Hardened (Factory New)', '0.1234', '123', '44', 'STEAM']
      ]
    }
  });

  const adapter = new MarketCsgoTmAdapter(fetchStub, { logger });
  adapter.waitTurn = async () => undefined;

  const result = await adapter.scanProfiles(state.scanProfiles, state);
  assert.equal(result.providerStatus.status, 'provider_ok');

  const manifestTrace = traces.find((entry) => entry.message === 'HTTP response payload.' && /manifest/i.test(entry.details.label));
  const shardTrace = traces.find((entry) => entry.message === 'Watched shard matches.');

  assert.ok(manifestTrace);
  assert.equal(manifestTrace.details.response.formatFieldCount, 7);
  assert.equal(manifestTrace.details.response.shardCount, 1);

  assert.ok(shardTrace);
  assert.equal(shardTrace.details.matchedRows, 1);
  assert.equal(shardTrace.details.sampleWatchedRows[0].market_hash_name, 'AK-47 | Case Hardened (Factory New)');
  assert.equal(shardTrace.details.sampleWatchedRows[0].paintseed, '123');
});