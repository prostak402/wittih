importScripts('shared/cs2-scanner-core.js');

const ICON_URL = 'icon128.png';
const HEALTH_ALARM = 'cs2ScannerHealth';
const NOTIFICATION_PREFIX = 'cs2ScannerEvent:';
const MAX_CACHED_EVENTS = 50;
const MAX_CACHED_LOGS = 250;

let monitorCache = {
  connected: false,
  streamConnected: false,
  checkedAt: null,
  configStatus: 'not_synced',
  configMessage: '',
  lastConfigAppliedAt: null,
  lastSyncError: '',
  eventCursor: 0,
  logCursor: 0,
  agent: {
    startedAt: null,
    lastScanStartedAt: null,
    lastScanFinishedAt: null,
    lastScanSummary: null,
    scannerEnabled: true,
    isRunning: false,
    stopRequested: false
  },
  providers: {
    marketCsgoTm: { status: 'disconnected', message: '' },
    lisSkins: { status: 'disconnected', message: '' }
  },
  events: [],
  logs: []
};

const notificationLinks = {};
const notifiedEventIds = {};
let localLogCounter = 0;
let agentStreamSocket = null;
let agentStreamUrl = '';
let reconnectTimer = null;
let suppressNextAppStorageSync = false;

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (result) => {
      resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

function getAgentBaseUrl(state) {
  const raw = state && state.integrations ? state.integrations.agentBaseUrl : '';
  return (raw || CS2ScannerCore.DEFAULT_AGENT_URL).replace(/\/+$/, '');
}

function toSocketUrl(baseUrl) {
  return baseUrl.replace(/^http/i, 'ws') + '/events';
}

async function loadState() {
  const stored = await storageGet({
    [CS2ScannerCore.APP_STORAGE_KEY]: null,
    [CS2ScannerCore.LEGACY_STORAGE_KEY]: {}
  });

  return CS2ScannerCore.migrateState(
    stored[CS2ScannerCore.APP_STORAGE_KEY],
    stored[CS2ScannerCore.LEGACY_STORAGE_KEY]
  );
}

async function saveState(state) {
  await storageSet({
    [CS2ScannerCore.APP_STORAGE_KEY]: state,
    [CS2ScannerCore.LEGACY_STORAGE_KEY]: CS2ScannerCore.serializeLegacyPatternLibrary(state)
  });
}

async function persistMonitorCache() {
  await storageSet({
    [CS2ScannerCore.MONITOR_STORAGE_KEY]: monitorCache
  });
}

async function loadMonitorCache() {
  const stored = await storageGet({
    [CS2ScannerCore.MONITOR_STORAGE_KEY]: null
  });

  if (stored[CS2ScannerCore.MONITOR_STORAGE_KEY]) {
    monitorCache = Object.assign({}, monitorCache, stored[CS2ScannerCore.MONITOR_STORAGE_KEY]);
    monitorCache.agent = Object.assign({}, monitorCache.agent, (stored[CS2ScannerCore.MONITOR_STORAGE_KEY].agent || {}));
    monitorCache.providers = Object.assign({}, monitorCache.providers, (stored[CS2ScannerCore.MONITOR_STORAGE_KEY].providers || {}));
    monitorCache.events = Array.isArray(stored[CS2ScannerCore.MONITOR_STORAGE_KEY].events) ? stored[CS2ScannerCore.MONITOR_STORAGE_KEY].events : [];
    monitorCache.logs = Array.isArray(stored[CS2ScannerCore.MONITOR_STORAGE_KEY].logs) ? stored[CS2ScannerCore.MONITOR_STORAGE_KEY].logs : [];
  }
}

function cloneMonitor() {
  return JSON.parse(JSON.stringify(monitorCache));
}

function broadcastMonitorUpdate() {
  persistMonitorCache().catch(() => undefined);
  chrome.runtime.sendMessage({
    type: 'cs2Scanner:monitorUpdated',
    monitor: cloneMonitor()
  }, () => void chrome.runtime.lastError);
}

function normalizeLogDetails(details) {
  if (details == null) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(details));
  } catch (error) {
    return { error: 'Could not serialize log details.' };
  }
}

