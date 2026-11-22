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

/**
 * The game shows "Disconnected from server. Reconnecting..." and resets its
 * join flag from the disconnect callback. When the handler was never invoked,
 * a dropped session looked like a healthy one forever.
 */
test('a dropped session notifies the game once, and a healthy one stays quiet', () => {
  const notices = [];

  class FakeEventSource {
    constructor() {
      this.readyState = 1; // OPEN
      FakeEventSource.instance = this;
    }
    close() { this.readyState = FakeEventSource.CLOSED; }
  }
  FakeEventSource.CLOSED = 2;

  class DeadWebSocket {
    constructor() {
      throw new Error('simulated: no WebSocket server');
    }
  }

  globalThis.window = {
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  globalThis.WebSocket = DeadWebSocket;
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = () => Promise.resolve({ ok: true });

  const client = new NetworkClient('ws://127.0.0.1:9', 'blue', 'Tester');
  client.onDisconnect(() => notices.push('disconnected'));
  client.connect();

  const stream = FakeEventSource.instance;
  stream.onopen();
  assert.equal(client.isConnected(), true);
  assert.equal(notices.length, 0, 'a healthy stream never reports a disconnect');

  // The proxy caps the response and the stream is gone: the session with it.
  stream.readyState = FakeEventSource.CLOSED;
  stream.onerror();
  assert.equal(notices.length, 1, 'the game hears about the dropped session');
  assert.equal(client.isConnected(), false);

  // A second error from the dead stream must not queue the message again.
  stream.onerror();
  assert.equal(notices.length, 1, 'the loss is reported exactly once');

  client.disconnect();
});
