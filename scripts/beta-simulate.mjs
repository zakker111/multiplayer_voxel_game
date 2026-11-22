// Headless Beta battle simulation: full matches on the real authoritative server.
//
//   node scripts/beta-simulate.mjs [minutes=30] [roundMinutes=30] [runs=3] [botsPerTeam=10] [seed]
//
// Reproducing a report: a run takes its own seed (`baseSeed + runIndex - 1`, so
// run 1 uses the base seed itself) and installs
// it as Math.random plus a virtual clock, so the same arguments reproduce the
// same report exactly — same pickups, same deaths, same jeeps. Without a seed
// the banner prints the random one it picked; pass it back as the last argument:
//
//   node scripts/beta-simulate.mjs 30 30 3 10 12345
//
// The virtual clock matters as much as the RNG: reloads and other cooldowns read
// Date.now, and a fast headless run would otherwise spend most of a match
// "reloading" in wall-clock seconds. Advancing it with simulated ticks keeps the
// timers on match time and removes wall-clock jitter between runs.
//
// Beta is the online server path, so this drives the same ServerGame tick loop
// the live server runs: bots, workshops, blueprint hardware, jeeps, logistics
// and rounds. It reports what actually happened, not what the roles should do.
//
// What is counted, and over which window:
//   pickups / drops   a pickup starts when carryingFlag turns true, a drop ends
//                     it (death, capture or a round reset dropping the flag).
//                     The final carry is closed at the last simulated tick, so
//                     pickups === drops and carried seconds include it.
//   captures          authoritative `game.captures`, summed from finished-round
//                     records plus the live round; an independent event counter
//                     is cross-checked against it after every match.
//   returns           `game.flagReturns` (a teammate walking the flag home).
//                     The 60s automatic return is not a team action and is not
//                     counted, unlike a naive "flag is at base again" check.
//   droughts          longest stretch of a LIVE round without an objective
//                     event (pickup, touch, capture or return). The clock is
//                     reset at round start, so an intermission cannot inflate it.
//   flag out          live seconds in which at least one flag is away from base.
//   stalls            once-per-second movement samples of bots in mobile states;
//                     10s still is an episode, 20s is a long stall.
//   exposure          once-per-second samples of bot-driven jeeps; counts enemy
//                     players within 60m, regardless of line of sight.
//   destroyed         combat losses only. A round reset clears the field (spent
//                     supply), and that cleanup is not counted as a loss.
//
// Bots are identified with `isBotFlag`, never `instanceof ServerBot`: the test
// bundles compile serverGame and serverBot separately, so the class has two
// identities and instanceof silently misses every bot.
//
// Run `npm run pretest` first so dist/tests/serverGame.cjs exists.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SERVER_BOT_COUNT = '0'; // the harness owns the roster
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'; // keep the report readable
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { RED_FLAG_POS, BLUE_FLAG_POS } = require('../dist/tests/sharedTypes.cjs');

const MINUTES = positiveInt(process.argv[2], 30, 'minutes');
const ROUND_MINUTES = positiveInt(process.argv[3], 30, 'roundMinutes');
const RUNS = positiveInt(process.argv[4], 3, 'runs');
const BOTS_PER_TEAM = positiveInt(process.argv[5], 10, 'botsPerTeam');
const BASE_SEED = nonNegativeInt(process.argv[6], Math.floor(Math.random() * 2 ** 31), 'seed');

const TICK_DT = 1 / 20;
// A fixed epoch for the virtual clock: reproducibility must not depend on the
// date the harness happens to run.
const VIRTUAL_EPOCH_MS = Date.UTC(2026, 0, 1);
const SAMPLES_PER_SECOND = Math.round(1 / TICK_DT);
// Two extra ticks let a round whose clock expires exactly on the final simulated
// frame run its end-of-round transition, so the last round is not lost.
const TICKS = Math.round((MINUTES * 60) / TICK_DT) + 2;
const ROUND_SECONDS = ROUND_MINUTES * 60;
// States where standing still is a failure. DEFEND/CAMP hold posts on purpose,
// ENGAGE fights from cover, and TRENCH/BUILD are stationary jobs by design.
const MOBILE_STATES = new Set(['ADVANCE', 'FLANK', 'GRABFLAG', 'RETURN', 'ESCORT']);
const STALL_MOVE_METRES = 1.2;
const JEEP_EXPOSURE_RANGE = 60;

function nonNegativeInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`[beta-simulate] ${name} must be a non-negative integer (got ${raw})`);
    process.exit(1);
  }
  return value;
}

