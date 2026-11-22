// Headless Beta battle simulation: full matches on the real authoritative server.
//
//   node scripts/beta-simulate.mjs [minutes=20] [roundMinutes=4] [runs=3] [botsPerTeam=10]
//
// Beta mode is the online server path, so this feeds the same ServerGame tick
// loop the live server runs: bots, workshops, blueprint hardware, jeeps,
// logistics and rounds. It reports what actually happened instead of what the
// roles are supposed to do:
//   - round results and objective activity (caps, touches, returns, pickups)
//   - bot blueprint/emplacement builds per kind (guns, posts, crates), who
//     built them, who crewed them and how many rounds each kind fired
//   - vehicles (jeeps built, boarded, driven, arrived, abandoned)
//   - stuck bots (engine recoveries, long movement stalls) and final states
//   - stagnation (longest objective drought and longest gap without a death)
//
// Bots are identified with `isBotFlag`, never `instanceof ServerBot`: the test
// bundles compile serverGame and serverBot separately, so the same bot class
// has two identities and instanceof checks silently miss every bot.
//
// Run `npm run pretest` first so dist/tests/serverGame.cjs exists.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SERVER_BOT_COUNT = '0'; // the harness owns the roster
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'; // keep the report readable
const { ServerGame } = require('../dist/tests/serverGame.cjs');

