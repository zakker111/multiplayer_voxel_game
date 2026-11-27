// Structures as targets and obstacles (Phase 4): rounds and shells have to be
// able to wreck a built nest, a wrecked nest has to release its gunner, and
// bots have to walk around a build instead of through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { ServerWorld } = require('../dist/tests/serverWorld.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const { emplacementSpec, WEAPONS, GROUND_LEVEL, WRECK_LIFETIME_SECONDS } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';

const SAMPLES = [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]];

const groundTop = (game, x, z) => {
  for (let y = 40; y > -20; y--) if (game.world.isSolid(Math.round(x), y, Math.round(z))) return y + 0.5;
  return null;
};

const isFlat = (game, x, z) => {
  const tops = SAMPLES.map(([ox, oz]) => groundTop(game, x + ox, z + oz));
  if (tops.some((top) => top === null)) return false;
  return Math.max(...tops) - Math.min(...tops) <= 0 && Math.max(...tops) > 0;
};

const findSpots = (game, count) => {
  const spots = [];
  for (let z = -30; z <= 30; z += 3) {
    for (let x = -60; x <= 60; x += 3) {
      if (Math.abs(x) < 15 || Math.abs(z) > 50) continue;
      if (!isFlat(game, x, z)) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 6)) continue;
      spots.push({ x, y: groundTop(game, x, z), z });
      if (spots.length >= count) return spots;
    }
  }
  return spots;
};

const join = (game, team) => {
  const frames = [];
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  const workshop = game.getWorkshops()[team].position;
  player.position = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  return { id, player, frames };
};

/** Craft and place one build for `team`; returns the live emplacement. */
const build = (game, team, kind, spot, yaw = 0) => {
  const owner = join(game, team);
  game.workshopStock[team] = 400;
  game.handleMessage(owner.id, { type: 'craftBlueprint', kind, slot: 0 });
  game.handleMessage(owner.id, { type: 'placeEmplacement', kind, position: spot, yaw, slot: 0 });
  const emplacement = [...game.emplacements.values()].find((e) => e.kind === kind && e.team === team);
  assert.ok(emplacement, `the ${team} ${kind} was placed`);
  return { emplacement, owner };
};

/** Put a shooter on the pad and fire one round at `targetPoint`. */
const shootAt = (game, shooter, targetPoint) => {
  const player = game.players.get(shooter.id);
  const origin = { x: player.position.x, y: player.position.y + 1.6, z: player.position.z };
  const dx = targetPoint.x - origin.x;
  const dy = targetPoint.y - origin.y;
  const dz = targetPoint.z - origin.z;
  const len = Math.hypot(dx, dy, dz);
  game.handleMessage(shooter.id, {
    type: 'shoot',
    origin,
    direction: { x: dx / len, y: dy / len, z: dz / len },
  });
};

test('an enemy nest is a hittable target and a friendly one is not', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);
  const maxHp = emplacementSpec('mgNest').maxHp;
  assert.equal(nest.hp, maxHp);

  const origin = { x: spot.x, y: spot.y + 1.6, z: spot.z + 2.5 };
  const toward = (point) => {
    const dx = point.x - origin.x, dy = point.y - origin.y, dz = point.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    return { x: dx / len, y: dy / len, z: dz / len };
  };
  const aim = toward({ x: nest.position.x, y: nest.position.y + 0.8, z: nest.position.z });

  const enemy = game.hitEmplacement(origin, aim, 40, 'red');
  assert.ok(enemy, 'a red round finds the blue nest');
  assert.equal(enemy.emplacement.id, nest.id);
  assert.ok(enemy.distance > 0 && enemy.distance < 3, 'the hit is measured at the nest');

  assert.equal(game.hitEmplacement(origin, aim, 40, 'blue'), null, 'blue rounds pass through their own build');
});

