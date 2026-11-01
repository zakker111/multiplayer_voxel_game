// Bot role / kiting regression tests (run: node --test tests/*.test.mjs)
//
// The objective behaviour is the fragile part of the bot AI: every one of these
// cases was a measured failure before the roles landed (0 pickups and 0 captures
// in a 10-minute 10v10 bot-only match).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerWorld } = require('../dist/tests/serverWorld.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const types = require('../dist/tests/sharedTypes.cjs');

const GROUND_Y = types.GROUND_LEVEL;

function ctxFor(world, targets = [], built = []) {
  return {
    world,
    serverTime: 0,
    targets,
    friendlyDroppedFlagPos: null,
    canSee: () => true,
    fireWeapon: () => {},
    buildBlock: (bot, pos) => {
      if (world.canBuild(pos.x, pos.y, pos.z)) {
        world.setVoxel(pos.x, pos.y, pos.z, 4, 3);
        built.push({ ...pos });
      }
    },
  };
}

function run(bot, ctx, ticks) {
  for (let i = 0; i < ticks; i++) {
    ctx.serverTime += 1 / 20;
    bot.botUpdate(1 / 20, ctx);
  }
}

test('an assault runner ignores a distant contact instead of duelling', () => {
  const world = new ServerWorld();
  const bot = new ServerBot('assault-test', { x: 0, y: GROUND_Y, z: -40 }, 'blue', 'Runner');
  bot.role = 'assault';
  const enemy = { id: 'e1', position: { x: 0, y: GROUND_Y, z: -5 }, team: 'red', isDead: false, carryingFlag: false };
  const ctx = ctxFor(world, [enemy]);

  run(bot, ctx, 2);

  assert.strictEqual(bot.stateName, 'GRABFLAG', 'a contact 35m away must not stop the flag run');
});

test('support bots hold a defensive post in front of their own flag', () => {
  const world = new ServerWorld();
  const bot = new ServerBot('support-test', { x: 0, y: GROUND_Y, z: -120 }, 'blue', 'Holder');
  bot.role = 'support';
  const ctx = ctxFor(world);

  run(bot, ctx, 3);

  assert.strictEqual(bot.stateName, 'DEFEND', 'support bots defend, they do not join the attack');
  assert.ok(bot.defendPost, 'a defend post must be chosen');
  assert.ok(bot.defendPost.z > types.BLUE_FLAG_POS.z, 'the post sits in front of the home flag');
});

test('a carrier drops cover between itself and a chaser', () => {
  const world = new ServerWorld();
  const built = [];
  const bot = new ServerBot('carrier-test', { x: 0, y: GROUND_Y, z: 100 }, 'blue', 'Runner');
  bot.carryingFlag = true;
  const chaser = { id: 'e2', position: { x: 0, y: GROUND_Y, z: 110 }, team: 'red', isDead: false, carryingFlag: false };
  const ctx = ctxFor(world, [chaser], built);

  run(bot, ctx, 12);

  assert.strictEqual(bot.stateName, 'RETURN');
  assert.ok(built.length >= 2, `carrier should build cover, placed ${built.length}`);
  // The chaser is north of the carrier, so cover must be north of it too.
  assert.ok(built.every((c) => c.z > 100), 'cover belongs between carrier and chaser');
});

test('an empty magazine reloads instead of triggering a retreat', () => {
  const world = new ServerWorld();
  const bot = new ServerBot('reload-test', { x: 0, y: GROUND_Y, z: 0 }, 'blue', 'Shooter');
  bot.role = 'assault';
  bot.currentAmmo = 0;
  bot.isReloading = false;
  const enemy = { id: 'e3', position: { x: 0, y: GROUND_Y, z: 30 }, team: 'red', isDead: false, carryingFlag: false };
  const ctx = ctxFor(world, [enemy]);

  run(bot, ctx, 1);

  assert.strictEqual(bot.isReloading, true, 'dry magazine must start a reload');
  assert.notStrictEqual(bot.stateName, 'RETREAT', 'no ammo is not a reason to abandon the objective');
});

test('a teammate carrying our flag pulls nearby bots into ESCORT', () => {
  const world = new ServerWorld();
  const bot = new ServerBot('escort-test', { x: 0, y: GROUND_Y, z: 100 }, 'blue', 'Escort');
  bot.role = 'support';
  const carrier = { id: 'mate', position: { x: 4, y: GROUND_Y, z: 96 }, team: 'blue', isDead: false, carryingFlag: true };
  const ctx = ctxFor(world, [carrier]);

  run(bot, ctx, 2);

  assert.strictEqual(bot.stateName, 'ESCORT', 'support bots screen their carrier');
});