function pushLogs(entries) {
  const added = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry) {
      return;
    }

    const entryId = entry.entryId || ('log_' + (entry.cursor || Math.random()));
    const exists = monitorCache.logs.some((item) => String(item.entryId) === String(entryId));
    if (exists) {
      return;
    }

    const normalized = Object.assign({}, entry, {
      entryId,
      details: normalizeLogDetails(entry.details)
    });
    monitorCache.logs.unshift(normalized);
    added.push(normalized);
  });

  monitorCache.logs = monitorCache.logs.slice(0, MAX_CACHED_LOGS);
  return added;
}

function appendLocalLog(level, source, message, details) {
  localLogCounter += 1;
  pushLogs([{
    entryId: 'local_' + Date.now() + '_' + localLogCounter,
    createdAt: new Date().toISOString(),
    level: level || 'info',
    source: source || 'extension',
    message: message || '',
    details: normalizeLogDetails(details)
  }]);
}

function pushEvents(events) {
  const added = [];
  if (!Array.isArray(events) || !events.length) {
    return added;
  }

  events.forEach((event) => {
    if (!event || !event.eventId) {
      return;
    }

    const exists = monitorCache.events.some((item) => item.eventId === event.eventId);
    if (exists) {
      return;
    }

    monitorCache.events.unshift(event);
    added.push(event);
  });

  monitorCache.events = monitorCache.events.slice(0, MAX_CACHED_EVENTS);
  return added;
}

function mergeStatus(status) {
  if (!status) {
    return;
  }

  if (typeof status.eventCursor === 'number' && status.eventCursor < Number(monitorCache.eventCursor || 0)) {
    appendLocalLog('warn', 'background', 'Agent event cursor reset detected. Local cursor was reset to 0.', {
      localCursor: monitorCache.eventCursor,
      agentCursor: status.eventCursor
    });
    monitorCache.eventCursor = 0;
  }

  monitorCache.configStatus = status.configStatus || monitorCache.configStatus;
  monitorCache.configMessage = status.configMessage || '';
  monitorCache.lastConfigAppliedAt = status.lastConfigAppliedAt || null;
  monitorCache.agent = Object.assign({}, monitorCache.agent, {
    startedAt: status.startedAt || null,
    lastScanStartedAt: status.lastScanStartedAt || null,
    lastScanFinishedAt: status.lastScanFinishedAt || null,
    lastScanSummary: status.lastScanSummary || null,
    scannerEnabled: status.scannerEnabled !== false,
    isRunning: !!status.isRunning,
    stopRequested: !!status.stopRequested
  });
  monitorCache.providers = status.providers || monitorCache.providers;
}

async function requestAgent(path, options, meta) {
  const settings = meta || {};
  const state = await loadState();
  const url = getAgentBaseUrl(state) + path;
  const method = (options && options.method) || 'GET';

  if (!settings.silent) {
    appendLocalLog('debug', 'background', 'Requesting agent endpoint.', { method, path });
  }

  const response = await fetch(url, Object.assign({
    headers: {
      'Content-Type': 'application/json'
    }
  }, options || {}));

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data && data.error ? data.error : ('HTTP ' + response.status);
    if (!settings.silent) {
      appendLocalLog('error', 'background', 'Agent endpoint failed.', { method, path, status: response.status, error: message });
    }
    throw new Error(message);
  }

  if (!settings.silent) {
    appendLocalLog('debug', 'background', 'Agent endpoint responded.', { method, path, status: response.status });
  }
  return data;
}

