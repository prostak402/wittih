const test = require('node:test');
const assert = require('node:assert/strict');

const { ScannerEngine, createStoppedError } = require('../agent/lib/scanner-engine.js');
const { createDefaultState, normalizeSkinConfig, normalizeScanProfile } = require('../shared/cs2-scanner-core.js');

function buildState() {
  const state = createDefaultState();
  state.patternLibrary.skins['https://market.csgo.com|skin|ak-47 | case hardened'] = normalizeSkinConfig(
    'https://market.csgo.com|skin|ak-47 | case hardened',
    {
      url: 'https://market.csgo.com/ru/Rifle/AK-47/AK-47%20%7C%20Case%20Hardened%20%28Factory%20New%29',
      name: 'AK-47 | Case Hardened',
      tiers: [
        { name: 'Tier 1', patterns: [123] }
      ]
    }
  );
  state.scanProfiles = [
    normalizeScanProfile({
      id: 'profile_1',
      name: 'Test profile',
      skinKey: 'https://market.csgo.com|skin|ak-47 | case hardened',
      markets: ['marketCsgoTm'],
      tiers: ['Tier 1'],
      qualities: ['Factory New'],
      maxPrice: 100,
      currency: 'USD',
      cooldownSec: 30,
      enabled: true
    }, state)
  ];
  return state;
}

test('engine creates one event for matching tier under max price and dedupes repeats', async () => {
  const createdEvents = [];
  const engine = new ScannerEngine({
    initialState: buildState(),
    initialEvents: [],
    initialSeenKeys: {},
    notifier: {
      async sendEvent() {
        return { telegram: 'disabled' };
      }
    },
    adapters: {
      marketCsgoTm: {
        async scanProfiles() {
          return {
            providerStatus: { status: 'provider_ok', message: 'ok' },
            listingsByProfile: {
              profile_1: [
                {
                  market: 'marketCsgoTm',
                  listingId: 'lot_1',
                  skinKey: 'https://market.csgo.com|skin|ak-47 | case hardened',
                  skinName: 'AK-47 | Case Hardened (Factory New)',
                  price: 99.5,
                  currency: 'USD',
                  pattern: 123,
                  listingUrl: 'https://market.csgo.com/item/1'
                }
              ]
            }
          };
        }
      },
      lisSkins: {
        async scanProfiles() {
          return {
            providerStatus: { status: 'provider_ok', message: 'ok' },
            listingsByProfile: {}
          };
        }
      }
    },
    onEvent: async (event) => {
      createdEvents.push(event);
    },
    persist: async () => undefined
  });

  await engine.runDueProfiles('manual', true);
  await engine.runDueProfiles('manual', true);

  assert.equal(createdEvents.length, 1);
  assert.equal(createdEvents[0].listing.tier, 'Tier 1');
  assert.equal(engine.getEventsAfter(0).length, 1);
});

test('engine ignores listings whose skin name does not belong to the profile watchlist', async () => {
  const createdEvents = [];
  const engine = new ScannerEngine({
    initialState: buildState(),
    initialEvents: [],
    initialSeenKeys: {},
    notifier: {
      async sendEvent() {
        return { telegram: 'disabled' };
      }
    },
    adapters: {
      marketCsgoTm: {
        async scanProfiles() {
          return {
            providerStatus: { status: 'provider_ok', message: 'ok' },
            listingsByProfile: {
              profile_1: [
                {
                  market: 'marketCsgoTm',
                  listingId: 'lot_2',
                  skinKey: 'https://market.csgo.com|skin|ak-47 | case hardened',
                  skinName: 'M4A4 | Temukau (Factory New)',
                  price: 10,
                  currency: 'USD',
                  pattern: 123,
                  listingUrl: 'https://market.csgo.com/item/2'
                }
              ]
            }
          };
        }
      },
      lisSkins: {
        async scanProfiles() {
          return {
            providerStatus: { status: 'provider_ok', message: 'ok' },
            listingsByProfile: {}
          };
        }
      }
    },
    onEvent: async (event) => {
      createdEvents.push(event);
    },
    persist: async () => undefined
  });

  await engine.runDueProfiles('manual', true);

  assert.equal(createdEvents.length, 0);
  assert.equal(engine.getEventsAfter(0).length, 0);
});

