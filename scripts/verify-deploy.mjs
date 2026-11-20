#!/usr/bin/env node
// One-shot check for a deployed Voxel FPS CTF origin.
//
//   node verify-deploy.mjs https://your-app.onrender.com
//
// Verifies: (1) the client page loads, (2) /api/status reports an online
// authoritative server with the live roster (players per team plus the human/bot
// split) and the round snapshot including the tiebreak counters (touches /
// returns), and (3) the WebSocket handshake completes and the server sends its
// `init` frame (with the same round snapshot) plus answers a ping. While still
// joined it re-fetches /api/status to prove the roster counts the human (1 human,
// 19 bots, still 20 total) rather than just the idle bot fill.
//
// Uses the `ws` package out of the repo so it runs with no extra install.
import WebSocket from 'ws';

const base = (process.argv[2] || process.env.TARGET || '').trim().replace(/\/+$/, '');
if (!base) {
  console.error('usage: node verify-deploy.mjs https://your-app.onrender.com');
  process.exit(2);
}

const WARMUP_MS = Number(process.env.WARMUP_MS) || 120000; // free tier can take ~1 min to wake
// render.yaml sets SERVER_BOT_COUNT=10, and a human replaces a bot on their own
// team, so a healthy roster stays 10v10 = 20 whatever the human count is.
const BOTS_PER_TEAM = Number(process.env.EXPECTED_BOTS_PER_TEAM) || 10;
const EXPECTED_ROSTER = BOTS_PER_TEAM * 2;
// Team this checker joins as; must match the team `init` reports so the roster
// assertion below is unambiguous.
const CHECK_TEAM = 'blue';
const results = [];
let failures = 0;

function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  failures++;
  results.push({ ok: false, name, detail });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function isPair(value) {
  return (
    value && typeof value === 'object' &&
    Number.isFinite(value.red) && Number.isFinite(value.blue)
  );
}

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    redirect: 'follow',
    headers: { 'user-agent': 'voxel-deploy-check/1.0', accept: '*/*' },
    signal: AbortSignal.timeout(WARMUP_MS),
  });
  const body = await res.text();
  return { res, body };
}