async function maybeNotifyEvent(event) {
  const state = await loadState();
  if (!state.integrations.notifications.browserPush) {
    return;
  }

  if (notifiedEventIds[event.eventId]) {
    return;
  }

  notifiedEventIds[event.eventId] = true;
  const listing = event.listing || {};
  const priceLabel = CS2ScannerCore.formatPrice(listing.price, listing.currency);
  const title = listing.skinName || 'Rare pattern found';
  const message = [
    listing.market || 'market',
    listing.tier ? ('tier ' + listing.tier) : 'rare pattern',
    listing.pattern != null ? ('pattern #' + listing.pattern) : null,
    priceLabel
  ].filter(Boolean).join(' · ');

  const notificationId = NOTIFICATION_PREFIX + event.eventId;
  if (listing.listingUrl) {
    notificationLinks[notificationId] = listing.listingUrl;
  }

  await new Promise((resolve) => {
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: ICON_URL,
      title,
      message,
      requireInteraction: true
    }, () => {
      if (chrome.runtime.lastError) {
        delete notifiedEventIds[event.eventId];
        appendLocalLog('error', 'notifications', 'Browser notification failed.', {
          eventId: event.eventId,
          error: chrome.runtime.lastError.message
        });
      } else {
        appendLocalLog('info', 'notifications', 'Browser notification shown.', {
          eventId: event.eventId,
          notificationId
        });
      }
      resolve();
    });
  });
}

async function notifyEvents(events) {
  for (const event of events) {
    await maybeNotifyEvent(event);
  }
}

async function refreshEvents(options) {
  const settings = options || {};

  try {
    const payload = await requestAgent('/events?cursor=' + encodeURIComponent(monitorCache.eventCursor || 0), null, { silent: true });
    const events = Array.isArray(payload && payload.events) ? payload.events : [];
    const added = pushEvents(events);

    if (settings.notify !== false) {
      await notifyEvents(added);
    }

    monitorCache.eventCursor = payload && typeof payload.nextCursor === 'number'
      ? payload.nextCursor
      : monitorCache.eventCursor;
  } catch (error) {
    monitorCache.lastSyncError = error.message;
    appendLocalLog('error', 'background', 'Failed to refresh events from agent.', { error: error.message });
  }
}

async function refreshLogs() {
  try {
    const payload = await requestAgent('/logs?cursor=' + encodeURIComponent(monitorCache.logCursor || 0), null, { silent: true });
    const logs = Array.isArray(payload && payload.logs) ? payload.logs : [];
    pushLogs(logs);
    monitorCache.logCursor = payload && typeof payload.nextCursor === 'number'
      ? payload.nextCursor
      : monitorCache.logCursor;
  } catch (error) {
    monitorCache.lastSyncError = error.message;
    appendLocalLog('error', 'background', 'Failed to refresh logs from agent.', { error: error.message });
  }
}

async function refreshStatus(options) {
  const settings = options || {};

  try {
    const health = await requestAgent('/health', null, { silent: true });
    monitorCache.connected = !!(health && health.ok);
    monitorCache.checkedAt = new Date().toISOString();

    const status = await requestAgent('/status', null, { silent: true });
    mergeStatus(status);
    monitorCache.lastSyncError = '';

    if (settings.includeEvents !== false) {
      await refreshEvents({ notify: settings.notifyEvents !== false });
    }

    if (settings.includeLogs !== false) {
      await refreshLogs();
    }
  } catch (error) {
    monitorCache.connected = false;
    monitorCache.streamConnected = false;
    monitorCache.checkedAt = new Date().toISOString();
    monitorCache.lastSyncError = error.message;
    monitorCache.providers = {
      marketCsgoTm: { status: 'disconnected', message: error.message },
      lisSkins: { status: 'disconnected', message: error.message }
    };
    appendLocalLog('error', 'background', 'Failed to refresh status from agent.', { error: error.message });
  }

  broadcastMonitorUpdate();
  ensureAgentStream().catch(() => undefined);
  return cloneMonitor();
}