test('engine repairs legacy lis listing urls in stored journal events', async () => {
  const engine = new ScannerEngine({
    initialState: buildState(),
    initialEvents: [
      {
        cursor: 1,
        eventId: 'evt_lis',
        createdAt: new Date().toISOString(),
        profileId: 'profile_1',
        reason: 'matched_tier_and_price',
        dedupeKey: 'lisSkins:1:123:10',
        listing: {
          market: 'lisSkins',
          listingId: '1',
          skinName: '\u2605 Karambit | Doppler (Phase 4) (Minimal Wear)',
          pattern: 123,
          price: 10,
          currency: 'USD',
          listingUrl: 'https://lis-skins.com/market/csgo?search=%E2%98%85%20Karambit%20%7C%20Doppler%20(Phase%204)%20(Minimal%20Wear)'
        },
        deliveryStatus: {}
      }
    ],
    initialSeenKeys: {},
    notifier: {
      async sendEvent() {
        return { telegram: 'disabled' };
      }
    },
    adapters: {
      marketCsgoTm: { async scanProfiles() { return { providerStatus: { status: 'provider_ok', message: 'ok' }, listingsByProfile: {} }; } },
      lisSkins: { async scanProfiles() { return { providerStatus: { status: 'provider_ok', message: 'ok' }, listingsByProfile: {} }; } }
    },
    persist: async () => undefined
  });

  const storedEvent = engine.getEventsAfter(0)[0];
  assert.equal(
    storedEvent.listing.listingUrl,
    'https://lis-skins.com/ru/market/csgo/%E2%98%85-karambit-doppler-phase-4-minimal-wear/'
  );
});

test('engine can pause scanner and delete events from journal', async () => {
  const engine = new ScannerEngine({
    initialState: buildState(),
    initialEvents: [
      {
        cursor: 1,
        eventId: 'evt_keep',
        createdAt: new Date().toISOString(),
        profileId: 'profile_1',
        reason: 'matched_tier_and_price',
        dedupeKey: 'a',
        listing: { market: 'marketCsgoTm', listingId: '1', pattern: 123, price: 10 },
        deliveryStatus: {}
      },
      {
        cursor: 2,
        eventId: 'evt_drop',
        createdAt: new Date().toISOString(),
        profileId: 'profile_1',
        reason: 'matched_tier_and_price',
        dedupeKey: 'b',
        listing: { market: 'marketCsgoTm', listingId: '2', pattern: 123, price: 11 },
        deliveryStatus: {}
      }
    ],
    initialSeenKeys: {},
    notifier: {
      async sendEvent() {
        return { telegram: 'disabled' };
      }
    },
    adapters: {
      marketCsgoTm: { async scanProfiles() { return { providerStatus: { status: 'provider_ok', message: 'ok' }, listingsByProfile: {} }; } },
      lisSkins: { async scanProfiles() { return { providerStatus: { status: 'provider_ok', message: 'ok' }, listingsByProfile: {} }; } }
    },
    persist: async () => undefined
  });

  await engine.setScannerEnabled(false, 'Pause for test');
  assert.equal(engine.getStatus().scannerEnabled, false);

  const removed = await engine.deleteEvents(['evt_drop']);
  assert.equal(removed, 1);
  assert.equal(engine.getEventsAfter(0).some((event) => event.eventId === 'evt_drop'), false);
  assert.equal(engine.getEventsAfter(0).some((event) => event.eventId === 'evt_keep'), true);
});