/** Small, fast, seedable PRNG (mulberry32) so a run can be reproduced exactly. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function positiveInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`[beta-simulate] ${name} must be a positive integer (got ${raw})`);
    process.exit(1);
  }
  return value;
}

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '0%');
const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const total = (record) => Object.values(record).reduce((a, b) => a + b, 0);
const flagFor = (team) => (team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS);

function runMatch(index) {
  const seed = (BASE_SEED + index - 1) >>> 0;
  const realRandom = Math.random;
  const realNow = Date.now;
  let virtualMs = VIRTUAL_EPOCH_MS;
  Math.random = mulberry32(seed);
  Date.now = () => virtualMs;
  const advanceClock = () => { virtualMs += TICK_DT * 1000; };

  const game = new ServerGame();
  game.roundSeconds = ROUND_SECONDS;
  game.roundPhase = 'live';
  game.roundTimeLeft = ROUND_SECONDS;

  for (const team of ['blue', 'red']) {
    for (let i = 0; i < BOTS_PER_TEAM; i++) game.addBot(team, `${team === 'blue' ? 'Blue' : 'Red'}-${i}`);
  }

  // ---- objective / combat counters ----
  let pickups = 0;
  const pickupsByTeam = { blue: 0, red: 0 };
  let deaths = 0;
  const deathsByTeam = { blue: 0, red: 0 };
  let capturesScored = 0; // independent event counter, cross-checked at the end
  let drops = 0;
  let carriedSeconds = 0;
  let carrierDeaths = 0;
  let longestCarry = { seconds: 0, bot: '' };
  const carriers = new Set();
  const carryStart = new Map();
  const deadState = new Map();
  const recoverySeen = new Map();
  let recoveries = 0;

  // ---- stagnation / pressure ----
  let lastObjectiveAt = 0;
  let lastDeathAt = 0;
  let prevTouches = game.flagTouches.blue + game.flagTouches.red;
  let prevCaptures = game.captures.blue + game.captures.red;
  let prevReturns = game.flagReturns.blue + game.flagReturns.red;
  let maxObjectiveDrought = 0;
  let maxObjectiveDroughtAt = '';
  let maxKillGap = 0;
  let maxKillGapAt = '';
  let flagOutSeconds = 0;
  let stalls = 0;
  let longStalls = 0;
  const stuck = new Map();
  const stateSeconds = { blue: {}, red: {} };
  const closeToFlag = new Set();
  let closestDistance = Infinity;

  // ---- hardware ----
  const empl = {
    seen: new Set(),
    alive: new Set(),
    ammo: new Map(),
    gunner: new Map(),
    builtByKind: {},
    shotsByKind: {},
    mountsByKind: {},
    crewByKind: {},
    maxStanding: { blue: 0, red: 0 },
    maxStandingByKind: {},
    built: 0,
    destroyed: 0,
    shots: 0,
    mounts: 0,
  };

  // ---- vehicles ----
  const jeep = {
    seen: new Set(),
    builtByTeam: { blue: 0, red: 0 },
    driverTicks: 0,
    distance: 0,
    pos: new Map(),
    exposureSamples: 0,
    exposedSamples: 0,
    threats: 0,
  };

  // ---- per-round counters (folded into roundRecords) ----
  let roundPickups = 0;
  let roundDeaths = 0;
  let roundEmplacements = 0;
  let roundJeeps = 0;
  let roundFlagOutSeconds = 0;
  let roundFlagOutMax = 0;
  const roundRecords = [];

  let prevPhase = game.roundPhase;

  const endCarry = (player, at) => {
    drops++;
    const seconds = at - (carryStart.get(player.id) ?? at);
    carriedSeconds += seconds;
    if (seconds > longestCarry.seconds) longestCarry = { seconds, bot: player.name };
    carryStart.delete(player.id);
    carriers.delete(player.id);
  };

  for (let tick = 1; tick <= TICKS; tick++) {
    advanceClock();
    game.update(TICK_DT);
    const t = tick * TICK_DT;
    const phase = game.roundPhase;
    const live = phase === 'live';
    const roundLabel = `R${game.roundNumber}`;

    // ---- round boundaries (handled first, so events are never charged to the
    // wrong round and a reset cannot look like a negative delta) ----
    let roundStarted = false;
    if (prevPhase === 'live' && !live) {
      roundRecords.push({
        round: game.roundNumber,
        winner: game.roundWinner(),
        captures: { ...game.captures },
        touches: { ...game.flagTouches },
        returns: { ...game.flagReturns },
        kills: { ...game.roundKills },
        pickups: roundPickups,
        deaths: roundDeaths,
        emplacements: roundEmplacements,
        jeeps: roundJeeps,
        flagOutMax: roundFlagOutMax,
      });
    } else if (prevPhase !== 'live' && live) {
      roundStarted = true;
      roundPickups = 0;
      roundDeaths = 0;
      roundEmplacements = 0;
      roundJeeps = 0;
      roundFlagOutSeconds = 0;
      roundFlagOutMax = 0;
      lastObjectiveAt = t;
      lastDeathAt = t;
      prevTouches = game.flagTouches.blue + game.flagTouches.red;
      prevCaptures = game.captures.blue + game.captures.red;
      prevReturns = game.flagReturns.blue + game.flagReturns.red;
    }
    prevPhase = phase;

    // ---- objective + combat events ----
    for (const player of game.players.values()) {
      if (!player.isBotFlag) continue;
      const wasCarrier = carriers.has(player.id);
      const wasDead = deadState.get(player.id) ?? false;
      if (player.isDead && !wasDead) {
        deaths++;
        deathsByTeam[player.team]++;
        roundDeaths++;
        lastDeathAt = t;
        if (wasCarrier) carrierDeaths++;
      }
      deadState.set(player.id, player.isDead);

      if (player.carryingFlag) {
        if (!wasCarrier) {
          carriers.add(player.id);
          carryStart.set(player.id, t);
          pickups++;
          pickupsByTeam[player.team]++;
          roundPickups++;
          lastObjectiveAt = t;
        }
      } else if (wasCarrier) {
        endCarry(player, t);
      }

      const recoveryAt = player.lastRecoveryAt;
      if (typeof recoveryAt === 'number' && (recoverySeen.get(player.id) ?? -100) !== recoveryAt) {
        recoverySeen.set(player.id, recoveryAt);
        recoveries++;
      }
    }

    // Objective activity also includes flag touches, captures and teammate
    // returns; those keep the drought clock alive even when nobody is holding
    // the flag.
    const touches = game.flagTouches.blue + game.flagTouches.red;
    if (touches > prevTouches) lastObjectiveAt = t;
    prevTouches = touches;
    const captures = game.captures.blue + game.captures.red;
    if (captures > prevCaptures) {
      capturesScored += captures - prevCaptures;
      lastObjectiveAt = t;
    }
    prevCaptures = captures;
    const returns = game.flagReturns.blue + game.flagReturns.red;
    if (returns > prevReturns) lastObjectiveAt = t;
    prevReturns = returns;

    // ---- blueprint hardware ----
    const standing = { blue: 0, red: 0 };
    const standingByKind = {};
    const aliveNow = new Set();
    for (const emplacement of game.emplacements.values()) {
      aliveNow.add(emplacement.id);
      standing[emplacement.team]++;
      standingByKind[emplacement.kind] = (standingByKind[emplacement.kind] ?? 0) + 1;
      if (!empl.seen.has(emplacement.id)) {
        empl.seen.add(emplacement.id);
        empl.built++;
        roundEmplacements++;
        empl.builtByKind[emplacement.kind] = (empl.builtByKind[emplacement.kind] ?? 0) + 1;
        empl.ammo.set(emplacement.id, emplacement.ammo ?? 0);
        empl.gunner.set(emplacement.id, null);
      } else if (typeof emplacement.ammo === 'number') {
        const before = empl.ammo.get(emplacement.id) ?? emplacement.ammo;
        if (emplacement.ammo < before) {
          const fired = before - emplacement.ammo;
          empl.shots += fired;
          empl.shotsByKind[emplacement.kind] = (empl.shotsByKind[emplacement.kind] ?? 0) + fired;
        }
        empl.ammo.set(emplacement.id, emplacement.ammo);
      }
      const previous = empl.gunner.get(emplacement.id) ?? null;
      if (emplacement.gunnerId && emplacement.gunnerId !== previous) {
        const gunner = game.players.get(emplacement.gunnerId);
        if (gunner?.isBotFlag) {
          empl.mounts++;
          empl.mountsByKind[emplacement.kind] = (empl.mountsByKind[emplacement.kind] ?? 0) + 1;
          (empl.crewByKind[emplacement.kind] ??= new Set()).add(gunner.id);
        }
      }
      empl.gunner.set(emplacement.id, emplacement.gunnerId ?? null);
    }
    empl.maxStanding.blue = Math.max(empl.maxStanding.blue, standing.blue);
    empl.maxStanding.red = Math.max(empl.maxStanding.red, standing.red);
    for (const [kind, count] of Object.entries(standingByKind)) {
      empl.maxStandingByKind[kind] = Math.max(empl.maxStandingByKind[kind] ?? 0, count);
    }
    // A round reset clears the field (spent supply, not a combat loss), so the
    // removed-id diff is only meaningful inside a round that is already running.
    if (!roundStarted) for (const id of empl.alive) if (!aliveNow.has(id)) empl.destroyed++;
    empl.alive = aliveNow;

    // ---- vehicles ----
    const driving = new Set();
    const sampleThisTick = tick % SAMPLES_PER_SECOND === 0;
    for (const vehicle of game.jeeps.values()) {
      if (!jeep.seen.has(vehicle.id)) {
        jeep.seen.add(vehicle.id);
        jeep.builtByTeam[vehicle.team]++;
        roundJeeps++;
      }
      if (!vehicle.driverId) continue;
      const driver = game.players.get(vehicle.driverId);
      if (!driver?.isBotFlag) continue;
      driving.add(vehicle.id);
      jeep.driverTicks++;
      if (sampleThisTick) {
        let nearby = 0;
        for (const other of game.players.values()) {
          if (other.isDead || other.isSpectating || other.team === vehicle.team) continue;
          if (Math.hypot(other.position.x - vehicle.position.x, other.position.z - vehicle.position.z) < JEEP_EXPOSURE_RANGE) nearby++;
        }
        jeep.exposureSamples++;
        jeep.threats += nearby;
        if (nearby > 0) jeep.exposedSamples++;
      }
      const last = jeep.pos.get(vehicle.id);
      if (last) jeep.distance += Math.hypot(vehicle.position.x - last.x, vehicle.position.z - last.z);
      jeep.pos.set(vehicle.id, { ...vehicle.position });
    }
    for (const id of jeep.pos.keys()) if (!driving.has(id)) jeep.pos.delete(id);

    // ---- once-per-second samples ----
    if (sampleThisTick && live) {
      if (!game.blueFlagAtBase || !game.redFlagAtBase) {
        flagOutSeconds++;
        roundFlagOutSeconds++;
        roundFlagOutMax = Math.max(roundFlagOutMax, roundFlagOutSeconds);
      } else {
        roundFlagOutSeconds = 0;
      }

      const drivingBots = new Set();
      for (const vehicle of game.jeeps.values()) if (vehicle.driverId) drivingBots.add(vehicle.driverId);
      const gunningBots = new Set();
      for (const emplacement of game.emplacements.values()) if (emplacement.gunnerId) gunningBots.add(emplacement.gunnerId);

      for (const player of game.players.values()) {
        if (!player.isBotFlag || player.isDead || player.isSpectating) continue;
        stateSeconds[player.team][player.stateName] = (stateSeconds[player.team][player.stateName] ?? 0) + 1;

        const enemyFlag = flagFor(player.team);
        const toFlag = Math.hypot(player.position.x - enemyFlag.x, player.position.z - enemyFlag.z);
        if (toFlag < 25) closeToFlag.add(`${player.team}:${player.id}`);
        closestDistance = Math.min(closestDistance, toFlag);

        const eligible = MOBILE_STATES.has(player.stateName) && !drivingBots.has(player.id) && !gunningBots.has(player.id);
        const sample = stuck.get(player.id) ?? { last: null, still: 0, max: 0, episodes: 0, state: '', at: '' };
        if (!eligible) {
          sample.still = 0;
          sample.last = { ...player.position };
          stuck.set(player.id, sample);
          continue;
        }
        const moved = sample.last
          ? Math.hypot(player.position.x - sample.last.x, player.position.z - sample.last.z)
          : STALL_MOVE_METRES + 1;
        sample.last = { ...player.position };
        sample.state = player.stateName;
        if (moved > STALL_MOVE_METRES) {
          sample.still = 0;
        } else {
          sample.still++;
          if (sample.still > sample.max) {
            sample.max = sample.still;
            sample.at = `${roundLabel} ${player.name}`;
          }
          if (sample.still === 10) {
            sample.episodes++;
            stalls++;
          }
          if (sample.still === 20) longStalls++;
        }
        stuck.set(player.id, sample);
      }

      const objectiveIdle = t - lastObjectiveAt;
      if (objectiveIdle > maxObjectiveDrought) {
        maxObjectiveDrought = objectiveIdle;
        maxObjectiveDroughtAt = roundLabel;
      }
      const killIdle = t - lastDeathAt;
      if (killIdle > maxKillGap) {
        maxKillGap = killIdle;
        maxKillGapAt = roundLabel;
      }
    }
  }

  // Close carries that are still running when the clock stops, so pickup/drop
  // pairs and carried seconds are complete.
  const finalTime = TICKS * TICK_DT;
  for (const id of [...carriers]) {
    const player = game.players.get(id);
    if (player) endCarry(player, finalTime);
  }

  // ---- per-bot construction + final roster ----
  const bots = [...game.players.values()].filter((player) => player.isBotFlag);
  const structuresStarted = { trench: 0, 'l-trench': 0, bunker: 0, 'bunker-ports': 0 };
  const structuresCompleted = { trench: 0, 'l-trench': 0, bunker: 0, 'bunker-ports': 0 };
  const finalStates = { blue: {}, red: {} };
  const emplacedByKind = {};
  let blocksPlaced = 0;
  let botBuilders = 0;
  let botsWithBuiltGuns = 0;
  for (const bot of bots) {
    blocksPlaced += bot.blocksPlaced || 0;
    if ((bot.blocksPlaced || 0) > 0) botBuilders++;
    if ((bot.gunsBuilt || 0) > 0) botsWithBuiltGuns++;
    for (const kind of Object.keys(structuresStarted)) {
      structuresStarted[kind] += bot.structuresStarted?.[kind] || 0;
      structuresCompleted[kind] += bot.structuresCompleted?.[kind] || 0;
    }
    for (const [kind, count] of Object.entries(bot.emplacedByKind ?? {})) {
      emplacedByKind[kind] = (emplacedByKind[kind] ?? 0) + count;
    }
    if (!bot.isDead && !bot.isSpectating) {
      finalStates[bot.team][bot.stateName] = (finalStates[bot.team][bot.stateName] ?? 0) + 1;
    }
  }

  // ---- final hardware snapshot ----
  const standingNow = {};
  let crateCount = 0;
  let crateStock = 0;
  let postsStanding = 0;
  for (const emplacement of game.emplacements.values()) {
    standingNow[emplacement.kind] = (standingNow[emplacement.kind] ?? 0) + 1;
    if (emplacement.kind === 'supplyCrate') {
      crateCount++;
      crateStock += emplacement.stock ?? 0;
    }
    if (emplacement.kind === 'spottingPost') postsStanding++;
  }

  // Authoritative round totals plus the live round, so a capture at the final
  // tick is counted and a round reset can never subtract one.
  const liveCaptures = game.roundPhase === 'live' ? { ...game.captures } : { blue: 0, red: 0 };
  const capturedByRound = roundRecords.reduce(
    (sum, record) => ({ blue: sum.blue + record.captures.blue, red: sum.red + record.captures.red }),
    { blue: 0, red: 0 },
  );
  const totalCaptures = {
    blue: capturedByRound.blue + liveCaptures.blue,
    red: capturedByRound.red + liveCaptures.red,
  };
  const returns =
    roundRecords.reduce((sum, record) => sum + record.returns.blue + record.returns.red, 0) +
    (game.roundPhase === 'live' ? game.flagReturns.blue + game.flagReturns.red : 0);

  const roundsWins = { blue: 0, red: 0, draw: 0 };
  for (const record of roundRecords) roundsWins[record.winner]++;

  const stuckSamples = [...stuck.values()];
  const worstStall = stuckSamples.reduce(
    (worst, sample) => (sample.max > worst.max ? sample : worst),
    { max: 0, state: '', at: '', episodes: 0 },
  );

  const result = {
    index,
    seed,
    minutes: MINUTES,
    bots: bots.length,
    roundRecords,
    roundsWins,
    totalCaptures,
    incompleteRound: game.roundPhase === 'live',
    // ---- objective / combat ----
    pickups,
    pickupsByTeam,
    drops,
    deaths,
    deathsByTeam,
    returns,
    carrierDeaths,
    carriedSeconds: Number(carriedSeconds.toFixed(1)),
    longestCarry,
    closeToFlag: closeToFlag.size,
    closestDistance: Number.isFinite(closestDistance) ? Number(closestDistance.toFixed(1)) : null,
    flagOutSeconds,
    maxObjectiveDrought,
    maxObjectiveDroughtAt,
    maxKillGap,
    maxKillGapAt,
    // ---- bots ----
    structuresStarted,
    structuresCompleted,
    blocksPlaced,
    botBuilders,
    botsWithBuiltGuns,
    recoveries,
    stalls,
    longStalls,
    stallBots: stuckSamples.filter((sample) => sample.episodes > 0).length,
    worstStall,
    stateSeconds,
    finalStates,
    alive: bots.filter((bot) => !bot.isDead && !bot.isSpectating).length,
    // ---- hardware ----
    empl: {
      built: empl.built,
      destroyed: empl.destroyed,
      builtByKind: empl.builtByKind,
      maxStanding: empl.maxStanding,
      maxStandingByKind: empl.maxStandingByKind,
      shots: empl.shots,
      shotsByKind: empl.shotsByKind,
      mounts: empl.mounts,
      mountsByKind: empl.mountsByKind,
      crewByKind: Object.fromEntries(Object.entries(empl.crewByKind).map(([kind, set]) => [kind, [...set]])),
      emplacedByKind,
      standingNow,
      crateCount,
      crateStock,
      postsStanding,
    },
    // ---- vehicles ----
    jeep: {
      built: [...jeep.seen].length,
      builtByTeam: jeep.builtByTeam,
      entered: game.botJeepStats.entered,
      arrived: game.botJeepStats.arrived,
      damagedExits: game.botJeepStats.damagedExits,
      abandoned: game.botJeepStats.abandoned,
      humanYields: game.botJeepStats.humanYields,
      passengerRides: game.botJeepStats.passengerRides,
      recoveries: game.botJeepStats.recoveries,
      driverSeconds: Number((jeep.driverTicks / SAMPLES_PER_SECOND).toFixed(1)),
      distance: Number(jeep.distance.toFixed(1)),
      exposurePct: jeep.exposureSamples > 0 ? Math.round((jeep.exposedSamples / jeep.exposureSamples) * 100) : 0,
      meanThreats: jeep.exposureSamples > 0 ? Number((jeep.threats / jeep.exposureSamples).toFixed(2)) : 0,
    },
  };

  verifyMatch(result, capturesScored);
  // Restore the real clocks before the report is printed: nothing after this
  // point is simulated, and a lingering Date.now would confuse the logger.
  Math.random = realRandom;
  Date.now = realNow;
  return result;
}

/**
 * Guard rails for the report itself: a harness that silently miscounts is worse
 * than no harness, so the cheap invariants fail loudly after every match.
 */
