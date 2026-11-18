import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkClient } = require('../dist/tests/networkClient.cjs');

/**
 * The client is server-authoritative: unless it joins, the server sends it no
 * state (no bots on screen) and ignores its actions. Every `init` starts a NEW
 * session with a new player id and session token, so a reconnect must re-send
 * the join with the token that session issued — otherwise the player sits there
 * unnamed forever, which is exactly how Beta/online play appeared as "no bots,
 * can't dig".
 */
test('a reconnect re-sends join with the new session token', () => {
  const posted = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      FakeEventSource.instance = this;
    }
    close() {}
  }

  // No WebSocket server: connect() falls through to the SSE fallback.
  class DeadWebSocket {
    constructor() {
      throw new Error('simulated: no WebSocket server');
    }
  }

  globalThis.window = { location: { protocol: 'http:', host: 'localhost:3000' } };
  globalThis.WebSocket = DeadWebSocket;
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = (_url, options) => {
    posted.push(JSON.parse(options.body));
    return Promise.resolve({ ok: true });
  };

  const client = new NetworkClient('ws://127.0.0.1:9', 'blue', 'Tester');
  client.connect();

  const stream = FakeEventSource.instance;
  assert.ok(stream, 'SSE fallback stream should be opened');

  stream.onopen();
  assert.equal(client.isConnected(), true);
  assert.equal(posted.length, 0, 'join must not be sent before the session exists');

  // First session.
  stream.onmessage({ data: JSON.stringify({ type: 'init', playerId: 'p1', sessionToken: 'tok-1' }) });
  assert.equal(posted.length, 1, 'join is sent exactly once for the first session');
  assert.deepEqual(posted[0], {
    token: 'tok-1',
    message: { type: 'join', team: 'blue', name: 'Tester' },
  });

  // The stream reconnects: the server opens a new session with a new token.
  stream.onmessage({ data: JSON.stringify({ type: 'init', playerId: 'p2', sessionToken: 'tok-2' }) });
  assert.equal(posted.length, 2, 'the reconnected session is joined again, exactly once');
  assert.deepEqual(posted[1], {
    token: 'tok-2',
    message: { type: 'join', team: 'blue', name: 'Tester' },
  });
  assert.notEqual(posted[0].token, posted[1].token, 'the re-join must use the new token');

  client.disconnect();
});
