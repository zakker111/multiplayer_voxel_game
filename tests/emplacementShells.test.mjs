// Cannon and mortar shells (Phase 4): server-stepped projectiles with travel
// time, terrain collisions, splash damage and the gun rules around them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const {
  emplacementSpec, EMPLACEMENT_SHELL_GRAVITY, CANNON_BLAST_RADIUS, CANNON_BLAST_DAMAGE,
  MORTAR_BLAST_RADIUS, MANNED_EMPLACEMENTS,
} = require('../dist/tests/sharedTypes.cjs');
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

const join = (game, team, frames = []) => {
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  const workshop = game.getWorkshops()[team].position;
  player.position = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  return { id, player, frames };
};

/** Craft, place and man a gun of `kind`, returning it and the gunner. */
const manGun = (game, kind, team = 'blue') => {
  const frames = [];
  const gunner = join(game, team, frames);
  const [spot] = findSpots(game, 1);
  game.workshopStock[team] = 400;
  game.handleMessage(gunner.id, { type: 'craftBlueprint', kind, slot: 0 });
  game.handleMessage(gunner.id, { type: 'placeEmplacement', kind, position: spot, yaw: 0, slot: 0 });
  const gun = [...game.emplacements.values()][0];
  assert.ok(gun, `the ${kind} was placed`);
  gunner.player.position = { ...gun.position };
  game.handleMessage(gunner.id, { type: 'mountEmplacement', emplacementId: gun.id });
  assert.equal(gun.gunnerId, gunner.id, `the ${kind} is manned`);
  return { gun, gunner, frames };
};

/** Advance the server simulation for `seconds` at a fixed 20Hz tick. */
const run = (game, seconds) => {
  const step = 1 / 20;
  for (let t = 0; t < seconds; t += step) game.update(step);
};

test('the armed builds all carry a fire interval, the support builds none', () => {
  for (const kind of ['mgNest', 'cannon', 'mortar']) {
    assert.ok(emplacementSpec(kind).fireInterval > 0, `${kind} has a cadence`);
    assert.ok(MANNED_EMPLACEMENTS.includes(kind), `${kind} can be manned`);
  }
  for (const kind of ['supplyCrate', 'spottingPost']) {
    assert.equal(emplacementSpec(kind).fireInterval, 0, `${kind} never fires`);
    assert.equal(MANNED_EMPLACEMENTS.includes(kind), false, `${kind} is not a seat`);
  }
  assert.ok(emplacementSpec('cannon').fireInterval > emplacementSpec('mgNest').fireInterval, 'a cannon reloads slower than a belt feeds');
});

test('firing a cannon puts a shell in the air instead of a hitscan', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const startAmmo = gun.ammo;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  assert.equal(gun.ammo, startAmmo - 1, 'the shell left the barrel');
  const shells = [...game.shells.values()];
  assert.equal(shells.length, 1, 'one shell is in flight');
  assert.equal(shells[0].kind, 'cannon');
  assert.ok(shells[0].velocity.z < 0, 'yaw 0 fires down -z, like the rest of the game');
  assert.ok(Math.abs(shells[0].velocity.y) < 5, 'a cannon round is flat');
  assert.equal(gun.ammo, startAmmo - 1, 'the round cost ammo exactly once');
  assert.ok(gunner.frames.some((f) => f.type === 'shellFired'), 'clients are told a shell is up');
});

test('a shell flies for a while, falls under gravity and detonates on terrain', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const startY = gun.position.y;
  // Elevate the barrel so the round clears the flat pad it was built on.
  game.handleMessage(gunner.id, {
    type: 'playerInput',
    input: { moveX: 0, moveZ: 0, jump: false, crouch: false, sprint: false, yaw: 0, pitch: 0.3 },
  });
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  const shell = [...game.shells.values()][0];
  const firedVelocityY = shell.velocity.y;
  assert.ok(firedVelocityY > 10, 'the gunner can elevate a cannon round');

  run(game, 0.25); // five ticks

  assert.equal(game.shells.size, 1, 'still in the air after a quarter second');
  assert.ok(shell.position.z < gun.position.z - 5, 'it travelled away from the gun');
  assert.ok(shell.velocity.y < firedVelocityY - EMPLACEMENT_SHELL_GRAVITY * 0.2, 'gravity pulled it down');

  run(game, 5);

  assert.equal(game.shells.size, 0, 'the round came down');
  const impacts = gunner.frames.filter((f) => f.type === 'shellImpact');
  assert.ok(impacts.length >= 1, 'clients get the impact');
  assert.equal(impacts[0].kind, 'cannon');
  assert.equal(impacts[0].radius, CANNON_BLAST_RADIUS);
  assert.ok(gun.position.y >= startY - 1, 'the gun itself did not move');
});

