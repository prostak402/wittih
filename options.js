const appState = {
  data: CS2ScannerCore.createDefaultState(),
  currentSkinKey: null,
  currentProfileId: null,
  skinFilter: '',
  monitor: null,
  monitorAction: null
};

const statusLine = document.getElementById('status-line');
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const views = {
  patterns: document.getElementById('view-patterns'),
  profiles: document.getElementById('view-profiles'),
  integrations: document.getElementById('view-integrations'),
  monitor: document.getElementById('view-monitor')
};

const summarySkins = document.getElementById('summary-skins');
const summaryProfiles = document.getElementById('summary-profiles');
const summaryMarkets = document.getElementById('summary-markets');

const skinSearchInput = document.getElementById('skin-search');
const skinSelect = document.getElementById('skin-select');
const linksList = document.getElementById('links-list');
const newSkinBtn = document.getElementById('new-skin');
const openAllBtn = document.getElementById('open-all');
const exportSkinsBtn = document.getElementById('export-skins');
const importSkinsInput = document.getElementById('import-skins');
const skinUrlInput = document.getElementById('skin-url');
const skinNameInput = document.getElementById('skin-name');
const addTierBtn = document.getElementById('add-tier');
const tiersContainer = document.getElementById('tiers-container');
const saveSkinBtn = document.getElementById('save-skin');
const deleteSkinBtn = document.getElementById('delete-skin');

const profileSelect = document.getElementById('profile-select');
const newProfileBtn = document.getElementById('new-profile');
const deleteProfileBtn = document.getElementById('delete-profile');
const profileNameInput = document.getElementById('profile-name');
const profileSkinSelect = document.getElementById('profile-skin');
const profileEnabledInput = document.getElementById('profile-enabled');
const profileMarketsContainer = document.getElementById('profile-markets');
const profileTiersContainer = document.getElementById('profile-tiers');
const profileQualitiesContainer = document.getElementById('profile-qualities');
const profileMaxPriceInput = document.getElementById('profile-max-price');
const profileCurrencySelect = document.getElementById('profile-currency');
const profileCooldownInput = document.getElementById('profile-cooldown');
const profileNotesInput = document.getElementById('profile-notes');
const saveProfileBtn = document.getElementById('save-profile');

const agentBaseUrlInput = document.getElementById('agent-base-url');
const browserPushEnabledInput = document.getElementById('browser-push-enabled');
const httpTraceEnabledInput = document.getElementById('http-trace-enabled');
const marketRequestDelayInput = document.getElementById('market-request-delay');
const lisRequestDelayInput = document.getElementById('lis-request-delay');
const marketApiKeyInput = document.getElementById('market-api-key');
const lisApiKeyInput = document.getElementById('lis-api-key');
const telegramEnabledInput = document.getElementById('telegram-enabled');
const telegramBotTokenInput = document.getElementById('telegram-bot-token');
const telegramChatIdInput = document.getElementById('telegram-chat-id');
const saveIntegrationsBtn = document.getElementById('save-integrations');
const testAgentBtn = document.getElementById('test-agent');
const testNotificationBtn = document.getElementById('test-notification');

const monitorConnected = document.getElementById('monitor-connected');
const monitorConfig = document.getElementById('monitor-config');
const monitorStream = document.getElementById('monitor-stream');
const monitorScanner = document.getElementById('monitor-scanner');
const agentStarted = document.getElementById('agent-started');
const scanStarted = document.getElementById('scan-started');
const scanFinished = document.getElementById('scan-finished');
const scanSummary = document.getElementById('scan-summary');
const monitorError = document.getElementById('monitor-error');
const providerStatuses = document.getElementById('provider-statuses');
const refreshStatusBtn = document.getElementById('refresh-status');
const syncConfigBtn = document.getElementById('sync-config');
const scanNowBtn = document.getElementById('scan-now');
const toggleScanBtn = document.getElementById('toggle-scan');
const clearEventsBtn = document.getElementById('clear-events');
const eventsList = document.getElementById('events-list');
const logsList = document.getElementById('logs-list');
const logHttpOnlyInput = document.getElementById('log-http-only');

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (result) => resolve(result));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

function runtimeSend(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response) {
        resolve(null);
        return;
      }

      if (response.ok === false) {
        reject(new Error(response.error || 'Unknown runtime error'));
        return;
      }

      resolve(response);
    });
  });
}

function showStatus(message, isError) {
  statusLine.textContent = message || '';
  statusLine.classList.toggle('error', !!isError);

  if (!message) {
    return;
  }

  setTimeout(() => {
    if (statusLine.textContent === message) {
      statusLine.textContent = '';
      statusLine.classList.remove('error');
    }
  }, 3600);
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  try {
    return new Date(value).toLocaleString('ru-RU');
  } catch (error) {
    return String(value);
  }
}

