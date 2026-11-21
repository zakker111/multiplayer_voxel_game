#!/usr/bin/env node
// One-shot check for the deployed Voxel FPS CTF origins.
//
//   node verify-deploy.mjs                 # the whole deployment: Pages + Render + Beta link
//   node verify-deploy.mjs --all           # same, spelled out
//   node verify-deploy.mjs https://your-app.onrender.com          # one origin, full server
//   node verify-deploy.mjs https://you.github.io/repo --static    # one origin, no game server
//
// The default run (and `--all`) checks, in order:
//   1. GitHub Pages — static client: page, mount point, bundle freshness.
//   2. Render — the authoritative server: page, bundle freshness, every
//      /api/status field, then a real WebSocket join that proves the roster
//      counted the human and retired a bot.
//   3. The authoritative Beta URL (`?mode=beta&server=wss://…&team=blue`) — that
//      it names an explicit server (without `server=` Beta silently runs offline
//      against the local client), that its page serves the current bundle, and
//      that the named wss:// origin completes a handshake, init, join and ping.
// Override the hosts with PAGES_URL / RENDER_URL / BETA_URL, or hand a single
// origin as an argument (that mode behaves like the original single-target run).
//
// Freshness: a host is stale when its HTML names a different bundle than the
// current build. The expected name comes from EXPECTED_BUNDLE when set
// (e.g. `assets/index-DlPGlxu-.js`), otherwise from the local production build
// read out of `dist/index.html` — so run `npm run build` first (or point
// DIST_DIR at a build directory). A same-named bundle is also compared byte for
// byte against the local file. With neither source the run reports
// "freshness not verified" instead of silently passing, and every diverging
// host is listed as STALE in the summary with a non-zero exit.
//
// Uses the `ws` package out of the repo so it runs with no extra install.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

// The public deployment this project ships (see DEPLOYMENT.md / render.yaml).
const DEFAULTS = {
  pages: 'https://zakker111.github.io/multiplayer_voxel_game/',
  render: 'https://multiplayer-voxel-game.onrender.com',
};
// `server=` is what makes the link authoritative; `?mode=beta` alone runs Beta
// against the local client, so the default link spells the socket origin out.
const DEFAULT_BETA = `${DEFAULTS.render}/?mode=beta&server=wss%3A%2F%2Fmultiplayer-voxel-game.onrender.com&team=blue`;

const cli = process.argv.slice(2);
const STATIC_ONLY = cli.includes('--static');
const CHECK_ALL = cli.includes('--all');
const positional = cli.filter((arg) => !arg.startsWith('-'));

const WARMUP_MS = Number(process.env.WARMUP_MS) || 120000; // free tier can take ~1 min to wake
// render.yaml sets SERVER_BOT_COUNT=10, and a human replaces a bot on their own
// team, so a healthy roster stays 10v10 = 20 whatever the human count is.
const BOTS_PER_TEAM = Number(process.env.EXPECTED_BOTS_PER_TEAM) || 10;
const EXPECTED_ROSTER = BOTS_PER_TEAM * 2;
// Team this checker joins as; must match the team `init` reports so the roster
// assertion below is unambiguous.
const CHECK_TEAM = 'blue';
// Where a local production build lives; only used to judge bundle freshness.
const DIST_DIR = process.env.DIST_DIR || 'dist';

const results = [];
const targets = [];
let failures = 0;
let skipped = 0;

function heading(title) {
  console.log(`\n=== ${title} ===`);
}
function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  failures++;
  results.push({ ok: false, name, detail });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
// A check that could not run at all (no build to compare against, not a bug in
// the deployment). It never fails the run, but the summary says so instead of
// claiming a pass.
function skip(name, detail = '') {
  skipped++;
  results.push({ ok: true, skipped: true, name, detail });
  console.log(`  SKIP  ${name}${detail ? ` — ${detail}` : ''}`);
}
function isPair(value) {
  return (
    value && typeof value === 'object' &&
    Number.isFinite(value.red) && Number.isFinite(value.blue)
  );
}

