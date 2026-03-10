const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LisSkinsAdapter,
  buildLisListingUrl,
  buildLisSlug
} = require('../agent/lib/adapters/lis-skins.js');
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
    markets: ['lisSkins'],
    tiers: ['Tier 1'],
    qualities: ['Factory New'],
    maxPrice: 500,
    currency: 'USD',
    cooldownSec: 30,
    enabled: true
  }, profile), state));

  state.integrations.marketplaceCredentials.lisSkins.apiKey = 'test-token';
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

function createFetch(handler) {
  const calls = [];

  async function fetchStub(url, options) {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  }

  fetchStub.calls = calls;
  return fetchStub;
}

function buildAdapter(fetchStub) {
  const adapter = new LisSkinsAdapter(fetchStub);
  adapter.waitTurn = async () => undefined;
  return adapter;
}

test('lis adapter uses official names[] search, cursor pagination, and item_paint_seed routing', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 },
    { id: 'profile_mw', name: 'MW profile', qualities: ['Minimal Wear'], maxPrice: 75 }
  ]);

  const fetchStub = createFetch((url, options, callNumber) => {
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.origin + parsedUrl.pathname, 'https://api.lis-skins.com/v1/market/search');
    assert.equal(parsedUrl.searchParams.get('game'), 'csgo');
    assert.equal(parsedUrl.searchParams.get('sort_by'), 'newest');
    assert.equal(parsedUrl.searchParams.get('only_unlocked'), '1');
    assert.equal(parsedUrl.searchParams.get('price_to'), '150');
    assert.equal(options.headers.Authorization, 'Bearer test-token');

    const names = parsedUrl.searchParams.getAll('names[]').sort();
    assert.deepEqual(names, [
      'AK-47 | Case Hardened (Factory New)',
      'AK-47 | Case Hardened (Minimal Wear)'
    ]);

    if (callNumber === 1) {
      assert.equal(parsedUrl.searchParams.get('cursor'), null);
      return jsonResponse(200, {
        data: [
          {
            id: 11,
            name: 'AK-47 | Case Hardened (Factory New)',
            price: 72.5,
            created_at: '2026-03-10T10:00:00.000000Z',
            item_float: '0.03123',
            item_paint_seed: '123'
          }
        ],
        meta: {
          per_page: 200,
          next_cursor: 'cursor_2'
        }
      });
    }

    assert.equal(parsedUrl.searchParams.get('cursor'), 'cursor_2');
    return jsonResponse(200, {
      data: [
        {
          id: 12,
          name: 'AK-47 | Case Hardened (Minimal Wear)',
          price: 74.0,
          created_at: '2026-03-10T09:59:00.000000Z',
          item_float: '0.10234',
          item_paint_seed: '321'
        }
      ],
      meta: {
        per_page: 200,
        next_cursor: null
      }
    });
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_ok');
  assert.match(result.providerStatus.message, /official \/v1\/market\/search ok/i);
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(result.listingsByProfile.profile_fn.length, 1);
  assert.equal(result.listingsByProfile.profile_mw.length, 1);
  assert.equal(result.listingsByProfile.profile_fn[0].pattern, 123);
  assert.equal(result.listingsByProfile.profile_mw[0].pattern, 321);
  assert.equal(result.listingsByProfile.profile_fn[0].float, 0.03123);
  assert.equal(result.listingsByProfile.profile_mw[0].quality, 'Minimal Wear');
  assert.equal(
    result.listingsByProfile.profile_fn[0].listingUrl,
    'https://lis-skins.com/ru/market/csgo/ak-47-case-hardened-factory-new/'
  );
});

test('lis adapter ignores unrelated search results that do not exactly match watched names', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 }
  ]);

  const fetchStub = createFetch(() => jsonResponse(200, {
    data: [
      {
        id: 1,
        name: 'M4A4 | Temukau (Factory New)',
        price: 12,
        item_float: '0.01',
        item_paint_seed: '123'
      },
      {
        id: 2,
        name: 'AK-47 | Case Hardened (Factory New)',
        price: 72.5,
        item_float: '0.03123',
        item_paint_seed: '123'
      }
    ],
    meta: {
      per_page: 200,
      next_cursor: null
    }
  }));

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_ok');
  assert.match(result.providerStatus.message, /skipped 1 unrelated result/i);
  assert.equal(result.listingsByProfile.profile_fn.length, 1);
  assert.equal(result.listingsByProfile.profile_fn[0].skinName, 'AK-47 | Case Hardened (Factory New)');
});