test('a rifle round dents an enemy nest', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);
  const shooter = join(game, 'red');
  shooter.player.position = { x: spot.x, y: spot.y, z: spot.z + 2.5 };

  const before = nest.hp;
  shootAt(game, shooter, { x: nest.position.x, y: nest.position.y + 0.8, z: nest.position.z });
  assert.ok(nest.hp < before, `the nest took damage (${before} -> ${nest.hp})`);
  assert.ok(nest.hp > 0, 'one rifle round does not flatten a nest');
});

test('a rifle round aimed at your own build leaves it alone', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);
  const shooter = join(game, 'blue');
  shooter.player.position = { x: spot.x, y: spot.y, z: spot.z + 2.5 };

  const before = nest.hp;
  shootAt(game, shooter, { x: nest.position.x, y: nest.position.y + 0.8, z: nest.position.z });
  assert.equal(nest.hp, before, 'no friendly structure damage');
});

test('a wrecked nest smokes, releases its gunner and frees the slot', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest, owner } = build(game, 'blue', 'mgNest', spot);
  owner.player.position = { x: spot.x + 1.5, y: spot.y, z: spot.z };
  game.handleMessage(owner.id, { type: 'mountEmplacement', emplacementId: nest.id });
  assert.equal(nest.gunnerId, owner.id, 'the gunner is in the nest');

  game.damageEmplacement(nest.id, emplacementSpec('mgNest').maxHp + 50);

  const wreck = game.emplacements.get(nest.id);
  assert.ok(wreck, 'the wreck stays on the map');
  assert.equal(wreck.wreck, true, 'it is marked as a wreck');
  assert.equal(wreck.hp, 0, 'it has no health left');
  assert.equal(wreck.ammo, 0, 'its belt is gone');
  assert.equal(wreck.gunnerId, null, 'nobody is seated');
  assert.equal(game.gunnerEmplacement(owner.id), undefined, 'the gunner is no longer mounted');
  assert.ok(owner.frames.some((f) => f.type === 'emplacementsUpdated'
    && f.emplacements.length === 1 && f.emplacements[0].wreck === true),
    'clients are told to draw a smoking wreck');

  game.update(WRECK_LIFETIME_SECONDS - 1);
  assert.equal(game.emplacements.has(nest.id), true, 'the wreck is still there just before three minutes');
  game.update(1.1);
  assert.equal(game.emplacements.has(nest.id), false, 'the wreck disappears after three minutes');
});

test('a smoking wreck no longer counts against the team limit', () => {
  const game = new ServerGame();
  const [first, second] = findSpots(game, 2);
  const { emplacement: cannon } = build(game, 'blue', 'cannon', first);
  game.damageEmplacement(cannon.id, 99999);
  assert.equal(cannon.wreck, true, 'the cannon is a wreck');

  const owner = join(game, 'blue');
  game.workshopStock.blue = 400;
  game.handleMessage(owner.id, { type: 'craftBlueprint', kind: 'cannon', slot: 0 });
  game.handleMessage(owner.id, { type: 'placeEmplacement', kind: 'cannon', position: second, yaw: 0, slot: 0 });

  const live = [...game.emplacements.values()].filter((e) => e.kind === 'cannon' && !e.wreck);
  assert.equal(live.length, 1, 'a replacement cannon can be placed while the old one smokes');
  assert.equal(game.emplacements.size, 2, 'both the wreck and the new gun are on the map');
});

test('rifle fire that wrecks a nest ejects the gunner standing in it', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest, owner: gunner } = build(game, 'blue', 'mgNest', spot);
  gunner.player.position = { x: spot.x + 1.5, y: spot.y, z: spot.z };
  game.handleMessage(gunner.id, { type: 'mountEmplacement', emplacementId: nest.id });
  assert.equal(nest.gunnerId, gunner.id, 'the gunner is in the nest');

  const shooter = join(game, 'red');
  shooter.player.position = { x: spot.x, y: spot.y, z: spot.z + 2.5 };
  const aim = { x: nest.position.x, y: nest.position.y + 0.8, z: nest.position.z };
  // A 300 hp nest takes five 65-damage rifle rounds; clear the fire gate so the
  // test does not wait out the real cadence between shots.
  for (let i = 0; i < 5; i++) {
    game.lastShootTime.delete(shooter.id);
    shootAt(game, shooter, aim);
  }

  assert.equal(game.emplacements.get(nest.id)?.wreck, true, 'the nest is a smoking wreck');
  assert.equal(game.gunnerEmplacement(gunner.id), undefined, 'the gunner was freed');
  assert.ok(gunner.frames.some((f) => f.type === 'emplacementExited'), 'the gunner is told they are out');
  assert.ok(Math.hypot(
    gunner.player.position.x - spot.x,
    gunner.player.position.z - spot.z,
  ) > 1, 'the gunner was set down clear of the wreck');
});