function formatProviderBadge(status) {
  const normalized = String(status || 'unknown');
  const lower = normalized.toLowerCase();
  const className = lower.includes('ok') || lower.includes('connected') || lower.includes('applied') || lower.includes('running')
    ? 'ok'
    : (lower.includes('error') || lower.includes('invalid') || lower.includes('unsupported') || lower.includes('stopped') ? 'err' : 'warn');
  return { text: normalized, className };
}

function formatLogDetails(details) {
  if (!details) {
    return '';
  }

  try {
    return JSON.stringify(details, null, 2);
  } catch (error) {
    return String(details);
  }
}

function isProviderLogEntry(entry) {
  return ['marketCsgoTm', 'lisSkins'].includes(String(entry && entry.source || ''));
}

function setMonitorAction(action) {
  appState.monitorAction = action || null;
  renderMonitor();
}

function summarizeScan(monitor) {
  const summary = monitor && monitor.agent && monitor.agent.lastScanSummary;
  if (!summary) {
    return '—';
  }

  return [
    summary.status || 'unknown',
    summary.trigger || 'manual',
    typeof summary.profilesScanned === 'number' ? ('profiles ' + summary.profilesScanned) : null,
    typeof summary.eventsCreated === 'number' ? ('events ' + summary.eventsCreated) : null,
    summary.error || null
  ].filter(Boolean).join(' · ');
}

function getSkinEntries() {
  return Object.entries(appState.data.patternLibrary.skins).sort((a, b) => {
    const nameA = (a[1].name || a[0]).toLowerCase();
    const nameB = (b[1].name || b[0]).toLowerCase();
    return nameA.localeCompare(nameB, 'ru');
  });
}

function getFilteredSkinEntries() {
  const filter = appState.skinFilter.trim().toLowerCase();
  const entries = getSkinEntries();
  if (!filter) {
    return entries;
  }

  return entries.filter(([key, skin]) => {
    const haystack = [key, skin.name, skin.skinBaseName, skin.url].join(' ').toLowerCase();
    return haystack.includes(filter);
  });
}

function getProfileEntries() {
  return appState.data.scanProfiles.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
}

function updateSummary() {
  const summary = CS2ScannerCore.summarizeState(appState.data);
  summarySkins.textContent = summary.skins;
  summaryProfiles.textContent = summary.profiles;
  summaryMarkets.textContent = summary.markets;
}

function switchTab(tabId) {
  tabButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabId);
  });

  Object.entries(views).forEach(([key, node]) => {
    node.classList.toggle('active', key === tabId);
  });
}

function createTierRow(tierData) {
  const row = document.createElement('div');
  row.className = 'tier-row';

  const header = document.createElement('div');
  header.className = 'tier-row-header';

  const title = document.createElement('strong');
  title.textContent = 'Tier';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'danger';
  removeButton.textContent = 'Удалить';
  removeButton.addEventListener('click', () => {
    row.remove();
    updateTierTitles();
  });

  header.appendChild(title);
  header.appendChild(removeButton);

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Название tier';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'tier-name';
  nameInput.value = tierData && tierData.name ? tierData.name : '';
  nameLabel.appendChild(nameInput);

  const patternsLabel = document.createElement('label');
  patternsLabel.textContent = 'Pattern ID через пробел, запятую или перенос';
  const patternsInput = document.createElement('textarea');
  patternsInput.className = 'tier-patterns';
  patternsInput.value = tierData && Array.isArray(tierData.patterns) ? tierData.patterns.join(' ') : '';
  patternsLabel.appendChild(patternsInput);

  row.appendChild(header);
  row.appendChild(nameLabel);
  row.appendChild(patternsLabel);
  tiersContainer.appendChild(row);
  updateTierTitles();
}

function updateTierTitles() {
  Array.from(tiersContainer.children).forEach((row, index) => {
    const title = row.querySelector('.tier-row-header strong');
    const nameInput = row.querySelector('.tier-name');
    if (title) {
      title.textContent = 'Tier ' + (index + 1);
    }
    if (nameInput && !nameInput.value.trim()) {
      nameInput.placeholder = 'T' + (index + 1);
    }
  });
}

function clearSkinForm() {
  appState.currentSkinKey = null;
  skinUrlInput.value = '';
  skinNameInput.value = '';
  tiersContainer.innerHTML = '';
  createTierRow({ name: 'T1', patterns: [] });
  createTierRow({ name: 'T2', patterns: [] });
  createTierRow({ name: 'T3', patterns: [] });
}

function loadSkinIntoForm(skinKey) {
  const skin = appState.data.patternLibrary.skins[skinKey];
  if (!skin) {
    clearSkinForm();
    return;
  }

  appState.currentSkinKey = skinKey;
  skinUrlInput.value = skin.url || '';
  skinNameInput.value = skin.name || '';
  tiersContainer.innerHTML = '';

  if (Array.isArray(skin.tiers) && skin.tiers.length) {
    skin.tiers.forEach((tier) => createTierRow(tier));
  } else {
    createTierRow({ name: 'T1', patterns: [] });
  }
}

