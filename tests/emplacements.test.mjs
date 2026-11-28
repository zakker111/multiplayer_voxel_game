// Emplacement foundation (Phase 4): the kind table, the bench craft step and
// server-side placement validation. No client UI yet — these drive the server
// directly through the same protocol messages a client will send.
//
// Cost model: the bench charges the full spec cost when a blueprint is crafted
// into one of three slots; placing that blueprint is free and consumes the slot.

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

/** Flat, non-overlapping spots in the mid-map band so they clear both bases,
 *  the workshops and the bench (where the player stands to craft). */
const findSpots = (game, count) => {
  const spots = [];
  for (let z = -30; z <= 30; z += 3) {
    for (let x = -60; x <= 60; x += 3) {
      if (Math.abs(x) < 15) continue;           // clear of the workshop band
      if (Math.abs(z) > 50) continue;           // clear of the flag stands
      if (!isFlat(game, x, z)) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 5)) continue;
      spots.push({ x, y: groundTop(game, x, z), z });
      if (spots.length >= count) return spots;
    }
  }
  return spots;
};

/** A joined player standing at their team's bench, plus the frames the server
 *  sent them. Bots are off, so the first human id is the one we control. */
const setup = (team = 'blue') => {
  const game = new ServerGame();
  const frames = [];
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);

  // The bench sits at the workshop centre + BENCH_OFFSET, inside the protected
  // workshop cells. The player must stand there to craft.
  const workshop = game.getWorkshops()[team].position;
  const bench = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  player.position = { ...bench };

  return { game, id, player, frames, workshop, bench };
};

const craft = (game, id, kind, slot) =>
  game.handleMessage(id, { type: 'craftBlueprint', kind, slot });

const place = (game, id, kind, spot, yaw = 0, slot = 0) =>
  game.handleMessage(id, { type: 'placeEmplacement', kind, position: spot, yaw, slot });

const message = (frames, text) =>
  frames.filter((f) => f.type === 'emplacementMessage' && f.message === text);

test('the opening stockpile pays for an MG nest at the bench', () => {
  // The nest is the build the bench exists for. With a start stockpile under
  // its 70 blocks the craft is refused on the first click of a round, which
  // reads as a broken bench (and bots, which never mine, could never field one
  // at all until teammates deposited).
  const { game, id, frames } = setup('blue');
  craft(game, id, 'mgNest', 0);
  assert.deepEqual(
    frames.filter((f) => f.type === 'blueprintsUpdated').at(-1)?.blueprints,
    ['mgNest', null, null],
    `refused with: ${frames.filter((f) => f.type === 'emplacementMessage').map((f) => f.message).join(', ')}`,
  );
});

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

test('crafting at the bench charges the cost and fills the slot', () => {
  const { game, id, frames } = setup();
  const spec = emplacementSpec('mgNest');
  game.workshopStock.blue = 200;

  craft(game, id, 'mgNest', 0);

  assert.deepEqual(game.craftedBlueprints.get(id), ['mgNest', null, null], 'slot 1 holds the blueprint');
  assert.equal(game.workshopStock.blue, 200 - spec.cost, 'the bench charged the spec cost');
  const update = frames.filter((f) => f.type === 'blueprintsUpdated').pop();
  assert.deepEqual(update?.blueprints, ['mgNest', null, null], 'the crafter is told about the slot');
});

test('crafting is refused away from the bench, with junk input, and into a full slot', () => {
  const { game, id, frames } = setup();
  game.workshopStock.blue = 200;

  craft(game, id, 'mgNest', 0);
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mgNest');

  craft(game, id, 'mgNest', 0);
  assert.equal(message(frames, 'That slot already has a blueprint in it').length, 1, 'an occupied slot refuses');

  craft(game, id, 'tank', 1);
  assert.equal(message(frames, 'That is not a real blueprint').length, 1, 'unknown kinds refuse');

  craft(game, id, 'mgNest', 9);
  assert.equal(message(frames, 'Choose slot 1, 2 or 3').length, 1, 'out-of-range slots refuse');

  game.players.get(id).position = { x: 0, y: 40, z: 0 };
  craft(game, id, 'cannon', 1);
  assert.equal(message(frames, 'Stand at your blueprint bench to craft').length, 1, 'distance refuses');

  assert.deepEqual(game.craftedBlueprints.get(id), ['mgNest', null, null], 'only the first craft landed');
  assert.equal(game.workshopStock.blue, 200 - emplacementSpec('mgNest').cost, 'refusals cost nothing');
});

