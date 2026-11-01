// Defensive structure pool + stuck-recovery tests
// (run: node --test tests/*.test.mjs)
//
// Bots used to build exactly one blueprint (a straight wall) and had no way to
// notice they were grinding against an obstruction. These tests pin the pool
// shapes, budget filtering, random selection and the bounded recovery actions.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const types = require('../dist/tests/sharedTypes.cjs');

const GROUND = 8; // flat mock terrain

/** Context with a mocked, perfectly flat and empty world. */
function mockCtx(overrides = {}) {
  return {
    world: {
      canBuild: () => true,
      getGroundHeight: () => GROUND,
      isSolid: () => false,
      ...(overrides.world || {}),
    },
    serverTime: 0,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
    ...overrides,
  };
}

function botAt(x = 0, z = 0) {
  return new ServerBot('structure-test', { x, y: GROUND, z }, 'blue', 'Builder');
}

test('the pool offers exactly the four documented structures', () => {
  const bot = botAt();
  const ctx = mockCtx();
  const kinds = ['trench', 'l-trench', 'bunker', 'bunker-ports'];
  for (const kind of kinds) {
    const cells = bot.planStructure(ctx, kind, { x: 0, z: 0 }, 1);
    assert.ok(cells.length >= 10, `${kind} should be a real structure, got ${cells.length} cells`);
  }
});

test('straight trench is a single 2-high wall between bot and enemy', () => {
  const bot = botAt();
  const ctx = mockCtx();
  const cells = bot.planStructure(ctx, 'trench', { x: 0, z: 0 }, 1);

  const wall = cells.filter((c) => !c.roof);
  const zs = new Set(wall.map((c) => c.z));
  assert.strictEqual(zs.size, 1, 'wall occupies one Z row');
  assert.strictEqual([...zs][0], 2, 'wall sits toward the enemy (+Z for blue)');
  // 2-high wall with optional end parapets (budget permitting).
  assert.ok(wall.every((c) => c.y >= GROUND && c.y <= GROUND + 2), 'wall stays within 2-3 courses');
  assert.ok(wall.some((c) => c.y === GROUND + 1), 'wall is at least 2 high');
  assert.ok(wall.length >= 9, 'adaptive width builds a usable firing line');
});

test('L-trench adds a perpendicular return arm', () => {
  const bot = botAt();
  const ctx = mockCtx();
  const cells = bot.planStructure(ctx, 'l-trench', { x: 0, z: 0 }, 1);
  const zs = new Set(cells.map((c) => c.z));
  assert.ok(zs.has(2), 'front wall toward the enemy');
  assert.ok(zs.has(1) || zs.has(0) || zs.has(-1), 'arm returns toward friendly ground');
  assert.ok(zs.size >= 3, 'L shape spans several Z rows');
});

test('basic bunker has walls and a roofed front row', () => {
  const bot = botAt();
  const ctx = mockCtx();
  const cells = bot.planStructure(ctx, 'bunker', { x: 0, z: 0 }, 1);
  const roof = cells.filter((c) => c.roof);
  assert.ok(roof.length >= 3, 'front row is roofed');
  assert.ok(cells.some((c) => c.y === GROUND + 1), 'walls are 2 high');
  assert.ok(roof.every((c) => c.y === GROUND + 2), 'roof sits on top of the 2-high wall');
});

test('firing-port bunker is taller and leaves two head-height slits', () => {
  const bot = botAt();
  const ctx = mockCtx();
  const cells = bot.planStructure(ctx, 'bunker-ports', { x: 0, z: 0 }, 1);
  const front = cells.filter((c) => c.z === 2 && !c.roof);

  assert.ok(front.some((c) => c.y === GROUND + 2), 'front wall is 3 high');
  // Slits at dx -1 and +1 on the middle course: those cells must be absent.
  const portCells = front.filter((c) => c.y === GROUND + 1);
  const xs = portCells.map((c) => c.x).sort((a, b) => a - b);
  assert.ok(!xs.includes(-1) && !xs.includes(1), 'both firing ports stay open');
  assert.ok(xs.length >= 3, 'the rest of the middle course is solid');
});