function rebuildSkinSelect() {
  const entries = getFilteredSkinEntries();
  skinSelect.innerHTML = '';
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = entries.length ? '— выбери скин —' : 'База пуста';
  skinSelect.appendChild(emptyOption);

  entries.forEach(([key, skin]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = skin.name || skin.skinBaseName || key;
    skinSelect.appendChild(option);
  });

  skinSelect.value = appState.currentSkinKey && appState.data.patternLibrary.skins[appState.currentSkinKey]
    ? appState.currentSkinKey
    : '';
}

function rebuildLinksList() {
  const entries = getFilteredSkinEntries();
  linksList.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'small-note';
    empty.textContent = 'Нет сохранённых ссылок.';
    linksList.appendChild(empty);
    return;
  }

  entries.forEach(([key, skin]) => {
    const row = document.createElement('div');
    row.className = 'skin-link';
    const name = document.createElement('span');
    name.textContent = skin.name || skin.skinBaseName || key;
    const link = document.createElement('a');
    link.href = skin.url || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Открыть';
    row.appendChild(name);
    row.appendChild(link);
    linksList.appendChild(row);
  });
}

function collectSkinFormData() {
  const rawUrl = skinUrlInput.value.trim();
  if (!rawUrl) {
    throw new Error('Укажи URL страницы скина.');
  }

  const key = CS2ScannerCore.buildSkinKey(rawUrl);
  if (!key) {
    throw new Error('Не удалось собрать skin key из URL.');
  }

  const rows = Array.from(tiersContainer.children);
  if (!rows.length) {
    throw new Error('Добавь хотя бы один tier.');
  }

  const tiers = rows.map((row, index) => {
    const nameInput = row.querySelector('.tier-name');
    const patternsInput = row.querySelector('.tier-patterns');
    return {
      name: nameInput && nameInput.value.trim() ? nameInput.value.trim() : ('T' + (index + 1)),
      patterns: CS2ScannerCore.normalizePatternIds(String(patternsInput && patternsInput.value ? patternsInput.value : '').split(/[\s,;]+/).filter(Boolean))
    };
  });

  return {
    key,
    config: CS2ScannerCore.normalizeSkinConfig(key, {
      url: rawUrl,
      name: skinNameInput.value.trim(),
      tiers
    })
  };
}

async function saveCurrentSkin() {
  const data = collectSkinFormData();
  appState.data.patternLibrary.skins[data.key] = data.config;
  appState.currentSkinKey = data.key;
  await saveAppState('Скин сохранён.');
  rebuildSkinSelect();
  rebuildLinksList();
  loadSkinIntoForm(appState.currentSkinKey);
  renderProfileSkinOptions();
}

async function deleteCurrentSkin() {
  if (!appState.currentSkinKey || !appState.data.patternLibrary.skins[appState.currentSkinKey]) {
    throw new Error('Сначала выбери сохранённый скин.');
  }

  delete appState.data.patternLibrary.skins[appState.currentSkinKey];
  appState.data.scanProfiles = appState.data.scanProfiles.filter((profile) => profile.skinKey !== appState.currentSkinKey);
  appState.currentSkinKey = null;
  appState.currentProfileId = null;
  clearSkinForm();
  clearProfileForm();
  await saveAppState('Скин удалён.');
  rebuildSkinSelect();
  rebuildLinksList();
  rebuildProfileSelect();
  renderProfileSkinOptions();
}

function openAllLinks() {
  getFilteredSkinEntries().forEach(([, skin]) => {
    if (skin.url) {
      chrome.tabs.create({ url: skin.url });
    }
  });
}