test('a manned nest wrecks an enemy build and ejects its gunner', () => {
  const game = new ServerGame();
  const [blueSpot, redSpot] = findSpots(game, 2);
  const { emplacement: blueNest, owner: blueGunner } = build(game, 'blue', 'mgNest', blueSpot);
  blueGunner.player.position = { ...blueNest.position };
  game.handleMessage(blueGunner.id, { type: 'mountEmplacement', emplacementId: blueNest.id });
  assert.equal(blueNest.gunnerId, blueGunner.id, 'the blue nest is manned');

  const yaw = Math.atan2(-(blueNest.position.x - redSpot.x), -(blueNest.position.z - redSpot.z));
  const { emplacement: redNest, owner: redGunner } = build(game, 'red', 'mgNest', redSpot, yaw);
  redGunner.player.position = { ...redNest.position };
  game.handleMessage(redGunner.id, { type: 'mountEmplacement', emplacementId: redNest.id });
  assert.equal(redNest.gunnerId, redGunner.id, 'the red nest is manned');

  const maxHp = emplacementSpec('mgNest').maxHp;
  const gunnerHp = blueGunner.player.hp;
  game.handleMessage(redGunner.id, { type: 'fireEmplacement' });
  assert.ok(blueNest.hp < maxHp, 'one nest round dents the enemy build');
  assert.equal(blueGunner.player.hp, gunnerHp, 'the round stops at the build, not the gunner behind it');

  // Ten 30-damage rounds finish the 300 hp nest.
  for (let i = 0; i < 9 && !game.emplacements.get(blueNest.id)?.wreck; i++) {
    game.update(0.1);
    game.handleMessage(redGunner.id, { type: 'fireEmplacement' });
  }

  assert.equal(game.emplacements.get(blueNest.id)?.wreck, true, 'the enemy nest is a smoking wreck');
  assert.equal(game.gunnerEmplacement(blueGunner.id), undefined, 'its gunner is no longer seated');
  assert.ok(blueGunner.frames.some((f) => f.type === 'emplacementExited'), 'the gunner is told they are out');
  assert.equal(game.emplacements.get(redNest.id)?.wreck, false, 'the firing nest survived');
});

test('shell splash wrecks enemy structures and spares friendly ones', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);
  const shellAt = (team) => ({
    id: `shell-${team}`,
    kind: 'cannon',
    team,
    ownerId: null,
    position: { x: spot.x + 2, y: spot.y + 1, z: spot.z },
    velocity: { x: 0, y: 0, z: 0 },
  });

  game.explodeShell(shellAt('blue'), shellAt('blue').position);
  assert.equal(nest.hp, emplacementSpec('mgNest').maxHp, 'a friendly shell does not scratch it');

  game.explodeShell(shellAt('red'), shellAt('red').position);
  assert.ok(nest.hp < emplacementSpec('mgNest').maxHp, 'an enemy shell does');
});

test('the bot context treats a build footprint as unsteppable', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);
  const ctx = game.getBotContext();
  assert.equal(typeof ctx.blockedBy, 'function', 'bots are given the structure test');
  assert.equal(ctx.blockedBy(spot.x, spot.z), true, 'the nest centre is blocked');
  const spec = emplacementSpec('mgNest');
  assert.equal(ctx.blockedBy(spot.x + spec.halfWidth + 1.5, spot.z), false, 'the ground beside it is not');
});

