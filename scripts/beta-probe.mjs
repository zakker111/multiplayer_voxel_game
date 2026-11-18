// One-off Beta end-to-end probe over the wire protocol the browser uses.
// PHASE=core : connection, bots, join, movement, dig, build, shooting, reload,
//              ping, spectator, respawn, second client  (safe with bots on)
// PHASE=move : server movement validation — teleport refused, speed hack
//              throttled, ordinary movement accepted (validation ON)
// PHASE=limits: websocket socket cap + per-socket message flood throttle. Run
//              that server with WS_MAX_PER_IP=2 WS_MSG_RATE=20 WS_MSG_BURST=30.
// PHASE=all  : also workshop deposit, jeep build/enter/drive/exit and a flag
//              capture (deterministic when the server runs without bots). It
//              teleports the probe on purpose, so that server needs
//              MOVE_VALIDATION=off, on a freshly started server: flag state
//              persists between runs, so a dirty flag fails the CTF checks.
import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PHASE = process.env.PHASE || 'core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

class Client {
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.token = null;
    this.playerId = null;
    this.abort = new AbortController();
  }
  async connect() {
    const res = await fetch(`${BASE}/api/game/events`, {
      signal: this.abort.signal, headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = raw.split('\n').filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim()).join('\n');
            if (!data) continue;
            try { this.messages.push(JSON.parse(data)); } catch { /* ignore */ }
          }
        }
      } catch { /* aborted */ }
    })();
  }
  async waitFor(type, ms = 3000, pred = () => true) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = this.messages.find((x) => x.type === type && pred(x));
      if (m) return m;
      await sleep(20);
    }
    return null;
  }
  async waitAny(types, ms = 1500) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = this.messages.find((x) => types.includes(x.type));
      if (m) return m;
      await sleep(20);
    }
    return null;
  }
  last(type) { return this.messages.filter((m) => m.type === type).pop(); }
  types() { return [...new Set(this.messages.map((m) => m.type))].join(','); }
  async send(message) {
    const r = await fetch(`${BASE}/api/game/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token, message }),
    });
    return r.status;
  }
  place(pos, equipment = 'rifle') {
    return this.send({
      type: 'playerInput',
      input: {
        moveX: 0, moveZ: 0, jump: false, crouch: false, sprint: false, yaw: 0, pitch: 0,
        position: { x: pos.x, y: pos.y, z: pos.z }, equipment, isAiming: false,
      },
    });
  }
  close() { this.abort.abort(); }
}

const A = new Client('A');
const observer = new Client('observer');
try {
  await A.connect();
  await observer.connect();

  // ---------- connect / init / bots ----------
  const init = await A.waitFor('init', 6000);
  check('SSE connect delivers init', !!init);
  if (!init) throw new Error('no init');
  A.token = init.sessionToken;
  A.playerId = init.playerId;
  check('init carries session token + player id',
    typeof A.token === 'string' && typeof A.playerId === 'string');
  const bots = init.players.filter((p) => p.id.startsWith('bot_'));
  // Phase 2 deliberately runs the server botless so jeeps/CTF are deterministic.
  const expectedBots = PHASE === 'all' ? 0 : 20;
  // Bots refill on a timer, so a server that recently had a human can be one
  // bot short of the target for a few seconds.
  const botsOk = PHASE === 'all' ? bots.length === 0 : bots.length >= 18 && bots.length <= 20;
  check('init roster holds the expected bots', botsOk, `${bots.length} bots`);
  if (expectedBots > 0) {
    check('both teams in the roster', new Set(bots.map((b) => b.state.team)).size === 2);
  }
  check('init has round / workshops / flags state',
    !!init.round && !!init.workshops && !!init.flags, `phase=${init.round?.phase}`);

  // ---------- join ----------
  await A.send({ type: 'join', team: 'blue', name: 'Probe_A' });
  const joined = await A.waitFor('joined', 4000);
  check('join acknowledged', !!joined);
  const spawn = joined?.state?.position ?? init.state.position;
  check('joined on the requested team', joined?.state?.team === 'blue');
  check('spawn position is finite', Number.isFinite(spawn?.x) && Number.isFinite(spawn?.y));
  const pos = { x: Math.floor(spawn.x) + 0.5, y: spawn.y, z: Math.floor(spawn.z) + 0.5 };

  // ---------- transport limits: socket cap + per-socket message budget ----------
  if (PHASE === 'limits') {
    const wsUrl = BASE.replace(/^http/, 'ws');
    const openSocket = () => new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve({ ws, ...result }); } };
      ws.on('open', () => done({ opened: true }));
      ws.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }));
      ws.on('error', (err) => done({ opened: false, error: err.message }));
      ws.on('message', () => {});
    });

    const sockets = [];
    let refused = null;
    for (let i = 0; i < 6; i++) {
      const s = await openSocket();
      if (s.opened) sockets.push(s.ws);
      else { refused = s; break; }
    }
    check('sockets beyond the per-IP cap are refused', !!refused,
      refused ? String(refused.status ?? refused.error) : 'six sockets all accepted');
    check('the refusal is a 503 before the handshake', refused?.status === 503, String(refused?.status));
    check('sockets under the cap stay open', sockets.length === 2, `${sockets.length} accepted`);

    for (const ws of sockets) ws.close();
    await sleep(500);

    const pongs = new Set();
    const listener = await openSocket();
    check('closing sockets frees their slots', !!listener.opened);
    if (listener.opened) {
      listener.ws.on('message', (data) => {
        try {
          const m = JSON.parse(String(data));
          if (m.type === 'pong') pongs.add(m.t);
        } catch { /* ignore */ }
      });

      // A normal client must be unaffected: ten pings over ~500ms.
      for (let i = 0; i < 10; i++) {
        listener.ws.send(JSON.stringify({ type: 'ping', t: 1000 + i }));
        await sleep(50);
      }
      await sleep(300);
      const normalReplies = [...pongs].filter((t) => t >= 1000).length;
      check('normal-rate traffic still gets replies', normalReplies >= 9, `${normalReplies}/10 pongs`);

      // A flood is throttled to the budget instead of reaching the game loop.
      pongs.clear();
      for (let i = 0; i < 400; i++) listener.ws.send(JSON.stringify({ type: 'ping', t: i }));
      await sleep(1200);
      check('a message flood is throttled', pongs.size > 0 && pongs.size < 400,
        `${pongs.size}/400 pongs answered`);
      try { listener.ws.close(); } catch { /* already closed by the server */ }
    }
    throw { done: true };
  }

  // ---------- movement validation: teleport / speed hack / normal ----------
  if (PHASE === 'move') {
    // The server never echoes our own position, so read it from the observer.
    const seenPosition = () => observer.messages
      .filter((m) => m.type === 'playerUpdated' && m.playerId === A.playerId)
      .pop()?.state?.position;

    const legalFrom = (await (async () => {
      observer.messages.length = 0;
      await A.place(pos);
      await sleep(300);
      return seenPosition();
    })()) ?? pos;

    const legalT0 = Date.now();
    for (let i = 1; i <= 20; i++) {
      await A.place({ x: legalFrom.x + 0.4 * i, y: legalFrom.y, z: legalFrom.z });
      await sleep(50);
    }
    await sleep(200);
    const legalTo = seenPosition();
    const legalDist = legalTo ? Math.hypot(legalTo.x - legalFrom.x, legalTo.z - legalFrom.z) : 0;
    check('ordinary movement is accepted', legalDist > 5,
      `${legalDist.toFixed(1)}u in ${((Date.now() - legalT0) / 1000).toFixed(2)}s`);

    // A teleport aimed at the enemy flag must not arrive.
    observer.messages.length = 0;
    await A.place({ x: 0.5, y: legalFrom.y, z: 160.5 });
    await sleep(500);
    const afterTeleport = seenPosition() ?? legalTo;
    const flagGap = afterTeleport ? Math.hypot(afterTeleport.x - 0.5, afterTeleport.z - 160.5) : Infinity;
    check('teleport to the enemy flag is refused', flagGap > 100,
      `still ${flagGap.toFixed(0)}u short of the flag`);

    A.messages.length = 0;
    await A.send({ type: 'pickupFlag' });
    const stolen = await A.waitFor('flagPickedUp', 1500, (m) => m.playerId === A.playerId);
    check('a teleport cannot steal the flag', !stolen);

    // A speed hack gains no ground.
    const hackFrom = seenPosition() ?? legalTo;
    const hackT0 = Date.now();
    for (let i = 1; i <= 10; i++) {
      await A.place({ x: hackFrom.x + 25 * i, y: hackFrom.y, z: hackFrom.z });
      await sleep(20);
    }
    await sleep(400);
    const hackTo = seenPosition();
    const hackDist = hackTo ? Math.hypot(hackTo.x - hackFrom.x, hackTo.z - hackFrom.z) : 0;
    check('speed hack is throttled to legal speed', hackDist > 0.5 && hackDist < 25,
      `${hackDist.toFixed(1)}u of 250 requested in ${((Date.now() - hackT0) / 1000).toFixed(2)}s`);

    // These checks deliberately walk the player away from spawn, so the
    // position-dependent feature checks below would run from a stale spot.
    // Ordinary play under validation is covered by PHASE=core.
    throw { done: true };
  }

  // ---------- digging (pickaxe harvests; spade only digs) ----------
  await A.place(pos, 'spade');
  await sleep(120);
  A.messages.length = 0;
  let dug = null;
  for (const dy of [1, 2, 3, 4]) {
    const target = { x: Math.floor(pos.x), y: Math.floor(pos.y) - dy, z: Math.floor(pos.z) };
    A.messages.length = 0;
    await A.send({ type: 'useTool', tool: 'spade', target });
    // Attribute the change to our own coordinate: bots dig too and broadcast.
    dug = await A.waitFor('voxelChanged', 700,
      (m) => m.change.x === target.x && m.change.y === target.y && m.change.z === target.z);
    if (dug) break;
  }
  check('digging removes a voxel and broadcasts it', !!dug,
    dug ? `y=${dug.change.y} -> type ${dug.change.type}` : 'no voxelChanged');

  // ---------- building ----------
  A.messages.length = 0;
  let built = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1]]) {
    const cell = { x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) };
    await A.send({ type: 'build', position: cell });
    built = await A.waitFor('voxelChanged', 700,
      (m) => m.change.x === cell.x && m.change.y === cell.y && m.change.z === cell.z);
    if (built) break;
  }
  check('building places a voxel and broadcasts it', !!built);
  check('building spends inventory',
    !!A.messages.find((m) => m.type === 'inventoryUpdated' && m.inventory < 20),
    JSON.stringify(A.messages.filter((m) => m.type === 'inventoryUpdated').map((m) => m.inventory)));

  // ---------- shooting + reload ----------
  observer.messages.length = 0;
  await A.place(pos, 'rifle');
  await A.send({ type: 'shoot', origin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, direction: { x: 1, y: 0, z: 0 } });
  const shotSeen = await observer.waitFor('playerShot', 2000);
  check('shooting fires and reaches other clients', !!shotSeen,
    shotSeen ? `weapon=${shotSeen.weapon}` : `observer saw: ${observer.types()}`);
  A.messages.length = 0;
  await A.send({ type: 'reload' });
  const reload = await A.waitAny(['playerUpdated', 'ammoUpdated', 'reloadStarted'], 1200);
  check('reload is accepted', !!reload, reload ? reload.type : 'no feedback');

  // ---------- latency probe ----------
  const t = Date.now();
  await A.send({ type: 'ping', t });
  const pong = await A.waitFor('pong', 2000, (m) => m.t === t);
  check('ping/pong round-trips', !!pong, pong ? `${Date.now() - t}ms` : 'no pong');

  // ---------- spectator + respawn ----------
  A.messages.length = 0;
  await A.send({ type: 'toggleSpectator' });
  const spec = await A.waitAny(['spectatorToggled', 'playerUpdated'], 1500);
  check('spectator toggle handled', !!spec, spec ? spec.type : 'no response');
  await A.send({ type: 'toggleSpectator' });
  await sleep(250);
  A.messages.length = 0;
  await A.send({ type: 'requestRespawn' });
  const resp = await A.waitAny(['playerRespawned', 'joined', 'playerUpdated'], 2000);
  check('respawn handled', !!resp, resp ? resp.type : 'no response');

  // ---------- two players see each other ----------
  const B = new Client('B');
  await B.connect();
  const initB = await B.waitFor('init', 6000);
  B.token = initB?.sessionToken;
  B.playerId = initB?.playerId;
  check('second client connects', !!initB);
  A.messages.length = 0;
  await B.send({ type: 'join', team: 'red', name: 'Probe_B' });
  const seenB = await A.waitFor('playerJoined', 4000, (m) => m.playerId === B.playerId)
    ?? await A.waitFor('playerUpdated', 4000, (m) => m.playerId === B.playerId);
  check('other clients see the second player', !!seenB, seenB ? seenB.type : 'not seen');
  B.close();
  const leftSeen = await A.waitFor('playerLeft', 3000, (m) => m.playerId === B.playerId);
  check('disconnect removes the player for others', !!leftSeen);

  if (PHASE !== 'all') throw { done: true };

  // ---------- workshop: harvest with the pickaxe, deposit, build a jeep ----------
  let depositable = 0;
  outer:
  for (const [ox, oz] of [[8, 0], [-8, 0], [0, 8], [0, -8], [14, 14], [-14, -14]]) {
    const spot = { x: Math.floor(spawn.x) + ox + 0.5, y: spawn.y, z: Math.floor(spawn.z) + oz + 0.5 };
    await A.place(spot, 'pickaxe');
    await sleep(120);
    for (const dy of [1, 2, 3]) {
      await A.send({ type: 'useTool', tool: 'pickaxe', target: { x: Math.floor(spot.x), y: Math.floor(spot.y) - dy, z: Math.floor(spot.z) } });
      await sleep(430);
      const r = A.messages.filter((m) => m.type === 'resourcesUpdated').pop();
      if (r) depositable = r.depositable;
      if (depositable >= 2) break outer;
    }
  }
  check('pickaxe harvest yields depositable blocks', depositable >= 1, `depositable=${depositable}`);

  const workshopPos = init.workshops?.blue?.position;
  await A.place(workshopPos, 'rifle');
  await sleep(150);
  A.messages.length = 0;
  await A.send({ type: 'depositWorkshop', team: 'blue' });
  const stockMsg = await A.waitFor('workshopsUpdated', 2500);
  check('depositing feeds workshop stock', !!stockMsg && stockMsg.workshops.blue.stock > 0,
    stockMsg ? `stock=${stockMsg.workshops.blue.stock}` : 'no workshopsUpdated');

  A.messages.length = 0;
  await A.send({ type: 'buildJeep' });
  await A.waitFor('jeepsUpdated', 2500);
  const jeepMsg = A.messages.find((m) => m.type === 'jeepMessage');
  const jeep = A.last('jeepsUpdated')?.jeeps?.find((j) => j.team === 'blue');
  check('building a jeep produces a vehicle', !!jeep,
    jeep ? jeep.id : jeepMsg ? `rejected: ${jeepMsg.message}` : A.types());

  // ---------- enter, drive, exit ----------
  let entered = null;
  for (let attempt = 0; attempt < 5 && jeep; attempt++) {
    const live = A.last('jeepsUpdated')?.jeeps?.find((j) => j.id === jeep.id) ?? jeep;
    // Stand just outside the jeep footprint (the server discards a position that
    // lands inside a vehicle) but inside the 4m enter reach.
    await A.place({ x: live.position.x, y: live.position.y, z: live.position.z + 3.2 }, 'rifle');
    await A.send({ type: 'enterJeep', vehicleId: jeep.id });
    entered = await A.waitFor('jeepsUpdated', 700,
      (m) => m.jeeps.some((j) => j.id === jeep.id && j.driverId === A.playerId));
    if (entered) break;
    await sleep(150);
  }
  check('entering the jeep makes the client the driver', !!entered,
    entered ? '' : A.last('jeepMessage')?.message ?? `saw: ${A.types()}`);

  if (entered) {
    const startPos = A.last('jeepsUpdated').jeeps.find((j) => j.id === jeep.id).position;
    A.messages.length = 0;
    for (let i = 0; i < 8; i++) {
      await A.send({ type: 'driveJeep', throttle: 1, steering: 0, brake: false });
      await sleep(150);
    }
    const drove = A.waitFor('jeepsUpdated', 1200,
      (m) => m.jeeps.some((j) => j.id === jeep.id && Math.hypot(j.position.x - startPos.x, j.position.z - startPos.z) > 0.5));
    check('driving moves the jeep', !!(await drove), 'throttle held ~1.2s');

    A.messages.length = 0;
    await A.send({ type: 'exitJeep' });
    const exited = await A.waitAny(['jeepExited', 'jeepsUpdated'], 2000);
    check('exiting the jeep is handled', !!exited, exited ? exited.type : 'no response');
  }

  // ---------- CTF: pick the red flag up at its base, capture at ours ----------
  let picked = null;
  let captured = null;
  for (let attempt = 0; attempt < 3 && !captured; attempt++) {
    A.messages.length = 0;
    await A.place({ x: 0.5, y: spawn.y, z: 160.5 }, 'rifle');
    await sleep(120);
    await A.send({ type: 'pickupFlag' });
    picked = await A.waitFor('flagPickedUp', 1500, (m) => m.playerId === A.playerId);
    if (!picked) { await sleep(800); continue; }
    await A.place({ x: 0.5, y: spawn.y, z: -160.5 }, 'rifle');
    await sleep(80);
    await A.send({ type: 'captureFlag', team: 'red' });
    captured = await A.waitFor('flagCaptured', 2000, (m) => m.playerId === A.playerId);
    if (!captured) await sleep(2500);
  }
  check('enemy flag can be picked up', !!picked, picked ? `flag=${picked.flagTeam}` : A.types());
  check('carried flag captures at base and scores', !!captured,
    captured ? `blue captures=${captured.captures.blue}` : A.types());
} catch (err) {
  if (!err?.done) check('probe crashed', false, err?.message ?? String(err));
} finally {
  A.close();
  observer.close();
}

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[PHASE=${PHASE}] ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
