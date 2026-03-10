const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../shared/cs2-scanner-core.js');

test('migrates legacy pattern library into v2 state', () => {
  const legacy = {
    'https://market.csgo.com|skin|ak-47 | case hardened': {
      url: 'https://market.csgo.com/ru/Rifle/AK-47/AK-47%20%7C%20Case%20Hardened%20%28Factory%20New%29',
      name: 'AK-47 | Case Hardened',
      tiers: [
        { name: 'Tier 1', patterns: [1, 2, 3] }
      ]
    }
  };

  const state = core.migrateState(null, legacy);
  assert.equal(state.version, 2);
  assert.equal(Object.keys(state.patternLibrary.skins).length, 1);
  assert.equal(state.patternLibrary.skins['https://market.csgo.com|skin|ak-47 | case hardened'].tiers[0].patterns.length, 3);
});

test('findTierForPattern returns matching tier metadata', () => {
  const skin = {
    tiers: [
      { name: 'Tier 1', patterns: [5, 10] },
      { name: 'Tier 2', patterns: [20] }
    ]
  };

  const match = core.findTierForPattern(skin, 20);
  assert.equal(match.tier.name, 'Tier 2');
  assert.equal(match.index, 1);
});

test('normalizes per-market request intervals with safe defaults', () => {
  const defaults = core.createDefaultState();
  const state = core.normalizeState({
    scanner: {
      httpTraceEnabled: true,
      requestIntervalsMs: {
        marketCsgoTm: '425',
        lisSkins: ''
      }
    }
  });

  assert.equal(defaults.scanner.httpTraceEnabled, false);
  assert.equal(state.scanner.httpTraceEnabled, true);
  assert.equal(state.scanner.requestIntervalsMs.marketCsgoTm, 425);
  assert.equal(state.scanner.requestIntervalsMs.lisSkins, core.DEFAULT_REQUEST_INTERVALS_MS.lisSkins);
});


test('stores skinBaseName without star and builds separate market/lis names', () => {
  const url = 'https://market.csgo.com/ru/Knife/Karambit/%E2%98%85%20Karambit%20%7C%20Doppler%20%28Factory%20New%29?phase-product=phase3';
  const skinKey = core.buildSkinKey(url);
  const state = core.createDefaultState();
  state.patternLibrary.skins[skinKey] = core.normalizeSkinConfig(skinKey, {
    url,
    name: '\u2605 Karambit | Doppler (Factory New)',
    tiers: []
  });

  const profile = core.normalizeScanProfile({
    skinKey,
    qualities: ['Factory New', 'Minimal Wear']
  }, state);

  assert.equal(state.patternLibrary.skins[skinKey].skinBaseName, 'Karambit | Doppler');
  assert.deepEqual(core.buildLisSearchNamesForProfile(state.patternLibrary, profile), [
    'Karambit | Doppler (Phase 3) (Factory New)',
    'Karambit | Doppler (Phase 3) (Minimal Wear)'
  ]);
  assert.deepEqual(core.buildMarketHashNamesForProfile(state.patternLibrary, profile), [
    '\u2605 Karambit | Doppler (Phase 3) (Factory New)',
    '\u2605 Karambit | Doppler (Phase 3) (Minimal Wear)'
  ]);
});
