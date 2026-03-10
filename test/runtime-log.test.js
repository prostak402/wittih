const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeLog } = require('../agent/lib/runtime-log.js');

test('runtime log keeps full http trace strings while redacting secrets', () => {
  const logger = new RuntimeLog({ httpTraceEnabled: true, maxEntries: 10 });
  const longUrl = 'https://api.lis-skins.com/v1/market/search?' + 'names%5B%5D=' + 'A'.repeat(800);

  logger.traceHttp('lisSkins', 'HTTP request payload.', {
    httpTraceMode: 'full',
    url: longUrl,
    headers: {
      Authorization: 'Bearer secret-token',
      Accept: 'application/json'
    }
  });

  const entry = logger.getRecent(1)[0];
  assert.ok(entry);
  assert.equal(entry.details.url, longUrl);
  assert.equal(entry.details.headers.Authorization, '[redacted]');
  assert.equal(entry.details.headers.Accept, 'application/json');
});