function normalize(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

async function get(url, pathname = '') {
  const res = await fetch(`${url}${pathname}`, {
    redirect: 'follow',
    headers: { 'user-agent': 'voxel-deploy-check/1.0', accept: '*/*' },
    signal: AbortSignal.timeout(WARMUP_MS),
  });
  const body = await res.text();
  return { res, body };
}

// The bundle name this repo currently builds. `assets/index-<hash>.js` is what
// Vite emits into index.html; the hash changes with any client change, so a
// different name on the host means the deploy predates the current build.
async function expectedBundle() {
  const explicit = (process.env.EXPECTED_BUNDLE || '').trim().replace(/^\.?\//, '');
  if (explicit) {
    const at = explicit.indexOf('assets/');
    const name = at === -1 ? `assets/${explicit}` : explicit.slice(at);
    return { name, source: 'EXPECTED_BUNDLE' };
  }
  try {
    const html = await readFile(path.join(DIST_DIR, 'index.html'), 'utf8');
    const name = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    if (name) return { name, source: `${DIST_DIR}/index.html` };
  } catch {
    // No local build: the caller reports the check as unverified.
  }
  return null;
}

// ---------------------------------------------------------------- page + bundle
// Returns the page HTML so the bundle section can read the referenced asset.
async function checkPage(target) {
  console.log('\npage loads');
  try {
    const { res, body } = await get(target, '/');
    pass('GET / responds', `HTTP ${res.status} (${(body.length / 1024).toFixed(1)} KiB)`);

    const type = res.headers.get('content-type') || '';
    if (res.ok && /text\/html/i.test(type)) pass('served as HTML', type.split(';')[0]);
    else fail('served as HTML', `status ${res.status}, content-type "${type}"`);

    const hasRoot = /id="root"/.test(body) || /<div id=['"]root['"]/.test(body);
    if (hasRoot) pass('client mount point present', '<div id="root">');
    else fail('client mount point present', 'index.html has no #root div');

    return body;
  } catch (error) {
    fail('GET / responds', error?.message || String(error));
    return null;
  }
}

// Resolves the host's bundle name, proves it downloads, and compares it with the
// current build (name, then sha256). Records the verdict for the summary table.
async function checkBundle(target, pageBody) {
  console.log('\nbundle freshness');
  const served = pageBody?.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
  const verdict = { target, served, expected: null, stale: null };
  targets.push(verdict);

  if (!served) {
    fail('page references a client bundle', 'no /assets/index-*.js in the HTML');
    verdict.stale = true;
    return verdict;
  }
  pass('page references a client bundle', served);

  let servedBytes = null;
  try {
    const res = await fetch(`${target}/${served}`, {
      redirect: 'follow',
      headers: { 'user-agent': 'voxel-deploy-check/1.0', accept: '*/*' },
      signal: AbortSignal.timeout(WARMUP_MS),
    });
    servedBytes = Buffer.from(await res.arrayBuffer());
    const size = `${(servedBytes.length / 1024).toFixed(1)} KiB`;
    if (res.ok && servedBytes.length > 0) pass('bundle downloads', `HTTP ${res.status}, ${size}`);
    else fail('bundle downloads', `HTTP ${res.status}, ${size}`);

    const type = res.headers.get('content-type') || '';
    if (res.ok && /javascript|ecmascript/i.test(type)) pass('served as JavaScript', type.split(';')[0]);
    else fail('served as JavaScript', `content-type "${type}"`);
  } catch (error) {
    fail('bundle downloads', error?.message || String(error));
  }

  const expected = await expectedBundle();
  if (!expected) {
    skip(
      'host serves the current build',
      `cannot tell: no ${DIST_DIR}/index.html and no EXPECTED_BUNDLE — run "npm run build" or set EXPECTED_BUNDLE`,
    );
  } else {
    verdict.expected = expected.name;
    verdict.stale = served !== expected.name;
    if (!verdict.stale) {
      pass('host serves the current build', `${served} (from ${expected.source})`);
    } else {
      fail(
        'host serves the current build',
        `STALE: serving ${served}, current build is ${expected.name} (from ${expected.source})`,
      );
    }

    // The hash is content-derived, so an up-to-date name must also match byte
    // for byte; this catches a rebuilt bundle published under an old name.
    if (servedBytes) {
      try {
        const local = await readFile(path.join(DIST_DIR, expected.name));
        const hash = (buf) => createHash('sha256').update(buf).digest('hex');
        const localHash = hash(local);
        const servedHash = hash(servedBytes);
        if (localHash === servedHash) {
          pass('bundle matches the local build', `${local.length} bytes, sha256 ${localHash.slice(0, 12)}…`);
        } else {
          verdict.stale = true;
          fail('bundle matches the local build', `served sha256 ${servedHash.slice(0, 12)}… vs local ${localHash.slice(0, 12)}…`);
        }
      } catch {
        // No local copy of that bundle: the name comparison above is the verdict.
      }
    }
  }

  return verdict;
}

// ------------------------------------------------------------------- backend
// Full authoritative-server check: every /api/status field, then a real
// WebSocket join that must flip the roster from bots to (bots - 1 + 1 human).
async function checkBackend(target) {
  console.log('\n/api/status');
  // Snapshot of the roster before we join, so the post-join assertions below
  // compare deltas. Other humans may already be playing on a live server.
  let baselineRoster = null;
  try {
    const { res, body } = await get(target, '/api/status');
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

  console.log('\nWebSocket');
  const wsUrl = target.replace(/^http/i, 'ws');
  console.log(`      connecting to ${wsUrl} (this retires one bot while connected)`);
  try {
    const outcome = await wsProbe(wsUrl, { team: CHECK_TEAM, name: 'deploy-check' });
    const socket = outcome.socket;

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
        const { res, body } = await get(target, '/api/status');
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
          const before = baselineRoster;
          const expectHumans = before ? before.humans + 1 : 1;
          const expectBots = before ? before.bots - 1 : EXPECTED_ROSTER - 1;
          const expectTotal = before ? before.total : EXPECTED_ROSTER;
          const expectRed = before ? before.red : BOTS_PER_TEAM;
          const expectBlue = before ? before.blue : BOTS_PER_TEAM;
          pass('roster refetched while joined', `red ${joinedRoster.red} / blue ${joinedRoster.blue}, total ${joinedRoster.total} (${joinedRoster.humans} human, ${joinedRoster.bots} bots)${before ? `, baseline ${before.humans} human / ${before.bots} bots` : ''}`);

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

    if (socket) {
      try { socket.close(1000, 'check done'); } catch { /* already closed */ }
    }
  } catch (error) {
    fail('WebSocket handshake', error?.message || String(error));
  }
}

// Opens a socket, mirrors the real client's init → join handshake, and resolves
// once init/joined/pong have all arrived. The socket is left open for the caller.
function wsProbe(wsUrl, { team = CHECK_TEAM, name = 'deploy-check' } = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: 60000 });
    const seen = { init: null, joined: null, pong: null };
    let timer = null;
    const finish = (result) => {
      clearTimeout(timer);
      resolve({ socket, ...result });
    };
    timer = setTimeout(() => {
      try { socket.terminate(); } catch { /* already closed */ }
      finish({ error: `no init/joined/pong frames within 60s (socket state ${socket.readyState})` });
    }, 60000);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'ping', t: 12345 }));
    });

    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'init') {
        seen.init = msg;
        // Without a `join` the server counts us as a socket but never puts us on
        // a team, and it is the join that retires a same-team bot.
        socket.send(JSON.stringify({ type: 'join', team, name }));
      }
      if (msg.type === 'joined') seen.joined = msg;
      if (msg.type === 'pong') seen.pong = msg;
      if (seen.init && seen.joined && seen.pong) finish({ seen });
    });

    socket.on('error', (error) => finish({ error: error?.message || String(error) }));
    socket.on('unexpected-response', (_req, res) => finish({ error: `handshake rejected with HTTP ${res.statusCode}` }));
  });
}

