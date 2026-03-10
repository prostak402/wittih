const fs = require('node:fs');
const path = require('node:path');
const { createDefaultState } = require('../../shared/cs2-scanner-core.js');

const dataDir = path.join(__dirname, '..', 'data');
const configPath = path.join(dataDir, 'config.json');
const eventsPath = path.join(dataDir, 'events.json');
const seenPath = path.join(dataDir, 'seen.json');

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadState() {
  return readJson(configPath, createDefaultState());
}

function saveState(state) {
  writeJson(configPath, state);
}

function loadEvents() {
  return readJson(eventsPath, []);
}

function saveEvents(events) {
  writeJson(eventsPath, events);
}

function loadSeenKeys() {
  return readJson(seenPath, {});
}

function saveSeenKeys(seenKeys) {
  writeJson(seenPath, seenKeys);
}

module.exports = {
  dataDir,
  configPath,
  eventsPath,
  seenPath,
  ensureDataDir,
  readJson,
  writeJson,
  loadState,
  saveState,
  loadEvents,
  saveEvents,
  loadSeenKeys,
  saveSeenKeys
};
