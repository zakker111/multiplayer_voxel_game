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
const { emplacementSpec, WEAPONS, GROUND_LEVEL } = require('../dist/tests/sharedTypes.cjs');
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

test('a wrecked nest is removed and its gunner is set down', () => {
  const game = new ServerGame();
  const [spot] = findSpots(game, 1);
  const { emplacement: nest, owner } = build(game, 'blue', 'mgNest', spot);
  owner.player.position = { x: spot.x + 1.5, y: spot.y, z: spot.z };
  game.handleMessage(owner.id, { type: 'mountEmplacement', emplacementId: nest.id });
  assert.equal(nest.gunnerId, owner.id, 'the gunner is in the nest');

  game.damageEmplacement(nest.id, emplacementSpec('mgNest').maxHp + 50);

  assert.equal(game.emplacements.size, 0, 'the wreck is gone');
  assert.equal(game.gunnerEmplacement(owner.id), undefined, 'the gunner is no longer mounted');
  assert.ok(owner.frames.some((f) => f.type === 'emplacementsUpdated' && f.emplacements.length === 0),
    'clients are told the build is gone');
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

  assert.equal(game.emplacements.has(nest.id), false, 'the nest is destroyed by gunfire');
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
  for (let i = 0; i < 9 && game.emplacements.has(blueNest.id); i++) {
    game.update(0.1);
    game.handleMessage(redGunner.id, { type: 'fireEmplacement' });
  }

  assert.equal(game.emplacements.has(blueNest.id), false, 'the enemy nest is destroyed');
  assert.equal(game.gunnerEmplacement(blueGunner.id), undefined, 'its gunner is no longer seated');
  assert.ok(blueGunner.frames.some((f) => f.type === 'emplacementExited'), 'the gunner is told they are out');
  assert.ok(game.emplacements.has(redNest.id), 'the firing nest survived');
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
