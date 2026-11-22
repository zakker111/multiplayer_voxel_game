// Bot engineers emplacing guns (Phase 4 / stage 6).
//
// Bots have no bench, so the server charges a bot build straight to the team
// stock while judging the spot with the same rules a player's ghost is judged
// by. The AI side decides when and where, faces the build at the enemy base,
// and backs off when refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const { ServerWorld } = require('../dist/tests/serverWorld.cjs');
const { emplacementSpec, GROUND_LEVEL, RED_FLAG_POS, BLUE_FLAG_POS, WEAPONS } = require('../dist/tests/sharedTypes.cjs');
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
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 8)) continue;
      spots.push({ x, y: groundTop(game, x, z), z });
      if (spots.length >= count) return spots;
    }
  }
  return spots;
};

/** An engineer bot on a finished firebase, plus a recording context. */
const engineerWith = (overrides = {}) => {
  const bot = new ServerBot('gun-bot', { x: 0, y: GROUND_LEVEL, z: 0 }, 'blue', 'Sapper', true);
  const calls = [];
  let accept = true;
  const ctx = {
    world: new ServerWorld(),
    serverTime: 0,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
    placeEmplacement: (who, kind, position, yaw) => {
      calls.push({ kind, position, yaw });
      return accept;
    },
    ...overrides,
  };
  return { bot, ctx, calls, setAccept: (value) => { accept = value; } };
};

test('an engineer emplaces a gun on the firebase facing the enemy base', () => {
  const { bot, ctx, calls } = engineerWith();
  const center = { x: 10, z: -40 };
  bot.position = { x: 10, y: GROUND_LEVEL, z: -40 };
  const placed = bot.tryGunBuild(ctx, center, 100);

  assert.equal(placed, true, 'the gun went down');
  assert.equal(calls.length, 1, 'one attempt was accepted');
  assert.equal(calls[0].kind, 'mgNest');
  assert.ok(Math.hypot(calls[0].position.x - center.x, calls[0].position.z - center.z) <= 6,
    'the gun covers the firebase');
  assert.equal(bot.gunsBuilt, 1);

  // Facing convention: forward is (-sin yaw, -cos yaw).
  const dx = RED_FLAG_POS.x - center.x;
  const dz = RED_FLAG_POS.z - center.z;
  const len = Math.hypot(dx, dz);
  const forward = { x: -Math.sin(calls[0].yaw), z: -Math.cos(calls[0].yaw) };
  const dot = (forward.x * dx + forward.z * dz) / len;
  assert.ok(dot > 0.95, `the gun looks at the red base (dot=${dot.toFixed(2)})`);
});

test('a rifleman bot does not build guns', () => {
  const { bot, ctx, calls } = engineerWith();
  const grunt = new ServerBot('grunt', { x: 0, y: GROUND_LEVEL, z: 0 }, 'blue', 'Grunt', false);
  assert.equal(grunt.tryGunBuild(ctx, { x: 0, z: 0 }, 100), false);
  assert.equal(calls.length, 0, 'nobody asked the server for a build');
  assert.equal(bot.isEngineer, true);
});

test('a refused spot is retried, but not on every tick', () => {
  const { bot, ctx, calls, setAccept } = engineerWith();
  setAccept(false);
  assert.equal(bot.tryGunBuild(ctx, { x: 0, z: 0 }, 50), false);
  const attempts = calls.length;
  assert.ok(attempts > 1, 'the engineer probed several spots around the firebase');

  calls.length = 0;
  assert.equal(bot.tryGunBuild(ctx, { x: 0, z: 0 }, 55), false, 'still inside the cooldown');
  assert.equal(calls.length, 0, 'a refusal costs a window, not a tick');
  assert.equal(bot.gunsBuilt, 0);
});

test('bots pay the team stock for a gun and nothing for a refused spot', () => {
  const game = new ServerGame();
  const bot = game.players.get(game.addBot('blue', 'Sapper'));
  assert.equal(bot.isEngineer, true, 'the first blue bot is an engineer');
  const [spot] = findSpots(game, 1);
  const cost = emplacementSpec('mgNest').cost;

  game.workshopStock.blue = cost - 1;
  assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spot, 0), false, 'no stock, no gun');
  assert.equal(game.workshopStock.blue, cost - 1, 'a refusal spends nothing');
  assert.equal(game.emplacements.size, 0);

  game.workshopStock.blue = cost;
  assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spot, 0), true);
  assert.equal(game.workshopStock.blue, 0, 'the build was charged');
  const gun = [...game.emplacements.values()][0];
  assert.equal(gun.team, 'blue');
  assert.equal(gun.gunnerId, null, 'the gun is free for a human or a bot to take');
});

