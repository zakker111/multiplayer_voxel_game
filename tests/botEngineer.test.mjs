// Engineer / firebase regression tests.
//
// The bot roster now guarantees two dedicated engineers per team. They build
// the team's firebase (support gets a main structure plus an annex, assault
// gets a forward one) while the rest of the squad fights. These tests pin the
// assignment, both construction paths, rally staging, and the telemetry that
// the headless measurement script reads.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerWorld } = require('../dist/tests/serverWorld.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const types = require('../dist/tests/sharedTypes.cjs');

const GROUND = types.GROUND_LEVEL;

function totalStarts(bot) {
  return Object.values(bot.structuresStarted).reduce((sum, count) => sum + count, 0);
}

/** Minimal flat-world context for the plan/telemetry paths. */
function mockCtx() {
  return {
    world: {
      canBuild: () => true,
      getGroundHeight: () => GROUND,
      getGroundHeightBelow: () => GROUND,
      isSolid: () => false,
    },
    serverTime: 0,
    targets: [],
    friendlyDroppedFlagPos: null,
    canSee: () => false,
    fireWeapon: () => {},
    buildBlock: () => {},
  };
}

/** Real-world context for construction and movement tests. */
function ctxFor(world) {
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
      }
    },
  };
}

function botAt(x, z, engineer = false) {
  return new ServerBot('engineer-test', { x, y: GROUND, z }, 'blue', 'Builder', engineer);
}

test('the server assigns exactly two engineers to each team', () => {
  const game = new ServerGame();

  for (const team of ['blue', 'red']) {
    const bots = [...game.players.values()].filter(
      (p) => p.isBotFlag && p.team === team,
    );
    assert.ok(bots.length >= 2, `${team} should have a bot roster`);
    assert.strictEqual(
      bots.filter((p) => p.isEngineer).length,
      2,
      `${team} should have exactly two engineers`,
    );
    assert.deepStrictEqual(
      bots.slice(0, 2).map((p) => p.isEngineer),
      [true, true],
      `${team}'s first two bots should be the engineers`,
    );
    assert.ok(
      bots.slice(2).every((p) => !p.isEngineer),
      `${team}'s later bots should not be engineers`,
    );
  }
});

test('an assault engineer starts a forward firebase; a non-engineer keeps running', () => {
  const engineer = botAt(types.RED_FLAG_POS.x, types.RED_FLAG_POS.z - 60, true);
  engineer.role = 'assault';
  engineer.buildBias = 10; // make the build roll deterministic
  engineer.fortifyStage = 0;
  engineer.lastTrenchAt = -100;
  const ctx = mockCtx();

  engineer.chooseObjective(ctx, 100, types.RED_FLAG_POS, types.BLUE_FLAG_POS);

  assert.strictEqual(engineer.botState, 'TRENCH', 'engineer should begin construction');
  assert.strictEqual(totalStarts(engineer), 1, 'the forward plan should be counted');
  assert.ok(engineer.lastStructureKind, 'the chosen structure should be recorded');

  const runner = botAt(types.RED_FLAG_POS.x, types.RED_FLAG_POS.z - 60, false);
  runner.role = 'assault';
  runner.buildBias = 10;
  runner.fortifyStage = 0;
  runner.lastTrenchAt = -100;

  runner.chooseObjective(mockCtx(), 100, types.RED_FLAG_POS, types.BLUE_FLAG_POS);

  assert.strictEqual(runner.botState, 'GRABFLAG', 'non-engineers should keep attacking');
  assert.strictEqual(totalStarts(runner), 0, 'non-engineers should not start firebases');
});

test('a support engineer builds a main structure and then an annex', () => {
  const world = new ServerWorld();
  const ctx = ctxFor(world);
  const post = { x: 8, y: GROUND, z: types.BLUE_FLAG_POS.z + 26 };
  const bot = new ServerBot('annex-test', post, 'blue', 'Support', true);
  bot.role = 'support';
  bot.lastTrenchAt = -100;
  bot.startStructure(ctx, 'trench');

  let t = 0;
  for (let i = 0; i < 3000 && totalStarts(bot) < 2; i++) {
    t += 1 / 20;
    ctx.serverTime = t;
    bot.botUpdate(1 / 20, ctx);
  }

  assert.strictEqual(totalStarts(bot), 2, 'main structure plus annex should both start');
  assert.strictEqual(bot.structuresCompleted.trench, 1, 'the main trench should complete');
  assert.strictEqual(bot.fortifyStage, 1, 'the annex should be the second fortify stage');
  assert.strictEqual(bot.botState, 'TRENCH', 'the annex should enter the construction state');
});

test('a bot that respawns mid-rally stages again instead of skipping the wait', () => {
  const world = new ServerWorld();
  const ctx = ctxFor(world);
  const bot = new ServerBot(
    'rally-test',
    { x: types.RED_FLAG_POS.x, y: GROUND, z: types.RED_FLAG_POS.z - 60 },
    'blue',
    'Rally',
  );
  bot.role = 'assault';

  bot.doGrabFlag(ctx, types.RED_FLAG_POS, null, 999, 100);
  assert.strictEqual(bot.stagingSince, 100, 'a lone runner should start the rally pause');
  assert.strictEqual(bot.velocity.x, 0, 'rallying should stop lateral movement');
  assert.strictEqual(bot.velocity.z, 0, 'rallying should stop forward movement');

  // Death/respawn calls refillBlocks(); a stale rally timer must not carry over.
  bot.refillBlocks();
  assert.strictEqual(bot.stagingSince, null, 'respawn should clear the rally timer');

  bot.doGrabFlag(ctx, types.RED_FLAG_POS, null, 999, 103);
  assert.strictEqual(bot.stagingSince, 103, 'the new life should start a fresh rally pause');
  assert.strictEqual(bot.velocity.x, 0, 'the fresh rally should still hold position');
});

test('structuresStarted counts plans from startStructure and doBuild', () => {
  const bot = botAt(0, 0, true);
  const ctx = mockCtx();

  bot.startStructure(ctx, 'trench');
  assert.strictEqual(totalStarts(bot), 1, 'startStructure should count its plan');

  // The legacy BUILD path creates its plan directly rather than through
  // startStructure. Keep the plan shape fixed so this test only checks the
  // counter, not random structure selection.
  bot.refillBlocks();
  bot.position = { x: 0, y: GROUND, z: 2.5 };
  bot.chooseStructure = () => ({
    kind: 'trench',
    cells: [{ x: 0, y: GROUND, z: 2, roof: false }],
  });

  bot.doBuild(ctx, types.RED_FLAG_POS, 100);

  assert.strictEqual(totalStarts(bot), 2, 'doBuild should count its plan too');
  assert.strictEqual(bot.structuresStarted.trench, 2, 'both paths should count the trench');
  assert.strictEqual(bot.lastStructureKind, 'trench');
});