test('a bot steers around a blocked footprint instead of walking into it', () => {
  const world = new ServerWorld();
  const ctx = {
    world,
    serverTime: 0,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
    blockedBy: (x) => Math.abs(x - 8) < 2,
  };
  const bot = new ServerBot('path-test', { x: 2, y: GROUND_LEVEL, z: 0 }, 'blue', 'Runner');
  let entered = false;
  for (let tick = 0; tick < 120; tick++) {
    ctx.serverTime += 1 / 20;
    bot.moveTo({ x: 16, y: GROUND_LEVEL, z: 0 }, 1 / 20, ctx, false);
    if (Math.abs(bot.position.x - 8) < 2 - 0.6) entered = true;
  }
  assert.equal(entered, false, 'the bot never stood inside the footprint');
  assert.ok(bot.position.x > 3, 'it still made progress toward the far side');
});

test('a flag carrier never walls off its own run home', () => {
  // Regression: a carrier wedged in front of a crate screened itself in, one
  // 2-high column every 1.6s toward the chaser, and held the flag for 623s.
  const world = new ServerWorld();
  const ctx = {
    world,
    serverTime: 100,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
  };
  const bot = new ServerBot('carrier-cover-test', { x: 0, y: GROUND_LEVEL, z: 100 }, 'red', 'Carrier');
  bot.carryingFlag = true;
  bot.botBlocks = 30;
  let columns = 0;
  bot.tryBuildColumnAt = () => { columns++; };

  // The chaser is between the carrier and its own stand (red base is z=160):
  // a column here would land across the run home, so nothing may be built.
  ctx.serverTime = 100;
  bot.buildPanicCover({ x: 0, y: GROUND_LEVEL, z: 150 }, ctx, 100, 1.6, 2);
  assert.equal(columns, 0, 'no cover between the carrier and home');

  // A chaser behind the carrier is what screening is for.
  ctx.serverTime = 102;
  bot.buildPanicCover({ x: 0, y: GROUND_LEVEL, z: 40 }, ctx, 102, 1.6, 2);
  assert.equal(columns, 1, 'cover behind the carrier still goes up');
});

test('a pacing bot keeps its detour side instead of mirroring into a deadlock', () => {
  // Regression: when a wall ahead left only sideways steps, the probe loop
  // picked one side and the next tick's fallback picked the other, cancelling
  // out. A carrier in that state held the flag for 623s.
  const world = new ServerWorld();
  const ctx = {
    world,
    serverTime: 100,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
    // A wall ahead that only extends west of x=3: going around it eastward
    // opens the direct route, exactly like a crate beside the flag stand.
    blockedBy: (x, z) => z > 0.5 && x < 3,
  };
  const bot = new ServerBot('pacing-test', { x: 0, y: GROUND_LEVEL, z: 0 }, 'blue', 'Pacer');
  bot.detourDir = -1; // committed to +x (the side that gets around the wall)
  bot.detourUntil = 100.8;

  for (let tick = 0; tick < 80; tick++) {
    ctx.serverTime += 1 / 20;
    bot.lastStuckAt = ctx.serverTime; // the objective run is still making no headway
    bot.moveTo({ x: 0, y: GROUND_LEVEL, z: 20 }, 1 / 20, ctx, false);
    assert.ok(bot.position.x >= -0.1, 'never mirrors onto the uncommitted side');
  }
  assert.ok(bot.position.x > 3, 'the committed side actually gets around the wall');
  assert.ok(bot.position.z > 2, 'and then makes progress toward the objective');
});

