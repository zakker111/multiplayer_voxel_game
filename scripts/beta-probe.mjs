// One-off Beta end-to-end probe over the wire protocol the browser uses.
// PHASE=core : connection, bots, join, movement, dig, build, shooting, reload,
//              ping, spectator, respawn, second client  (safe with bots on)
// PHASE=move : server movement validation — teleport refused, speed hack
//              throttled, ordinary movement accepted (validation ON)
// PHASE=limits: websocket socket cap + per-socket message flood throttle. Run
//              that server with WS_MAX_PER_IP=2 WS_MSG_RATE=20 WS_MSG_BURST=30.
// PHASE=guard : banned IPs are refused before the handshake (403) and the SSE
//              per-IP cap rejects the extra stream. Needs a server with
//              TRUST_PROXY=1 ADMIN_TOKEN=<token>, and the same ADMIN_TOKEN here.
//              The SSE check reads SSE_MAX_PER_IP from this environment, so pass
//              it whenever the server overrides it (it must be at least 2: the
//              probe's own clients share one address).
// PHASE=structures: craft, place, man and fire a cannon, watch the shell reach
//              another client, then wreck the gun with rifle fire. Needs a
//              botless server with MOVE_VALIDATION=off (it teleports).
// PHASE=support: craft and place a supply crate, fill it with mined blocks and
//              draw them back out. Needs a botless server with
//              MOVE_VALIDATION=off (it teleports).
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
  const botless = PHASE === 'all' || PHASE === 'structures' || PHASE === 'support';
  const expectedBots = botless ? 0 : 20;
  // Bots refill on a timer, so a server that recently had a human can be one
  // bot short of the target for a few seconds.
  const botsOk = botless ? bots.length === 0 : bots.length >= 18 && bots.length <= 20;
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
  if (PHASE === 'guard') {
    // Needs a server started with TRUST_PROXY=1 and ADMIN_TOKEN=<token>; the
    // probe reads the same token from its own environment. Spoofed client
    // addresses stand in for "some other player".
    const wsUrl = BASE.replace(/^http/, 'ws');
    const admin = process.env.ADMIN_TOKEN;
    const bannedIp = '203.0.113.77';
    const sseIp = '203.0.113.78';
    if (!admin) {
      console.log('[PHASE=guard] needs ADMIN_TOKEN on the server and in this environment — skipped');
    } else {
      const adminCall = (path, body) =>
        fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
          body: JSON.stringify(body),
        });
      const attempt = (ip) => new Promise((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { 'x-forwarded-for': ip } });
        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          try { ws.terminate(); } catch { /* already gone */ }
          resolve(result);
        };
        ws.on('open', () => done({ handshake: true }));
        ws.on('unexpected-response', (_req, res) => done({ handshake: false, status: res.statusCode }));
        ws.on('error', (err) => done({ handshake: false, status: `error: ${err.message}` }));
        setTimeout(() => done({ handshake: false, status: 'timeout' }), 4000);
      });

      await adminCall('/api/admin/ban', { kind: 'ip', value: bannedIp });
      const banned = await attempt(bannedIp);
      check('a banned IP is refused before the handshake', banned.handshake === false && banned.status === 403, String(banned.status));

      const other = await attempt('203.0.113.79');
      check('unrelated clients still complete the handshake', other.handshake === true, String(other.status ?? 'open'));

      await adminCall('/api/admin/unban', { kind: 'ip', value: bannedIp });
      const unbanned = await attempt(bannedIp);
      check('unbanning lets the same address back in', unbanned.handshake === true, String(unbanned.status ?? 'open'));

      // The SSE fallback must not be a way around a ban either.
      await adminCall('/api/admin/ban', { kind: 'ip', value: bannedIp });
      const bannedSse = await fetch(`${BASE}/api/game/events`, {
        headers: { Accept: 'text/event-stream', 'x-forwarded-for': bannedIp },
      });
      check('a banned IP is refused by the SSE fallback', bannedSse.status === 403, String(bannedSse.status));
      await adminCall('/api/admin/unban', { kind: 'ip', value: bannedIp });

      // SSE fallback cap: open exactly SSE_MAX_PER_IP streams from one address,
      // then expect the next one to be refused. The probe reads the cap from its
      // own environment (default 16, the server default).
      const sseCap = Number(process.env.SSE_MAX_PER_IP || 16);
      const openSse = async (ip) => {
        const abort = new AbortController();
        const res = await fetch(`${BASE}/api/game/events`, {
          headers: { Accept: 'text/event-stream', 'x-forwarded-for': ip },
          signal: abort.signal,
        });
        return { status: res.status, close: () => abort.abort() };
      };
      const streams = [];
      for (let i = 0; i < sseCap; i++) streams.push(await openSse(sseIp));
      const over = await openSse(sseIp);
      const opened = streams.filter((s) => s.status === 200).length;
      check('the SSE per-IP cap refuses the extra stream', opened === sseCap && over.status === 503, `${opened}/${sseCap} open, extra ${over.status}`);

      over.close();
      streams[0]?.close();
      let freed = { status: 0 };
      for (let i = 0; i < 20 && freed.status !== 200; i++) {
        await sleep(100);
        freed = await openSse(sseIp);
      }
      check('closing an SSE stream frees its slot', freed.status === 200, String(freed.status));
      freed.close();
      for (const s of streams.slice(1)) s.close();
    }
  }

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
  // The spawn can sit on a lip with air beneath it, so sweep a few columns.
  for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 2], [-2, -2]]) {
    for (const dy of [1, 2, 3, 4]) {
      const target = { x: Math.floor(pos.x) + ox, y: Math.floor(pos.y) - dy, z: Math.floor(pos.z) + oz };
      A.messages.length = 0;
      await A.send({ type: 'useTool', tool: 'spade', target });
      // Attribute the change to our own coordinate: bots dig too and broadcast.
      dug = await A.waitFor('voxelChanged', 700,
        (m) => m.change.x === target.x && m.change.y === target.y && m.change.z === target.z);
      if (dug) break;
    }
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

  // ---------- player-built emplacements: craft, place, man, fire, wreck ----------
  if (PHASE === 'structures') {
    const shop = init.workshops.blue.position;
    // Stock starts at 50 and a cannon costs 90, so dig and deposit first.
    let stock = init.workshops.blue.stock;
    // A voxel is worth one block, so mining a cannon's cost takes a few trips.
    const seams = [];
    for (const r of [8, 12, 16, 20]) {
      for (const [ox, oz] of [[0, r], [r, 0], [0, -r], [-r, 0], [r, r], [-r, r], [r, -r], [-r, -r]]) seams.push([ox, oz]);
    }
    for (let seam = 0; seam < seams.length && stock < 90; seam++) {
      const [ox, oz] = seams[seam];
      await A.place({ x: shop.x + ox + 0.5, y: shop.y, z: shop.z + oz + 0.5 }, 'pickaxe');
      await sleep(180);
      for (const dy of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await A.send({
          type: 'useTool', tool: 'pickaxe',
          target: { x: Math.floor(shop.x + ox), y: Math.floor(shop.y) - dy, z: Math.floor(shop.z + oz) },
        });
        await sleep(520);
      }
      await A.place(shop, 'rifle');
      await sleep(180);
      await A.send({ type: 'depositWorkshop', team: 'blue' });
      const upd = await A.waitFor('workshopsUpdated', 2500, (m) => m.workshops.blue.stock > stock);
      if (upd) stock = upd.workshops.blue.stock;
      A.messages.length = 0;
    }
    check('the workshop can fund a cannon', stock >= 90, `stock=${stock}`);
    const bench = { x: shop.x - 3, y: shop.y, z: shop.z + 5 };
    await A.place(bench);
    await sleep(150);
    A.messages.length = 0;
    await A.send({ type: 'craftBlueprint', kind: 'cannon', slot: 0 });
    const crafted = await A.waitFor('blueprintsUpdated', 2000, (m) => m.blueprints?.[0] === 'cannon');
    check('crafting at the bench fills a blueprint slot', !!crafted,
      crafted ? JSON.stringify(crafted.blueprints) : `saw ${A.types()}`);

    let gun = null;
    let refusal = '';
    // Preview is a cheap 90 ms server-side check: scan for a pad the server
    // accepts, then place there. The map is only flat in bands, so sweep it.
    let pad = null;
    let scans = 0;
    outer:
    for (let z = -32; z <= 32; z += 4) {
      for (let x = -64; x <= 64; x += 4) {
        if (Math.abs(x) < 16 || scans >= 220) continue;
        scans++;
        A.messages.length = 0;
        await A.send({ type: 'previewEmplacement', kind: 'cannon', position: { x, y: shop.y, z }, yaw: 0, slot: 0 });
        await sleep(105);
        const good = A.last('emplacementPreview');
        if (good?.ok && good.position) { pad = good.position; break outer; }
        if (good && !good.ok) refusal = good.reason ?? refusal;
      }
    }
    if (pad) {
      A.messages.length = 0;
      await A.send({ type: 'placeEmplacement', kind: 'cannon', position: pad, yaw: 0, slot: 0 });
      const upd = await A.waitFor('emplacementsUpdated', 1500,
        (m) => (m.emplacements ?? []).some((e) => e.kind === 'cannon'));
      gun = upd?.emplacements?.find((e) => e.kind === 'cannon') ?? null;
    }
    check('a crafted cannon can be placed', !!gun,
      gun ? `at ${gun.position.x},${gun.position.z} hp=${gun.hp}`
        : `no accepted spot after ${scans} previews (${refusal || 'silent'})`);

    if (gun) {
      // Climb in from beside the gun; manning needs to be within reach.
      await A.place({ x: gun.position.x + 1.5, y: gun.position.y, z: gun.position.z }, 'rifle');
      await sleep(150);
      await A.send({ type: 'mountEmplacement', emplacementId: gun.id });
      const mounted = await A.waitFor('emplacementMounted', 2000, (m) => m.emplacementId === gun.id);
      check('the cannon can be manned with F', !!mounted, mounted ? '' : `saw ${A.types()}`);

      observer.messages.length = 0;
      await A.send({ type: 'fireEmplacement' });
      const fired = await observer.waitFor('shellFired', 3000, (m) => m.kind === 'cannon');
      check('firing the cannon sends a shell to other clients', !!fired,
        fired ? `v=(${fired.velocity.x.toFixed(1)},${fired.velocity.y.toFixed(1)},${fired.velocity.z.toFixed(1)})`
          : `observer saw ${observer.types()}`);
      const impact = fired ? await observer.waitFor('shellImpact', 6000, (m) => m.id === fired.id) : null;
      check('the shell lands and reports its impact', !!impact,
        impact ? `radius=${impact.radius}` : 'no shellImpact');

      // An enemy rifleman tears the gun down.
      const R = new Client('R');
      await R.connect();
      const initR = await R.waitFor('init', 6000);
      R.token = initR?.sessionToken;
      R.playerId = initR?.playerId;
      await R.send({ type: 'join', team: 'red', name: 'Probe_R' });
      await R.waitFor('joined', 4000);
      const muzzle = { x: gun.position.x, y: gun.position.y, z: gun.position.z + 3 };
      await R.place(muzzle);
      await sleep(150);
      const origin = { x: muzzle.x, y: gun.position.y + 1.6, z: muzzle.z };
      const dx = gun.position.x - origin.x;
      const dy = gun.position.y + 0.8 - origin.y;
      const dz = gun.position.z - origin.z;
      const len = Math.hypot(dx, dy, dz);
      const aim = { x: dx / len, y: dy / len, z: dz / len };
      let damaged = false;
      let gone = false;
      const startHp = gun.hp;
      R.messages.length = 0;
      for (let shot = 0; shot < 30 && !gone; shot++) {
        await R.send({ type: 'shoot', origin, direction: aim });
        await sleep(140);
        const upd = R.last('emplacementsUpdated');
        const live = upd?.emplacements?.find((e) => e.id === gun.id);
        if (upd) {
          if (!live) gone = true;
          else if (live.hp < startHp) damaged = true;
        }
      }
      check('rifle fire damages and eventually wrecks an enemy emplacement', damaged || gone,
        gone ? 'destroyed' : damaged ? 'damaged but standing' : 'no damage seen');
      check('a wrecked cannon leaves the map', gone, gone ? '' : `hp ${startHp} -> ${R.last('emplacementsUpdated')?.emplacements?.find((e) => e.id === gun.id)?.hp}`);
    }
  }

  // ---------- forward supply crate: craft, place, fill, draw ----------
  if (PHASE === 'support') {
    const shop = init.workshops.blue.position;
    check('the workshop can fund a supply crate', init.workshops.blue.stock >= 20,
      `stock=${init.workshops.blue.stock}`);

    const bench = { x: shop.x - 3, y: shop.y, z: shop.z + 5 };
    await A.place(bench);
    await sleep(150);
    A.messages.length = 0;
    await A.send({ type: 'craftBlueprint', kind: 'supplyCrate', slot: 0 });
    const crafted = await A.waitFor('blueprintsUpdated', 2000, (m) => m.blueprints?.[0] === 'supplyCrate');
    check('crafting a crate fills a blueprint slot', !!crafted, crafted ? '' : `saw ${A.types()}`);

    let crate = null;
    let scans = 0;
    let refusal = '';
    outerCrate:
    for (let z = -32; z <= 32; z += 4) {
      for (let x = -64; x <= 64; x += 4) {
        if (Math.abs(x) < 16 || scans >= 160) continue;
        scans++;
        A.messages.length = 0;
        await A.send({ type: 'previewEmplacement', kind: 'supplyCrate', position: { x, y: shop.y, z }, yaw: 0, slot: 0 });
        await sleep(105);
        const good = A.last('emplacementPreview');
        if (good?.ok && good.position) {
          A.messages.length = 0;
          await A.send({ type: 'placeEmplacement', kind: 'supplyCrate', position: good.position, yaw: 0, slot: 0 });
          const upd = await A.waitFor('emplacementsUpdated', 1500,
            (m) => (m.emplacements ?? []).some((e) => e.kind === 'supplyCrate'));
          crate = upd?.emplacements?.find((e) => e.kind === 'supplyCrate') ?? null;
          break outerCrate;
        }
        if (good && !good.ok) refusal = good.reason ?? refusal;
      }
    }
    check('a crafted supply crate can be placed', !!crate,
      crate ? `at ${crate.position.x},${crate.position.z}`
        : `no accepted spot after ${scans} previews (${refusal || 'silent'})`);

    if (crate) {
      // Mine a few blocks; the pickaxe is the only thing that yields supply.
      let depositable = 0;
      outerMine:
      for (const [ox, oz] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) {
        const spot = { x: Math.floor(shop.x) + ox + 0.5, y: shop.y, z: Math.floor(shop.z) + oz + 0.5 };
        await A.place(spot, 'pickaxe');
        await sleep(120);
        for (const dy of [1, 2, 3]) {
          A.messages.length = 0;
          await A.send({ type: 'useTool', tool: 'pickaxe', target: { x: Math.floor(spot.x), y: Math.floor(spot.y) - dy, z: Math.floor(spot.z) } });
          await sleep(520);
          const res = A.last('resourcesUpdated');
          if (res) depositable = res.depositable;
          if (depositable >= 2) break outerMine;
        }
      }
      check('the player carries mined blocks', depositable >= 2, `carried=${depositable}`);

      await A.place({ x: crate.position.x + 1.5, y: crate.position.y, z: crate.position.z }, 'rifle');
      await sleep(150);
      A.messages.length = 0;
      await A.send({ type: 'useSupplyCrate', emplacementId: crate.id, action: 'deposit' });
      const filled = await A.waitFor('emplacementsUpdated', 2000,
        (m) => (m.emplacements ?? []).some((e) => e.id === crate.id && e.stock > 0));
      const stock = filled?.emplacements?.find((e) => e.id === crate.id)?.stock ?? 0;
      check('depositing mined blocks fills the crate', stock >= 2, `stock=${stock}`);
      check('depositing empties the carried blocks',
        A.last('resourcesUpdated')?.depositable === 0,
        `depositable=${A.last('resourcesUpdated')?.depositable}`);

      A.messages.length = 0;
      await A.send({ type: 'useSupplyCrate', emplacementId: crate.id, action: 'draw' });
      const drawn = await A.waitFor('emplacementsUpdated', 2000,
        (m) => (m.emplacements ?? []).some((e) => e.id === crate.id && e.stock < stock));
      const left = drawn?.emplacements?.find((e) => e.id === crate.id)?.stock ?? stock;
      check('teammates can draw blocks back out', left < stock, `stock ${stock} -> ${left}`);
      check('a draw refills build inventory', !!A.last('inventoryUpdated'),
        A.last('inventoryUpdated') ? `inventory=${A.last('inventoryUpdated').inventory}` : 'no inventoryUpdated');
    }
  }

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
