// Emplacement foundation (Phase 4): the kind table, server-side placement
// validation and cost charging. No client UI yet — these drive the server
// directly through the same protocol message a client will send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { EMPLACEMENTS, emplacementSpec, RED_FLAG_POS } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';

/** Footprint samples the server's ground check uses. */
const SAMPLES = [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]];

const groundTop = (game, x, z) => {
  for (let y = 40; y > -20; y--) if (game.world.isSolid(Math.round(x), y, Math.round(z))) return y + 0.5;
  return null;
};

const isFlat = (game, x, z) => {
  const tops = SAMPLES.map(([ox, oz]) => groundTop(game, x + ox, z + oz));
  if (tops.some((top) => top === null)) return false;
  const high = Math.max(...tops), low = Math.min(...tops);
  return high - low <= 0 && high > 0;
};

/** Flat, non-overlapping spots away from both bases and workshops. */
const findSpots = (game, count) => {
  const spots = [];
  for (let z = -30; z <= 30; z += 3) {
    for (let x = -60; x <= 60; x += 3) {
      if (!isFlat(game, x, z)) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 5)) continue;
      spots.push({ x, y: groundTop(game, x, z), z });
      if (spots.length >= count) return spots;
    }
  }
  return spots;
};

const setup = (team = 'blue') => {
  const game = new ServerGame();
  const frames = [];
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  player.position = { x: 0, y: 40, z: 0 }; // clear of every placement footprint
  return { game, id, player, frames };
};

const place = (game, id, kind, spot, yaw = 0) =>
  game.handleMessage(id, { type: 'placeEmplacement', kind, position: spot, yaw });

test('every emplacement kind is a complete spec', () => {
  const kinds = ['mgNest', 'cannon', 'mortar', 'supplyCrate', 'spottingPost'];
  assert.deepEqual(Object.keys(EMPLACEMENTS).sort(), [...kinds].sort());

  for (const kind of kinds) {
    const spec = emplacementSpec(kind);
    assert.ok(spec, `${kind} exists`);
    assert.ok(spec.cost > 0, `${kind} costs blocks`);
    assert.ok(spec.maxHp > 0, `${kind} has health`);
    assert.ok(spec.teamLimit >= 1, `${kind} has a team limit`);
    assert.ok(spec.halfWidth > 0 && spec.halfLength > 0 && spec.height > 0, `${kind} has a footprint`);
  }

  for (const gun of ['mgNest', 'cannon', 'mortar']) {
    const spec = emplacementSpec(gun);
    assert.ok(spec.ammo > 0, `${gun} carries ammo`);
    assert.ok(spec.arc > 0, `${gun} has a firing arc`);
    assert.ok(spec.maxRange > 0, `${gun} has a range`);
  }
  assert.ok(emplacementSpec('mortar').minRange > 0, 'indirect fire needs a minimum range');

  for (const support of ['supplyCrate', 'spottingPost']) {
    assert.equal(emplacementSpec(support).ammo, 0, `${support} is unarmed`);
    assert.equal(emplacementSpec(support).arc, 0, `${support} is unarmed`);
  }
  assert.equal(emplacementSpec('tank'), undefined, 'unknown kinds have no spec');
  assert.equal(emplacementSpec('toString'), undefined, 'prototype keys are not specs');
});

test('a valid placement is charged once and stored with its spec stats', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  assert.ok(spot, 'the generated terrain has a flat spot to build on');
  game.workshopStock.blue = 200;

  place(game, id, 'mgNest', spot);

  assert.equal(game.emplacements.size, 1);
  const built = [...game.emplacements.values()][0];
  const spec = emplacementSpec('mgNest');
  assert.equal(built.kind, 'mgNest');
  assert.equal(built.team, 'blue');
  assert.equal(built.hp, spec.maxHp);
  assert.equal(built.ammo, spec.ammo);
  assert.equal(built.position.y, spot.y, 'snapped to the server ground');
  assert.equal(game.workshopStock.blue, 200 - spec.cost, 'charged exactly the spec cost');
});

test('an unaffordable placement is refused and costs nothing', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  const spec = emplacementSpec('cannon');
  game.workshopStock.blue = spec.cost - 1;

  place(game, id, 'cannon', spot);

  assert.equal(game.emplacements.size, 0);
  assert.equal(game.workshopStock.blue, spec.cost - 1, 'no charge for a refusal');
});

test('nothing can be placed near the enemy base', () => {
  const { game, id } = setup('blue');
  game.workshopStock.blue = 200;

  place(game, id, 'mortar', { x: RED_FLAG_POS.x, y: 10, z: RED_FLAG_POS.z });

  assert.equal(game.emplacements.size, 0);
  assert.equal(game.workshopStock.blue, 200, 'no charge for a refusal');
});

test('a spot claimed twice is refused the second time', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  place(game, id, 'mgNest', spot);
  place(game, id, 'mgNest', spot);

  assert.equal(game.emplacements.size, 1);
  assert.equal(game.workshopStock.blue, 200 - emplacementSpec('mgNest').cost);
});

test('the per-team limit stops the build after its allowance', () => {
  const { game, id } = setup();
  const spots = findSpots(game, 3);
  assert.ok(spots.length >= 3, 'needs three flat spots');
  const spec = emplacementSpec('mgNest');
  game.workshopStock.blue = 300;

  for (const spot of spots) place(game, id, 'mgNest', spot);

  assert.equal(game.emplacements.size, spec.teamLimit, 'only the allowed number stands');
  assert.equal(game.workshopStock.blue, 300 - spec.cost * spec.teamLimit);
});

test('junk kinds and off-ground positions are ignored', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  place(game, id, 'tank', spot);
  place(game, id, 'mgNest', { x: Number.NaN, y: 0, z: 0 });
  place(game, id, 'mgNest', { x: spot.x, y: spot.y + 20, z: spot.z });

  assert.equal(game.emplacements.size, 0, 'nothing was built');
  assert.equal(game.workshopStock.blue, 200, 'and nothing was charged');
});

test('each team pays from its own stockpile', () => {
  const { game, id } = setup('blue');
  const red = game.addPlayer({ send: () => {}, isOpen: () => true });
  game.handleMessage(red, { type: 'join', team: 'red' });
  game.players.get(red).position = { x: 0, y: 40, z: 0 };

  const spots = findSpots(game, 2);
  assert.ok(spots.length >= 2, 'needs two flat spots');
  game.workshopStock.blue = 200;
  game.workshopStock.red = 200;

  place(game, id, 'supplyCrate', spots[0]);
  place(game, red, 'supplyCrate', spots[1]);

  assert.equal(game.emplacements.size, 2);
  assert.equal(game.workshopStock.blue, 200 - emplacementSpec('supplyCrate').cost);
  assert.equal(game.workshopStock.red, 200 - emplacementSpec('supplyCrate').cost);
});

test('a new round clears the map of emplacements', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  place(game, id, 'mgNest', spot);
  assert.equal(game.emplacements.size, 1);

  game.startNextRound();

  assert.equal(game.emplacements.size, 0);
});