function downloadJson(fileName, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSkins() {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
  const payload = CS2ScannerCore.buildExportPayload(appState.data.patternLibrary, manifest);
  const fileName = 'cs2-pattern-tiers-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  downloadJson(fileName, JSON.stringify(payload, null, 2));
  showStatus('Экспорт готов.');
}

async function importSkins(file) {
  const text = await file.text();
  const imported = CS2ScannerCore.parseImportedPatternLibrary(text);
  appState.data.patternLibrary.skins = Object.assign({}, appState.data.patternLibrary.skins, imported.skins);
  await saveAppState('Импорт завершён.');
  rebuildSkinSelect();
  rebuildLinksList();
  renderProfileSkinOptions();
}

function rebuildProfileSelect() {
  const entries = getProfileEntries();
  profileSelect.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = entries.length ? '— выбери профиль —' : 'Профилей пока нет';
  profileSelect.appendChild(empty);

  entries.forEach((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = (profile.enabled ? '● ' : '○ ') + (profile.name || profile.id);
    profileSelect.appendChild(option);
  });

  profileSelect.value = appState.currentProfileId && appState.data.scanProfiles.some((profile) => profile.id === appState.currentProfileId)
    ? appState.currentProfileId
    : '';
}

function renderProfileSkinOptions() {
  const previousValue = profileSkinSelect.value;
  profileSkinSelect.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = '— выбери скин —';
  profileSkinSelect.appendChild(option);

  getSkinEntries().forEach(([key, skin]) => {
    const node = document.createElement('option');
    node.value = key;
    node.textContent = skin.name || skin.skinBaseName || key;
    profileSkinSelect.appendChild(node);
  });

  if (appState.currentProfileId) {
    const currentProfile = appState.data.scanProfiles.find((item) => item.id === appState.currentProfileId);
    profileSkinSelect.value = currentProfile ? currentProfile.skinKey : previousValue;
  } else {
    profileSkinSelect.value = previousValue || '';
  }
}

function buildCheckbox(id, label, checked) {
  const wrapper = document.createElement('label');
  wrapper.className = 'checkbox-item';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = id;
  input.checked = !!checked;
  const text = document.createElement('span');
  text.textContent = label;
  wrapper.appendChild(input);
  wrapper.appendChild(text);
  return wrapper;
}

function renderMarketOptions(selectedMarkets) {
  profileMarketsContainer.innerHTML = '';
  CS2ScannerCore.MARKET_OPTIONS.forEach((market) => {
    profileMarketsContainer.appendChild(buildCheckbox(market.id, market.label, selectedMarkets.includes(market.id)));
  });
}

function renderQualityOptions(selectedQualities) {
  profileQualitiesContainer.innerHTML = '';
  CS2ScannerCore.QUALITY_OPTIONS.forEach((quality) => {
    profileQualitiesContainer.appendChild(buildCheckbox(quality, quality, selectedQualities.includes(quality)));
  });
}

function renderTierOptions(skinKey, selectedTiers) {
  profileTiersContainer.innerHTML = '';
  const skin = appState.data.patternLibrary.skins[skinKey];

  if (!skin || !Array.isArray(skin.tiers) || !skin.tiers.length) {
    const empty = document.createElement('div');
    empty.className = 'small-note';
    empty.textContent = 'У выбранного скина нет tier-ов.';
    profileTiersContainer.appendChild(empty);
    return;
  }

  skin.tiers.forEach((tier, index) => {
    const tierName = tier.name || ('T' + (index + 1));
    profileTiersContainer.appendChild(buildCheckbox(tierName, tierName + ' (' + tier.patterns.length + ')', selectedTiers.includes(tierName)));
  });
}

function clearProfileForm() {
  appState.currentProfileId = null;
  profileNameInput.value = '';
  profileEnabledInput.checked = true;
  renderProfileSkinOptions();
  const firstSkinEntry = getSkinEntries()[0];
  const firstSkinKey = firstSkinEntry ? firstSkinEntry[0] : '';
  profileSkinSelect.value = firstSkinKey;
  renderMarketOptions(['marketCsgoTm']);
  renderQualityOptions(['Factory New']);
  renderTierOptions(firstSkinKey, []);
  profileMaxPriceInput.value = '';
  profileCurrencySelect.value = 'USD';
  profileCooldownInput.value = String(appState.data.scanner.defaultCooldownSec || 30);
  profileNotesInput.value = '';
}

function loadProfileIntoForm(profileId) {
  const profile = appState.data.scanProfiles.find((item) => item.id === profileId);
  if (!profile) {
    clearProfileForm();
    return;
  }

  appState.currentProfileId = profile.id;
  profileNameInput.value = profile.name || '';
  profileEnabledInput.checked = profile.enabled !== false;
  renderProfileSkinOptions();
  profileSkinSelect.value = profile.skinKey || '';
  renderMarketOptions(profile.markets || []);
  renderQualityOptions(profile.qualities || []);
  renderTierOptions(profile.skinKey, profile.tiers || []);
  profileMaxPriceInput.value = profile.maxPrice === '' ? '' : profile.maxPrice;
  profileCurrencySelect.value = profile.currency || 'USD';
  profileCooldownInput.value = String(profile.cooldownSec || appState.data.scanner.defaultCooldownSec || 30);
  profileNotesInput.value = profile.notes || '';
}

function collectCheckedValues(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
}

function collectProfileFormData() {
  const skinKey = profileSkinSelect.value;
  if (!skinKey) {
    throw new Error('Выбери скин для профиля.');
  }

  const markets = collectCheckedValues(profileMarketsContainer);
  const qualities = collectCheckedValues(profileQualitiesContainer);
  const tiers = collectCheckedValues(profileTiersContainer);
  const skin = appState.data.patternLibrary.skins[skinKey];

  if (!markets.length) {
    throw new Error('Нужно выбрать хотя бы один маркетплейс.');
  }

  return CS2ScannerCore.normalizeScanProfile({
    id: appState.currentProfileId || undefined,
    enabled: profileEnabledInput.checked,
    name: profileNameInput.value.trim(),
    skinKey,
    markets,
    tiers: tiers.length ? tiers : (skin && skin.tiers ? skin.tiers.map((tier, index) => tier.name || ('T' + (index + 1))) : []),
    qualities: qualities.length ? qualities : ['Factory New'],
    maxPrice: profileMaxPriceInput.value.trim(),
    currency: profileCurrencySelect.value,
    cooldownSec: profileCooldownInput.value,
    notes: profileNotesInput.value.trim()
  }, appState.data);
}

async function saveCurrentProfile() {
  const profile = collectProfileFormData();
  const index = appState.data.scanProfiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) {
    appState.data.scanProfiles[index] = profile;
  } else {
    appState.data.scanProfiles.push(profile);
  }

  appState.currentProfileId = profile.id;
  await saveAppState('Профиль сохранён.');
  rebuildProfileSelect();
  loadProfileIntoForm(profile.id);
}
async function deleteCurrentProfile() {
  if (!appState.currentProfileId) {
    throw new Error('Сначала выбери профиль.');
  }

  appState.data.scanProfiles = appState.data.scanProfiles.filter((profile) => profile.id !== appState.currentProfileId);
  appState.currentProfileId = null;
  clearProfileForm();
  await saveAppState('Профиль удалён.');
  rebuildProfileSelect();
}

