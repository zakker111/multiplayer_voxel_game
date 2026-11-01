// End-to-end bot TRENCH-building regression test.
// Bundles the real ServerBot + ServerWorld and runs a headless bot through its
// FSM, asserting that it actually places trench wall voxels in the world.
//
// The trigger moved when bot roles landed: defenders now dig in on their post
// in front of their own flag (midfield digging is no longer part of the support
// role), and attackers dig a forward firebase short of the enemy stand. This
// test drives the defender path, which is the one that must always work.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerWorld } = require('../dist/tests/serverWorld.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const types = require('../dist/tests/sharedTypes.cjs');

const GROUND_Y = types.GROUND_LEVEL; // ground surface height used by server world

function makeCtx(world, builtCells) {
  return {
    world,
    serverTime: 0,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: (bot, pos) => {
      if (world.canBuild(pos.x, pos.y, pos.z)) {
        world.setVoxel(pos.x, pos.y, pos.z, 4, 3);
        builtCells.push({ ...pos });
      }
    },
  };
}

test('a pinned defender enters TRENCH and builds wall voxels end-to-end', () => {
  const world = new ServerWorld();
  const built = [];
  const ctx = makeCtx(world, built);

  // Blue defender standing on its post (26m in front of the home stand).
  const post = { x: 8, y: GROUND_Y, z: types.BLUE_FLAG_POS.z + 26 };
  const bot = new ServerBot('bot-test', post, 'blue', 'TestBot');
  bot.role = 'support'; // runtime field; support holds and digs
  bot.pinnedDownUntil = 1e6; // "someone is shooting at us" -> dig in
  bot.lastTrenchAt = -100;
  // The builder now picks from a structure pool; pin the straight trench here so
  // the shape assertions below stay meaningful.
  bot.startStructure(ctx, 'trench');

  let sawTrench = false;
  let t = 0;
  const dt = 1 / 20;
  for (let i = 0; i < 1200; i++) {
    t += dt;
    ctx.serverTime = t;
    bot.botUpdate(dt, ctx);
    if (bot.stateName === 'TRENCH') sawTrench = true;
    if (sawTrench && built.length >= 10) break;
  }

  assert.ok(sawTrench, 'pinned defender should transition into TRENCH on its post');
  assert.ok(built.length >= 8, `trench should place multiple wall voxels, got ${built.length}`);

  // All placed cells must be solid in the world now
  for (const c of built) {
    assert.ok(world.isSolid(c.x, c.y, c.z), `placed cell ${JSON.stringify(c)} should be solid`);
  }

  // Trench shape sanity: cells form a wall line along X at roughly constant Z,
  // with heights on/just above the terrain surface (groundY .. groundY+3).
  const zs = new Set(built.map((c) => c.z));
  assert.equal(zs.size, 1, 'trench wall should lie on a single Z row');
  const xs = built.map((c) => c.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 4, 'wall should span several blocks along X');
  // Terrain undulates (~7-10), so compare each column against its own base
  // cell instead of a single arena constant.
  const baseYByX = new Map();
  for (const c of built) baseYByX.set(c.x, Math.min(baseYByX.get(c.x) ?? Infinity, c.y));
  for (const c of built) {
    const baseY = baseYByX.get(c.x);
    assert.ok(c.y >= baseY, `trench cell ${JSON.stringify(c)} at or above its column base`);
    assert.ok(c.y <= baseY + 3, `trench cell ${JSON.stringify(c)} stays within wall height`);
  }
});

test('the trench wall is built between the defender and the enemy', () => {
  const world = new ServerWorld();
  const built = [];
  const ctx = makeCtx(world, built);

  const postZ = types.BLUE_FLAG_POS.z + 26;
  const bot = new ServerBot('bot-facing', { x: 0, y: GROUND_Y, z: postZ }, 'blue', 'Facing');
  bot.role = 'support';
  bot.pinnedDownUntil = 1e6;
  bot.lastTrenchAt = -100;
  bot.startStructure(ctx, 'trench');

  let t = 0;
  for (let i = 0; i < 600; i++) {
    t += 1 / 20;
    ctx.serverTime = t;
    bot.botUpdate(1 / 20, ctx);
    if (built.length >= 4) break;
  }

  assert.ok(built.length > 0, 'defender should place blocks');
  // Blue defends toward +Z (the red side), so the wall belongs north of the post.
  for (const c of built) {
    assert.ok(c.z > postZ - 1, `wall cell ${JSON.stringify(c)} should sit toward the enemy (+Z)`);
  }
});