function handleStreamMessage(rawData) {
  let message = null;
  try {
    message = JSON.parse(rawData);
  } catch (error) {
    appendLocalLog('error', 'background', 'Failed to parse agent stream message.', { error: error.message });
    return;
  }

  if (!message || !message.type) {
    return;
  }

  if (message.type === 'status') {
    mergeStatus(message.data);
    broadcastMonitorUpdate();
    return;
  }

  if (message.type === 'event') {
    const added = pushEvents([message.data]);
    monitorCache.eventCursor = Math.max(Number(monitorCache.eventCursor || 0), Number(message.data && message.data.cursor || 0));
    notifyEvents(added).then(() => broadcastMonitorUpdate()).catch(() => broadcastMonitorUpdate());
    return;
  }

  if (message.type === 'events') {
    pushEvents(Array.isArray(message.data) ? message.data : []);
    broadcastMonitorUpdate();
    return;
  }

  if (message.type === 'log') {
    pushLogs([message.data]);
    monitorCache.logCursor = Math.max(Number(monitorCache.logCursor || 0), Number(message.data && message.data.cursor || 0));
    broadcastMonitorUpdate();
    return;
  }

  if (message.type === 'logs') {
    pushLogs(Array.isArray(message.data) ? message.data : []);
    broadcastMonitorUpdate();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureAgentStream(true).catch(() => undefined);
  }, 3000);
}

async function ensureAgentStream(forceReconnect) {
  const state = await loadState();
  const nextUrl = toSocketUrl(getAgentBaseUrl(state));

  if (!forceReconnect && agentStreamSocket && agentStreamUrl === nextUrl) {
    const readyState = agentStreamSocket.readyState;
    if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
      return;
    }
  }

  if (agentStreamSocket) {
    try {
      agentStreamSocket.close();
    } catch (error) {
      // no-op
    }
  }

  agentStreamUrl = nextUrl;
  appendLocalLog('debug', 'background', 'Connecting to agent event stream.', { url: nextUrl });
  const socket = new WebSocket(nextUrl);
  agentStreamSocket = socket;

  socket.onopen = () => {
    monitorCache.streamConnected = true;
    appendLocalLog('info', 'background', 'Agent event stream connected.', { url: nextUrl });
    broadcastMonitorUpdate();
  };

  socket.onmessage = (event) => {
    handleStreamMessage(event.data);
  };

  socket.onerror = () => {
    appendLocalLog('warn', 'background', 'Agent event stream reported an error.', { url: nextUrl });
  };

  socket.onclose = () => {
    monitorCache.streamConnected = false;
    appendLocalLog('warn', 'background', 'Agent event stream disconnected.', { url: nextUrl });
    broadcastMonitorUpdate();
    scheduleReconnect();
  };
}

async function syncConfig(trigger) {
  try {
    const state = await loadState();
    await requestAgent('/config', {
      method: 'PUT',
      body: JSON.stringify({
        state,
        trigger: trigger || 'extension'
      })
    });
    monitorCache.configStatus = 'config_applied';
    monitorCache.lastConfigAppliedAt = new Date().toISOString();
    monitorCache.configMessage = 'Configuration sent to agent.';
    monitorCache.lastSyncError = '';
  } catch (error) {
    monitorCache.configStatus = 'config_invalid';
    monitorCache.configMessage = error.message;
    monitorCache.lastSyncError = error.message;
  }

  broadcastMonitorUpdate();
  return refreshStatus({ includeEvents: true, includeLogs: true, notifyEvents: true });
}

async function runScanNow() {
  await requestAgent('/scan/run', {
    method: 'POST',
    body: JSON.stringify({ trigger: 'extension_manual' })
  });
  return refreshStatus({ includeEvents: true, includeLogs: true, notifyEvents: true });
}

async function setScannerEnabled(enabled) {
  const nextEnabled = !!enabled;
  const state = await loadState();
  state.scanner = Object.assign({}, state.scanner || {}, { engineEnabled: nextEnabled });
  suppressNextAppStorageSync = true;
  await saveState(CS2ScannerCore.normalizeState(state));

  monitorCache.agent = Object.assign({}, monitorCache.agent, {
    scannerEnabled: nextEnabled,
    stopRequested: !nextEnabled && !!monitorCache.agent.isRunning
  });
  monitorCache.configStatus = 'config_applied';
  monitorCache.configMessage = nextEnabled
    ? 'Scanner start requested.'
    : (monitorCache.agent.isRunning ? 'Stop requested. Waiting for current request to abort.' : 'Scanner stopped.');
  broadcastMonitorUpdate();

  await requestAgent(nextEnabled ? '/scan/start' : '/scan/stop', {
    method: 'POST',
    body: JSON.stringify({
      reason: nextEnabled ? 'Scanner resumed from extension.' : 'Scanner stopped from extension.'
    })
  }, { silent: true });

  return refreshStatus({ includeEvents: true, includeLogs: true, notifyEvents: false });
}

