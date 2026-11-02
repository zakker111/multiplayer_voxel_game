// Live smoke test for the production server (run: node .smoke.mjs).
// Covers the WebSocket join/input/respawn path, garbage-frame resilience, the
// HTTP fallback auth (token required, playerId alone rejected) and SSE init.
import WebSocket from 'ws';
import http from 'node:http';

const PORT = Number(process.env.SMOKE_PORT || 3110);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient() {
  const ws = new WebSocket(WS_URL);
  const frames = [];
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return { ws, frames };
}

async function post(body) {
  const res = await fetch(`${BASE}/api/game/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  // ---------- WebSocket ----------
  const a = wsClient();
  const b = wsClient();
  await Promise.all([
    new Promise((resolve, reject) => { a.ws.once('open', resolve); a.ws.once('error', reject); }),
    new Promise((resolve, reject) => { b.ws.once('open', resolve); b.ws.once('error', reject); }),
  ]);
  await sleep(400);

  const init = a.frames.find((f) => f.type === 'init');
  check('init received', !!init);
  check('init has playerId', typeof init?.playerId === 'string' && init.playerId.length > 0);
  check('init has sessionToken', typeof init?.sessionToken === 'string' && init.sessionToken.length > 10);
  check('init has round snapshot', !!init?.round && typeof init.round.timeLeft === 'number');
  check('init has 20 bots online', (init?.players?.length ?? 0) >= 20, `${init?.players?.length}`);

  a.ws.send(JSON.stringify({ type: 'join', team: 'blue', name: 'SmokeWS' }));
  b.ws.send(JSON.stringify({ type: 'join', team: 'red', name: 'SmokeObserver' }));
  await sleep(400);
  check('join accepted', b.frames.some((f) => f.type === 'playerJoined' && f.playerId === a.frames.find((f) => f.type === 'init')?.playerId)
    || a.frames.some((f) => f.type === 'playerUpdated'));

  // Movement is observed from the other client: the server never echoes a
  // player's own movement back to them.
  const target = { x: 0, y: 12, z: -210 };
  for (let i = 0; i < 15; i++) {
    a.ws.send(JSON.stringify({
      type: 'playerInput',
      input: { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, sprint: true, position: target },
    }));
    await sleep(50);
  }
  await sleep(300);
  const seenByB = b.frames.filter((f) => f.type === 'playerUpdated' && f.playerId === init.playerId).at(-1);
  check(
    'player input reaches other clients',
    !!seenByB && Math.abs(seenByB.state.position.z - target.z) < 0.01,
    `observed z=${seenByB?.state.position?.z}`,
  );

  // Garbage frames must not kill the connection or log errors.
  const wsClosed = { v: false };
  a.ws.once('close', () => { wsClosed.v = true; });
  a.ws.send('this is not json');
  a.ws.send(JSON.stringify({ type: 'playerInput' }));
  a.ws.send(JSON.stringify({ type: 'shoot' }));
  a.ws.send(JSON.stringify({ type: 'shoot', origin: { x: 999, y: 50, z: 999 }, direction: { x: 0, y: 0, z: 1 } }));
  a.ws.send(JSON.stringify({ type: 'join', team: 'purple' }));
  a.ws.send(JSON.stringify({ type: 'footstep', volume: 'loud', pitch: null }));
  await sleep(300);
  check('survives malformed frames', !wsClosed.v);

  a.ws.send(JSON.stringify({ type: 'requestRespawn' }));
  await sleep(250);
  check('respawn while alive is safe', !wsClosed.v && !a.frames.some((f) => f.type === 'playerDied' && f.playerId === init.playerId));

  a.ws.send(JSON.stringify({ type: 'ping', t: 12345 }));
  await sleep(250);
  check('ping/pong echoes token', a.frames.some((f) => f.type === 'pong' && f.t === 12345));

  // ---------- HTTP fallback auth ----------
  const noToken = await post({ playerId: init.playerId, message: { type: 'join', team: 'red' } });
  check('HTTP rejects playerId without token', noToken.status === 401, `status ${noToken.status}`);

  const badToken = await post({ token: 'forged', message: { type: 'join', team: 'red' } });
  check('HTTP rejects forged token', badToken.status === 401, `status ${badToken.status}`);

  const goodToken = await post({ token: init.sessionToken, message: { type: 'join', team: 'blue', name: 'SmokeWS' } });
  check('HTTP accepts its own session token', goodToken.status === 200, `status ${goodToken.status}`);

  // ---------- SSE (stream stays open while messages are posted) ----------
  const sse = { req: null, init: null };
  await new Promise((resolve) => {
    const req = http.get(`${BASE}/api/game/events`, (res) => {
      sse.req = req;
      let buffer = '';
      const timer = setTimeout(resolve, 4000);
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? ''; // A large init event may span multiple chunks.
        for (const event of events) {
          if (!event.startsWith('data: ')) continue;
          let message;
          try { message = JSON.parse(event.slice(6)); } catch { continue; }
          if (message.type === 'init') {
            sse.init = message;
            clearTimeout(timer);
            resolve();
            break;
          }
        }
      });
    });
    req.on('error', () => resolve());
  });
  check('SSE init received', !!sse.init?.playerId);
  check('SSE init carries a session token', typeof sse.init?.sessionToken === 'string');
  if (sse.init?.sessionToken) {
    const ssePost = await post({ token: sse.init.sessionToken, message: { type: 'join', team: 'red', name: 'SmokeSSE' } });
    check('SSE session token authorizes HTTP messages', ssePost.status === 200, `status ${ssePost.status}`);
  }
  sse.req?.destroy();
  await sleep(200);

  a.ws.close();
  b.ws.close();
  await sleep(300);
  check('server stays up after disconnect', (await fetch(`${BASE}/`)).status === 200);

  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE ERROR', err);
  process.exit(1);
});