const MINUTES = Number(process.argv[2] ?? 20);
const ROUND_MINUTES = Number(process.argv[3] ?? 4);
const RUNS = Number(process.argv[4] ?? 3);
const BOTS_PER_TEAM = Number(process.argv[5] ?? 10);
const TICK_DT = 1 / 20;
// Two extra ticks let a round whose clock expires exactly on the final simulated
// frame run its end-of-round transition, so the last round is not lost.
const TICKS = Math.round((MINUTES * 60) / TICK_DT) + 2;
// States where standing still is a failure. DEFEND/CAMP hold posts on purpose,
// ENGAGE fights from cover, and TRENCH/BUILD are stationary jobs by design.
const MOBILE_STATES = new Set(['ADVANCE', 'FLANK', 'GRABFLAG', 'RETURN', 'ESCORT']);
const ROUND_SECONDS = ROUND_MINUTES * 60;
const TRACE = process.env.SIM_TRACE === '1';

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '0%');
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function runMatch(index) {
  const game = new ServerGame();
  game.roundSeconds = ROUND_SECONDS;
  game.roundPhase = 'live';
  game.roundTimeLeft = ROUND_SECONDS;

  for (const team of ['blue', 'red']) {
    for (let i = 0; i < BOTS_PER_TEAM; i++) game.addBot(team, `${team === 'blue' ? 'Blue' : 'Red'}-${i}`);
  }

  const stats = {
    pickups: 0,
    pickupsByTeam: { blue: 0, red: 0 },
    captures: { blue: 0, red: 0 },
    deaths: 0,
    deathsByTeam: { blue: 0, red: 0 },
    returns: 0,
    emplacementsBuilt: 0,
    emplacementsDestroyed: 0,
    jeepsBuilt: 0,
    flagOutSeconds: 0,
    stalls: 0,
    longStalls: 0,
    maxObjectiveDrought: 0,
    maxObjectiveDroughtAt: '',
    maxKillGap: 0,
    maxKillGapAt: '',
  };

  const empl = {
    seen: new Set(),
    builtByKind: {},
    builtByTeam: { blue: 0, red: 0 },
    alive: new Set(),
    ammo: new Map(),
    gunner: new Map(),
    shots: 0,
    shotsByKind: {},
    mounts: 0,
    mountsByKind: {},
    crewByKind: {},
    gunnerBots: new Set(),
    maxStanding: { blue: 0, red: 0 },
    maxStandingByKind: {},
  };
  const jeep = {
    seen: new Set(),
    builtByTeam: { blue: 0, red: 0 },
    driverTicks: 0,
    distance: 0,
    pos: new Map(),
    // Exposure while a bot is driving: one sample a second, counting enemies
    // within rifle range of the vehicle. This is the number a route change is
    // supposed to move, independent of who happens to get shot.
    samples: 0,
    exposed: 0,
    threatSum: 0,
  };
  const deadState = new Map();
  const carriers = new Set();
  const carryStart = new Map();
  const closeToFlag = new Set();
  const closest = { distance: Infinity };
  const stateSeconds = { blue: {}, red: {} };
  let carrierDeaths = 0;
  let drops = 0;
  let carriedSeconds = 0;
  let longestCarry = { seconds: 0, bot: '' };
  const lastRecoveryByBot = new Map();
  const stuck = new Map();
  const roundRecords = [];
  let recoveries = 0;

  let prevPhase = game.roundPhase;
  let prevBlueAtBase = game.blueFlagAtBase;
  let prevRedAtBase = game.redFlagAtBase;
  let prevTouches = game.flagTouches.blue + game.flagTouches.red;
  let prevCaptureBlue = game.captures.blue;
  let prevCaptureRed = game.captures.red;

  let traceLines = 0;
  let lastObjectiveAt = 0;
  let lastDeathAt = 0;
  let roundPickups = 0;
  let roundDeaths = 0;
  let roundEmpl = 0;
  let roundJeeps = 0;
  let roundFlagOut = 0;
  let roundFlagOutMax = 0;

  for (let tick = 1; tick <= TICKS; tick++) {
    game.update(TICK_DT);
    const t = tick * TICK_DT;
    const live = game.roundPhase === 'live';
    const roundLabel = `R${game.roundNumber}`;

    // ---- objective + combat events ----
    for (const player of game.players.values()) {
      if (!player.isBotFlag) continue;
      const wasCarrier = carriers.has(player.id);
      const wasDead = deadState.get(player.id) ?? false;
      if (player.isDead && !wasDead) {
        stats.deaths++;
        stats.deathsByTeam[player.team]++;
        roundDeaths++;
        lastDeathAt = t;
        if (wasCarrier) carrierDeaths++;
      }
      deadState.set(player.id, player.isDead);

      if (player.carryingFlag && !wasCarrier) {
        carriers.add(player.id);
        carryStart.set(player.id, t);
        stats.pickups++;
        stats.pickupsByTeam[player.team]++;
        roundPickups++;
        lastObjectiveAt = t;
        if (TRACE && traceLines++ < 150) {
          console.log(`PICKUP t=${t.toFixed(2)} ${player.name} ${player.team} state=${player.stateName} hp=${player.hp.toFixed(0)}` +
            ` blueAtBase=${game.blueFlagAtBase} redAtBase=${game.redFlagAtBase}` +
            ` blueCarrier=${game.blueFlagCarrier} redCarrier=${game.redFlagCarrier}` +
            ` dropped=${game.droppedFlags.length} pos=${player.position.x.toFixed(1)},${player.position.z.toFixed(1)}`);
        }
      }
      if (!player.carryingFlag) {
        if (wasCarrier) {
          drops++;
          const carried = t - (carryStart.get(player.id) ?? t);
          carriedSeconds += carried;
          if (carried > longestCarry.seconds) longestCarry = { seconds: carried, bot: player.name };
          carryStart.delete(player.id);
        }
        if (wasCarrier && TRACE && traceLines++ < 150) {
          console.log(`DROP   t=${t.toFixed(2)} ${player.name} ${player.team} state=${player.stateName} hp=${player.hp.toFixed(0)}` +
            ` dead=${player.isDead} spectating=${player.isSpectating}` +
            ` blueAtBase=${game.blueFlagAtBase} redAtBase=${game.redFlagAtBase}` +
            ` blueCarrier=${game.blueFlagCarrier} redCarrier=${game.redFlagCarrier}` +
            ` dropped=${game.droppedFlags.length} pos=${player.position.x.toFixed(1)},${player.position.z.toFixed(1)}`);
        }
        carriers.delete(player.id);
      }

      const recoveryAt = player.lastRecoveryAt;
      if (typeof recoveryAt === 'number' && (lastRecoveryByBot.get(player.id) ?? -100) !== recoveryAt) {
        lastRecoveryByBot.set(player.id, recoveryAt);
        recoveries++;
      }
    }

    if (live && game.blueFlagAtBase && !prevBlueAtBase) { stats.returns++; lastObjectiveAt = t; }
    if (live && game.redFlagAtBase && !prevRedAtBase) { stats.returns++; lastObjectiveAt = t; }
    prevBlueAtBase = game.blueFlagAtBase;
    prevRedAtBase = game.redFlagAtBase;

    const touches = game.flagTouches.blue + game.flagTouches.red;
    if (touches > prevTouches) { lastObjectiveAt = t; prevTouches = touches; }
    if (game.captures.blue !== prevCaptureBlue) {
      stats.captures.blue += game.captures.blue - prevCaptureBlue;
      prevCaptureBlue = game.captures.blue;
      lastObjectiveAt = t;
    }
    if (game.captures.red !== prevCaptureRed) {
      stats.captures.red += game.captures.red - prevCaptureRed;
      prevCaptureRed = game.captures.red;
      lastObjectiveAt = t;
    }

    // ---- blueprint hardware (bot-built emplacements) ----
    const standing = { blue: 0, red: 0 };
    const standingByKind = {};
    const aliveNow = new Set();
    for (const emplacement of game.emplacements.values()) {
      aliveNow.add(emplacement.id);
      standing[emplacement.team]++;
      standingByKind[emplacement.kind] = (standingByKind[emplacement.kind] ?? 0) + 1;
      if (!empl.seen.has(emplacement.id)) {
        empl.seen.add(emplacement.id);
        stats.emplacementsBuilt++;
        roundEmpl++;
        empl.builtByKind[emplacement.kind] = (empl.builtByKind[emplacement.kind] ?? 0) + 1;
        empl.builtByTeam[emplacement.team]++;
        empl.ammo.set(emplacement.id, emplacement.ammo ?? 0);
      } else if (typeof emplacement.ammo === 'number') {
        const before = empl.ammo.get(emplacement.id) ?? emplacement.ammo;
        if (emplacement.ammo < before) {
          const fired = before - emplacement.ammo;
          empl.shots += fired;
          empl.shotsByKind[emplacement.kind] = (empl.shotsByKind[emplacement.kind] ?? 0) + fired;
        }
        empl.ammo.set(emplacement.id, emplacement.ammo);
      }
      const beforeGunner = empl.gunner.get(emplacement.id) ?? null;
      if (emplacement.gunnerId && emplacement.gunnerId !== beforeGunner) {
        const gunner = game.players.get(emplacement.gunnerId);
        if (gunner?.isBotFlag) {
          empl.mounts++;
          empl.gunnerBots.add(gunner.id);
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
    if (live) {
      for (const id of empl.alive) if (!aliveNow.has(id)) stats.emplacementsDestroyed++;
    }
    empl.alive = aliveNow;

    // ---- vehicles ----
    const driving = new Set();
    for (const vehicle of game.jeeps.values()) {
      if (!jeep.seen.has(vehicle.id)) {
        jeep.seen.add(vehicle.id);
        jeep.builtByTeam[vehicle.team]++;
        stats.jeepsBuilt++;
        roundJeeps++;
      }
      if (!vehicle.driverId) continue;
      const driver = game.players.get(vehicle.driverId);
      if (!driver?.isBotFlag) continue;
      driving.add(vehicle.id);
      jeep.driverTicks++;
      if (tick % 20 === 0) {
        let nearby = 0;
        for (const other of game.players.values()) {
          if (other.isDead || other.isSpectating || other.team === vehicle.team) continue;
          if (Math.hypot(other.position.x - vehicle.position.x, other.position.z - vehicle.position.z) < 60) nearby++;
        }
        jeep.samples++;
        jeep.threatSum += nearby;
        if (nearby > 0) jeep.exposed++;
      }
      const last = jeep.pos.get(vehicle.id);
      if (last) jeep.distance += Math.hypot(vehicle.position.x - last.x, vehicle.position.z - last.z);
      jeep.pos.set(vehicle.id, { ...vehicle.position });
    }
    for (const id of jeep.pos.keys()) if (!driving.has(id)) jeep.pos.delete(id);

    // ---- once-per-second samples: flag-out time and stuck bots ----
    if (tick % 20 === 0 && live) {
      if (!game.blueFlagAtBase || !game.redFlagAtBase) {
        stats.flagOutSeconds++;
        roundFlagOut++;
        roundFlagOutMax = Math.max(roundFlagOutMax, roundFlagOut);
      } else {
        roundFlagOut = 0;
      }

      for (const player of game.players.values()) {
        if (!player.isBotFlag || player.isDead || player.isSpectating) continue;
        stateSeconds[player.team][player.stateName] = (stateSeconds[player.team][player.stateName] ?? 0) + 1;
        const enemyFlag = player.team === 'blue' ? game.RED_FLAG_POS : game.BLUE_FLAG_POS;
        const toFlag = Math.hypot(player.position.x - enemyFlag.x, player.position.z - enemyFlag.z);
        if (toFlag < 25) closeToFlag.add(`${player.team}:${player.name}`);
        if (toFlag < closest.distance) closest.distance = toFlag;
        const sample = stuck.get(player.id) ?? {
          last: null, still: 0, max: 0, episodes: 0, state: '', worstAt: '',
        };
        const drivingThisBot = [...game.jeeps.values()].some((v) => v.driverId === player.id);
        const manningGun = Boolean(game.gunnerEmplacement(player.id));
        const eligible = !drivingThisBot && !manningGun && MOBILE_STATES.has(player.stateName);
        if (!eligible) {
          sample.still = 0;
          sample.last = { ...player.position };
          stuck.set(player.id, sample);
          continue;
        }
        const moved = sample.last
          ? Math.hypot(player.position.x - sample.last.x, player.position.z - sample.last.z)
          : 99;
        sample.last = { ...player.position };
        sample.state = player.stateName;
        if (moved > 1.2) {
          sample.still = 0;
        } else {
          sample.still++;
          if (sample.still > sample.max) {
            sample.max = sample.still;
            sample.worstAt = `${roundLabel} ${player.name}`;
          }
          if (sample.still === 10) {
            sample.episodes++;
            stats.stalls++;
          }
          if (sample.still === 20) stats.longStalls++;
        }
        stuck.set(player.id, sample);
      }

      const objectiveIdle = t - lastObjectiveAt;
      if (objectiveIdle > stats.maxObjectiveDrought) {
        stats.maxObjectiveDrought = objectiveIdle;
        stats.maxObjectiveDroughtAt = roundLabel;
      }
      const killIdle = t - lastDeathAt;
      if (killIdle > stats.maxKillGap) {
        stats.maxKillGap = killIdle;
        stats.maxKillGapAt = roundLabel;
      }
    }

    // ---- round boundaries ----
    if (prevPhase !== 'live' && game.roundPhase === 'live') {
      roundPickups = 0;
      roundDeaths = 0;
      roundEmpl = 0;
      roundJeeps = 0;
      roundFlagOut = 0;
      roundFlagOutMax = 0;
    }
    if (prevPhase === 'live' && game.roundPhase !== 'live') {
      const winner = game.roundWinner();
      roundRecords.push({
        round: game.roundNumber,
        winner,
        captures: { ...game.captures },
        touches: { ...game.flagTouches },
        returns: { ...game.flagReturns },
        kills: { ...game.roundKills },
        pickups: roundPickups,
        deaths: roundDeaths,
        emplacements: roundEmpl,
        jeeps: roundJeeps,
        flagOutMax: roundFlagOutMax,
      });
    }
    prevPhase = game.roundPhase;
  }

  // ---- construction + bot telemetry ----
  const structuresStarted = { trench: 0, 'l-trench': 0, bunker: 0, 'bunker-ports': 0 };
  const structuresCompleted = { trench: 0, 'l-trench': 0, bunker: 0, 'bunker-ports': 0 };
  const bots = [...game.players.values()].filter((p) => p.isBotFlag);
  let blocksPlaced = 0;
  let gunsBuilt = 0;
  let botBuilders = 0;
  let gunEngineers = 0;
  const finalStates = { blue: {}, red: {} };
  for (const bot of bots) {
    blocksPlaced += bot.blocksPlaced || 0;
    if ((bot.blocksPlaced || 0) > 0) botBuilders++;
    gunsBuilt += bot.gunsBuilt || 0;
    if ((bot.gunsBuilt || 0) > 0) gunEngineers++;
    for (const kind of Object.keys(structuresStarted)) {
      structuresStarted[kind] += bot.structuresStarted?.[kind] || 0;
      structuresCompleted[kind] += bot.structuresCompleted?.[kind] || 0;
    }
    if (!bot.isDead && !bot.isSpectating) {
      finalStates[bot.team][bot.stateName] = (finalStates[bot.team][bot.stateName] ?? 0) + 1;
    }
  }

  // Final hardware picture: what is standing, what the bots chose to build, and
  // whether the support builds ever held anything.
  const standingNow = {};
  let crateStock = 0;
  let crateCount = 0;
  let postsStanding = 0;
  for (const emplacement of game.emplacements.values()) {
    standingNow[emplacement.kind] = (standingNow[emplacement.kind] ?? 0) + 1;
    if (emplacement.kind === 'supplyCrate') { crateCount++; crateStock += emplacement.stock ?? 0; }
    if (emplacement.kind === 'spottingPost') postsStanding++;
  }
  const emplacedByKind = {};
  for (const bot of bots) {
    for (const [kind, count] of Object.entries(bot.emplacedByKind ?? {})) {
      emplacedByKind[kind] = (emplacedByKind[kind] ?? 0) + count;
    }
  }

  const roundsWins = { blue: 0, red: 0, draw: 0 };
  for (const record of roundRecords) roundsWins[record.winner]++;
  // Event-based, so a round still in progress at the final frame is counted.
  const totalCaptures = { ...stats.captures };
  const stallBots = [...stuck.values()].filter((sample) => sample.episodes > 0).length;
  const worstStall = [...stuck.values()].reduce(
    (worst, sample) => (sample.max > worst.max ? sample : worst),
    { max: 0, state: '', worstAt: '', episodes: 0 },
  );
  const incompleteRound = roundRecords.length < Math.floor((MINUTES * 60) / (ROUND_SECONDS + 20));

  return {
    index,
    minutes: MINUTES,
    bots: bots.length,
    roundRecords,
    roundsWins,
    totalCaptures,
    incompleteRound,
    stats,
    structuresStarted,
    structuresCompleted,
    blocksPlaced,
    botBuilders,
    gunsBuilt,
    gunEngineers,
    botsWithBuiltGuns: [...bots].filter((b) => (b.gunsBuilt || 0) > 0).length,
    jeep: {
      ...game.botJeepStats,
      builtByTeam: jeep.builtByTeam,
      driverSeconds: Number((jeep.driverTicks / 20).toFixed(1)),
      distance: Number(jeep.distance.toFixed(1)),
      exposureSamples: jeep.samples,
      exposurePct: jeep.samples > 0 ? Math.round((jeep.exposed / jeep.samples) * 100) : 0,
      meanThreats: jeep.samples > 0 ? Number((jeep.threatSum / jeep.samples).toFixed(2)) : 0,
    },
    empl: {
      builtByKind: empl.builtByKind,
      builtByTeam: empl.builtByTeam,
      maxStanding: empl.maxStanding,
      maxStandingByKind: empl.maxStandingByKind,
      shots: empl.shots,
      shotsByKind: empl.shotsByKind,
      mounts: empl.mounts,
      mountsByKind: empl.mountsByKind,
      crewByKind: Object.fromEntries(Object.entries(empl.crewByKind).map(([kind, set]) => [kind, [...set]])),
      gunnerBots: empl.gunnerBots.size,
      emplacedByKind,
      standingNow,
      crateCount,
      crateStock,
      postsStanding,
    },
    recoveries,
    carrierDeaths,
    drops,
    carriedSeconds: Number(carriedSeconds.toFixed(1)),
    longestCarry,
    closeToFlag: closeToFlag.size,
    closestDistance: Number.isFinite(closest.distance) ? Number(closest.distance.toFixed(1)) : null,
    stateSeconds,
    stallBots,
    worstStall,
    finalStates,
    alive: bots.filter((b) => !b.isDead && !b.isSpectating).length,
  };
}

function printMatch(result) {
  const { stats, jeep, empl } = result;
  console.log('');
  console.log(`══════════ RUN ${result.index} — ${result.minutes} min, ${result.bots / 2}v${result.bots / 2}, ${ROUND_MINUTES}-min rounds ══════════`);
  console.log(`Rounds finished: ${result.roundRecords.length}` +
    (result.incompleteRound ? ' (+1 in progress at the final whistle)' : '') +
    ` | Blue ${result.roundsWins.blue} - Red ${result.roundsWins.red}${result.roundsWins.draw ? ` - Draw ${result.roundsWins.draw}` : ''}`);

  for (const record of result.roundRecords) {
    console.log(
      `  R${record.round} ${record.winner.toUpperCase().padEnd(5)} | caps ${record.captures.blue}-${record.captures.red}` +
      ` | touches ${record.touches.blue}-${record.touches.red}` +
      ` | returns ${record.returns.blue}-${record.returns.red}` +
      ` | kills ${record.kills.blue}-${record.kills.red}` +
      ` | pickups ${record.pickups} | deaths ${record.deaths}` +
      ` | empl ${record.emplacements} | jeeps ${record.jeeps}` +
      ` | flag out max ${record.flagOutMax}s`,
    );
  }

  console.log('  ── battle ──');
  console.log(`  captures ${result.totalCaptures.blue}-${result.totalCaptures.red} (total ${result.totalCaptures.blue + result.totalCaptures.red})` +
    ` | pickups ${stats.pickups} (B${stats.pickupsByTeam.blue}/R${stats.pickupsByTeam.red})` +
    ` | returns ${stats.returns}`);
  console.log(`  deaths ${stats.deaths} (B${stats.deathsByTeam.blue}/R${stats.deathsByTeam.red})` +
    ` | flag outside base ${stats.flagOutSeconds}s`);
  const caps = result.totalCaptures.blue + result.totalCaptures.red;
  console.log(`  carrier runs: ${stats.pickups} pickups, ${caps} scored (${pct(caps, stats.pickups)} conversion),` +
    ` ${result.carrierDeaths} carriers died (${pct(result.carrierDeaths, stats.pickups)}), ${result.drops} carry periods ended` +
    ` | ${result.carriedSeconds}s carried, mean ${(result.carriedSeconds / Math.max(1, stats.pickups)).toFixed(1)}s,` +
    ` longest ${result.longestCarry.seconds.toFixed(0)}s (${result.longestCarry.bot || 'n/a'})`);
  console.log(`  flag pressure: ${result.closeToFlag} bots reached the enemy stand zone (<25m),` +
    ` closest approach ${result.closestDistance ?? 'n/a'}m`);

  console.log('  ── bot blueprints / emplacements ──');
  console.log(`  built ${stats.emplacementsBuilt} | destroyed ${stats.emplacementsDestroyed}` +
    ` | peak standing B${empl.maxStanding.blue}/R${empl.maxStanding.red}` +
    ` | mounts ${empl.mounts} by ${empl.gunnerBots} bots | rounds fired ${empl.shots}`);
  const allKinds = [...new Set([...Object.keys(empl.builtByKind), ...Object.keys(empl.emplacedByKind)])];
  for (const kind of allKinds) {
    const crew = empl.crewByKind[kind]?.length ?? 0;
    console.log(`    ${kind.padEnd(12)} built ${String(empl.builtByKind[kind] ?? 0).padEnd(3)}` +
      ` standing now ${String(empl.standingNow[kind] ?? 0).padEnd(2)} peak ${String(empl.maxStandingByKind[kind] ?? 0).padEnd(2)}` +
      ` crewed by ${String(crew).padEnd(2)} bots (${empl.mountsByKind[kind] ?? 0} mounts)` +
      ` rounds fired ${empl.shotsByKind[kind] ?? 0}`);
  }
  console.log(`  support builds: supply crates ${empl.crateCount} holding ${empl.crateStock} blocks` +
    ` | spotting posts ${empl.postsStanding} | engineers who placed hardware ${result.botsWithBuiltGuns}` +
    ` (${Object.entries(empl.emplacedByKind).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'})`);
  console.log(`  engineers who placed a gun: ${result.botsWithBuiltGuns}` +
    ` | structures started ${Object.values(result.structuresStarted).reduce((a, b) => a + b, 0)}` +
    ` completed ${Object.values(result.structuresCompleted).reduce((a, b) => a + b, 0)}` +
    ` (${Object.entries(result.structuresCompleted).map(([k, n]) => `${k} ${result.structuresStarted[k]}→${n}`).join(', ')})`);
  console.log(`  blocks placed ${result.blocksPlaced} by ${result.botBuilders} bots`);

  console.log('  ── vehicles ──');
  console.log(`  jeeps built ${jeep.built ?? 0} (B${jeep.builtByTeam.blue}/R${jeep.builtByTeam.red})` +
    ` | boarded ${jeep.entered} | arrived ${jeep.arrived} | passenger rides ${jeep.passengerRides}`);
  console.log(`  driven ${jeep.driverSeconds}s / ${jeep.distance}m` +
    ` | damaged exits ${jeep.damagedExits} | stuck recoveries ${jeep.recoveries} | abandoned ${jeep.abandoned}` +
    ` | human yields ${jeep.humanYields}`);
  console.log(`  exposure while driving: ${jeep.exposurePct}% of seconds had an enemy within 60m` +
    ` (mean ${jeep.meanThreats} nearby) | arrival rate ${pct(jeep.arrived, jeep.built)}`);

  console.log('  ── stuck / stagnation ──');
  console.log(`  bot stuck recoveries ${result.recoveries} | movement stalls ≥10s ${stats.stalls} (${result.stallBots} bots)` +
    ` | ≥20s ${stats.longStalls}`);
  if (result.worstStall.max > 0) {
    console.log(`  worst stall ${result.worstStall.max}s in ${result.worstStall.state} (${result.worstStall.worstAt})`);
  }
  console.log(`  longest objective drought ${stats.maxObjectiveDrought.toFixed(0)}s (${stats.maxObjectiveDroughtAt || 'n/a'})` +
    ` | longest no-death gap ${stats.maxKillGap.toFixed(0)}s (${stats.maxKillGapAt || 'n/a'})`);
  console.log(`  final states B ${JSON.stringify(result.finalStates.blue)} | R ${JSON.stringify(result.finalStates.red)}` +
    ` | alive ${result.alive}/${result.bots}`);
  const mix = (team) => {
    const entries = Object.entries(result.stateSeconds[team]);
    const total = entries.reduce((sum, [, seconds]) => sum + seconds, 0);
    return entries.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([state, seconds]) => `${state} ${pct(seconds, total)}`).join(', ');
  };
  console.log(`  time in state: B ${mix('blue')} | R ${mix('red')}`);
}

function printSummary(results) {
  console.log('');
  console.log('══════════════════════ ACROSS ALL RUNS ══════════════════════');
  console.log('run | winner      | caps    | pickups | deaths | empl built/peak | jeeps b/a | stall bots | drought | no-death');
  for (const result of results) {
    const caps = result.totalCaptures;
    const capText = `${caps.blue}-${caps.red}`;
    const winner = result.roundsWins.blue > result.roundsWins.red ? 'BLUE'
      : result.roundsWins.red > result.roundsWins.blue ? 'RED' : 'DRAW';
    console.log(
      ` ${result.index}  | ${winner.padEnd(11)} | ${capText.padEnd(7)} | ${String(result.stats.pickups).padEnd(7)} | ` +
      `${String(result.stats.deaths).padEnd(6)} | ${String(result.stats.emplacementsBuilt).padEnd(5)}/${Math.max(result.empl.maxStanding.blue, result.empl.maxStanding.red)}` +
      `         | ${result.jeep.built ?? 0}/${result.jeep.arrived}      | ${String(result.stallBots).padEnd(10)} | ` +
      `${`${result.stats.maxObjectiveDrought.toFixed(0)}s`.padEnd(7)} | ${result.stats.maxKillGap.toFixed(0)}s`,
    );
  }
  const totals = {
    captures: results.reduce((n, r) => n + r.totalCaptures.blue + r.totalCaptures.red, 0),
    pickups: results.reduce((n, r) => n + r.stats.pickups, 0),
    deaths: results.reduce((n, r) => n + r.stats.deaths, 0),
    empl: results.reduce((n, r) => n + r.stats.emplacementsBuilt, 0),
    jeepsBuilt: results.reduce((n, r) => n + (r.jeep.built ?? 0), 0),
    jeepsArrived: results.reduce((n, r) => n + r.jeep.arrived, 0),
    gunShots: results.reduce((n, r) => n + r.empl.shots, 0),
    recoveries: results.reduce((n, r) => n + r.recoveries, 0),
    stalls: results.reduce((n, r) => n + r.stats.stalls, 0),
    rounds: results.reduce((n, r) => n + r.roundRecords.length, 0),
    zeroCapRounds: results.reduce((n, r) => n + r.roundRecords.filter((x) => x.captures.blue === 0 && x.captures.red === 0).length, 0),
  };
  console.log('');
  console.log(`Totals over ${results.length} matches: ${totals.rounds} rounds, ${totals.captures} captures, ` +
    `${totals.pickups} pickups, ${totals.deaths} deaths, ${totals.zeroCapRounds} zero-capture rounds.`);
  console.log(`Carrier deaths: ${results.reduce((n, r) => n + r.carrierDeaths, 0)}` +
    ` | bots reaching the enemy stand zone: ${results.reduce((n, r) => n + r.closeToFlag, 0)} (bot-runs)`);
  console.log(`Bots: ${totals.empl} emplacements built, ${totals.gunShots} rounds fired, ` +
    `${totals.jeepsBuilt} jeeps built and ${totals.jeepsArrived} arrived` +
    ` (${pct(totals.jeepsArrived, totals.jeepsBuilt)} arrival), ` +
    `${totals.recoveries} stuck recoveries, ${totals.stalls} movement stalls ≥10s.`);
  console.log(`Jeep exposure: ${results.reduce((n, r) => n + r.jeep.damagedExits, 0)} damaged exits, ` +
    `${results.reduce((n, r) => n + r.jeep.abandoned, 0)} abandoned, ` +
    `mean exposure ${(results.reduce((n, r) => n + r.jeep.exposurePct, 0) / results.length).toFixed(0)}% of driving seconds in rifle range`);
  const conversion = totals.pickups > 0 ? Math.round((totals.captures / totals.pickups) * 100) : 0;
  const carrierDeaths = results.reduce((n, r) => n + r.carrierDeaths, 0);
  console.log(`Conversion: ${totals.captures}/${totals.pickups} pickups scored (${conversion}%)` +
    ` | carriers killed ${carrierDeaths} (${pct(carrierDeaths, totals.pickups)})` +
    ` | mean carry ${(results.reduce((n, r) => n + r.carriedSeconds, 0) / Math.max(1, totals.pickups)).toFixed(1)}s`);
  const kinds = {};
  for (const result of results) {
    for (const [kind, count] of Object.entries(result.empl.builtByKind)) kinds[kind] = (kinds[kind] ?? 0) + count;
  }
  console.log(`Blueprint mix: ${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}` +
    ` | mean objective drought ${(results.reduce((n, r) => n + r.stats.maxObjectiveDrought, 0) / results.length).toFixed(0)}s`);
  console.log('');
}

console.log('=== BETA BATTLE SIMULATION ===');
console.log(`${RUNS} matches × ${MINUTES} min, ${ROUND_MINUTES}-min rounds, ${BOTS_PER_TEAM}v${BOTS_PER_TEAM} server bots, 20 Hz.`);

const results = [];
for (let index = 1; index <= RUNS; index++) {
  const result = runMatch(index);
  results.push(result);
  printMatch(result);
}
printSummary(results);
