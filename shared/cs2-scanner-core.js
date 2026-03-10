(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.CS2ScannerCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 2;
  const LEGACY_STORAGE_KEY = 'cs2PatternTiers';
  const APP_STORAGE_KEY = 'cs2ScannerState';
  const MONITOR_STORAGE_KEY = 'cs2ScannerMonitorCache';
  const DEFAULT_AGENT_URL = 'http://127.0.0.1:37891';
  const QUALITY_OPTIONS = [
    'Factory New',
    'Minimal Wear',
    'Field-Tested',
    'Well-Worn',
    'Battle-Scarred',
    'Not Painted'
  ];
  const MARKET_OPTIONS = [
    { id: 'marketCsgoTm', label: 'Market.csgo.tm' },
    { id: 'lisSkins', label: 'LIS-SKINS' }
  ];
  const MARKET_IDS = MARKET_OPTIONS.map((item) => item.id);
  const MIN_PROFILE_COOLDOWN_SEC = 10;
  const MAX_PROFILE_COOLDOWN_SEC = 300;
  const DEFAULT_REQUEST_INTERVALS_MS = {
    marketCsgoTm: 300,
    lisSkins: 350
  };
  const MIN_REQUEST_INTERVAL_MS = 100;
  const MAX_REQUEST_INTERVAL_MS = 10000;

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function normalizePatternIds(values) {
    const list = Array.isArray(values) ? values : [];
    const seen = new Set();
    const result = [];

    list.forEach((value) => {
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed) || seen.has(parsed)) {
        return;
      }

      seen.add(parsed);
      result.push(parsed);
    });

    return result.sort((a, b) => a - b);
  }

  function buildSkinKey(urlString, fallbackOrigin) {
    try {
      const url = new URL(urlString, fallbackOrigin || 'https://market.csgo.com');
      const decodedPath = decodeURIComponent(url.pathname);
      const segments = decodedPath.split('/').filter(Boolean);
      if (!segments.length) {
        return null;
      }

      let lastSeg = segments[segments.length - 1];
      lastSeg = lastSeg.replace(/\s*\([^()]*\)\s*$/, '');
      lastSeg = lastSeg.trim();
      if (!lastSeg) {
        return null;
      }

      return url.origin + '|skin|' + lastSeg.toLowerCase();
    } catch (error) {
      return null;
    }
  }

  function extractSkinBaseName(urlString) {
    try {
      const url = new URL(urlString, 'https://market.csgo.com');
      const decodedPath = decodeURIComponent(url.pathname);
      const segments = decodedPath.split('/').filter(Boolean);
      if (!segments.length) {
        return null;
      }

      const baseName = segments[segments.length - 1]
        .replace(/\s*\([^()]*\)\s*$/, '')
        .trim();

      return baseName || null;
    } catch (error) {
      return null;
    }
  }

  function normalizeSkinBaseName(value) {
    return String(value || '')
      .replace(/[\u2605\u2606]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || null;
  }

  function buildMarketHashName(baseName, quality) {
    const normalizedBaseName = String(baseName || '').trim();
    const normalizedQuality = String(quality || '').trim();
    if (!normalizedBaseName) {
      return '';
    }

    if (!normalizedQuality || normalizedQuality === 'Not Painted') {
      return normalizedBaseName;
    }

    return normalizedBaseName + ' (' + normalizedQuality + ')';
  }

  function stripKnownQualitySuffix(name) {
    const normalizedName = String(name || '').trim();
    const match = normalizedName.match(/\(([^()]+)\)\s*$/);
    if (!match) {
      return normalizedName;
    }

    return QUALITY_OPTIONS.includes(match[1].trim())
      ? normalizedName.slice(0, match.index).trim()
      : normalizedName;
  }

  function extractPhaseProductLabel(urlString) {
    try {
      const url = new URL(urlString, 'https://market.csgo.com');
      const rawValue = String(url.searchParams.get('phase-product') || url.searchParams.get('phase') || '').trim().toLowerCase();
      if (!rawValue) {
        return null;
      }

      const labels = {
        phase1: 'Phase 1',
        phase2: 'Phase 2',
        phase3: 'Phase 3',
        phase4: 'Phase 4',
        ruby: 'Ruby',
        sapphire: 'Sapphire',
        emerald: 'Emerald',
        blackpearl: 'Black Pearl',
        'black-pearl': 'Black Pearl',
        black_pearl: 'Black Pearl'
      };

      return labels[rawValue] || null;
    } catch (error) {
      return null;
    }
  }

  function hasExplicitDopplerVariant(baseName) {
    return /\((phase\s+[1-4]|ruby|sapphire|emerald|black pearl)\)/i.test(String(baseName || ''));
  }

  function applyUrlVariantLabel(baseName, urlString) {
    const normalizedBaseName = String(baseName || '').trim();
    if (!normalizedBaseName || hasExplicitDopplerVariant(normalizedBaseName) || !/doppler/i.test(normalizedBaseName)) {
      return normalizedBaseName;
    }

    const phaseLabel = extractPhaseProductLabel(urlString);
    if (!phaseLabel) {
      return normalizedBaseName;
    }

    return normalizedBaseName + ' (' + phaseLabel + ')';
  }

  function buildNamesForQualities(baseName, qualities) {
    const normalizedBaseName = String(baseName || '').trim();
    if (!normalizedBaseName) {
      return [];
    }

    return normalizeQualities(qualities).map((quality) => buildMarketHashName(normalizedBaseName, quality));
  }

  function normalizeTier(tier, index) {
    return {
      name: (tier && tier.name ? String(tier.name).trim() : '') || ('T' + (index + 1)),
      patterns: normalizePatternIds(tier && tier.patterns)
    };
  }

  function normalizeSkinConfig(key, skinConfig) {
    const cfg = safeObject(skinConfig);
    const url = cfg.url ? String(cfg.url).trim() : '';
    const derivedKey = buildSkinKey(url) || key || '';
    const rawSkinBaseName = extractSkinBaseName(url) || cfg.skinBaseName || stripKnownQualitySuffix(cfg.name || '') || null;
    const skinBaseName = normalizeSkinBaseName(rawSkinBaseName);
    const tiers = safeArray(cfg.tiers).map((tier, index) => normalizeTier(tier, index));

    return {
      url,
      name: (cfg.name ? String(cfg.name).trim() : '') || skinBaseName || derivedKey,
      skinBaseName,
      tiers
    };
  }

  function normalizePatternLibrary(patternLibrary) {
    const source = safeObject(patternLibrary && patternLibrary.skins ? patternLibrary.skins : patternLibrary);
    const skins = {};

    Object.entries(source).forEach(([key, value]) => {
      const normalizedKey = buildSkinKey((value && value.url) || key) || key;
      if (!normalizedKey) {
        return;
      }

      skins[normalizedKey] = normalizeSkinConfig(normalizedKey, value);
    });

    return { skins };
  }

  function normalizeMarketCredentials(credentials) {
    const source = safeObject(credentials);
    return {
      marketCsgoTm: {
        enabled: source.marketCsgoTm ? source.marketCsgoTm.enabled !== false : true,
        apiKey: source.marketCsgoTm && source.marketCsgoTm.apiKey ? String(source.marketCsgoTm.apiKey).trim() : ''
      },
      lisSkins: {
        enabled: source.lisSkins ? source.lisSkins.enabled !== false : true,
        apiKey: source.lisSkins && source.lisSkins.apiKey ? String(source.lisSkins.apiKey).trim() : ''
      }
    };
  }

  function normalizeRequestInterval(value, marketId) {
    const defaultValue = DEFAULT_REQUEST_INTERVALS_MS[marketId] || 300;
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return defaultValue;
    }

    return Math.min(MAX_REQUEST_INTERVAL_MS, Math.max(MIN_REQUEST_INTERVAL_MS, parsed));
  }

  function normalizeRequestIntervals(intervals) {
    const source = safeObject(intervals);
    return {
      marketCsgoTm: normalizeRequestInterval(source.marketCsgoTm, 'marketCsgoTm'),
      lisSkins: normalizeRequestInterval(source.lisSkins, 'lisSkins')
    };
  }
  function normalizeNotifications(notifications) {
    const source = safeObject(notifications);
    return {
      browserPush: source.browserPush !== false,
      telegramEnabled: !!source.telegramEnabled,
      telegramBotToken: source.telegramBotToken ? String(source.telegramBotToken).trim() : '',
      telegramChatId: source.telegramChatId ? String(source.telegramChatId).trim() : ''
    };
  }

  function normalizeIntegrations(integrations) {
    const source = safeObject(integrations);
    return {
      agentBaseUrl: (source.agentBaseUrl ? String(source.agentBaseUrl).trim() : '') || DEFAULT_AGENT_URL,
      marketplaceCredentials: normalizeMarketCredentials(source.marketplaceCredentials),
      notifications: normalizeNotifications(source.notifications)
    };
  }

  function normalizeScanner(scanner) {
    const source = safeObject(scanner);
    const defaultCooldown = parseInt(source.defaultCooldownSec, 10);

    return {
      engineEnabled: source.engineEnabled !== false,
      httpTraceEnabled: !!source.httpTraceEnabled,
      defaultCooldownSec: Number.isNaN(defaultCooldown)
        ? 30
        : Math.min(MAX_PROFILE_COOLDOWN_SEC, Math.max(MIN_PROFILE_COOLDOWN_SEC, defaultCooldown)),
      requestIntervalsMs: normalizeRequestIntervals(source.requestIntervalsMs)
    };
  }

  function normalizeMarkets(markets) {
    const selected = safeArray(markets)
      .map((value) => String(value))
      .filter((value) => MARKET_IDS.includes(value));

    return selected.length ? Array.from(new Set(selected)) : ['marketCsgoTm'];
  }

  function normalizeQualities(qualities) {
    const selected = safeArray(qualities)
      .map((value) => String(value))
      .filter((value) => QUALITY_OPTIONS.includes(value));

    return selected.length ? Array.from(new Set(selected)) : ['Factory New'];
  }

  function normalizeSelectedTiers(tiers) {
    return Array.from(new Set(
      safeArray(tiers)
        .map((value) => String(value).trim())
        .filter(Boolean)
    ));
  }

  function createProfileId() {
    return 'profile_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function createDefaultState() {
    return {
      version: VERSION,
      patternLibrary: { skins: {} },
      scanProfiles: [],
      integrations: normalizeIntegrations({}),
      scanner: normalizeScanner({}),
      monitor: {
        lastSyncedAt: null
      }
    };
  }

  function createProfileNameFromSkin(patternLibrary, skinKey) {
    const skins = normalizePatternLibrary(patternLibrary).skins;
    const skin = skins[skinKey];
    return skin ? String(skin.name || skin.skinBaseName || skinKey) : 'New profile';
  }

  function normalizeScanProfile(profile, state) {
    const source = safeObject(profile);
    const scanner = normalizeScanner(state && state.scanner);
    const maxPriceValue = source.maxPrice === '' || source.maxPrice == null ? '' : Number(source.maxPrice);
    const cooldownValue = parseInt(source.cooldownSec, 10);

    return {
      id: source.id ? String(source.id) : createProfileId(),
      enabled: source.enabled !== false,
      name: (source.name ? String(source.name).trim() : '') || createProfileNameFromSkin(state && state.patternLibrary, source.skinKey),
      skinKey: source.skinKey ? String(source.skinKey) : '',
      markets: normalizeMarkets(source.markets),
      tiers: normalizeSelectedTiers(source.tiers),
      qualities: normalizeQualities(source.qualities),
      maxPrice: maxPriceValue === '' || Number.isNaN(maxPriceValue) ? '' : Math.max(0, maxPriceValue),
      currency: (source.currency ? String(source.currency).trim().toUpperCase() : '') || 'USD',
      cooldownSec: Number.isNaN(cooldownValue)
        ? scanner.defaultCooldownSec
        : Math.min(MAX_PROFILE_COOLDOWN_SEC, Math.max(MIN_PROFILE_COOLDOWN_SEC, cooldownValue)),
      notes: source.notes ? String(source.notes).trim() : ''
    };
  }

  function normalizeState(rawState) {
    const source = safeObject(rawState);
    const state = {
      version: VERSION,
      patternLibrary: normalizePatternLibrary(source.patternLibrary),
      integrations: normalizeIntegrations(source.integrations),
      scanner: normalizeScanner(source.scanner),
      monitor: {
        lastSyncedAt: source.monitor && source.monitor.lastSyncedAt ? String(source.monitor.lastSyncedAt) : null
      }
    };

    state.scanProfiles = safeArray(source.scanProfiles).map((profile) => normalizeScanProfile(profile, state));
    return state;
  }

  function migrateState(rawState, legacyPatterns) {
    const state = normalizeState(rawState);
    const legacy = safeObject(legacyPatterns);

    if (!Object.keys(state.patternLibrary.skins).length && Object.keys(legacy).length) {
      state.patternLibrary = normalizePatternLibrary(legacy);
    }

    state.scanProfiles = state.scanProfiles.map((profile) => normalizeScanProfile(profile, state));
    return state;
  }

  function serializeLegacyPatternLibrary(state) {
    return deepClone(normalizePatternLibrary(state && state.patternLibrary).skins);
  }

  function findTierForPattern(skinConfig, patternId) {
    if (!skinConfig || !Array.isArray(skinConfig.tiers)) {
      return null;
    }

    for (let index = 0; index < skinConfig.tiers.length; index += 1) {
      const tier = skinConfig.tiers[index];
      if (!tier || !Array.isArray(tier.patterns)) {
        continue;
      }

      if (tier.patterns.includes(patternId)) {
        return { tier, index };
      }
    }

    return null;
  }

  function buildMarketHashNamesForProfile(patternLibrary, profile) {
    const skins = normalizePatternLibrary(patternLibrary).skins;
    const skin = skins[profile && profile.skinKey];
    if (!skin) {
      return [];
    }

    const baseName = applyUrlVariantLabel(
      extractSkinBaseName(skin.url) || stripKnownQualitySuffix(skin.name || '') || skin.skinBaseName || skin.name,
      skin.url
    );
    return buildNamesForQualities(baseName, profile && profile.qualities);
  }

  function buildLisSearchNamesForProfile(patternLibrary, profile) {
    const skins = normalizePatternLibrary(patternLibrary).skins;
    const skin = skins[profile && profile.skinKey];
    if (!skin) {
      return [];
    }

    const lisBaseName = normalizeSkinBaseName(
      applyUrlVariantLabel(
        extractSkinBaseName(skin.url) || stripKnownQualitySuffix(skin.name || '') || skin.skinBaseName || skin.name,
        skin.url
      )
    );
    return buildNamesForQualities(lisBaseName, profile && profile.qualities);
  }

  function buildExportPayload(sourceConfig, manifestInfo) {
    const patternLibrary = normalizePatternLibrary(sourceConfig && sourceConfig.patternLibrary ? sourceConfig.patternLibrary : sourceConfig);
    const entries = Object.entries(patternLibrary.skins).sort((a, b) => {
      const nameA = (a[1].name || a[0]).toLowerCase();
      const nameB = (b[1].name || b[0]).toLowerCase();
      return nameA.localeCompare(nameB, 'ru');
    });

    const exportedSkinsConfig = {};
    const flatTiers = [];
    let patternCount = 0;

    entries.forEach(([key, cfg]) => {
      const tiers = safeArray(cfg.tiers).map((tier, index) => normalizeTier(tier, index));
      const exportedSkin = {
        url: cfg.url || '',
        name: cfg.name || cfg.skinBaseName || key,
        skinBaseName: cfg.skinBaseName || null,
        tiers
      };

      exportedSkinsConfig[key] = exportedSkin;

      tiers.forEach((tier, index) => {
        patternCount += tier.patterns.length;
        flatTiers.push({
          skinKey: key,
          skinName: exportedSkin.name,
          skinBaseName: exportedSkin.skinBaseName,
          sourceUrl: exportedSkin.url,
          tierIndex: index,
          tierName: tier.name,
          ruleName: exportedSkin.name + ' / ' + tier.name,
          patterns: tier.patterns,
          patternCount: tier.patterns.length
        });
      });
    });

    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      source: {
        extension: 'CS2 Pattern Tier Helper',
        version: manifestInfo && manifestInfo.version ? manifestInfo.version : null,
        storageKey: LEGACY_STORAGE_KEY
      },
      summary: {
        skinCount: entries.length,
        tierCount: flatTiers.length,
        patternCount
      },
      skinsConfig: exportedSkinsConfig,
      flatTiers
    };
  }

  function parseImportedPatternLibrary(rawImport) {
    const parsed = typeof rawImport === 'string' ? JSON.parse(rawImport) : rawImport;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Import payload is empty.');
    }

    if (parsed.skinsConfig) {
      return normalizePatternLibrary(parsed.skinsConfig);
    }

    if (parsed.patternLibrary) {
      return normalizePatternLibrary(parsed.patternLibrary);
    }

    return normalizePatternLibrary(parsed);
  }

  function formatPrice(price, currency) {
    if (price === '' || price == null || Number.isNaN(Number(price))) {
      return 'n/a';
    }

    try {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 2
      }).format(Number(price));
    } catch (error) {
      return String(price) + ' ' + (currency || '').trim();
    }
  }

  function summarizeState(state) {
    const normalized = normalizeState(state);
    return {
      skins: Object.keys(normalized.patternLibrary.skins).length,
      profiles: normalized.scanProfiles.length,
      markets: MARKET_OPTIONS.length
    };
  }

  return {
    VERSION,
    LEGACY_STORAGE_KEY,
    APP_STORAGE_KEY,
    MONITOR_STORAGE_KEY,
    DEFAULT_AGENT_URL,
    QUALITY_OPTIONS,
    MARKET_OPTIONS,
    MARKET_IDS,
    MIN_PROFILE_COOLDOWN_SEC,
    MAX_PROFILE_COOLDOWN_SEC,
    DEFAULT_REQUEST_INTERVALS_MS,
    MIN_REQUEST_INTERVAL_MS,
    MAX_REQUEST_INTERVAL_MS,
    createDefaultState,
    createProfileId,
    buildSkinKey,
    extractSkinBaseName,
    buildMarketHashName,
    buildMarketHashNamesForProfile,
    buildLisSearchNamesForProfile,
    normalizePatternIds,
    normalizeTier,
    normalizeSkinConfig,
    normalizeRequestIntervals,
    normalizePatternLibrary,
    normalizeScanProfile,
    normalizeIntegrations,
    normalizeNotifications,
    normalizeState,
    migrateState,
    serializeLegacyPatternLibrary,
    findTierForPattern,
    buildExportPayload,
    parseImportedPatternLibrary,
    formatPrice,
    summarizeState,
    deepClone
  };
});