function verifyMatch(result, capturesScored) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`[beta-simulate] metric check failed in run ${result.index}: ${message}`);
  };

  assert(result.drops === result.pickups,
    `every pickup must close a carry period (pickups=${result.pickups}, drops=${result.drops})`);
  assert(result.carrierDeaths + result.totalCaptures.blue + result.totalCaptures.red <= result.pickups,
    'carrier deaths and captures cannot exceed pickups');
  assert(capturesScored === result.totalCaptures.blue + result.totalCaptures.red,
    `capture events (${capturesScored}) must match round totals (${result.totalCaptures.blue + result.totalCaptures.red})`);
  assert(total(result.empl.builtByKind) === result.empl.built,
    'per-kind hardware totals must add up to the builds seen');
  assert(result.empl.destroyed <= result.empl.built,
    `destroyed hardware (${result.empl.destroyed}) cannot exceed builds (${result.empl.built})`);
  assert(total(result.structuresCompleted) <= total(result.structuresStarted),
    'completed structures cannot exceed started ones');
  const jeepEnds = result.jeep.arrived + result.jeep.damagedExits + result.jeep.abandoned + result.jeep.humanYields;
  assert(jeepEnds <= result.jeep.built,
    `jeep outcomes (${jeepEnds}) cannot exceed jeeps built (${result.jeep.built})`);
  assert(result.jeep.entered <= result.jeep.built, 'boarded jeeps cannot exceed built ones');
}

