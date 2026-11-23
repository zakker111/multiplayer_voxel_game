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

/**
 * Leaving online play (or being kicked) closes the socket on purpose. The old
 * socket's queued close event and any fallback timer from that connection must
 * stay inert: otherwise the game shows "Disconnected from server. Reconnecting..."
 * and an SSE stream re-joins a session the player just ended.
 */
test('an intentional disconnect stays silent and never revives a session', () => {
  const notices = [];
  let fallbackStreams = 0;

  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      FakeWebSocket.instance = this;
    }
    close() { this.readyState = 3; }
  }

  class FakeEventSource {
    constructor() {
      fallbackStreams++;
      FakeEventSource.instance = this;
    }
    close() {}
  }

  globalThis.window = {
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
  };
  globalThis.WebSocket = FakeWebSocket;
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = () => Promise.resolve({ ok: true });

  const client = new NetworkClient('ws://127.0.0.1:9', 'blue', 'Tester');
  client.onDisconnect(() => notices.push('disconnected'));
  client.connect();

  const socket = FakeWebSocket.instance;
  assert.ok(socket, 'the WebSocket transport is opened first');
  socket.onopen?.();
  socket.onmessage({ data: JSON.stringify({ type: 'init', playerId: 'p1', sessionToken: 'tok-1' }) });
  assert.equal(client.isConnected(), true);

  // The player leaves while a close event is still queued for the old socket.
  const queuedClose = socket.onclose;
  client.disconnect();
  assert.equal(client.isConnected(), false);

  queuedClose();
  assert.equal(notices.length, 0, 'leaving on purpose must not report a lost session');

  // The 10s WebSocket timeout from that connection can still fire afterwards;
  // it calls connectSSE, which must refuse to reopen an ended session.
  client.connectSSE();
  assert.equal(fallbackStreams, 0, 'an ended session must not reopen over SSE');
});