test('the pool respects the remaining block budget', () => {
  const bot = botAt();
  const ctx = mockCtx();
  bot.botBlocks = 2; // less than the cheapest structure
  const pick = bot.chooseStructure(ctx, { x: 0, z: 0 }, 1);
  assert.strictEqual(pick, null, 'nothing may be started without enough blocks');
});

test('selection is random across the valid pool', () => {
  const bot = botAt();
  const ctx = mockCtx();
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const pick = bot.chooseStructure(ctx, { x: 0, z: 0 }, 1);
    if (pick) seen.add(pick.kind);
  }
  assert.ok(seen.size >= 3, `expected several structure kinds, saw ${[...seen].join(', ')}`);
});

test('a stuck bot clears the block directly ahead', () => {
  const bot = botAt(0, 0);
  let dug = null;
  const ctx = mockCtx({
    world: { canBuild: () => true, getGroundHeight: () => GROUND, isSolid: () => true },
    digBlock: (_bot, pos) => { dug = pos; },
  });
  bot.forwardDir = () => ({ x: 0, y: 0, z: -1 });
  bot.recoverFromStuck(ctx, 100);
  assert.ok(dug, 'recovery should mine the obstruction');
  assert.strictEqual(dug.z, -1, 'the block ahead is the target');
});

test('recovery is bounded and re-plans after repeated failures', () => {
  const bot = botAt(0, 0);
  const ctx = mockCtx(); // no digging available, nothing solid
  bot.trenchPlan = [{ x: 0, y: GROUND, z: 2 }];
  bot.buildPlan = [{ x: 0, y: GROUND, z: 2 }];
  bot.defendPost = { x: 0, y: GROUND, z: 0 };
  bot.forwardDir = () => ({ x: 0, y: 0, z: -1 });

  let t = 100;
  for (let i = 1; i <= 4; i++) {
    bot.recoverFromStuck(ctx, t);
    t += 3; // respect the rate limit
  }

  assert.strictEqual(bot.recoveryAttempts, 0, 'attempts reset once the cap is hit');
  assert.strictEqual(bot.trenchPlan, null, 'stale dig plans are cleared');
  assert.strictEqual(bot.buildPlan, null, 'stale build plans are cleared');
  assert.strictEqual(bot.defendPost, null, 'a stale defend post is dropped');
  assert.strictEqual(bot.stateName, 'ADVANCE', 'bot re-plans instead of retrying forever');
});

test('standing still for two samples triggers recovery', () => {
  const bot = botAt(10, 10);
  const ctx = mockCtx();
  bot.botState = 'ADVANCE';
  bot.position = { x: 10, y: GROUND, z: 10 };
  ctx.serverTime = 1;
  bot.checkProgress(ctx); // baseline sample (moved into position)
  ctx.serverTime = 2;
  bot.checkProgress(ctx); // strike 1
  ctx.serverTime = 3;
  bot.checkProgress(ctx); // strike 2 -> recover

  assert.strictEqual(bot.recoveryAttempts, 1, 'two dead samples should recover once');
  assert.ok(bot.waypoint, 'recovery sets a fresh waypoint');
});

test('digging and holding states are not treated as stuck', () => {
  const bot = botAt(5, 5);
  const ctx = mockCtx();
  bot.position = { x: 5, y: GROUND, z: 5 };
  bot.botState = 'TRENCH';
  ctx.serverTime = 1;
  bot.checkProgress(ctx);
  ctx.serverTime = 2;
  bot.checkProgress(ctx);
  ctx.serverTime = 3;
  bot.checkProgress(ctx);
  assert.strictEqual(bot.recoveryAttempts, 0, 'a digging bot is allowed to stand still');
});