async function deleteEvent(eventId) {
  await requestAgent('/events/delete', {
    method: 'POST',
    body: JSON.stringify({ eventId })
  });
  monitorCache.events = monitorCache.events.filter((event) => event.eventId !== eventId);
  broadcastMonitorUpdate();
  return refreshStatus({ includeEvents: false, includeLogs: true, notifyEvents: false });
}

async function clearEvents() {
  await requestAgent('/events/clear', {
    method: 'POST',
    body: JSON.stringify({ trigger: 'extension_clear' })
  });
  monitorCache.events = [];
  broadcastMonitorUpdate();
  return refreshStatus({ includeEvents: false, includeLogs: true, notifyEvents: false });
}

async function testNotification() {
  const state = await loadState();

  if (state.integrations.notifications.browserPush) {
    await new Promise((resolve) => {
      chrome.notifications.create(NOTIFICATION_PREFIX + 'test_' + Date.now(), {
        type: 'basic',
        iconUrl: ICON_URL,
        title: 'CS2 scanner test',
        message: 'Browser notification channel is active.',
        requireInteraction: true
      }, () => {
        if (chrome.runtime.lastError) {
          appendLocalLog('error', 'notifications', 'Browser test notification failed.', {
            error: chrome.runtime.lastError.message
          });
        } else {
          appendLocalLog('info', 'notifications', 'Browser test notification shown.');
        }
        resolve();
      });
    });
  }

  try {
    await requestAgent('/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ trigger: 'extension_test' })
    });
  } catch (error) {
    monitorCache.lastSyncError = error.message;
    broadcastMonitorUpdate();
  }

  return cloneMonitor();
}

function ensureAlarm() {
  chrome.alarms.create(HEALTH_ALARM, {
    periodInMinutes: 0.5
  });
}

async function initializeBackground() {
  await loadMonitorCache();
  ensureAlarm();
  ensureAgentStream().catch(() => undefined);
  refreshStatus({ includeEvents: true, includeLogs: true, notifyEvents: false }).catch(() => undefined);
  syncConfig('background_init').catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  initializeBackground().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  initializeBackground().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === HEALTH_ALARM) {
    refreshStatus({ includeEvents: true, includeLogs: true, notifyEvents: false }).catch(() => undefined);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes[CS2ScannerCore.APP_STORAGE_KEY] || changes[CS2ScannerCore.LEGACY_STORAGE_KEY]) {
    if (suppressNextAppStorageSync) {
      suppressNextAppStorageSync = false;
      return;
    }

    syncConfig('storage_changed').catch(() => undefined);
    ensureAgentStream(true).catch(() => undefined);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const url = notificationLinks[notificationId];
  if (!url) {
    return;
  }

  chrome.tabs.create({ url });
  delete notificationLinks[notificationId];
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === 'cs2Scanner:getMonitor') {
    sendResponse({ ok: true, monitor: cloneMonitor() });
    return false;
  }

  if (message.type === 'cs2Scanner:syncConfig') {
    syncConfig('manual').then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'cs2Scanner:refreshStatus') {
    refreshStatus({ includeEvents: true, includeLogs: true, notifyEvents: false }).then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'cs2Scanner:scanNow') {
    runScanNow().then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'cs2Scanner:setScannerEnabled') {
    setScannerEnabled(!!message.enabled).then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'cs2Scanner:deleteEvent') {
    deleteEvent(message.eventId).then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'cs2Scanner:clearEvents') {
    clearEvents().then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'cs2Scanner:testNotification') {
    testNotification().then((monitor) => sendResponse({ ok: true, monitor })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

initializeBackground().catch(() => undefined);