test('a fully blocked bot holds its slide side for a beat', () => {
  // Regression: the fallback direction must be re-rolled every 0.8s, not every
  // tick. Re-rolling each tick turns a slide along a wall into a jitter on the
  // spot (it cost ~15 pickups on seeded matches when it slipped in).
  const world = new ServerWorld();
  const ctx = {
    world,
    serverTime: 100,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
    blockedBy: () => true, // every probe is blocked -> pure fallback slide
  };
  const bot = new ServerBot('slide-test', { x: 0, y: GROUND_LEVEL, z: 0 }, 'blue', 'Slider');
  const realRandom = Math.random;
  let roll = 0;
  Math.random = () => (roll++ % 2 === 0 ? 0.1 : 0.9); // alternate the side on every roll
  const signs = [];
  try {
    for (let tick = 0; tick < 16; tick++) {
      ctx.serverTime += 1 / 20;
      bot.moveTo({ x: 0, y: GROUND_LEVEL, z: 20 }, 1 / 20, ctx, false);
      signs.push(Math.sign(bot.velocity.x));
    }
  } finally {
    Math.random = realRandom;
  }
  assert.equal(new Set(signs).size, 1, 'one side for the whole 0.8s window');
});

test('a bot treats an enemy nest as a visible target in the shared context', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);
  // The context lists both teams' builds; each bot filters its own side out.
  const ctx = game.getBotContext();
  const blueBuilds = ctx.targets.filter((t) => t.emplacement && t.team === 'blue');
  const redBuilds = ctx.targets.filter((t) => t.emplacement && t.team === 'red');
  assert.equal(blueBuilds.length, 1, 'the blue nest is in the shared target list');
  assert.equal(blueBuilds[0].emplacement?.kind, 'mgNest', 'the nest carries its kind');
  assert.equal(blueBuilds[0].emplacement?.manned, false, 'an unmanned nest is not manned');
  assert.equal(redBuilds.length, 0, 'no red builds leak into the list');
});

test('a bot engages a manned enemy nest instead of ignoring it', () => {
  // Headless bots with a mocked world: the bot sees a manned red nest and
  // switches to ENGAGE to fight it, then fires at it.
  const world = new ServerWorld();
  const nestPos = { x: 20, y: GROUND_LEVEL, z: 0 };
  const nestId = 'red-nest';
  let firedAt = null;
  const ctx = {
    world,
    serverTime: 0,
    targets: [
      {
        id: nestId,
        position: nestPos,
        team: 'red',
        isDead: false,
        carryingFlag: false,
        emplacement: { id: nestId, kind: 'mgNest', manned: true },
      },
    ],
    friendlyDroppedFlagPos: null,
    canSee: (from, to) => Math.hypot(from.x - to.x, from.z - to.z) < 45,
    fireWeapon: () => { throw new Error('should not fire at a player target') },
    fireAtEmplacement: (_bot, id, _dir, _eye) => { firedAt = id; },
    buildBlock: () => {},
    blockedBy: (x, z) => Math.abs(x - nestPos.x) < 3 && Math.abs(z - nestPos.z) < 2.5,
  };
  const bot = new ServerBot('engager', { x: 0, y: GROUND_LEVEL, z: 0 }, 'blue', 'Hunter');
  bot.equipment = 'rifle';
  bot.currentAmmo = 30;
  bot.magazineSize = 30;

  // Run long enough for the bot to notice the nest and switch states.
  for (let tick = 0; tick < 300; tick++) {
    ctx.serverTime += 1 / 20;
    bot.botUpdate(1 / 20, ctx);
    if (firedAt) break;
  }
  assert.equal(firedAt, nestId, 'the bot fired at the manned nest');
  assert.equal(bot.stateName, 'ENGAGE', 'the bot entered ENGAGE to fight the nest');
});