function renderIntegrations() {
  const integrations = appState.data.integrations;
  const scanner = appState.data.scanner || {};
  agentBaseUrlInput.value = integrations.agentBaseUrl || CS2ScannerCore.DEFAULT_AGENT_URL;
  browserPushEnabledInput.checked = integrations.notifications.browserPush !== false;
  httpTraceEnabledInput.checked = !!scanner.httpTraceEnabled;
  marketRequestDelayInput.value = String((scanner.requestIntervalsMs && scanner.requestIntervalsMs.marketCsgoTm) || CS2ScannerCore.DEFAULT_REQUEST_INTERVALS_MS.marketCsgoTm);
  lisRequestDelayInput.value = String((scanner.requestIntervalsMs && scanner.requestIntervalsMs.lisSkins) || CS2ScannerCore.DEFAULT_REQUEST_INTERVALS_MS.lisSkins);
  marketApiKeyInput.value = integrations.marketplaceCredentials.marketCsgoTm.apiKey || '';
  lisApiKeyInput.value = integrations.marketplaceCredentials.lisSkins.apiKey || '';
  telegramEnabledInput.checked = !!integrations.notifications.telegramEnabled;
  telegramBotTokenInput.value = integrations.notifications.telegramBotToken || '';
  telegramChatIdInput.value = integrations.notifications.telegramChatId || '';
}

function collectIntegrationsFormData() {
  appState.data.integrations = CS2ScannerCore.normalizeIntegrations({
    agentBaseUrl: agentBaseUrlInput.value.trim(),
    marketplaceCredentials: {
      marketCsgoTm: {
        enabled: true,
        apiKey: marketApiKeyInput.value.trim()
      },
      lisSkins: {
        enabled: true,
        apiKey: lisApiKeyInput.value.trim()
      }
    },
    notifications: {
      browserPush: browserPushEnabledInput.checked,
      telegramEnabled: telegramEnabledInput.checked,
      telegramBotToken: telegramBotTokenInput.value.trim(),
      telegramChatId: telegramChatIdInput.value.trim()
    }
  });

  appState.data.scanner = Object.assign({}, appState.data.scanner || {}, {
    httpTraceEnabled: httpTraceEnabledInput.checked,
    requestIntervalsMs: CS2ScannerCore.normalizeRequestIntervals({
      marketCsgoTm: marketRequestDelayInput.value,
      lisSkins: lisRequestDelayInput.value
    })
  });
}

async function saveIntegrations() {
  collectIntegrationsFormData();
  await saveAppState('Интеграции сохранены и отправлены агенту.');
}

function renderProviderStatuses(monitor) {
  providerStatuses.innerHTML = '';
  Object.entries(monitor.providers || {}).forEach(([providerId, value]) => {
    const row = document.createElement('div');
    row.className = 'monitor-card stack';

    const header = document.createElement('div');
    header.className = 'inline-row';
    const name = document.createElement('strong');
    name.textContent = providerId;
    const badgeData = formatProviderBadge(value && value.status);
    const badge = document.createElement('span');
    badge.className = 'status-badge ' + badgeData.className;
    badge.textContent = badgeData.text;
    header.appendChild(name);
    header.appendChild(badge);

    const message = document.createElement('div');
    message.className = 'small-note';
    message.textContent = value && value.message ? value.message : 'No details.';

    row.appendChild(header);
    row.appendChild(message);
    providerStatuses.appendChild(row);
  });
}

