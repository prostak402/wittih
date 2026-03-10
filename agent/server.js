const http = require('node:http');
const { URL } = require('node:url');
const { WebSocketServer } = require('ws');

const { migrateState, createDefaultState } = require('../shared/cs2-scanner-core.js');
const storage = require('./lib/storage.js');
const { TelegramNotifier } = require('./lib/notifier.js');
const { RuntimeLog } = require('./lib/runtime-log.js');
const { MarketCsgoTmAdapter } = require('./lib/adapters/market-csgo-tm.js');
const { LisSkinsAdapter } = require('./lib/adapters/lis-skins.js');
const { ScannerEngine } = require('./lib/scanner-engine.js');

const PORT = Number(process.env.CS2_SCANNER_PORT || 37891);

storage.ensureDataDir();

const initialState = migrateState(storage.loadState(), {});
const logger = new RuntimeLog({
  maxEntries: 500,
  httpTraceEnabled: !!(initialState && initialState.scanner && initialState.scanner.httpTraceEnabled)
});
const notifier = new TelegramNotifier(fetch, logger);
const engine = new ScannerEngine({
  initialState,
  initialEvents: storage.loadEvents(),
  initialSeenKeys: storage.loadSeenKeys(),
  notifier,
  logger,
  adapters: {
    marketCsgoTm: new MarketCsgoTmAdapter(fetch, { logger }),
    lisSkins: new LisSkinsAdapter(fetch, { logger })
  },
  persist: async (state, events, seenKeys) => {
    storage.saveState(state);
    storage.saveEvents(events);
    storage.saveSeenKeys(seenKeys);
  }
});

const server = http.createServer(requestHandler);
const wss = new WebSocketServer({ noServer: true });

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    request.on('error', reject);
  });
}

function broadcast(message) {
  const serialized = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(serialized);
    }
  });
}

logger.onEntry = (entry) => {
  broadcast({ type: 'log', data: entry });
};

engine.onEvent = async (event) => {
  broadcast({ type: 'event', data: event });
};

engine.onStatusChange = (status) => {
  broadcast({ type: 'status', data: status });
};

async function requestHandler(request, response) {
  if (request.method === 'OPTIONS') {
    writeJson(response, 204, {});
    return;
  }

  const url = new URL(request.url, 'http://127.0.0.1:' + PORT);
  logger.debug('agent-http', 'Incoming request.', {
    method: request.method,
    path: url.pathname,
    query: url.search
  });

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      writeJson(response, 200, {
        ok: true,
        startedAt: engine.startedAt,
        configStatus: engine.configStatus
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      writeJson(response, 200, engine.getStatus());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      const cursor = Number(url.searchParams.get('cursor') || 0);
      writeJson(response, 200, {
        events: engine.getEventsAfter(cursor),
        nextCursor: engine.eventCursor
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/logs') {
      const cursor = Number(url.searchParams.get('cursor') || 0);
      writeJson(response, 200, {
        logs: logger.getAfter(cursor),
        nextCursor: logger.cursor
      });
      return;
    }

    if (request.method === 'PUT' && url.pathname === '/config') {
      const body = await readBody(request);
      const state = migrateState(body && body.state ? body.state : createDefaultState(), {});
      logger.setHttpTraceEnabled(!!(state && state.scanner && state.scanner.httpTraceEnabled));
      await engine.applyState(state);
      writeJson(response, 200, {
        ok: true,
        configStatus: engine.configStatus,
        status: engine.getStatus()
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/scan/run') {
      const body = await readBody(request).catch(() => ({}));
      const status = await engine.runDueProfiles(body && body.trigger ? body.trigger : 'manual', true);
      writeJson(response, 200, {
        ok: true,
        status
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/scan/stop') {
      const body = await readBody(request).catch(() => ({}));
      const status = await engine.setScannerEnabled(false, body && body.reason ? body.reason : 'Scanner stopped by user.');
      writeJson(response, 200, { ok: true, status });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/scan/start') {
      const body = await readBody(request).catch(() => ({}));
      const status = await engine.setScannerEnabled(true, body && body.reason ? body.reason : 'Scanner resumed by user.');
      writeJson(response, 200, { ok: true, status });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/events/delete') {
      const body = await readBody(request).catch(() => ({}));
      const eventIds = Array.isArray(body && body.eventIds)
        ? body.eventIds
        : (body && body.eventId ? [body.eventId] : []);
      const removed = await engine.deleteEvents(eventIds);
      writeJson(response, 200, {
        ok: true,
        removed,
        status: engine.getStatus()
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/events/clear') {
      const removed = await engine.clearEvents();
      writeJson(response, 200, {
        ok: true,
        removed,
        status: engine.getStatus()
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/notifications/test') {
      await notifier.sendTest(engine.getNotifications());
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    logger.error('agent-http', 'Request failed.', {
      method: request.method,
      path: url.pathname,
      error: error.message
    });
    const statusCode = error.message && error.message.includes('Invalid JSON') ? 400 : 500;
    writeJson(response, statusCode, { error: error.message });
  }
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://127.0.0.1:' + PORT);
  if (url.pathname !== '/events') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'status', data: engine.getStatus() }));
  socket.send(JSON.stringify({ type: 'events', data: engine.getEventsAfter(Math.max(0, engine.eventCursor - 20)) }));
  socket.send(JSON.stringify({ type: 'logs', data: logger.getRecent(120) }));
});

server.listen(PORT, '127.0.0.1', () => {
  engine.start();
  logger.info('agent', 'CS2 scanner agent listening.', {
    url: 'http://127.0.0.1:' + PORT
  });
  console.log('CS2 scanner agent listening on http://127.0.0.1:' + PORT);
});