test('lis adapter reports metadata unsupported only when official item_paint_seed field is absent', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 }
  ]);

  const fetchStub = createFetch(() => jsonResponse(200, {
    data: [
      {
        id: 11,
        name: 'AK-47 | Case Hardened (Factory New)',
        price: 72.5,
        item_float: '0.03123'
      }
    ],
    meta: {
      per_page: 200,
      next_cursor: null
    }
  }));

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_metadata_unsupported');
  assert.equal(result.listingsByProfile.profile_fn.length, 1);
  assert.equal(result.listingsByProfile.profile_fn[0].pattern, null);
});

test('lis adapter keeps provider_ok when official paint seed field exists but current offers have null seed values', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 }
  ]);

  const fetchStub = createFetch(() => jsonResponse(200, {
    data: [
      {
        id: 11,
        name: 'AK-47 | Case Hardened (Factory New)',
        price: 72.5,
        item_float: '0.03123',
        item_paint_seed: null
      }
    ],
    meta: {
      per_page: 200,
      next_cursor: null
    }
  }));

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_ok');
  assert.match(result.providerStatus.message, /no paint seeds/i);
  assert.equal(result.listingsByProfile.profile_fn.length, 1);
  assert.equal(result.listingsByProfile.profile_fn[0].pattern, null);
});

test('lis adapter maps auth and rate limit failures to provider statuses', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 }
  ]);

  const authAdapter = buildAdapter(createFetch(() => jsonResponse(403, { error: 'Forbidden' })));
  const authResult = await authAdapter.scanProfiles(state.scanProfiles, state);
  assert.equal(authResult.providerStatus.status, 'provider_auth_error');

  const rateAdapter = buildAdapter(createFetch(() => jsonResponse(429, { error: 'Too many requests' })));
  const rateResult = await rateAdapter.scanProfiles(state.scanProfiles, state);
  assert.equal(rateResult.providerStatus.status, 'provider_rate_limited');
});

test('lis adapter returns auth error when api key is missing', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 }
  ]);
  state.integrations.marketplaceCredentials.lisSkins.apiKey = '';

  const adapter = buildAdapter(createFetch(() => {
    throw new Error('fetch should not be called without api key');
  }));

  const result = await adapter.scanProfiles(state.scanProfiles, state);
  assert.equal(result.providerStatus.status, 'provider_auth_error');
  assert.equal(result.providerStatus.message, 'LIS-SKINS API key is missing.');
});

test('lis listing url builder creates canonical marketplace permalinks', () => {
  assert.equal(
    buildLisSlug('\u2605 Karambit | Doppler (Phase 4) (Minimal Wear)'),
    '\u2605-karambit-doppler-phase-4-minimal-wear'
  );
  assert.equal(
    buildLisSlug("\u2605 Sport Gloves | Pandora's Box (Factory New)"),
    "\u2605-sport-gloves-pandora's-box-factory-new"
  );
  assert.equal(
    buildLisSlug('\u2605 StatTrak\u2122 Karambit | Gamma Doppler (Emerald) (Factory New)'),
    '\u2605-stattrak-karambit-gamma-doppler-emerald-factory-new'
  );
  assert.equal(
    buildLisListingUrl(null, '\u2605 Butterfly Knife | Doppler (Ruby) (Minimal Wear)'),
    'https://lis-skins.com/ru/market/csgo/%E2%98%85-butterfly-knife-doppler-ruby-minimal-wear/'
  );
});