function renderEvents(monitor) {
  eventsList.innerHTML = '';
  const events = Array.isArray(monitor.events) ? monitor.events : [];
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'small-note';
    empty.textContent = 'События пока не приходили.';
    eventsList.appendChild(empty);
    return;
  }

  events.forEach((event) => {
    const card = document.createElement('div');
    card.className = 'event-card';

    const top = document.createElement('div');
    top.className = 'event-row';
    const title = document.createElement('strong');
    title.textContent = (event.listing && event.listing.skinName) || 'Rare pattern event';
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'danger small';
    removeButton.textContent = 'Удалить';
    removeButton.addEventListener('click', async () => {
      try {
        const response = await runtimeSend('cs2Scanner:deleteEvent', { eventId: event.eventId });
        if (response && response.monitor) {
          appState.monitor = response.monitor;
          renderMonitor();
        }
        showStatus('Запись удалена из журнала.');
      } catch (error) {
        showStatus(error.message, true);
      }
    });
    top.appendChild(title);
    top.appendChild(removeButton);

    const body = document.createElement('div');
    const listing = event.listing || {};
    body.textContent = [
      listing.market || 'market',
      listing.tier ? ('tier ' + listing.tier) : 'rare pattern',
      listing.pattern != null ? ('pattern #' + listing.pattern) : null,
      listing.price != null ? CS2ScannerCore.formatPrice(listing.price, listing.currency) : null
    ].filter(Boolean).join(' · ');

    card.appendChild(top);
    card.appendChild(body);

    if (listing.listingUrl) {
      const link = document.createElement('a');
      link.href = listing.listingUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Открыть оффер';
      card.appendChild(link);
    }

    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const created = document.createElement('span');
    created.textContent = formatDateTime(event.createdAt);
    meta.appendChild(created);
    if (event.reason) {
      const reason = document.createElement('span');
      reason.textContent = event.reason;
      meta.appendChild(reason);
    }
    card.appendChild(meta);
    eventsList.appendChild(card);
  });
}

function renderLogs(monitor) {
  logsList.innerHTML = '';
  const allLogs = Array.isArray(monitor.logs) ? monitor.logs : [];
  const showAllLogs = !!(logHttpOnlyInput && logHttpOnlyInput.checked);
  const providerLogs = allLogs.filter((entry) => isProviderLogEntry(entry));
  const logs = showAllLogs ? allLogs : providerLogs;
  if (!logs.length) {
    const empty = document.createElement('div');
    empty.className = 'small-note';
    empty.textContent = showAllLogs
      ? 'Лог пока пуст.'
      : 'Provider log is empty.';
    logsList.appendChild(empty);
    return;
  }

  logs.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'log-card';

    const header = document.createElement('div');
    header.className = 'log-row';
    const message = document.createElement('strong');
    message.textContent = entry.message || 'Runtime log entry';
    const levelName = String(entry.level || 'info').toLowerCase();
    const level = document.createElement('span');
    level.className = 'log-level ' + levelName;
    level.textContent = levelName;
    header.appendChild(message);
    header.appendChild(level);
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    const created = document.createElement('span');
    created.textContent = formatDateTime(entry.createdAt);
    const source = document.createElement('span');
    source.textContent = entry.source || 'agent';
    meta.appendChild(created);
    meta.appendChild(source);
    card.appendChild(meta);

    const detailsText = formatLogDetails(entry.details);
    if (detailsText) {
      const details = document.createElement('pre');
      details.className = 'log-details';
      details.textContent = detailsText;
      card.appendChild(details);
    }

    logsList.appendChild(card);
  });
}