// ---------------------------------------------------------------- 1. the page
console.log(`\nTarget: ${base}\n`);
console.log('[1/3] page loads');
let page = null;
try {
  page = await get('/');
  const { res, body } = page;
  pass('GET / responds', `HTTP ${res.status} (${(body.length / 1024).toFixed(1)} KiB)`);

  const type = res.headers.get('content-type') || '';
  if (res.ok && /text\/html/i.test(type)) pass('served as HTML', type.split(';')[0]);
  else fail('served as HTML', `status ${res.status}, content-type "${type}"`);

  const hasRoot = /id="root"/.test(body) || /<div id=["']root["']/.test(body);
  if (hasRoot) pass('client mount point present', '<div id="root">');
  else fail('client mount point present', 'index.html has no #root div');

  const bundle = body.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (bundle) pass('bundle referenced', bundle[0]);
  else fail('bundle referenced', 'no /assets/index-*.js in HTML');
} catch (error) {
  fail('GET / responds', error?.message || String(error));
}

// ------------------------------------------------------------ 2. /api/status
console.log('\n[2/3] /api/status');
// Snapshot of the roster before we join, so the post-join assertions below
// compare deltas. Other humans may already be playing on a live server.
let baselineRoster = null;
try {
  const { res, body } = await get('/api/status');
  pass('GET /api/status responds', `HTTP ${res.status}`);
  let status = null;
  try {
    status = JSON.parse(body);
  } catch {
    fail('/api/status is JSON', `body starts: ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
  }

  if (status) {
    if (status.status === 'online') pass('server reports online');
    else fail('server reports online', `status="${status.status}"`);

    if (status.tickRate === 20) pass('tickRate 20 Hz');
    else fail('tickRate 20 Hz', `tickRate=${status.tickRate}`);

    if (Number.isFinite(status.connectedPlayers)) pass('player count exposed', `${status.connectedPlayers} connected`);
    else fail('player count exposed', `connectedPlayers=${status.connectedPlayers}`);

    // The roster is the full head-count (bots included); connectedPlayers is
    // just open sockets, so a healthy bot match would report 0 there.
    const roster = status.roster;
    const rosterOk =
      roster && typeof roster === 'object' &&
      Number.isFinite(roster.red) && Number.isFinite(roster.blue) &&
      Number.isFinite(roster.total) &&
      Number.isFinite(roster.humans) && Number.isFinite(roster.bots);
    if (rosterOk) {
      baselineRoster = { ...roster };
      pass('roster exposed', `red ${roster.red} / blue ${roster.blue}, total ${roster.total} (${roster.humans} human, ${roster.bots} bots)`);

      if (roster.red + roster.blue === roster.total) pass('roster total matches team counts', `${roster.red} + ${roster.blue} = ${roster.total}`);
      else fail('roster total matches team counts', `red ${roster.red} + blue ${roster.blue} != total ${roster.total}`);

      if (roster.humans + roster.bots === roster.total) pass('roster human/bot split adds up', `${roster.humans} + ${roster.bots} = ${roster.total}`);
      else fail('roster human/bot split adds up', `humans ${roster.humans} + bots ${roster.bots} != total ${roster.total}`);

      if (roster.total === EXPECTED_ROSTER) pass('bot roster is 10v10', `${roster.total} combatants (expected ${EXPECTED_ROSTER})`);
      else fail('bot roster is 10v10', `total ${roster.total} (expected ${EXPECTED_ROSTER}; SERVER_BOT_COUNT not applied?)`);

      if (roster.red === BOTS_PER_TEAM && roster.blue === BOTS_PER_TEAM) pass('roster balanced per team', `red ${roster.red} / blue ${roster.blue}`);
      else fail('roster balanced per team', `red ${roster.red} / blue ${roster.blue} (expected ${BOTS_PER_TEAM} each)`);
    } else {
      fail('roster exposed', `no usable "roster" field in /api/status: ${JSON.stringify(roster)}`);
    }

    const round = status.round;
    if (!round || typeof round !== 'object') {
      fail('round snapshot present', 'no "round" field in /api/status');
    } else {
      pass('round snapshot present', `round ${round.round}, phase "${round.phase}", ${Math.round(round.timeLeft)}s left of ${round.duration}s`);

      if (round.phase === 'live' || round.phase === 'intermission') pass('round phase valid', round.phase);
      else fail('round phase valid', `phase="${round.phase}"`);

      if (round.duration === 1800) pass('ROUND_MINUTES=30 applied', 'duration 1800s');
      else fail('ROUND_MINUTES=30 applied', `duration=${round.duration}s (expected 1800)`);

      if (isPair(round.captures)) pass('captures counter', `red ${round.captures.red} / blue ${round.captures.blue}`);
      else fail('captures counter', JSON.stringify(round.captures));

      if (isPair(round.touches)) pass('TIEBREAK touches counter', `red ${round.touches.red} / blue ${round.touches.blue}`);
      else fail('TIEBREAK touches counter', JSON.stringify(round.touches));

      if (isPair(round.returns)) pass('TIEBREAK returns counter', `red ${round.returns.red} / blue ${round.returns.blue}`);
      else fail('TIEBREAK returns counter', JSON.stringify(round.returns));

      if (isPair(round.wins)) pass('wins counter', `red ${round.wins.red} / blue ${round.wins.blue}`);
      else fail('wins counter', JSON.stringify(round.wins));
    }
  }
} catch (error) {
  fail('GET /api/status responds', error?.message || String(error));
}

// -------------------------------------------------------------- 3. WebSocket
console.log('\n[3/3] WebSocket');
const wsUrl = base.replace(/^http/i, 'ws');
console.log(`      connecting to ${wsUrl} (this retires one bot while connected)`);
try {
  let joinedSocket = null;
  const outcome = await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: 60000 });
    joinedSocket = socket;
    const seen = { init: null, joined: null, pong: null };
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch { /* already closed */ }
      resolve({ error: `no init/joined/pong frames within 60s (socket state ${socket.readyState})` });
    }, 60000);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'ping', t: 12345 }));
    });

    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'init') {
        seen.init = msg;
        // Mirror what the real client does on init (networkClient.adoptSession):
        // without a `join` the server counts us as a socket but never puts us on
        // a team, and it is the join that retires a same-team bot.
        socket.send(JSON.stringify({ type: 'join', team: CHECK_TEAM, name: 'deploy-check' }));
      }
      if (msg.type === 'joined') seen.joined = msg;
      if (msg.type === 'pong') seen.pong = msg;
      if (seen.init && seen.joined && seen.pong) {
        clearTimeout(timer);
        // Leave the socket open: the roster re-check below needs this player to
        // still be in the match for /api/status to report it.
        resolve({ seen });
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error?.message || String(error) });
    });

    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ error: `handshake rejected with HTTP ${res.statusCode}` });
    });
  });

  if (outcome.error) {
    fail('WebSocket handshake', outcome.error);
  } else {
    const { init, joined, pong } = outcome.seen;
    pass('WebSocket handshake', wsUrl.startsWith('wss://') ? 'wss:// upgrade accepted' : 'ws:// upgrade accepted');
    if (typeof init.playerId === 'string' && init.playerId) pass('init frame received', `playerId ${init.playerId}`);
    else fail('init frame received', 'init has no playerId');

    const state = init.state || {};
    if (Number.isFinite(state.hp)) pass('player spawned with state', `hp ${state.hp}, team ${state.team}, equipment ${state.equipment}`);
    else fail('player spawned with state', JSON.stringify(state).slice(0, 120));

    if (joined && joined.state) pass('join acknowledged', `joined team ${joined.state.team}`);
    else fail('join acknowledged', JSON.stringify(joined).slice(0, 120));

    const roster = Array.isArray(init.players) ? init.players.length : -1;
    if (roster >= 10) pass('bot roster present', `${roster} other combatants (10v10 minus you, plus bots)`);
    else fail('bot roster present', `init.players length ${roster} (SERVER_BOT_COUNT not applied?)`);

    if (init.round && isPair(init.round.touches) && isPair(init.round.returns)) {
      pass('init carries round + tiebreak counters', `touches red ${init.round.touches.red}/blue ${init.round.touches.blue}, returns red ${init.round.returns.red}/blue ${init.round.returns.blue}`);
    } else {
      fail('init carries round + tiebreak counters', JSON.stringify(init.round));
    }

    if (pong && pong.t === 12345) pass('ping/pong round trip', 'echoed t=12345');
    else fail('ping/pong round trip', JSON.stringify(pong));

    // Joining retires a bot on the same team, so a correct roster keeps 20
    // combatants while the split flips from 0/20 to 1/19 humans/bots.
    try {
      const { res, body } = await get('/api/status');
      let live = null;
      try {
        live = JSON.parse(body);
      } catch {
        fail('roster refetched while joined', `HTTP ${res.status}, body starts: ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
      }

      const joinedRoster = live && live.roster;
      const joinedOk =
        joinedRoster && typeof joinedRoster === 'object' &&
        Number.isFinite(joinedRoster.red) && Number.isFinite(joinedRoster.blue) &&
        Number.isFinite(joinedRoster.total) &&
        Number.isFinite(joinedRoster.humans) && Number.isFinite(joinedRoster.bots);

      if (!joinedOk) {
        fail('roster refetched while joined', `no usable roster after join: ${JSON.stringify(joinedRoster)}`);
      } else {
        // Compare with the pre-join snapshot when we have one; the absolute
        // expectation (1 human, 19 bots of 20) only holds on an empty server.
        const base = baselineRoster;
        const expectHumans = base ? base.humans + 1 : 1;
        const expectBots = base ? base.bots - 1 : EXPECTED_ROSTER - 1;
        const expectTotal = base ? base.total : EXPECTED_ROSTER;
        const expectRed = base ? base.red : BOTS_PER_TEAM;
        const expectBlue = base ? base.blue : BOTS_PER_TEAM;
        pass('roster refetched while joined', `red ${joinedRoster.red} / blue ${joinedRoster.blue}, total ${joinedRoster.total} (${joinedRoster.humans} human, ${joinedRoster.bots} bots)${base ? `, baseline ${base.humans} human / ${base.bots} bots` : ''}`);

        if (joinedRoster.humans === expectHumans) pass('joined human counted in roster', `humans ${joinedRoster.humans} (expected ${expectHumans})`);
        else fail('joined human counted in roster', `humans ${joinedRoster.humans} (expected ${expectHumans})`);

        if (joinedRoster.bots === expectBots) pass('human replaced one bot', `bots ${joinedRoster.bots} (expected ${expectBots})`);
        else fail('human replaced one bot', `bots ${joinedRoster.bots} (expected ${expectBots})`);

        if (joinedRoster.total === expectTotal) pass('roster total unchanged on join', `${joinedRoster.total} combatants (expected ${expectTotal})`);
        else fail('roster total unchanged on join', `total ${joinedRoster.total} (expected ${expectTotal})`);

        if (joinedRoster.red === expectRed && joinedRoster.blue === expectBlue) pass('roster still balanced after join', `red ${joinedRoster.red} / blue ${joinedRoster.blue} (expected ${expectRed}/${expectBlue})`);
        else fail('roster still balanced after join', `red ${joinedRoster.red} / blue ${joinedRoster.blue} (expected ${expectRed}/${expectBlue})`);
      }
    } catch (error) {
      fail('roster refetched while joined', error?.message || String(error));
    }
  }

  if (joinedSocket) {
    try { joinedSocket.close(1000, 'check done'); } catch { /* already closed */ }
  }
} catch (error) {
  fail('WebSocket handshake', error?.message || String(error));
}

// ------------------------------------------------------------------ summary
const total = results.length;
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'} — ${total - failures}/${total} passed\n`);
process.exit(failures === 0 ? 0 : 1);