// ------------------------------------------------------- authoritative Beta link
// `?mode=beta` alone runs Beta against the local client, so the link only
// reaches the authoritative server when it carries `server=wss://…`. This
// section checks exactly that, then opens the socket it names.
async function checkBeta(betaUrl) {
  heading(`Beta link — ${betaUrl}`);
  let parsed = null;
  try {
    parsed = new URL(betaUrl);
  } catch {
    fail('Beta URL parses', betaUrl);
    return;
  }

  if (parsed.searchParams.get('mode') === 'beta') pass('link selects Beta mode', 'mode=beta');
  else fail('link selects Beta mode', `mode=${parsed.searchParams.get('mode') ?? '(missing)'}`);

  const server = (parsed.searchParams.get('server') || '').trim();
  let serverUrl = null;
  try {
    serverUrl = server ? new URL(server) : null;
  } catch {
    serverUrl = null;
  }
  if (serverUrl && /^wss?:$/.test(serverUrl.protocol)) {
    pass('link names an explicit game server', serverUrl.href);
    if (serverUrl.protocol === 'wss:') pass('game server uses wss://', 'secure upgrade for an HTTPS page');
    else fail('game server uses wss://', `ws:// on an HTTPS page is blocked by the browser (${serverUrl.href})`);
  } else {
    // No `server=`: Beta loads only the local client, with no authoritative
    // match behind it. That is the failure this check exists to catch.
    fail('link names an explicit game server', server ? `bad server="${server}"` : 'no server= — Beta would run offline');
    return;
  }

  // The page served for the link (ignoring the query) must be the current build.
  const pageBase = normalize(`${parsed.origin}${parsed.pathname}`);
  console.log('\nBeta page');
  const pageBody = await checkPage(pageBase);
  await checkBundle(pageBase, pageBody);

  console.log('\nBeta game server');
  const socketUrl = serverUrl.href.replace(/\/+$/, '');
  console.log(`      connecting to ${socketUrl}`);
  try {
    const outcome = await wsProbe(socketUrl, { team: CHECK_TEAM, name: 'beta-check' });
    if (outcome.error) {
      fail('Beta server accepts the WebSocket', outcome.error);
    } else {
      const { init, joined, pong } = outcome.seen;
      pass('Beta server accepts the WebSocket', `${socketUrl.startsWith('wss://') ? 'wss' : 'ws'}:// upgrade accepted`);
      if (typeof init.playerId === 'string' && init.playerId && typeof init.sessionToken === 'string') {
        pass('Beta init carries a session', `playerId ${init.playerId}`);
      } else {
        fail('Beta init carries a session', JSON.stringify(init).slice(0, 120));
      }
      if (joined?.state?.team === CHECK_TEAM) pass('Beta join lands on the linked team', `team ${joined.state.team}`);
      else fail('Beta join lands on the linked team', JSON.stringify(joined?.state).slice(0, 120));
      if (init.round && isPair(init.round.captures)) {
        pass('Beta init carries the round', `round ${init.round.round}, phase "${init.round.phase}", ${Math.round(init.round.timeLeft)}s left`);
      } else {
        fail('Beta init carries the round', JSON.stringify(init.round).slice(0, 120));
      }
      if (pong?.t === 12345) pass('Beta ping/pong round trip', 'echoed t=12345');
      else fail('Beta ping/pong round trip', JSON.stringify(pong));
    }
    if (outcome.socket) {
      try { outcome.socket.close(1000, 'check done'); } catch { /* already closed */ }
    }
  } catch (error) {
    fail('Beta server accepts the WebSocket', error?.message || String(error));
  }
}