test('an unaffordable craft is refused and costs nothing', () => {
  const { game, id, frames } = setup();
  const spec = emplacementSpec('cannon');
  game.workshopStock.blue = spec.cost - 1;

  craft(game, id, 'cannon', 0);

  assert.equal(message(frames, 'Not enough workshop blocks for that build').length, 1);
  assert.equal(game.workshopStock.blue, spec.cost - 1, 'no charge for a refusal');
  assert.equal(game.craftedBlueprints.get(id), undefined, 'no slot was created');
  assert.equal(frames.filter((f) => f.type === 'blueprintsUpdated').length, 0, 'and no slot update');
});

test('a valid placement consumes the crafted blueprint and stores its spec stats', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  assert.ok(spot, 'the generated terrain has a flat spot to build on');
  game.workshopStock.blue = 200;

  const craftCost = emplacementSpec('mgNest').cost;
  craft(game, id, 'mgNest', 0);
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mgNest', 'the slot now holds the blueprint');

  place(game, id, 'mgNest', spot, 0, 0);

  assert.equal(game.emplacements.size, 1);
  const built = [...game.emplacements.values()][0];
  const spec = emplacementSpec('mgNest');
  assert.equal(built.kind, 'mgNest');
  assert.equal(built.team, 'blue');
  assert.equal(built.hp, spec.maxHp);
  assert.equal(built.ammo, spec.ammo);
  assert.equal(built.position.y, spot.y, 'snapped to the server ground');
  assert.equal(game.workshopStock.blue, 200 - craftCost, 'stock only moved at the bench, not at placement');
  assert.equal(game.craftedBlueprints.get(id)?.[0], null, 'the slot is empty after placement');
});

test('placing an empty or mismatched slot is refused', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  place(game, id, 'mgNest', spot, 0, 0);
  assert.equal(game.emplacements.size, 0, 'no blueprint, no build');
  assert.equal(game.workshopStock.blue, 200, 'and nothing was charged');

  craft(game, id, 'mgNest', 0);
  place(game, id, 'cannon', spot, 0, 0);
  assert.equal(game.emplacements.size, 0, 'the slot holds a different kind');
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mgNest', 'the mismatched attempt spent nothing');
});

test('nothing can be placed near the enemy base', () => {
  const { game, id } = setup('blue');
  game.workshopStock.blue = 200;

  craft(game, id, 'mortar', 0);
  place(game, id, 'mortar', { x: RED_FLAG_POS.x, y: 10, z: RED_FLAG_POS.z }, 0, 0);

  assert.equal(game.emplacements.size, 0);
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mortar', 'the refused build keeps its blueprint');
});

test('a spot claimed twice is refused the second time', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  craft(game, id, 'mgNest', 0);
  place(game, id, 'mgNest', spot, 0, 0);
  craft(game, id, 'mgNest', 0);
  place(game, id, 'mgNest', spot, 0, 0);

  assert.equal(game.emplacements.size, 1);
  assert.equal(game.workshopStock.blue, 200 - emplacementSpec('mgNest').cost * 2, 'both crafts were paid for');
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mgNest', 'the blocked spot kept its blueprint');
});

test('the per-team limit stops the build after its allowance', () => {
  const { game, id } = setup();
  const spec = emplacementSpec('mgNest');
  const spots = findSpots(game, spec.teamLimit + 1);
  assert.ok(spots.length > spec.teamLimit, 'needs one more flat spot than the limit');
  game.workshopStock.blue = 300;

  for (let i = 0; i < spec.teamLimit; i++) {
    craft(game, id, 'mgNest', 0);
    place(game, id, 'mgNest', spots[i], 0, 0);
  }

  assert.equal(game.emplacements.size, spec.teamLimit, 'only the allowed number stands');
  assert.equal(game.workshopStock.blue, 300 - spec.cost * spec.teamLimit, 'one craft charge per build');
  assert.deepEqual(game.craftedBlueprints.get(id), [null, null, null], 'all crafted slots consumed');

  // One more blueprint survives the refused build: the limit is checked before
  // the slot, so nothing is spent and the blueprint stays in the slot.
  craft(game, id, 'mgNest', 0);
  place(game, id, 'mgNest', spots[spec.teamLimit], 0, 0);
  assert.equal(game.emplacements.size, spec.teamLimit, 'still capped by the team limit');
  assert.equal(game.workshopStock.blue, 300 - spec.cost * (spec.teamLimit + 1), 'only the craft moved stock');
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mgNest', 'the refused build kept its blueprint');
});