test('a bot round damages an enemy build and never its own', () => {
  // Regression: botShoot looked for an 'emplace-' id prefix while the server
  // issues 'emp_<n>', so every bot round aimed at a build was silently dropped.
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest } = build(game, 'blue', 'mgNest', spot);

  const redId = game.addBot('red', 'Red-Shooter');
  const redBot = game.players.get(redId);
  const blueId = game.addBot('blue', 'Blue-Shooter');
  const blueBot = game.players.get(blueId);
  redBot.position = { x: spot.x, y: spot.y, z: spot.z + 6 };
  blueBot.position = { x: spot.x, y: spot.y, z: spot.z + 5 };
  redBot.equipment = 'rifle';
  blueBot.equipment = 'rifle';

  const ctx = game.getBotContext();
  const target = ctx.targets.find((t) => t.id === nest.id);
  assert.ok(target?.emplacement, 'the build is in the shared target list');

  const shotFrom = (bot) => {
    const origin = { x: bot.position.x, y: bot.position.y + 1.6, z: bot.position.z };
    const point = { x: nest.position.x, y: nest.position.y + 0.8, z: nest.position.z };
    const dx = point.x - origin.x, dy = point.y - origin.y, dz = point.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    return { x: dx / len, y: dy / len, z: dz / len };
  };

  const startingHp = nest.hp;
  for (let i = 0; i < 3; i++) ctx.fireWeapon(redBot, target, shotFrom(redBot), 1.6);
  assert.ok(nest.hp < startingHp, `a bot round damages the enemy nest (${startingHp} -> ${nest.hp})`);

  const afterEnemyFire = nest.hp;
  for (let i = 0; i < 3; i++) ctx.fireWeapon(blueBot, target, shotFrom(blueBot), 1.6);
  assert.equal(nest.hp, afterEnemyFire, 'a bot never damages its own team\'s build');
});

const nestArena = (manned, startDist = 20) => {
  const bot = new ServerBot('standoff', { x: 0, y: GROUND_LEVEL, z: 0 }, 'blue', 'Sapper');
  bot.equipment = 'rifle';
  bot.currentAmmo = 30;
  bot.magazineSize = 30;
  const nestPos = { x: startDist, y: GROUND_LEVEL, z: 0 };
  const ctx = {
    world: new ServerWorld(),
    serverTime: 0,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => true,
    fireWeapon: () => {},
    buildBlock: () => {},
    blockedBy: (x, z) => Math.abs(x - nestPos.x) < 1.6 && Math.abs(z - nestPos.z) < 1.6,
  };
  const target = {
    id: 'red-nest',
    position: nestPos,
    team: 'red',
    isDead: false,
    carryingFlag: false,
    emplacement: { id: 'red-nest', kind: 'mgNest', manned },
  };
  // botUpdate() enters ENGAGE before acting it out; the harness has to match,
  // otherwise leaving ENGAGE later is a no-op and the reset is never exercised.
  bot.transition('ENGAGE', 0, 4);
  return { bot, ctx, target, nestPos };
};

/** Drive one doEngage tick loop and report how close the bot ever got. */
const driveEngage = (bot, ctx, target, nestPos, ticks) => {
  const gap = () => Math.hypot(nestPos.x - bot.position.x, nestPos.z - bot.position.z);
  let closest = Infinity;
  for (let tick = 0; tick < ticks; tick++) {
    ctx.serverTime += 0.05;
    bot.doEngage(target, gap(), ctx, ctx.serverTime);
    closest = Math.min(closest, gap());
  }
  return { closest, final: gap() };
};

const engageNest = (manned, ticks, startDist = 20) => {
  const arena = nestArena(manned, startDist);
  return { ...arena, ...driveEngage(arena.bot, arena.ctx, arena.target, arena.nestPos, ticks) };
};

test('a bot engaging a manned nest out-ranges it instead of walking into the muzzle', () => {
  // A manned nest outguns a rifle inside its reach, so a bot that finds itself
  // in the kill zone backs out past maxRange and answers with rifle fire
  // (140m full range) instead of charging the muzzle.
  const reach = emplacementSpec('mgNest').maxRange;
  const { closest, final } = engageNest(true, 160, 60);
  assert.ok(closest >= 59.5, `the bot never dives on the gun (closest ${closest.toFixed(1)}m)`);
  assert.ok(final >= reach, `it pulls back outside the gun's reach (final ${final.toFixed(1)}m)`);
});