function renderMonitor() {
  const monitor = appState.monitor || {
    connected: false,
    streamConnected: false,
    configStatus: 'disconnected',
    configMessage: '',
    lastSyncError: '',
    agent: {},
    providers: {},
    events: [],
    logs: []
  };

  const connectedBadge = formatProviderBadge(monitor.connected ? 'connected' : 'disconnected');
  monitorConnected.textContent = connectedBadge.text;
  monitorConnected.className = 'status-badge ' + connectedBadge.className;

  const configBadge = formatProviderBadge(monitor.configStatus || 'not_synced');
  monitorConfig.textContent = configBadge.text;
  monitorConfig.className = 'status-badge ' + configBadge.className;

  const streamBadge = formatProviderBadge(monitor.streamConnected ? 'stream_online' : 'stream_offline');
  monitorStream.textContent = streamBadge.text;
  monitorStream.className = 'status-badge ' + streamBadge.className;

  const scannerText = monitor.agent && monitor.agent.isRunning
    ? 'scanner_running'
    : ((monitor.agent && monitor.agent.scannerEnabled !== false) ? 'scanner_ready' : 'scanner_paused');
  const scannerBadge = formatProviderBadge(scannerText);
  monitorScanner.textContent = scannerBadge.text;
  monitorScanner.className = 'status-badge ' + scannerBadge.className;

  agentStarted.textContent = formatDateTime(monitor.agent && monitor.agent.startedAt);
  scanStarted.textContent = formatDateTime(monitor.agent && monitor.agent.lastScanStartedAt);
  scanFinished.textContent = formatDateTime(monitor.agent && monitor.agent.lastScanFinishedAt);
  scanSummary.textContent = summarizeScan(monitor);
  monitorError.textContent = monitor.lastSyncError || monitor.configMessage || '—';

  const pendingAction = appState.monitorAction || null;
  const scannerEnabled = pendingAction === 'starting'
    ? true
    : (pendingAction === 'stopping'
      ? false
      : !(monitor.agent && monitor.agent.scannerEnabled === false));
  const isBusyWithAction = pendingAction === 'starting' || pendingAction === 'stopping' || pendingAction === 'scan_now';

  if (pendingAction === 'starting') {
    toggleScanBtn.textContent = 'Starting...';
    toggleScanBtn.className = 'primary';
    toggleScanBtn.disabled = true;
  } else if (pendingAction === 'stopping') {
    toggleScanBtn.textContent = 'Stopping...';
    toggleScanBtn.className = 'warning';
    toggleScanBtn.disabled = true;
  } else {
    toggleScanBtn.textContent = scannerEnabled ? 'Stop scan' : 'Resume scan';
    toggleScanBtn.className = scannerEnabled ? 'warning' : 'primary';
    toggleScanBtn.disabled = pendingAction === 'scan_now';
  }

  scanNowBtn.disabled = isBusyWithAction || !!(monitor.agent && monitor.agent.isRunning) || !scannerEnabled;

  renderProviderStatuses(monitor);
  renderEvents(monitor);
  renderLogs(monitor);
}

function renderAll() {
  updateSummary();
  rebuildSkinSelect();
  rebuildLinksList();
  rebuildProfileSelect();
  renderProfileSkinOptions();
  renderIntegrations();
  renderMonitor();

  if (appState.currentSkinKey && appState.data.patternLibrary.skins[appState.currentSkinKey]) {
    loadSkinIntoForm(appState.currentSkinKey);
  } else if (!skinUrlInput.value) {
    clearSkinForm();
  }

  if (appState.currentProfileId && appState.data.scanProfiles.some((profile) => profile.id === appState.currentProfileId)) {
    loadProfileIntoForm(appState.currentProfileId);
  } else if (!profileNameInput.value) {
    clearProfileForm();
  }
}

async function saveAppState(successMessage) {
  appState.data = CS2ScannerCore.normalizeState(appState.data);
  await storageSet({
    [CS2ScannerCore.APP_STORAGE_KEY]: appState.data,
    [CS2ScannerCore.LEGACY_STORAGE_KEY]: CS2ScannerCore.serializeLegacyPatternLibrary(appState.data)
  });

  updateSummary();

  try {
    const response = await runtimeSend('cs2Scanner:syncConfig');
    if (response && response.monitor) {
      appState.monitor = response.monitor;
      renderMonitor();
    }
  } catch (error) {
    appState.monitor = appState.monitor || {};
    showStatus(successMessage + ' Но agent не подтвердил sync: ' + error.message, true);
    return;
  }

  showStatus(successMessage);
}

async function loadInitialState() {
  const stored = await storageGet({
    [CS2ScannerCore.APP_STORAGE_KEY]: null,
    [CS2ScannerCore.LEGACY_STORAGE_KEY]: {},
    [CS2ScannerCore.MONITOR_STORAGE_KEY]: null
  });

  appState.data = CS2ScannerCore.migrateState(
    stored[CS2ScannerCore.APP_STORAGE_KEY],
    stored[CS2ScannerCore.LEGACY_STORAGE_KEY]
  );
  appState.monitor = stored[CS2ScannerCore.MONITOR_STORAGE_KEY] || null;

  try {
    const response = await runtimeSend('cs2Scanner:getMonitor');
    if (response && response.monitor) {
      appState.monitor = response.monitor;
    }
  } catch (error) {
    showStatus('Не удалось получить монитор агента: ' + error.message, true);
  }

  renderAll();
}

async function refreshMonitorFromBackground(message) {
  const response = await runtimeSend('cs2Scanner:refreshStatus');
  appState.monitor = response && response.monitor ? response.monitor : appState.monitor;
  renderMonitor();
  if (message) {
    showStatus(message);
  }
}
tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    switchTab(button.dataset.tab);
  });
});

skinSearchInput.addEventListener('input', () => {
  appState.skinFilter = skinSearchInput.value;
  rebuildSkinSelect();
  rebuildLinksList();
});