// ---------------------------------------------------------------------- plan
const explicit = normalize(positional[0] || process.env.TARGET);
const plan = [];
let betaUrl = process.env.BETA_URL ? normalize(process.env.BETA_URL) : null;
if (CHECK_ALL || !explicit) {
  // Whole-deployment run: both public hosts plus the authoritative Beta link.
  const pages = normalize(process.env.PAGES_URL || DEFAULTS.pages);
  const render = normalize(process.env.RENDER_URL || DEFAULTS.render);
  plan.push({ label: `GitHub Pages — ${pages}`, target: pages, backend: false });
  plan.push({ label: `Render — ${render}`, target: render, backend: true });
  betaUrl ??= DEFAULT_BETA;
} else {
  plan.push({ label: explicit, target: explicit, backend: !STATIC_ONLY });
}

for (const item of plan) {
  heading(item.label);
  const pageBody = await checkPage(item.target);
  await checkBundle(item.target, pageBody);
  if (item.backend) {
    await checkBackend(item.target);
  } else {
    console.log('\nStatic origin: /api/status and WebSocket checks do not apply.');
  }
}

if (betaUrl) await checkBeta(betaUrl);

// ------------------------------------------------------------------ summary
// With several hosts, spell out which bundle each one serves so a stale deploy
// is obvious at a glance, not just as one FAIL inside a long log.
if (targets.length > 1) {
  console.log('\n=== bundle summary ===');
  const seen = new Set();
  for (const entry of targets) {
    const key = normalize(entry.target);
    if (seen.has(key)) continue; // the Beta page is the Render page
    seen.add(key);
    const state = entry.stale === null
      ? 'freshness not verified'
      : entry.stale
        ? `STALE — current build is ${entry.expected}`
        : 'current build';
    const mark = entry.stale === null ? 'SKIP' : entry.stale ? 'STALE' : 'OK';
    console.log(`  ${mark.padEnd(5)} ${normalize(entry.target)} — ${entry.served ?? 'no bundle'} (${state})`);
  }
}

const total = results.length;
const passed = results.filter((result) => result.ok && !result.skipped).length;
const label = failures
  ? 'CHECKS FAILED'
  : skipped
    ? 'ALL CHECKS PASSED (freshness not verified)'
    : 'ALL CHECKS PASSED';
console.log(`\n${label} — ${passed}/${total - skipped} passed${skipped ? `, ${skipped} skipped` : ''}\n`);
process.exit(failures === 0 ? 0 : 1);