test('junk kinds and off-ground positions are ignored', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;
  craft(game, id, 'mgNest', 0);

  place(game, id, 'tank', spot, 0, 0);
  place(game, id, 'mgNest', { x: Number.NaN, y: 0, z: 0 }, 0, 0);
  place(game, id, 'mgNest', { x: spot.x, y: spot.y + 20, z: spot.z }, 0, 0);

  assert.equal(game.emplacements.size, 0, 'nothing was built');
  assert.equal(game.workshopStock.blue, 200 - emplacementSpec('mgNest').cost, 'only the craft was charged');
  assert.equal(game.craftedBlueprints.get(id)?.[0], 'mgNest', 'the blueprint was not consumed');
});

test('each team pays from its own stockpile', () => {
  const { game, id: blueId } = setup('blue');
  const redId = game.addPlayer({ send: () => {}, isOpen: () => true });
  game.handleMessage(redId, { type: 'join', team: 'red' });
  const redPlayer = game.players.get(redId);
  const redWorkshop = game.getWorkshops().red.position;
  redPlayer.position = { x: redWorkshop.x - 3, y: redWorkshop.y, z: redWorkshop.z + 5 };

  const spots = findSpots(game, 2);
  assert.ok(spots.length >= 2, 'needs two flat spots');
  game.workshopStock.blue = 200;
  game.workshopStock.red = 200;
  const crateCost = emplacementSpec('supplyCrate').cost;

  craft(game, blueId, 'supplyCrate', 0);
  craft(game, redId, 'supplyCrate', 1);
  place(game, blueId, 'supplyCrate', spots[0], 0, 0);
  place(game, redId, 'supplyCrate', spots[1], 0, 1);

  assert.equal(game.emplacements.size, 2);
  assert.equal(game.workshopStock.blue, 200 - crateCost);
  assert.equal(game.workshopStock.red, 200 - crateCost);
  assert.equal(game.craftedBlueprints.get(blueId)?.[0], null, 'blue blueprint consumed');
  assert.equal(game.craftedBlueprints.get(redId)?.[1], null, 'red blueprint consumed');
});

test('the ghost preview agrees with placement and charges nothing', () => {
  const { game, id, frames } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;
  const nestCost = emplacementSpec('mgNest').cost;
  craft(game, id, 'mgNest', 0);

  game.handleMessage(id, { type: 'previewEmplacement', kind: 'mgNest', position: spot, yaw: Math.PI / 2, slot: 0 });
  const preview = frames.filter((f) => f.type === 'emplacementPreview').pop();
  assert.ok(preview, 'the server answered the preview');
  assert.equal(preview.ok, true);
  assert.equal(preview.yaw, Math.PI / 2, 'rotation is echoed back');
  assert.deepEqual(preview.position, spot, 'the snapped spot comes back to the ghost');
  assert.equal(game.emplacements.size, 0, 'a preview builds nothing');
  assert.equal(game.workshopStock.blue, 200 - nestCost, 'only the craft cost moved');

  place(game, id, 'mgNest', spot, Math.PI / 2, 0);
  assert.equal(game.emplacements.size, 1, 'the same spot then places for real');
});

test('the ghost preview explains a refusal', () => {
  const { game, id, frames } = setup('blue');
  game.workshopStock.blue = 200;

  game.handleMessage(id, { type: 'previewEmplacement', kind: 'mortar', position: { x: RED_FLAG_POS.x, y: 10, z: RED_FLAG_POS.z }, yaw: 0, slot: 0 });
  const preview = frames.filter((f) => f.type === 'emplacementPreview').pop();

  assert.equal(preview.ok, false);
  assert.match(String(preview.reason), /enemy base/i);
  assert.equal(game.workshopStock.blue, 200);
});

test('preview replies are throttled so a hovering ghost cannot spam', () => {
  const { game, id, frames } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  for (let i = 0; i < 10; i++) {
    game.handleMessage(id, { type: 'previewEmplacement', kind: 'mgNest', position: spot, yaw: 0, slot: 0 });
  }

  assert.equal(frames.filter((f) => f.type === 'emplacementPreview').length, 1, 'a burst gets one reply');
});