function printMatch(result) {
  const { empl, jeep } = result;
  const caps = result.totalCaptures.blue + result.totalCaptures.red;

  console.log('');
  console.log(`══════════ RUN ${result.index} — ${result.minutes} min, ${result.bots / 2}v${result.bots / 2}, ${ROUND_MINUTES}-min rounds, seed ${result.seed} ══════════`);
  console.log(`Rounds finished: ${result.roundRecords.length}` +
    (result.incompleteRound ? ' (+1 in progress at the final tick)' : '') +
    ` | Blue ${result.roundsWins.blue} - Red ${result.roundsWins.red}${result.roundsWins.draw ? ` - Draw ${result.roundsWins.draw}` : ''}`);

  for (const record of result.roundRecords) {
    console.log(
      `  R${record.round} ${record.winner.toUpperCase().padEnd(5)} | caps ${record.captures.blue}-${record.captures.red}` +
      ` | touches ${record.touches.blue}-${record.touches.red}` +
      ` | returns ${record.returns.blue}-${record.returns.red}` +
      ` | kills ${record.kills.blue}-${record.kills.red}` +
      ` | pickups ${record.pickups} | deaths ${record.deaths}` +
      ` | hardware ${record.emplacements} | jeeps ${record.jeeps}` +
      ` | flag out max ${record.flagOutMax}s`,
    );
  }

  console.log('  ── battle ──');
  console.log(`  captures ${result.totalCaptures.blue}-${result.totalCaptures.red} (total ${caps})` +
    ` | pickups ${result.pickups} (B${result.pickupsByTeam.blue}/R${result.pickupsByTeam.red})` +
    ` | returns ${result.returns}`);
  console.log(`  bot deaths ${result.deaths} (B${result.deathsByTeam.blue}/R${result.deathsByTeam.red})` +
    ` | flag outside base ${result.flagOutSeconds}s`);
  console.log(`  carrier runs: ${result.pickups} pickups, ${caps} scored (${pct(caps, result.pickups)} conversion),` +
    ` ${result.carrierDeaths} carriers died (${pct(result.carrierDeaths, result.pickups)}), ${result.drops} carry periods ended` +
    ` | ${result.carriedSeconds}s carried, mean ${(result.carriedSeconds / Math.max(1, result.pickups)).toFixed(1)}s,` +
    ` longest ${result.longestCarry.seconds.toFixed(0)}s (${result.longestCarry.bot || 'n/a'})`);
  console.log(`  flag pressure: ${result.closeToFlag} bots reached the enemy stand zone (<25m),` +
    ` closest approach ${result.closestDistance ?? 'n/a'}m`);

  console.log('  ── bot blueprints / emplacements ──');
  console.log(`  built ${empl.built} | destroyed ${empl.destroyed}` +
    ` | peak standing B${empl.maxStanding.blue}/R${empl.maxStanding.red}` +
    ` | mounts ${empl.mounts} | rounds fired ${empl.shots}`);
  const allKinds = [...new Set([...Object.keys(empl.builtByKind), ...Object.keys(empl.emplacedByKind)])];
  for (const kind of allKinds) {
    console.log(`    ${kind.padEnd(12)} built ${String(empl.builtByKind[kind] ?? 0).padEnd(3)}` +
      ` standing now ${String(empl.standingNow[kind] ?? 0).padEnd(2)} peak ${String(empl.maxStandingByKind[kind] ?? 0).padEnd(2)}` +
      ` crewed by ${String(empl.crewByKind[kind]?.length ?? 0).padEnd(2)} bots (${empl.mountsByKind[kind] ?? 0} mounts)` +
      ` rounds fired ${empl.shotsByKind[kind] ?? 0}`);
  }
  console.log(`  support builds: supply crates ${empl.crateCount} holding ${empl.crateStock} blocks` +
    ` | spotting posts ${empl.postsStanding}`);
  console.log(`  engineers who placed hardware: ${result.botsWithBuiltGuns}` +
    ` (${Object.entries(empl.emplacedByKind).map(([kind, n]) => `${kind}×${n}`).join(', ') || 'none'})` +
    ` | structures started ${total(result.structuresStarted)} completed ${total(result.structuresCompleted)}` +
    ` (${Object.entries(result.structuresCompleted).map(([kind, n]) => `${kind} ${result.structuresStarted[kind]}→${n}`).join(', ')})`);
  console.log(`  blocks placed ${result.blocksPlaced} by ${result.botBuilders} bots`);

  console.log('  ── vehicles ──');
  console.log(`  jeeps built ${jeep.built} (B${jeep.builtByTeam.blue}/R${jeep.builtByTeam.red})` +
    ` | boarded ${jeep.entered} | arrived ${jeep.arrived} | passenger rides ${jeep.passengerRides}`);
  console.log(`  driven ${jeep.driverSeconds}s / ${jeep.distance}m` +
    ` | damaged exits ${jeep.damagedExits} | jeep recoveries ${jeep.recoveries} | abandoned ${jeep.abandoned}` +
    ` | human yields ${jeep.humanYields}`);
  console.log(`  exposure while driving: ${jeep.exposurePct}% of seconds had an enemy within ${JEEP_EXPOSURE_RANGE}m` +
    ` (mean ${jeep.meanThreats} nearby) | arrival rate ${pct(jeep.arrived, jeep.built)}`);

  console.log('  ── stuck / stagnation ──');
  console.log(`  bot stuck recoveries ${result.recoveries} | movement stalls ≥10s ${result.stalls} (${result.stallBots} bots)` +
    ` | ≥20s ${result.longStalls}`);
  if (result.worstStall.max > 0) {
    console.log(`  worst stall ${result.worstStall.max}s in ${result.worstStall.state} (${result.worstStall.at})`);
  }
  console.log(`  longest objective drought ${result.maxObjectiveDrought.toFixed(0)}s (${result.maxObjectiveDroughtAt || 'n/a'})` +
    ` | longest no-death gap ${result.maxKillGap.toFixed(0)}s (${result.maxKillGapAt || 'n/a'})`);
  console.log(`  final states B ${JSON.stringify(result.finalStates.blue)} | R ${JSON.stringify(result.finalStates.red)}` +
    ` | alive ${result.alive}/${result.bots}`);
  const mix = (team) => {
    const entries = Object.entries(result.stateSeconds[team]);
    const seconds = total(result.stateSeconds[team]);
    return entries.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([state, count]) => `${state} ${pct(count, seconds)}`).join(', ');
  };
  console.log(`  time in state: B ${mix('blue')} | R ${mix('red')}`);
}

