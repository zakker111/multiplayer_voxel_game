// End-to-end bot TRENCH-building regression test.
// Bundles the real ServerBot + ServerWorld and runs a headless bot through its
// FSM, asserting that it actually places trench wall voxels in the world.
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

test('bot enters TRENCH state and builds wall voxels end-to-end', () => {
  const world = new ServerWorld();
  const built = [];
  const ctx = makeCtx(world, built);

  // Spawn a blue bot near midfield so the trench trigger (midDist < 35) fires
  const midZ = (types.BLUE_FLAG_POS.z + types.RED_FLAG_POS.z) / 2;
  const spawn = { x: 32, y: GROUND_Y, z: midZ };
  const bot = new ServerBot('bot-test', spawn, 'blue', 'TestBot');

  // Deterministic trench entry: RNG is consumed by the constructor's bias
  // rolls first, then per-decision-gate. Fresh sequence per tick: value #1
  // fails the flag-grab coin flip (0.9 > 0.55), value #2 passes the TRENCH
  // gate (0.1 < buildBias*0.8). Near-base BUILD can't fire at midfield
  // distance anyway. The state timer is expired at construction so a decision
  // runs on the very first tick.
  const origRandom = Math.random;

  let sawTrench = false;
  let t = 0;
  const dt = 1 / 20;
  for (let i = 0; i < 1200; i++) {
    t += dt;
    ctx.serverTime = t;
    let k = 0;
    const seq = [0.9, 0.1];
    Math.random = () => seq[Math.min(k++, seq.length - 1)];
    if (!sawTrench) {
      bot.position = { ...spawn }; // keep trigger condition (midDist<35) stable
    }
    bot.botUpdate(dt, ctx);
    if (bot.stateName === 'TRENCH') sawTrench = true;
    if (sawTrench && built.length >= 10) break;
  }
  Math.random = origRandom;

  assert.ok(sawTrench, 'bot should transition into TRENCH state at midfield');
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
  for (const c of built) {
    assert.ok(c.y >= GROUND_Y, `trench cell ${JSON.stringify(c)} at or above base ground level`);
    assert.ok(c.y <= GROUND_Y + 3, 'trench cells stay within wall height');
  }
});