test('the blast hurts enemies by distance and leaves teammates alone', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const near = join(game, 'red');
  const far = join(game, 'red');
  const mate = join(game, 'blue');
  game.spawnProtectedUntil.delete(near.id);
  game.spawnProtectedUntil.delete(far.id);
  game.spawnProtectedUntil.delete(mate.id);
  const nest = { x: gun.position.x, y: gun.position.y + 1, z: gun.position.z - 6 };
  near.player.position = { x: nest.x, y: nest.y - 1, z: nest.z };
  far.player.position = { x: nest.x + CANNON_BLAST_RADIUS - 0.5, y: nest.y - 1, z: nest.z };
  mate.player.position = { x: nest.x + 0.5, y: nest.y - 1, z: nest.z };

  const nearHp = near.player.hp;
  const farHp = far.player.hp;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  const shell = [...game.shells.values()][0];
  game.explodeShell(shell, nest);

  assert.ok(near.player.hp < nearHp, 'the enemy at the centre is hit');
  assert.ok(far.player.hp < farHp, 'the enemy at the edge is hit too');
  assert.ok(near.player.hp < far.player.hp, 'but the centre hurts more than the edge');
  assert.equal(mate.player.hp, 100, 'a teammate is never caught by a friendly shell');
  assert.ok(CANNON_BLAST_DAMAGE > 0);
});

test('a shell removes the terrain it lands on and tells clients', () => {
  const game = new ServerGame();
  const frames = [];
  const { gun, gunner } = manGun(game, 'cannon', 'blue');
  join(game, 'red', frames);

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  run(game, 3);

  const voxels = frames.filter((f) => f.type === 'voxelChanged' && f.change.type === 0);
  assert.ok(voxels.length > 0, 'the crater reached the clients');
});

test('the mortar lobs on a high arc, slower than the cannon', () => {
  const game = new ServerGame();
  const { gunner } = manGun(game, 'mortar');

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  const shell = [...game.shells.values()][0];
  assert.equal(shell.kind, 'mortar');
  assert.ok(shell.velocity.y > 20, 'it goes up');
  assert.ok(Math.hypot(shell.velocity.x, shell.velocity.z) < 40, 'and forward slower than a cannon round');

  const climb = shell.position.y;
  run(game, 0.5);
  assert.ok(shell.position.y > climb, 'the round is still rising');
  assert.equal(MORTAR_BLAST_RADIUS > CANNON_BLAST_RADIUS, true, 'the mortar splashes wider');
});

test('a cannon cannot fire twice inside its reload', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const startAmmo = gun.ammo;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  assert.equal(gun.ammo, startAmmo - 1, 'the reload holds the second round');

  game.world.updateTime(emplacementSpec('cannon').fireInterval + 0.1);
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  assert.equal(gun.ammo, startAmmo - 2, 'and lets it go once the reload is done');
});

test('an empty cannon stays silent', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  gun.ammo = 1;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  game.world.updateTime(5);
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  assert.equal(gun.ammo, 0, 'ammo never goes negative');
  assert.ok(
    gunner.frames.some((f) => f.type === 'emplacementMessage' && /out of rounds/i.test(f.message)),
    'the gunner hears the click',
  );
});

test('a round reset takes the shells with it', () => {
  const game = new ServerGame();
  const { gunner } = manGun(game, 'mortar');
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  assert.equal(game.shells.size, 1);

  game.startNextRound();

  assert.equal(game.shells.size, 0, 'no shells outlive the round');
  assert.equal(game.emplacements.size, 0);
});
