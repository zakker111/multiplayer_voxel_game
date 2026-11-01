// Headless bot-only match measurement.
//
//   node scripts/measure-bots.mjs [minutes]
//
// Runs the real ServerGame with its bot roster and reports objective activity
// (pickups, captures, returns, deaths) so AI changes are judged on numbers
// instead of impressions. Nothing is written to disk.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.SERVER_BOT_COUNT = process.env.SERVER_BOT_COUNT || '10';
const { ServerGame } = require('../dist/tests/serverGame.cjs');

const minutes = Number(process.argv[2] || 10);
const ticks = Math.round((minutes * 60) / (1 / 20));

const game = new ServerGame();
const stats = { pickups: 0, captures: 0, returns: 0, deaths: 0, byTeam: { red: 0, blue: 0 } };
// Structure pool usage + stuck recoveries, observed per bot.
const structureChoices = {};
const activePlanByBot = new Map();
let recoveries = 0;
const lastRecoveryByBot = new Map();
const carriers = new Set();

let lastBlueCapture = game.captures.blue;
let lastRedCapture = game.captures.red;
let lastBlueFlagAtBase = game.blueFlagAtBase;
let lastRedFlagAtBase = game.redFlagAtBase;
const states = new Map();
const started = Date.now();

for (let tick = 1; tick <= ticks; tick++) {
  game.update(1 / 20);

  for (const [id, player] of game.players) {
    if (player.carryingFlag && !carriers.has(id)) {
      carriers.add(id);
      stats.pickups++;
    }
    if (!player.carryingFlag) carriers.delete(id);
    if (player.isDead) {
      const prev = states.get(id) || false;
      if (!prev) stats.deaths++;
      states.set(id, true);
    } else {
      states.set(id, false);
    }
  }

  for (const [id, player] of game.players) {
    // Count real plan starts (idle -> active), not kind changes: two bunkers
    // back-to-back are two starts and must not collapse into one.
    const hasPlan = Boolean(player.trenchPlan?.length || player.buildPlan?.length);
    if (hasPlan && !activePlanByBot.get(id)) {
      const kind = player.lastStructure;
      if (kind) structureChoices[kind] = (structureChoices[kind] || 0) + 1;
    }
    activePlanByBot.set(id, hasPlan);
    const recoveryAt = player.lastRecoveryAt;
    if (typeof recoveryAt === 'number' && (lastRecoveryByBot.get(id) ?? -100) !== recoveryAt) {
      lastRecoveryByBot.set(id, recoveryAt);
      recoveries++;
    }
  }

  if (game.blueFlagAtBase && !lastBlueFlagAtBase) stats.returns++;
  if (game.redFlagAtBase && !lastRedFlagAtBase) stats.returns++;
  lastBlueFlagAtBase = game.blueFlagAtBase;
  lastRedFlagAtBase = game.redFlagAtBase;

  if (game.captures.blue !== lastBlueCapture) { stats.byTeam.blue += game.captures.blue - lastBlueCapture; stats.captures += game.captures.blue - lastBlueCapture; }
  if (game.captures.red !== lastRedCapture) { stats.byTeam.red += game.captures.red - lastRedCapture; stats.captures += game.captures.red - lastRedCapture; }
  lastBlueCapture = game.captures.blue;
  lastRedCapture = game.captures.red;
}

// Actual construction, not just plans: blocks placed and plans completed.
const blocksPlaced = [...game.players.values()].reduce((n, p) => n + (p.blocksPlaced || 0), 0);
const structuresCompleted = { trench: 0, 'l-trench': 0, bunker: 0, 'bunker-ports': 0 };
for (const player of game.players.values()) {
  for (const kind of Object.keys(structuresCompleted)) {
    structuresCompleted[kind] += player.structuresCompleted?.[kind] || 0;
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(JSON.stringify({
  minutes,
  bots: game.players.size,
  ...stats,
  capturesPer10Min: Number(((stats.captures / minutes) * 10).toFixed(2)),
  pickupsPer10Min: Number(((stats.pickups / minutes) * 10).toFixed(2)),
  structureChoices,
  blocksPlaced,
  structuresCompleted,
  recoveries,
  simSeconds: Number(elapsed),
}, null, 2));