test('engine accepts lis listings matched against lis search names instead of market hash names', async () => {
  const url = 'https://market.csgo.com/ru/Knife/Karambit/%E2%98%85%20Karambit%20%7C%20Doppler%20%28Factory%20New%29?phase-product=phase3';
  const skinKey = require('../shared/cs2-scanner-core.js').buildSkinKey(url);
  const state = createDefaultState();
  state.patternLibrary.skins[skinKey] = normalizeSkinConfig(skinKey, {
    url,
    name: '\u2605 Karambit | Doppler (Factory New)',
    tiers: [
      { name: 'Tier 1', patterns: [123] }
    ]
  });
  state.scanProfiles = [
    normalizeScanProfile({
      id: 'profile_lis',
      name: 'LIS profile',
      skinKey,
      markets: ['lisSkins'],
      tiers: ['Tier 1'],
      qualities: ['Factory New'],
      maxPrice: 100,
      currency: 'USD',
      cooldownSec: 30,
      enabled: true
    }, state)
  ];

  const createdEvents = [];
  const engine = new ScannerEngine({
    initialState: state,
    initialEvents: [],
    initialSeenKeys: {},
    notifier: {
      async sendEvent() {
        return { telegram: 'disabled' };
      }
    },
    adapters: {
      marketCsgoTm: { async scanProfiles() { return { providerStatus: { status: 'provider_ok', message: 'ok' }, listingsByProfile: {} }; } },
      lisSkins: {
        async scanProfiles() {
          return {
            providerStatus: { status: 'provider_ok', message: 'ok' },
            listingsByProfile: {
              profile_lis: [
                {
                  market: 'lisSkins',
                  listingId: 'lis_1',
                  skinKey,
                  skinName: '\u2605 Karambit | Doppler (Phase 3) (Factory New)',
                  price: 50,
                  currency: 'USD',
                  pattern: 123,
                  listingUrl: 'https://lis-skins.com/ru/market/csgo/%E2%98%85-karambit-doppler-phase-3-factory-new/'
                }
              ]
            }
          };
        }
      }
    },
    onEvent: async (event) => {
      createdEvents.push(event);
    },
    persist: async () => undefined
  });

  await engine.runDueProfiles('manual', true);

  assert.equal(createdEvents.length, 1);
  assert.equal(createdEvents[0].listing.market, 'lisSkins');
  assert.equal(createdEvents[0].listing.tier, 'Tier 1');
});

test('engine stop request aborts an in-flight scan and reports final stopped state', async () => {
  let abortSeen = false;
  const engine = new ScannerEngine({
    initialState: buildState(),
    initialEvents: [],
    initialSeenKeys: {},
    notifier: {
      async sendEvent() {
        return { telegram: 'disabled' };
      }
    },
    adapters: {
      marketCsgoTm: {
        async scanProfiles(profiles, state, context) {
          return new Promise((resolve, reject) => {
            if (!context || !context.signal) {
              reject(new Error('Abort signal is missing.'));
              return;
            }

            context.signal.addEventListener('abort', () => {
              abortSeen = true;
              reject(createStoppedError('Scan stopped by user.'));
            }, { once: true });
          });
        }
      },
      lisSkins: {
        async scanProfiles() {
          return {
            providerStatus: { status: 'provider_ok', message: 'ok' },
            listingsByProfile: {}
          };
        }
      }
    },
    persist: async () => undefined
  });

  const runPromise = engine.runDueProfiles('manual', true);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const stopStatus = await engine.setScannerEnabled(false, 'Stop now');
  assert.equal(stopStatus.scannerEnabled, false);

  const finalStatus = await runPromise;
  assert.equal(abortSeen, true);
  assert.equal(finalStatus.isRunning, false);
  assert.equal(finalStatus.stopRequested, false);
  assert.equal(finalStatus.scannerEnabled, false);
  assert.equal(finalStatus.lastScanSummary.status, 'stopped');
});