test('a bot that breaks off and re-engages the same nest gets a fresh standoff window', () => {
  // Regression: the standoff clock is per target id and was never cleared. A
  // bot that left ENGAGE and met the same nest again saw `t - suppressSince`
  // already past the 6s cap on its first tick back, so it charged the muzzle
  // it had just backed away from.
  const reach = emplacementSpec('mgNest').maxRange;
  const { bot, ctx, target, nestPos, final } = engageNest(true, 160, 60);
  assert.ok(final >= reach, `the first fight backs out past the gun (final ${final.toFixed(1)}m)`);

  // Break off, then meet the same gun again from far out — the range a bot
  // actually sights a build at (130m). With the stale clock the old code saw
  // "already waited 6s" and walked straight at the muzzle; a fresh window has
  // it walk to the standoff ring and hold.
  bot.transition('ADVANCE', ctx.serverTime, 1);
  bot.position = { x: nestPos.x - 120, y: GROUND_LEVEL, z: nestPos.z };
  bot.transition('ENGAGE', ctx.serverTime, 4);

  // Five seconds, still inside the fresh 6s cap: no charge.
  const again = driveEngage(bot, ctx, target, nestPos, 100);
  assert.ok(again.closest >= reach + 10,
    `the bot holds its ring instead of charging in (closest ${again.closest.toFixed(1)}m)`);
});

test('a bot that switches target and back to the same nest also restarts the clock', () => {
  const { bot, ctx, target, nestPos } = engageNest(true, 160, 60);
  const reach = emplacementSpec('mgNest').maxRange;
  // A rifleman steals the bot's attention while it never leaves ENGAGE.
  const player = {
    id: 'red-rifle',
    position: { x: nestPos.x - 50, y: GROUND_LEVEL, z: 30 },
    team: 'red',
    isDead: false,
    carryingFlag: false,
  };
  ctx.serverTime += 0.05;
  bot.doEngage(player, 55, ctx, ctx.serverTime);
  // Back on the nest, sighted from far out again.
  bot.position = { x: nestPos.x - 120, y: GROUND_LEVEL, z: nestPos.z };

  const again = driveEngage(bot, ctx, target, nestPos, 100);
  assert.ok(again.closest >= reach + 10,
    `the nest gets a full window again (closest ${again.closest.toFixed(1)}m)`);
});

test('a bot engaging an unmanned build closes to a standoff instead of into it', () => {
  const { closest } = engageNest(false, 120);
  assert.ok(closest <= 13, `the bot closes in to fight the build (closest ${closest.toFixed(1)}m)`);
  assert.ok(closest >= 10.5, `but stops outside its footprint (closest ${closest.toFixed(1)}m)`);
});

test('a bot routes around an emplacement instead of walking into it', () => {
  const world = new ServerWorld();
  const nestX = 10;
  const ctx = {
    world,
    serverTime: 0,
    targets: [
      {
        id: 'enemy-nest',
        position: { x: nestX, y: GROUND_LEVEL, z: 0 },
        team: 'red',
        isDead: false,
        carryingFlag: false,
        emplacement: { id: 'enemy-nest', kind: 'mgNest', manned: true },
      },
    ],
    friendlyDroppedFlagPos: null,
    canSee: () => true,
    fireWeapon: () => {},
    fireAtEmplacement: () => {},
    buildBlock: () => {},
    blockedBy: (x, z) => Math.abs(x - nestX) < 3 && Math.abs(z - 0) < 2.5,
  };
  const bot = new ServerBot('router', { x: 0, y: GROUND_LEVEL, z: 8 }, 'blue', 'Runner');
  let enteredFootprint = false;
  for (let tick = 0; tick < 200; tick++) {
    ctx.serverTime += 1 / 20;
    // Move toward a point on the far side of the nest.
    bot.moveTo({ x: nestX, y: GROUND_LEVEL, z: -8 }, 1 / 20, ctx, false);
    if (Math.abs(bot.position.x - nestX) < 3 - 0.5 && Math.abs(bot.position.z - 0) < 2.5 - 0.5) {
      enteredFootprint = true;
    }
  }
  assert.equal(enteredFootprint, false, 'the bot never stood inside the nest footprint');
  // It should have gone around to the other side.
  assert.ok(Math.abs(bot.position.z + 8) < 4 || Math.abs(bot.position.x - nestX) > 4,
    'the bot made progress past the nest');
});
