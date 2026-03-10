const {
  buildLisSearchNamesForProfile,
  buildMarketHashNamesForProfile,
  findTierForPattern,
  normalizeState
} = require('../../shared/cs2-scanner-core.js');
const {
  buildLisListingUrl,
  normalizeSkinNameKey
} = require('./adapters/lis-skins.js');

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function createStoppedError(reason) {
  const error = new Error(reason || 'Scan stopped by user.');
  error.code = 'scan_stopped';
  return error;
}

function isAbortError(error) {
  return !!(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function sanitizeListing(listing) {
  if (!listing || typeof listing !== 'object') {
    return listing;
  }

  if (listing.market !== 'lisSkins') {
    return listing;
  }

  const nextListing = Object.assign({}, listing);
  const currentUrl = String(nextListing.listingUrl || '').trim();
  const shouldRepairUrl = !currentUrl
    || /^https?:\/\/market\.csgo\.com/i.test(currentUrl)
    || /^https?:\/\/lis-skins\.com\/market\/csgo\?search=/i.test(currentUrl);

  if (shouldRepairUrl && nextListing.skinName) {
    nextListing.listingUrl = buildLisListingUrl(nextListing.raw || null, nextListing.skinName);
  }

  return nextListing;
}

function sanitizeEvents(events) {
  const source = Array.isArray(events) ? events : [];
  return source.map((event) => {
    if (!event || typeof event !== 'object') {
      return event;
    }

    return Object.assign({}, event, {
      listing: sanitizeListing(event.listing)
    });
  });
}

class ScannerEngine {
  constructor(options) {
    this.adapters = options.adapters;
    this.notifier = options.notifier;
    this.logger = options.logger || createNoopLogger();
    this.onEvent = options.onEvent || (async () => undefined);
    this.onStatusChange = options.onStatusChange || (() => undefined);
    this.persist = options.persist || (() => undefined);
    this.state = normalizeState(options.initialState || {});
    this.events = sanitizeEvents(options.initialEvents);
    this.seenKeys = options.initialSeenKeys || {};
    this.eventCursor = this.events.reduce((max, event) => Math.max(max, Number(event.cursor || 0)), 0);
    this.startedAt = new Date().toISOString();
    this.configStatus = 'connected';
    this.configMessage = '';
    this.lastConfigAppliedAt = null;
    this.lastScanStartedAt = null;
    this.lastScanFinishedAt = null;
    this.lastScanSummary = null;
    this.providers = {
      marketCsgoTm: { status: 'disconnected', message: 'No scans yet.' },
      lisSkins: { status: 'disconnected', message: 'No scans yet.' }
    };
    this.profileLastRunAt = {};
    this.intervalHandle = null;
    this.isRunning = false;
    this.stopRequested = false;
    this.currentAbortController = null;
  }

  start() {
    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      this.runDueProfiles('timer', false).catch((error) => {
        this.configMessage = error.message;
        this.logger.error('engine', 'Scheduled scan failed.', { error: error.message });
        this.onStatusChange(this.getStatus());
      });
    }, 5000);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isScannerEnabled() {
    return this.state.scanner.engineEnabled !== false;
  }

  abortCurrentRun(reason) {
    if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
      return;
    }

    try {
      this.currentAbortController.abort(createStoppedError(reason));
    } catch (error) {
      try {
        this.currentAbortController.abort();
      } catch (innerError) {
        // no-op
      }
    }
  }

  createRunContext(trigger, forceAll) {
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    this.currentAbortController = abortController;

    return {
      trigger,
      forceAll,
      signal: abortController ? abortController.signal : null,
      shouldStop: () => this.stopRequested || !!(abortController && abortController.signal.aborted),
      throwIfStopped: () => {
        if (this.stopRequested || (abortController && abortController.signal.aborted)) {
          throw createStoppedError();
        }
      }
    };
  }

  async saveState() {
    await this.persist(this.state, this.events, this.seenKeys);
  }

  async setScannerEnabled(enabled, reason) {
    const nextEnabled = !!enabled;
    const wasRunning = this.isRunning;
    this.state = normalizeState({
      ...this.state,
      scanner: {
        ...this.state.scanner,
        engineEnabled: nextEnabled
      }
    });

    if (nextEnabled) {
      this.stopRequested = false;
      this.configStatus = 'connected';
      this.configMessage = reason || 'Scanner resumed.';
      this.logger.info('engine', 'Scanner resumed.', { reason: reason || null });
    } else {
      this.stopRequested = wasRunning;
      if (wasRunning) {
        this.abortCurrentRun(reason || 'Scanner stopped.');
      }
      this.configStatus = 'config_applied';
      this.configMessage = wasRunning ? (reason || 'Stop requested. Waiting for current request to abort.') : (reason || 'Scanner stopped.');
      this.logger.warn('engine', 'Scanner stop requested.', {
        reason: reason || null,
        running: wasRunning
      });
    }

    this.lastConfigAppliedAt = new Date().toISOString();
    await this.saveState();
    this.onStatusChange(this.getStatus());
    return this.getStatus();
  }

  async applyState(nextState) {
    const previousEnabled = this.isScannerEnabled();
    this.state = normalizeState(nextState);
    const nextEnabled = this.isScannerEnabled();

    if (!nextEnabled && previousEnabled && this.isRunning) {
      this.stopRequested = true;
      this.abortCurrentRun('Scanner disabled by config update.');
    }

    if (nextEnabled) {
      this.stopRequested = false;
    }

    this.configStatus = 'config_applied';
    this.configMessage = 'Configuration loaded.';
    this.lastConfigAppliedAt = new Date().toISOString();
    this.logger.info('engine', 'Configuration applied.', {
      profiles: this.state.scanProfiles.length,
      scannerEnabled: nextEnabled,
      requestIntervalsMs: this.state.scanner.requestIntervalsMs
    });
    await this.saveState();
    this.onStatusChange(this.getStatus());
  }

  getStatus() {
    return {
      startedAt: this.startedAt,
      configStatus: this.configStatus,
      configMessage: this.configMessage,
      lastConfigAppliedAt: this.lastConfigAppliedAt,
      lastScanStartedAt: this.lastScanStartedAt,
      lastScanFinishedAt: this.lastScanFinishedAt,
      lastScanSummary: this.lastScanSummary,
      providers: this.providers,
      eventCursor: this.eventCursor,
      scannerEnabled: this.isScannerEnabled(),
      isRunning: this.isRunning,
      stopRequested: this.stopRequested
    };
  }

  getEventsAfter(cursor) {
    const numericCursor = Number(cursor || 0);
    return this.events.filter((event) => Number(event.cursor || 0) > numericCursor);
  }

  getNotifications() {
    return this.state.integrations.notifications;
  }

  buildEvent(profile, listing) {
    this.eventCursor += 1;
    return {
      cursor: this.eventCursor,
      eventId: 'evt_' + this.eventCursor,
      createdAt: new Date().toISOString(),
      profileId: profile.id,
      reason: 'matched_tier_and_price',
      dedupeKey: [listing.market, listing.listingId, listing.pattern, listing.price].join(':'),
      listing,
      deliveryStatus: {}
    };
  }

  shouldAlertProfile(profile, listing) {
    const skin = this.state.patternLibrary.skins[profile.skinKey];
    if (!skin || listing.pattern == null) {
      return null;
    }

    const allowedNamesSource = listing.market === 'lisSkins'
      ? buildLisSearchNamesForProfile(this.state.patternLibrary, profile)
      : buildMarketHashNamesForProfile(this.state.patternLibrary, profile);
    const allowedNames = allowedNamesSource
      .map((name) => normalizeSkinNameKey(name))
      .filter(Boolean);
    const listingNameKey = normalizeSkinNameKey(listing.skinName);
    if (allowedNames.length && (!listingNameKey || !allowedNames.includes(listingNameKey))) {
      return null;
    }

    const tierInfo = findTierForPattern(skin, listing.pattern);
    if (!tierInfo) {
      return null;
    }

    const tierName = tierInfo.tier && tierInfo.tier.name ? tierInfo.tier.name : ('T' + (tierInfo.index + 1));
    if (Array.isArray(profile.tiers) && profile.tiers.length && !profile.tiers.includes(tierName)) {
      return null;
    }

    if (profile.currency && listing.currency && String(profile.currency).toUpperCase() !== String(listing.currency).toUpperCase()) {
      return null;
    }

    if (profile.maxPrice !== '' && listing.price != null && Number(listing.price) > Number(profile.maxPrice)) {
      return null;
    }

    return Object.assign({}, sanitizeListing(listing), { tier: tierName });
  }

  markProfilesRun(profiles) {
    const now = Date.now();
    profiles.forEach((profile) => {
      this.profileLastRunAt[profile.id] = now;
    });
  }

  getDueProfiles(forceAll) {
    const now = Date.now();
    return this.state.scanProfiles.filter((profile) => {
      if (!profile.enabled || !profile.skinKey) {
        return false;
      }

      if (!this.state.patternLibrary.skins[profile.skinKey]) {
        return false;
      }

      if (forceAll) {
        return true;
      }

      const lastRunAt = this.profileLastRunAt[profile.id] || 0;
      const cooldownMs = Number(profile.cooldownSec || this.state.scanner.defaultCooldownSec || 30) * 1000;
      return now - lastRunAt >= cooldownMs;
    });
  }

  async deliverEvent(event) {
    try {
      event.deliveryStatus = await this.notifier.sendEvent(event, this.getNotifications());
      this.logger.info('notifications', 'Delivered event notification.', {
        eventId: event.eventId,
        deliveryStatus: event.deliveryStatus
      });
    } catch (error) {
      event.deliveryStatus = { telegram: 'error', error: error.message };
      this.logger.error('notifications', 'Failed to deliver event notification.', {
        eventId: event.eventId,
        error: error.message
      });
    }
  }

  async handleListings(profile, listings, runContext) {
    const createdEvents = [];

    for (const listing of listings) {
      runContext.throwIfStopped();

      const matchedListing = this.shouldAlertProfile(profile, listing);
      if (!matchedListing) {
        continue;
      }

      const dedupeKey = [matchedListing.market, matchedListing.listingId, matchedListing.pattern, matchedListing.price].join(':');
      if (this.seenKeys[dedupeKey]) {
        continue;
      }

      this.seenKeys[dedupeKey] = new Date().toISOString();
      const event = this.buildEvent(profile, matchedListing);
      await this.deliverEvent(event);
      this.events.unshift(event);
      this.events = this.events.slice(0, 200);
      await this.onEvent(event);
      createdEvents.push(event);
      this.logger.info('engine', 'Created rare pattern event.', {
        eventId: event.eventId,
        profileId: profile.id,
        listingId: matchedListing.listingId,
        market: matchedListing.market
      });
    }

    return createdEvents;
  }

  async deleteEvents(eventIds) {
    const ids = Array.isArray(eventIds) ? eventIds.map((value) => String(value)) : [];
    const before = this.events.length;
    this.events = this.events.filter((event) => !ids.includes(String(event.eventId)));
    const removed = before - this.events.length;
    if (removed > 0) {
      this.logger.info('engine', 'Deleted events from journal.', { removed, eventIds: ids });
      await this.saveState();
      this.onStatusChange(this.getStatus());
    }

    return removed;
  }

  async clearEvents() {
    const removed = this.events.length;
    this.events = [];
    this.logger.info('engine', 'Cleared event journal.', { removed });
    await this.saveState();
    this.onStatusChange(this.getStatus());
    return removed;
  }

  async runDueProfiles(trigger, forceAll) {
    if (this.isRunning) {
      this.logger.warn('engine', 'Scan requested while another run is active.', { trigger });
      return this.getStatus();
    }

    if (!forceAll && !this.isScannerEnabled()) {
      this.lastScanSummary = {
        trigger,
        profilesScanned: 0,
        eventsCreated: 0,
        status: 'paused'
      };
      this.onStatusChange(this.getStatus());
      return this.getStatus();
    }

    this.isRunning = true;
    this.stopRequested = false;
    this.lastScanStartedAt = new Date().toISOString();
    const dueProfiles = this.getDueProfiles(forceAll);
    const createdEvents = [];
    const runContext = this.createRunContext(trigger, forceAll);
    let thrownError = null;

    this.logger.info('engine', 'Scan started.', {
      trigger,
      forceAll: !!forceAll,
      profilesScanned: dueProfiles.length,
      scannerEnabled: this.isScannerEnabled()
    });

    try {
      runContext.throwIfStopped();

      const marketProfiles = dueProfiles.filter((profile) => profile.markets.includes('marketCsgoTm'));
      const lisProfiles = dueProfiles.filter((profile) => profile.markets.includes('lisSkins'));

      const marketResult = await this.adapters.marketCsgoTm.scanProfiles(marketProfiles, this.state, runContext);
      this.providers.marketCsgoTm = marketResult.providerStatus;
      for (const profile of marketProfiles) {
        const listings = marketResult.listingsByProfile[profile.id] || [];
        createdEvents.push(...await this.handleListings(profile, listings, runContext));
      }

      runContext.throwIfStopped();

      const lisResult = await this.adapters.lisSkins.scanProfiles(lisProfiles, this.state, runContext);
      this.providers.lisSkins = lisResult.providerStatus;
      for (const profile of lisProfiles) {
        const listings = lisResult.listingsByProfile[profile.id] || [];
        createdEvents.push(...await this.handleListings(profile, listings, runContext));
      }

      this.markProfilesRun(dueProfiles);
      this.lastScanFinishedAt = new Date().toISOString();
      this.lastScanSummary = {
        trigger,
        profilesScanned: dueProfiles.length,
        eventsCreated: createdEvents.length,
        status: 'completed'
      };
      await this.saveState();
      this.logger.info('engine', 'Scan finished.', this.lastScanSummary);
    } catch (error) {
      thrownError = error;
      this.lastScanFinishedAt = new Date().toISOString();

      if (error.code === 'scan_stopped' || isAbortError(error)) {
        this.lastScanSummary = {
          trigger,
          profilesScanned: dueProfiles.length,
          eventsCreated: createdEvents.length,
          status: 'stopped'
        };
        this.configMessage = error.message || 'Scan stopped by user.';
        this.logger.warn('engine', 'Scan stopped before completion.', this.lastScanSummary);
        await this.saveState();
      } else {
        this.lastScanSummary = {
          trigger,
          profilesScanned: dueProfiles.length,
          eventsCreated: createdEvents.length,
          status: 'error',
          error: error.message
        };
        this.logger.error('engine', 'Scan failed.', this.lastScanSummary);
      }
    } finally {
      this.isRunning = false;
      this.stopRequested = false;
      this.currentAbortController = null;
      this.onStatusChange(this.getStatus());
    }

    if (thrownError && thrownError.code !== 'scan_stopped' && !isAbortError(thrownError)) {
      throw thrownError;
    }

    return this.getStatus();
  }
}

module.exports = {
  ScannerEngine,
  createStoppedError
};