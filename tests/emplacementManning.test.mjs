// Manning a built emplacement (Phase 4): the seat, the arc, the gun and the
// ways a gunner leaves it. The server owns all of it; the client only asks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { EMPLACEMENTS, emplacementSpec, EMPLACEMENT_MOUNT_REACH, MANNED_EMPLACEMENTS } = require('../dist/tests/sharedTypes.cjs');
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

/** Flat mid-map spots clear of the bases, workshops and flag stands. */
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

const benchFor = (game, team) => {
  const workshop = game.getWorkshops()[team].position;
  return { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
};

const join = (game, team, frames = []) => {
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  player.position = { ...benchFor(game, team) };
  return { id, player, frames };
};

/** Build a manned-ready nest for `team` at `spot` and stand the owner next to it. */
const nestAt = (game, id, player, spot, yaw = 0) => {
  game.workshopStock[player.team] = 400;
  game.handleMessage(id, { type: 'craftBlueprint', kind: 'mgNest', slot: 0 });
  game.handleMessage(id, { type: 'placeEmplacement', kind: 'mgNest', position: spot, yaw, slot: 0 });
  const nest = [...game.emplacements.values()][0];
  assert.ok(nest, 'the nest was placed');
  return nest;
};

const mount = (game, id, nest) =>
  game.handleMessage(id, { type: 'mountEmplacement', emplacementId: nest.id });

test('the armed builds are seats, the support builds are not', () => {
  const armed = ['mgNest', 'cannon', 'mortar'];
  assert.deepEqual([...MANNED_EMPLACEMENTS].sort(), [...armed].sort(), 'every gun can be manned');
  for (const kind of Object.keys(EMPLACEMENTS)) {
    const manned = MANNED_EMPLACEMENTS.includes(kind);
    assert.equal(manned, armed.includes(kind), `${kind} manning matches its role`);
  }
});

test('a gunner must be close, on the same team, and find the seat free', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot);

  // Standing at the bench, metres away.
  mount(game, blue.id, nest);
  assert.equal(nest.gunnerId, null, 'cannot man a nest from across the map');

  // Close enough now.
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);
  assert.equal(nest.gunnerId, blue.id, 'a nearby owner mans the nest');

  // A second player, including the other team, is refused.
  const red = join(game, 'red');
  red.player.position = { ...nest.position };
  game.handleMessage(red.id, { type: 'mountEmplacement', emplacementId: nest.id });
  assert.equal(nest.gunnerId, blue.id, 'the seat stays with its gunner');
  assert.ok(
    red.frames.some((f) => f.type === 'emplacementMessage' && /other team/i.test(f.message)),
    'the enemy is told why',
  );

  const blue2 = join(game, 'blue');
  blue2.player.position = { ...nest.position };
  game.handleMessage(blue2.id, { type: 'mountEmplacement', emplacementId: nest.id });
  assert.equal(nest.gunnerId, blue.id, 'a teammate cannot take an occupied nest');
});

test('mounting snaps the gunner onto the seat and keeps them there', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot);
  blue.player.position = { x: nest.position.x + EMPLACEMENT_MOUNT_REACH - 0.5, y: nest.position.y, z: nest.position.z };

  mount(game, blue.id, nest);

  assert.equal(nest.gunnerId, blue.id);
  assert.deepEqual(blue.player.position, nest.position, 'the gunner sits on the nest');
  const mounted = frames.filter((f) => f.type === 'emplacementMounted').pop();
  assert.ok(mounted, 'the client is told it is seated');
  assert.equal(mounted.emplacementId, nest.id);

  // Movement input is ignored while seated: only the look direction is read.
  game.handleMessage(blue.id, {
    type: 'playerInput',
    input: { moveX: 1, moveZ: 0, jump: false, crouch: false, sprint: false, yaw: 0.4, pitch: 0.1, position: { x: nest.position.x + 40, y: nest.position.y, z: nest.position.z } },
  });
  assert.deepEqual(blue.player.position, nest.position, 'a seated gunner cannot walk off the nest');
  assert.equal(nest.yaw, 0.4, 'but the nest follows their aim');
});

