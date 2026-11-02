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
// Structure starts/usage + stuck recoveries, observed per bot.
let recoveries = 0;
let jeepDriverTicks = 0;
let jeepDrivingDistance = 0;
const lastJeepPositions = new Map();
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

  const activeJeeps = new Set();
  for (const [id, jeep] of game.jeeps) {
    if (!jeep.driverId || !game.players.get(jeep.driverId)?.isBotFlag) continue;
    activeJeeps.add(id);
    jeepDriverTicks++;
    const last = lastJeepPositions.get(id);
    if (last) jeepDrivingDistance += Math.hypot(jeep.position.x - last.x, jeep.position.z - last.z);
    lastJeepPositions.set(id, { ...jeep.position });
  }
  for (const id of lastJeepPositions.keys()) if (!activeJeeps.has(id)) lastJeepPositions.delete(id);

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
const structureChoices = { trench: 0, 'l-trench': 0, bunker: 0, 'bunker-ports': 0 };
for (const player of game.players.values()) {
  for (const kind of Object.keys(structuresCompleted)) {
    structuresCompleted[kind] += player.structuresCompleted?.[kind] || 0;
    structureChoices[kind] += player.structuresStarted?.[kind] || 0;
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
  botJeeps: { ...game.botJeepStats, driverSeconds: Number((jeepDriverTicks / 20).toFixed(1)), distanceMeters: Number(jeepDrivingDistance.toFixed(1)) },
  simSeconds: Number(elapsed),
}, null, 2));