skinSelect.addEventListener('change', () => {
  const key = skinSelect.value;
  if (!key) {
    clearSkinForm();
    return;
  }
  loadSkinIntoForm(key);
});

newSkinBtn.addEventListener('click', () => {
  clearSkinForm();
  skinSelect.value = '';
});

openAllBtn.addEventListener('click', () => {
  openAllLinks();
});

exportSkinsBtn.addEventListener('click', () => {
  exportSkins();
});

importSkinsInput.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    return;
  }

  try {
    await importSkins(file);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    importSkinsInput.value = '';
  }
});

addTierBtn.addEventListener('click', () => {
  createTierRow({ name: '', patterns: [] });
});

saveSkinBtn.addEventListener('click', async () => {
  try {
    await saveCurrentSkin();
  } catch (error) {
    showStatus(error.message, true);
  }
});

deleteSkinBtn.addEventListener('click', async () => {
  try {
    await deleteCurrentSkin();
  } catch (error) {
    showStatus(error.message, true);
  }
});

profileSelect.addEventListener('change', () => {
  const id = profileSelect.value;
  if (!id) {
    clearProfileForm();
    return;
  }

  loadProfileIntoForm(id);
});

newProfileBtn.addEventListener('click', () => {
  clearProfileForm();
  profileSelect.value = '';
});

deleteProfileBtn.addEventListener('click', async () => {
  try {
    await deleteCurrentProfile();
  } catch (error) {
    showStatus(error.message, true);
  }
});

profileSkinSelect.addEventListener('change', () => {
  renderTierOptions(profileSkinSelect.value, []);
});

saveProfileBtn.addEventListener('click', async () => {
  try {
    await saveCurrentProfile();
  } catch (error) {
    showStatus(error.message, true);
  }
});

saveIntegrationsBtn.addEventListener('click', async () => {
  try {
    await saveIntegrations();
  } catch (error) {
    showStatus(error.message, true);
  }
});

if (logHttpOnlyInput) {
  logHttpOnlyInput.addEventListener('change', () => {
    renderLogs(appState.monitor || {});
  });
}

testAgentBtn.addEventListener('click', async () => {
  try {
    await refreshMonitorFromBackground('Статус агента обновлён.');
  } catch (error) {
    showStatus(error.message, true);
  }
});

testNotificationBtn.addEventListener('click', async () => {
  try {
    const response = await runtimeSend('cs2Scanner:testNotification');
    if (response && response.monitor) {
      appState.monitor = response.monitor;
      renderMonitor();
    }
    showStatus('Тест уведомления отправлен.');
  } catch (error) {
    showStatus(error.message, true);
  }
});

refreshStatusBtn.addEventListener('click', async () => {
  try {
    await refreshMonitorFromBackground('Монитор обновлён.');
  } catch (error) {
    showStatus(error.message, true);
  }
});

syncConfigBtn.addEventListener('click', async () => {
  try {
    const response = await runtimeSend('cs2Scanner:syncConfig');
    if (response && response.monitor) {
      appState.monitor = response.monitor;
      renderMonitor();
    }
    showStatus('Конфигурация отправлена агенту.');
  } catch (error) {
    showStatus(error.message, true);
  }
});

scanNowBtn.addEventListener('click', async () => {
  try {
    setMonitorAction('scan_now');
    const response = await runtimeSend('cs2Scanner:scanNow');
    if (response && response.monitor) {
      appState.monitor = response.monitor;
      renderMonitor();
    }
    showStatus('Сканирование запущено.');
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    setMonitorAction(null);
  }
});

toggleScanBtn.addEventListener('click', async () => {
  try {
    const currentlyEnabled = !(appState.monitor && appState.monitor.agent && appState.monitor.agent.scannerEnabled === false);
    const enabled = !currentlyEnabled;
    setMonitorAction(enabled ? 'starting' : 'stopping');
    const response = await runtimeSend('cs2Scanner:setScannerEnabled', { enabled });
    if (response && response.monitor) {
      appState.monitor = response.monitor;
      renderMonitor();
    }
    appState.data.scanner = Object.assign({}, appState.data.scanner || {}, { engineEnabled: enabled });
    showStatus(enabled ? 'Сканер возобновлён.' : 'Сканер остановлен.');
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    setMonitorAction(null);
  }
});

clearEventsBtn.addEventListener('click', async () => {
  try {
    const response = await runtimeSend('cs2Scanner:clearEvents');
    if (response && response.monitor) {
      appState.monitor = response.monitor;
      renderMonitor();
    }
    showStatus('Журнал очищен.');
  } catch (error) {
    showStatus(error.message, true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'cs2Scanner:monitorUpdated') {
    return;
  }

  appState.monitor = message.monitor;
  renderMonitor();
});

loadInitialState().catch((error) => {
  showStatus(error.message, true);
});