test('a bot build respects the team limit and uses no blueprint slot', () => {
  const game = new ServerGame();
  const bot = game.players.get(game.addBot('blue', 'Sapper'));
  const spots = findSpots(game, 3);
  game.workshopStock.blue = 1000;
  const limit = emplacementSpec('mgNest').teamLimit;
  for (let i = 0; i < limit; i++) {
    assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spots[i], 0), true, `gun ${i + 1} placed`);
  }
  assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spots[limit], 0), false, 'the cap holds');
  assert.equal(game.emplacements.size, limit);
  assert.deepEqual(game.craftedBlueprints.get(bot.id) ?? [null, null, null], [null, null, null],
    'a bot never touches the bench slots');
});

test('the server-side context lets an engineer emplace for real', () => {
  const game = new ServerGame();
  const bot = game.players.get(game.addBot('red', 'Fusilier'));
  const [spot] = findSpots(game, 1);
  game.workshopStock.red = 500;
  const ctx = game.getBotContext();
  assert.equal(typeof ctx.placeEmplacement, 'function', 'bots are given the build hook');

  bot.position = { x: spot.x, y: spot.y, z: spot.z };
  const placed = bot.tryGunBuild(ctx, { x: spot.x, z: spot.z }, 60);
  assert.equal(placed, true, 'a flat spot near the engineer was accepted');
  const gun = [...game.emplacements.values()][0];
  assert.equal(gun.team, 'red');
  assert.ok(['mgNest', 'cannon', 'mortar', 'supplyCrate', 'spottingPost'].includes(gun.kind),
    `the engineer built real hardware (${gun.kind})`);
  assert.equal(game.workshopStock.red, 500 - emplacementSpec(gun.kind).cost,
    'the chosen blueprint was charged at its own price');
  assert.ok(WEAPONS[bot.equipment], 'the engineer keeps its rifle after building');
});

test('an engineer builds the whole blueprint catalogue, not just nests', () => {
  const kinds = ['mgNest', 'cannon', 'mortar', 'supplyCrate', 'spottingPost'];
  const { bot, ctx, calls } = engineerWith({
    availableEmplacements: () => kinds.map((kind) => ({ kind, standing: 0 })),
  });
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    calls.length = 0;
    assert.equal(bot.tryGunBuild(ctx, { x: 0, z: 0 }, 100 + i * 20), true);
    seen.add(calls[0].kind);
  }
  assert.deepEqual([...seen].sort(), [...kinds].sort(), 'every blueprint was chosen at least once');
  assert.deepEqual(Object.keys(bot.emplacedByKind).sort(), [...kinds].sort(),
    'diagnostics record what each engineer actually placed');
});

test('an engineer only builds what the team can pay for and has room for', () => {
  const { bot, ctx, calls } = engineerWith({
    availableEmplacements: () => [{ kind: 'mortar', standing: 0 }],
  });
  assert.equal(bot.tryGunBuild(ctx, { x: 0, z: 0 }, 100), true);
  assert.equal(calls[0].kind, 'mortar');
  assert.equal(bot.emplacedByKind.mortar, 1);

  // Nothing affordable or under the cap: no build is attempted at all.
  calls.length = 0;
  ctx.availableEmplacements = () => [];
  assert.equal(bot.tryGunBuild(ctx, { x: 0, z: 0 }, 200), false);
  assert.equal(calls.length, 0, 'nothing was offered, so nothing was probed');
  assert.equal(bot.gunsBuilt, 1);
});

test('the server offers every affordable blueprint and closes each team limit', () => {
  const game = new ServerGame();
  const bot = game.players.get(game.addBot('blue', 'Sapper'));
  const spots = findSpots(game, 4);
  game.workshopStock.blue = 5000;
  const offered = game.botEmplacementOptions('blue').map((option) => option.kind);
  assert.deepEqual([...offered].sort(),
    ['cannon', 'mgNest', 'mortar', 'spottingPost', 'supplyCrate'].sort(),
    'with stock, every blueprint is on the table');
  assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spots[0], 0), true);
  assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spots[1], 0), true);
  const after = game.botEmplacementOptions('blue');
  assert.ok(!after.some((option) => option.kind === 'mgNest'), 'a full nest cap is not offered');
  assert.ok(after.some((option) => option.kind === 'cannon'), 'the other guns are still offered');
});

test('bots can crew the heavy guns, not only nests', () => {
  const game = new ServerGame();
  const bot = game.players.get(game.addBot('blue', 'Sapper'));
  const [spot] = findSpots(game, 1);
  game.workshopStock.blue = 500;
  assert.equal(game.botPlaceEmplacement(bot, 'cannon', spot, 0), true);
  bot.position = { x: spot.x + 2, y: spot.y, z: spot.z };
  const seat = game.getBotContext().guns.freeNear(bot, 10);
  assert.equal(seat?.kind, 'cannon', 'a cannon seat is offered to bots');
});