test('a new round clears the map and the carried blueprints', () => {
  const { game, id } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 200;

  craft(game, id, 'mgNest', 0);
  place(game, id, 'mgNest', spot, 0, 0);
  assert.equal(game.emplacements.size, 1);
  assert.equal(game.craftedBlueprints.get(id)?.[0], null, 'the placed blueprint is already consumed');
  assert.equal(game.workshopStock.blue, 200 - emplacementSpec('mgNest').cost, 'only the craft cost moved');

  // Craft a second one and hold it without placing, so the round reset has
  // something to clear.
  craft(game, id, 'cannon', 1);
  assert.equal(game.craftedBlueprints.get(id)?.[1], 'cannon', 'a held blueprint exists');

  game.startNextRound();

  assert.equal(game.emplacements.size, 0, 'emplacements clear on round reset');
  assert.equal(game.craftedBlueprints.get(id), undefined, 'carried blueprints are dropped with no refund');
});

test('dismantling a friendly build clears it and returns its cost to the stock', () => {
  const { game, id, frames } = setup();
  const [nestSpot, crateSpot] = findSpots(game, 2);
  game.workshopStock.blue = 200;

  craft(game, id, 'mgNest', 0);
  place(game, id, 'mgNest', nestSpot, 0, 0);
  const nest = [...game.emplacements.values()][0];
  assert.ok(nest, 'the nest is up');

  game.players.get(id).position = { ...nest.position };
  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: nest.id });

  assert.equal(game.emplacements.size, 0, 'the build is gone');
  assert.equal(game.workshopStock.blue, 200, 'the full craft cost came back');
  assert.equal(message(frames, 'Dismantled MG nest (+70 blocks)').length, 1, 'the player is told what came back');

  // A crate hands back its contents too: they are the team's mined blocks.
  // Leave the stock room to take them (a full workshop refunds nothing).
  game.workshopStock.blue = 150;
  const crate = game.createEmplacement('blue', emplacementSpec('supplyCrate'), crateSpot, 0);
  crate.stock = 7;
  game.players.get(id).position = { ...crate.position };
  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: crate.id });

  assert.equal(game.workshopStock.blue, 150 + emplacementSpec('supplyCrate').cost + 7, 'cost plus contents');
  assert.equal(game.emplacements.size, 0, 'the crate is gone too');
});

test('a dismantle refuses enemy and out-of-reach builds', () => {
  const { game, id, frames } = setup();
  const [enemySpot, ownSpot] = findSpots(game, 2);
  game.workshopStock.blue = 200;

  const enemy = game.createEmplacement('red', emplacementSpec('mgNest'), enemySpot, 0);
  game.players.get(id).position = { ...enemy.position };
  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: enemy.id });
  assert.equal(message(frames, 'Only your own team builds can be dismantled').length, 1, 'an enemy build refuses');

  const own = game.createEmplacement('blue', emplacementSpec('mortar'), ownSpot, 0);
  game.players.get(id).position = { x: own.position.x + 30, y: own.position.y, z: own.position.z };
  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: own.id });
  assert.equal(message(frames, 'Walk up to the build to dismantle it').length, 1, 'reach refuses');

  assert.equal(game.emplacements.size, 2, 'nothing was removed');
  assert.equal(game.workshopStock.blue, 200, 'a refusal refunds nothing');
});

test('dismantling a nest a friendly bot mans evicts the bot instead of refusing', () => {
  const { game, id, frames } = setup();
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 100;
  const nest = game.createEmplacement('blue', emplacementSpec('mgNest'), spot, 0);
  const bot = game.players.get(game.addBot('blue', 'Crewman'));
  bot.position = { ...nest.position };
  assert.equal(game.getBotContext().guns.mount(bot, nest.id), true, 'the bot takes the seat');
  assert.equal(nest.gunnerId, bot.id);

  game.players.get(id).position = { ...nest.position };
  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: nest.id });

  assert.equal(game.emplacements.size, 0, 'a crewed build still comes down');
  assert.equal(nest.gunnerId, null, 'the seat is released');
  assert.ok(
    Math.hypot(bot.position.x - nest.position.x, bot.position.z - nest.position.z) > 1,
    'the bot is put on clear ground instead of left inside the sandbags',
  );
  assert.equal(message(frames, 'Dismantled MG nest (+70 blocks)').length, 1, 'the cost still comes back');
  assert.equal(game.workshopStock.blue, 170);
});