test('lis adapter includes URL phase variants in names[] search and matches starred phased response names', async () => {
  const state = createDefaultState();
  const url = 'https://market.csgo.com/ru/Knife/Karambit/%E2%98%85%20Karambit%20%7C%20Doppler%20%28Factory%20New%29?phase-product=phase3';
  const skinKey = require('../shared/cs2-scanner-core.js').buildSkinKey(url);
  state.patternLibrary.skins[skinKey] = normalizeSkinConfig(skinKey, {
    url,
    name: '\u2605 Karambit | Doppler (Factory New)',
    tiers: [
      { name: 'Tier 1', patterns: [123] }
    ]
  });
  state.scanProfiles = [normalizeScanProfile({
    id: 'profile_knife',
    skinKey,
    markets: ['lisSkins'],
    tiers: ['Tier 1'],
    qualities: ['Factory New', 'Minimal Wear'],
    maxPrice: 500,
    currency: 'USD',
    cooldownSec: 30,
    enabled: true
  }, state)];
  state.integrations.marketplaceCredentials.lisSkins.apiKey = 'test-token';

  const fetchStub = createFetch((url, options) => {
    const parsedUrl = new URL(url);
    assert.deepEqual(parsedUrl.searchParams.getAll('names[]').sort(), [
      '\u2605 Karambit | Doppler (Phase 3) (Factory New)',
      '\u2605 Karambit | Doppler (Phase 3) (Minimal Wear)'
    ]);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return jsonResponse(200, {
      data: [
        {
          id: 99,
          name: '\u2605 Karambit | Doppler (Phase 3) (Factory New)',
          price: 123.45,
          item_float: '0.03123',
          item_paint_seed: '123'
        }
      ],
      meta: {
        per_page: 200,
        next_cursor: null
      }
    });
  });

  const adapter = buildAdapter(fetchStub);
  const result = await adapter.scanProfiles(state.scanProfiles, state);

  assert.equal(result.providerStatus.status, 'provider_ok');
  assert.equal(result.listingsByProfile.profile_knife.length, 1);
  assert.equal(result.listingsByProfile.profile_knife[0].skinName, '\u2605 Karambit | Doppler (Phase 3) (Factory New)');
  assert.equal(
    result.listingsByProfile.profile_knife[0].listingUrl,
    'https://lis-skins.com/ru/market/csgo/%E2%98%85-karambit-doppler-phase-3-factory-new/'
  );
});

test('lis adapter emits full HTTP trace request and raw response payload when trace logging is enabled', async () => {
  const { state } = buildState([
    { id: 'profile_fn', name: 'FN profile', qualities: ['Factory New'], maxPrice: 150 }
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

  const fetchStub = createFetch(() => jsonResponse(200, {
    data: [
      {
        id: 11,
        name: 'AK-47 | Case Hardened (Factory New)',
        price: 72.5,
        item_float: '0.03123',
        item_paint_seed: '123',
        item_paint_index: '44'
      }
    ],
    meta: {
      per_page: 200,
      next_cursor: null
    }
  }));

  const adapter = new LisSkinsAdapter(fetchStub, { logger });
  adapter.waitTurn = async () => undefined;

  const result = await adapter.scanProfiles(state.scanProfiles, state);
  assert.equal(result.providerStatus.status, 'provider_ok');

  const requestTrace = traces.find((entry) => entry.message === 'HTTP request payload.');
  const responseTrace = traces.find((entry) => entry.message === 'HTTP response payload.');

  assert.ok(requestTrace);
  assert.equal(requestTrace.details.httpTraceKind, 'request');
  assert.equal(requestTrace.details.httpTraceMode, 'full');
  assert.equal(requestTrace.details.headers.Authorization, 'Bearer [redacted]');
  assert.deepEqual(requestTrace.details.query.names, ['AK-47 | Case Hardened (Factory New)']);
  assert.match(requestTrace.details.url, /names%5B%5D=AK-47(?:\+|%20)%7C(?:\+|%20)Case(?:\+|%20)Hardened(?:\+|%20)%28Factory(?:\+|%20)New%29/);

  assert.ok(responseTrace);
  assert.equal(responseTrace.details.httpTraceKind, 'response');
  assert.equal(responseTrace.details.httpTraceMode, 'full');
  assert.equal(responseTrace.details.responsePreview.itemCount, 1);
  assert.equal(responseTrace.details.responseRaw.data[0].item_paint_seed, '123');
  assert.equal(responseTrace.details.responseRaw.data[0].item_paint_index, '44');
});