test('the arc clamps the nest to its placement facing', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot, 0);
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);

  const halfArc = emplacementSpec('mgNest').arc / 2;
  game.handleMessage(blue.id, {
    type: 'playerInput',
    input: { moveX: 0, moveZ: 0, jump: false, crouch: false, sprint: false, yaw: Math.PI, pitch: 0 },
  });
  assert.ok(Math.abs(nest.yaw) <= halfArc + 1e-6, 'aim stays inside the arc');
  assert.ok(Math.abs(Math.abs(nest.yaw) - halfArc) < 1e-6, 'and lands on the arc edge rather than the request');
});

test('the nest fires server-side rounds, spends ammo and damages an enemy', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot, 0);
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);

  // Directly in front of the nest (yaw 0 looks down -z).
  const red = join(game, 'red');
  red.player.position = { x: nest.position.x, y: nest.position.y, z: nest.position.z - 2.5 };
  game.spawnProtectedUntil.delete(red.id);
  const startHp = red.player.hp;
  const startAmmo = nest.ammo;

  game.handleMessage(blue.id, { type: 'fireEmplacement' });

  assert.equal(nest.ammo, startAmmo - 1, 'the round left the belt');
  assert.ok(red.player.hp < startHp, 'the enemy in the line of fire was hit');
  assert.ok(frames.some((f) => f.type === 'hitConfirmed'), 'the gunner gets the hit marker');

  // The same tick cannot empty the belt.
  game.handleMessage(blue.id, { type: 'fireEmplacement' });
  assert.equal(nest.ammo, startAmmo - 1, 'the fire rate limits the next round');
});

test('a round never reaches past the gun range', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot, 0);
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);

  const spec = emplacementSpec('mgNest');
  const red = join(game, 'red');
  red.player.position = { x: nest.position.x, y: nest.position.y, z: nest.position.z - (spec.maxRange + 25) };
  game.spawnProtectedUntil.delete(red.id);
  const startHp = red.player.hp;
  const startAmmo = nest.ammo;

  game.handleMessage(blue.id, { type: 'fireEmplacement' });

  assert.equal(nest.ammo, startAmmo - 1, 'the round left the belt');
  assert.equal(red.player.hp, startHp, 'a target past the gun range is never hit');
});

test('an empty belt refuses to fire', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot);
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);

  nest.ammo = 1;
  game.handleMessage(blue.id, { type: 'fireEmplacement' });
  game.world.updateTime(1); // outrun the fire-rate window
  game.handleMessage(blue.id, { type: 'fireEmplacement' });

  assert.equal(nest.ammo, 0, 'ammo never goes negative');
  assert.ok(
    frames.some((f) => f.type === 'emplacementMessage' && /out of rounds/i.test(f.message)),
    'the gunner is told the belt is dry',
  );
});

test('a gunner cannot fire from outside the seat', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot);
  const startAmmo = nest.ammo;

  game.handleMessage(blue.id, { type: 'fireEmplacement' });

  assert.equal(nest.ammo, startAmmo, 'standing next to a nest does not shoot it');
});

test('dismounting frees the seat and puts the gunner on clear ground', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot);
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);

  game.handleMessage(blue.id, { type: 'dismountEmplacement' });

  assert.equal(nest.gunnerId, null, 'the seat is free again');
  assert.ok(frames.some((f) => f.type === 'emplacementExited'), 'the client is told to step out');
  assert.ok(
    Math.hypot(blue.player.position.x - nest.position.x, blue.player.position.z - nest.position.z) > 1,
    'and they are not standing inside the nest',
  );
});

test('death, disconnect and a new round all free the seat', () => {
  const game = new ServerGame();
  const frames = [];
  const blue = join(game, 'blue', frames);
  const [spot] = findSpots(game, 1);
  const nest = nestAt(game, blue.id, blue.player, spot);
  blue.player.position = { ...nest.position };
  mount(game, blue.id, nest);

  game.handlePlayerDeath(blue.id);
  assert.equal(nest.gunnerId, null, 'a dead gunner is not manning anything');

  blue.player.isDead = false;
  blue.player.hp = 100;
  mount(game, blue.id, nest);
  assert.equal(nest.gunnerId, blue.id, 'a healthy gunner can climb back in');

  game.removePlayer(blue.id);
  assert.equal(nest.gunnerId, null, 'a disconnected gunner releases the nest');

  const blue2 = join(game, 'blue');
  blue2.player.position = { ...nest.position };
  mount(game, blue2.id, nest);
  assert.equal(nest.gunnerId, blue2.id);

  game.startNextRound();
  assert.equal(game.emplacements.size, 0, 'the nest is gone with the round');
});
