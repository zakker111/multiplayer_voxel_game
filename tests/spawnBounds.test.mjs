// Spawn/void-bound regression test (run: node --test tests/)
//
// Every team spawn must be INSIDE the "fell out of the world" bounds, otherwise
// the client eliminates a player on the very first frame after spawning
// ("player spawns eliminated"). The bound used to be a hardcoded 124 while the
// map is 448 wide and spawns sit at |z| 200..220.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  WORLD_SIZE,
  WORLD_HALF,
  BLUE_SPAWN_Z_MIN,
  BLUE_SPAWN_Z_MAX,
  RED_SPAWN_Z_MIN,
  RED_SPAWN_Z_MAX,
  SPAWN_X_RANGE,
  BLUE_FLAG_POS,
  RED_FLAG_POS,
  GROUND_LEVEL,
  isOutOfWorld,
} = require('../dist/tests/sharedTypes.cjs');

test('world half extent covers the spawn zones', () => {
  assert.strictEqual(WORLD_HALF, WORLD_SIZE / 2);
  for (const [label, zMin, zMax] of [
    ['blue', BLUE_SPAWN_Z_MIN, BLUE_SPAWN_Z_MAX],
    ['red', RED_SPAWN_Z_MIN, RED_SPAWN_Z_MAX],
  ]) {
    assert.ok(Math.abs(zMin) <= WORLD_HALF, `${label} spawn zMin ${zMin} outside world half ${WORLD_HALF}`);
    assert.ok(Math.abs(zMax) <= WORLD_HALF, `${label} spawn zMax ${zMax} outside world half ${WORLD_HALF}`);
  }
});

test('every possible spawn point is inside the world (not void-killed at spawn)', () => {
  const zRanges = [
    [BLUE_SPAWN_Z_MIN, BLUE_SPAWN_Z_MAX],
    [RED_SPAWN_Z_MIN, RED_SPAWN_Z_MAX],
  ];
  for (const [zMin, zMax] of zRanges) {
    for (const x of [-SPAWN_X_RANGE, -SPAWN_X_RANGE / 2, 0, SPAWN_X_RANGE / 2, SPAWN_X_RANGE]) {
      for (const z of [zMin, (zMin + zMax) / 2, zMax]) {
        const spawn = { x, y: GROUND_LEVEL, z };
        assert.strictEqual(
          isOutOfWorld(spawn),
          false,
          `spawn ${JSON.stringify(spawn)} is out of world and would be instantly eliminated`,
        );
      }
    }
  }
});

test('flag bases are inside the world', () => {
  assert.strictEqual(isOutOfWorld({ x: BLUE_FLAG_POS.x, y: GROUND_LEVEL, z: BLUE_FLAG_POS.z }), false);
  assert.strictEqual(isOutOfWorld({ x: RED_FLAG_POS.x, y: GROUND_LEVEL, z: RED_FLAG_POS.z }), false);
});

test('genuinely out-of-world positions are still detected', () => {
  assert.strictEqual(isOutOfWorld({ x: 0, y: -9, z: 0 }), true, 'below void floor');
  assert.strictEqual(isOutOfWorld({ x: WORLD_HALF + 1, y: GROUND_LEVEL, z: 0 }), true, 'past +x edge');
  assert.strictEqual(isOutOfWorld({ x: 0, y: GROUND_LEVEL, z: -WORLD_HALF - 1 }), true, 'past -z edge');
});