function printSummary(results) {
  const summed = {
    captures: results.reduce((n, r) => n + r.totalCaptures.blue + r.totalCaptures.red, 0),
    pickups: results.reduce((n, r) => n + r.pickups, 0),
    deaths: results.reduce((n, r) => n + r.deaths, 0),
    carrierDeaths: results.reduce((n, r) => n + r.carrierDeaths, 0),
    carriedSeconds: results.reduce((n, r) => n + r.carriedSeconds, 0),
    hardware: results.reduce((n, r) => n + r.empl.built, 0),
    gunShots: results.reduce((n, r) => n + r.empl.shots, 0),
    jeepsBuilt: results.reduce((n, r) => n + r.jeep.built, 0),
    jeepsArrived: results.reduce((n, r) => n + r.jeep.arrived, 0),
    jeepDamaged: results.reduce((n, r) => n + r.jeep.damagedExits, 0),
    jeepAbandoned: results.reduce((n, r) => n + r.jeep.abandoned, 0),
    recoveries: results.reduce((n, r) => n + r.recoveries, 0),
    stalls: results.reduce((n, r) => n + r.stalls, 0),
    standTouches: results.reduce((n, r) => n + r.closeToFlag, 0),
    rounds: results.reduce((n, r) => n + r.roundRecords.length, 0),
    zeroCapRounds: results.reduce(
      (n, r) => n + r.roundRecords.filter((record) => record.captures.blue === 0 && record.captures.red === 0).length,
      0,
    ),
    zeroCaptureMatches: results.filter((r) => r.totalCaptures.blue + r.totalCaptures.red === 0).length,
  };

  console.log('');
  console.log('══════════════════════ ACROSS ALL RUNS ══════════════════════');
  const columns = [
    ['run', 3], ['winner', 11], ['caps', 7], ['pickups', 7], ['deaths', 6],
    ['hardware/peak', 13], ['jeeps b/a', 9], ['stall bots', 10], ['drought', 7], ['no-death', 0],
  ];
  console.log(` ${columns.map(([label, width]) => label.padEnd(width)).join(' | ')}`);
  for (const result of results) {
    const winner = result.roundsWins.blue > result.roundsWins.red ? 'BLUE'
      : result.roundsWins.red > result.roundsWins.blue ? 'RED' : 'DRAW';
    const peak = Math.max(result.empl.maxStanding.blue, result.empl.maxStanding.red);
    const cells = [
      String(result.index),
      winner,
      `${result.totalCaptures.blue}-${result.totalCaptures.red}`,
      String(result.pickups),
      String(result.deaths),
      `${result.empl.built}/${peak}`,
      `${result.jeep.built}/${result.jeep.arrived}`,
      String(result.stallBots),
      `${result.maxObjectiveDrought.toFixed(0)}s`,
      `${result.maxKillGap.toFixed(0)}s`,
    ];
    console.log(` ${cells.map((cell, i) => cell.padEnd(columns[i][1])).join(' | ')}`);
  }

  const conversion = summed.pickups > 0 ? Math.round((summed.captures / summed.pickups) * 100) : 0;
  console.log('');
  console.log(`Totals over ${results.length} matches: ${summed.rounds} rounds, ${summed.captures} captures, ` +
    `${summed.pickups} pickups, ${summed.deaths} bot deaths, ` +
    `${summed.zeroCapRounds} zero-capture rounds (${summed.zeroCaptureMatches} zero-capture matches).`);
  console.log(`Carrier runs: ${summed.pickups} pickups scored ${summed.captures} (${conversion}%)` +
    ` | carriers killed ${summed.carrierDeaths} (${pct(summed.carrierDeaths, summed.pickups)})` +
    ` | mean carry ${(summed.carriedSeconds / Math.max(1, summed.pickups)).toFixed(1)}s` +
    ` | bots reaching the enemy stand zone ${summed.standTouches} (bot-runs)`);
  console.log(`Bots: ${summed.hardware} emplacements built, ${summed.gunShots} rounds fired, ` +
    `${summed.jeepsBuilt} jeeps built and ${summed.jeepsArrived} arrived (${pct(summed.jeepsArrived, summed.jeepsBuilt)} arrival), ` +
    `${summed.recoveries} stuck recoveries, ${summed.stalls} movement stalls ≥10s.`);
  console.log(`Jeep losses: ${summed.jeepDamaged} shot-up exits, ${summed.jeepAbandoned} abandoned, ` +
    `mean exposure ${(avg(results.map((r) => r.jeep.exposurePct))).toFixed(0)}% of driving seconds within ${JEEP_EXPOSURE_RANGE}m of an enemy.`);
  const kinds = {};
  for (const result of results) {
    for (const [kind, count] of Object.entries(result.empl.builtByKind)) kinds[kind] = (kinds[kind] ?? 0) + count;
  }
  console.log(`Blueprint mix: ${Object.entries(kinds).map(([kind, n]) => `${kind}×${n}`).join(', ') || 'none'}` +
    ` | mean objective drought ${avg(results.map((r) => r.maxObjectiveDrought)).toFixed(0)}s`);
  console.log(`Seeds: ${results.map((r) => r.seed).join(', ')} | reproduce with the base seed printed in the banner`);
  console.log('');
}

console.log('=== BETA BATTLE SIMULATION ===');
console.log(`${RUNS} matches × ${MINUTES} min, ${ROUND_MINUTES}-min rounds, ${BOTS_PER_TEAM}v${BOTS_PER_TEAM} server bots, 20 Hz.`);
console.log(`Base seed ${BASE_SEED} (run i uses base + i - 1). Reproduce exactly with:`);
console.log(`  node scripts/beta-simulate.mjs ${MINUTES} ${ROUND_MINUTES} ${RUNS} ${BOTS_PER_TEAM} ${BASE_SEED}`);

const results = [];
for (let index = 1; index <= RUNS; index++) {
  const result = runMatch(index);
  results.push(result);
  printMatch(result);
}
printSummary(results);
