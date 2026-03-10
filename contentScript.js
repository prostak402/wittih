const STORAGE_KEY = 'cs2PatternTiers';

let cs2pt_skinsConfig = {};
let cs2pt_lastUrl = location.href;
let cs2pt_observerInitialized = false;
let cs2pt_processScheduled = false;

function cs2pt_log(...args) {
  // console.log('[CS2 Pattern Tier]', ...args);
}

function cs2pt_injectStyles() {
  if (document.getElementById('cs2-pattern-tier-style')) return;
  const style = document.createElement('style');
  style.id = 'cs2-pattern-tier-style';
  style.textContent = `
    .cs2pt-tier-wrapper {
      margin-top: 2px;
      font-size: 11px;
      line-height: 1.3;
      display: block;
      color: #cfd8dc;
      white-space: normal;
    }
    .cs2pt-tier-wrapper::before {
      content: 'Tier:';
      opacity: 0.7;
      margin-right: 4px;
    }
    .cs2pt-tier-label {
      padding: 0 6px;
      border-radius: 999px;
      font-size: 10px;
      line-height: 1.4;
      font-weight: 600;
      display: inline-block;
      white-space: nowrap;
      vertical-align: baseline;
    }
    .cs2pt-tier-0 { background-color: #4caf50; color: #fff; }
    .cs2pt-tier-1 { background-color: #ff9800; color: #fff; }
    .cs2pt-tier-2 { background-color: #f44336; color: #fff; }
    .cs2pt-tier-default { background-color: #2196f3; color: #fff; }
  `;
  document.head.appendChild(style);
}

function cs2pt_buildSkinKey(urlString) {
  try {
    const url = new URL(urlString, location.origin);
    const decodedPath = decodeURIComponent(url.pathname);
    const segments = decodedPath.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    let lastSeg = segments[segments.length - 1];
    lastSeg = lastSeg.replace(/\s*\([^()]*\)\s*$/, '');
    lastSeg = lastSeg.trim();
    if (!lastSeg) return null;

    const key = url.origin + '|skin|' + lastSeg.toLowerCase();
    return key;
  } catch (e) {
    cs2pt_log('Bad URL in buildSkinKey', urlString, e);
    return null;
  }
}

function cs2pt_getCurrentSkinKey() {
  return cs2pt_buildSkinKey(location.href);
}

function cs2pt_loadConfig(callback) {
  chrome.storage.local.get({ [STORAGE_KEY]: {} }, (res) => {
    cs2pt_skinsConfig = res[STORAGE_KEY] || {};
    cs2pt_log('Loaded config', cs2pt_skinsConfig);
    if (typeof callback === 'function') callback();
  });
}

function cs2pt_findTierForPattern(skinConfig, patternId) {
  if (!skinConfig || !Array.isArray(skinConfig.tiers)) return null;
  for (let i = 0; i < skinConfig.tiers.length; i++) {
    const tier = skinConfig.tiers[i];
    if (!tier || !Array.isArray(tier.patterns)) continue;
    if (tier.patterns.includes(patternId)) {
      return { tier, index: i };
    }
  }
  return null;
}

function cs2pt_annotatePatternNode(node, tierInfo) {
  const leftCol = node.closest('.left') || node.parentElement || node;

  let wrapper = leftCol.querySelector('.cs2pt-tier-wrapper');

  if (!tierInfo) {
    if (wrapper) wrapper.remove();
    return;
  }

  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'cs2pt-tier-wrapper';
    if (node.parentElement === leftCol) {
      node.insertAdjacentElement('afterend', wrapper);
    } else {
      leftCol.appendChild(wrapper);
    }
  }

  let label = wrapper.querySelector('.cs2pt-tier-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'cs2pt-tier-label';
    wrapper.appendChild(label);
  }

  const { tier, index } = tierInfo;
  const idxClass = typeof index === 'number' ? `cs2pt-tier-${index}` : 'cs2pt-tier-default';
  label.className = `cs2pt-tier-label ${idxClass}`;

  const displayText = tier && tier.name ? tier.name : ('T' + (typeof index === 'number' ? (index + 1) : ''));
  label.textContent = displayText;

  const fullName = tier && tier.name ? tier.name : ('Tier ' + (typeof index === 'number' ? (index + 1) : '?'));
  label.title = fullName;
}

function cs2pt_processPage() {
  cs2pt_processScheduled = false;
  cs2pt_injectStyles();

  const skinKey = cs2pt_getCurrentSkinKey();
  if (!skinKey) return;
  const skinConfig = cs2pt_skinsConfig[skinKey];
  if (!skinConfig) {
    cs2pt_log('No config for skin', skinKey);
    return;
  }

  const patternNodes = document.querySelectorAll('[mattooltip="Паттерн"].pattern');
  patternNodes.forEach(node => {
    const text = (node.textContent || '').trim();
    const match = text.match(/\d+/);
    if (!match) {
      return;
    }
    const patternId = parseInt(match[0], 10);
    if (isNaN(patternId)) return;

    const tierInfo = cs2pt_findTierForPattern(skinConfig, patternId);
    cs2pt_annotatePatternNode(node, tierInfo);
  });
}

function cs2pt_scheduleProcessPage() {
  if (cs2pt_processScheduled) return;
  cs2pt_processScheduled = true;
  setTimeout(cs2pt_processPage, 200);
}

function cs2pt_initObserver() {
  if (cs2pt_observerInitialized) return;
  cs2pt_observerInitialized = true;

  const observer = new MutationObserver(() => {
    cs2pt_scheduleProcessPage();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function cs2pt_initUrlWatcher() {
  setInterval(() => {
    if (location.href !== cs2pt_lastUrl) {
      cs2pt_lastUrl = location.href;
      cs2pt_log('URL changed, re-processing', cs2pt_lastUrl);
      cs2pt_scheduleProcessPage();
    }
  }, 1000);
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEY]) {
      cs2pt_skinsConfig = changes[STORAGE_KEY].newValue || {};
      cs2pt_log('Config updated from storage.onChanged', cs2pt_skinsConfig);
      cs2pt_scheduleProcessPage();
    }
  });
}

cs2pt_loadConfig(() => {
  cs2pt_scheduleProcessPage();
  cs2pt_initObserver();
  cs2pt_initUrlWatcher();
});
