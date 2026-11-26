// Shared vehicle rules (run: npm test). These are the ground, footprint and
// exit tests the server and the offline client both drive with, so they are
// pinned here rather than through either game loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { vehicleGround, vehicleClear, vehicleExitSpot } = require('../dist/tests/vehiclePhysics.cjs');

const JEEP = { halfWidth: 1.3, halfLength: 2, height: 2 };

/** Ground everywhere with surface `top + 0.5`, plus loose cells [x, y, z]. */
function terrain(top, cells = []) {
  const extra = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
  return { isSolid: (x, y, z) => y <= top || extra.has(`${x},${y},${z}`) };
}

const at = (x, y, z) => ({ x, y, z });
const jeep = (x = 0, z = 0, y = 0.5, yaw = 0) => ({ id: 'jeep-1', kind: 'jeep', position: at(x, y, z), yaw });

/* ---------- ground ---------- */

test('vehicleGround sits a body on flat ground at its own height', () => {
  assert.equal(vehicleGround(terrain(0), at(0, 0.5, 0), 0, JEEP), 0.5);
});

test('vehicleGround climbs a one-voxel step under the body', () => {
  // (1, 0) is inside the footprint but is not one of the nine ring samples the
  // rule used to take, which is exactly the step it missed: the body has to
  // rise onto the block rather than drop to the lower surface and clip it.
  const step = terrain(0, [[1, 1, 0]]);
  assert.equal(vehicleGround(step, at(0, 0.5, 0), 0, JEEP), 1.5);
});

test('vehicleGround refuses a wall taller than one voxel', () => {
  const wall = terrain(0, [[1, 1, 0], [1, 2, 0]]);
  assert.equal(vehicleGround(wall, at(0, 0.5, 0), 0, JEEP), null);
});

test('vehicleGround refuses a drop taller than one voxel', () => {
  // Ground two voxels below the body: not a step down, a cliff.
  assert.equal(vehicleGround(terrain(-2), at(0, 0.5, 0), 0, JEEP), null);
});

test('vehicleGround allows a body to sit one voxel above lower ground', () => {
  // Same height difference as the cliff, within the one-voxel tolerance.
  assert.equal(vehicleGround(terrain(-1), at(0, 0.5, 0), 0, JEEP), -0.5);
});

/* ---------- footprint ---------- */

test('vehicleClear accepts a body on open ground', () => {
  assert.equal(vehicleClear(terrain(0), at(0, 0.5, 0), 0, JEEP), true);
});

test('vehicleClear rejects a solid block inside the footprint', () => {
  assert.equal(vehicleClear(terrain(0, [[0, 1, 0]]), at(0, 0.5, 0), 0, JEEP), false);
  // The floor under the body is the ground it stands on, not an obstacle.
  assert.equal(vehicleClear(terrain(0, [[0, 0, 0]]), at(0, 0.5, 0), 0, JEEP), true);
});

test('vehicleClear ignores a solid block outside the footprint', () => {
  // The body is 4m long and 2.6m wide at this yaw: x=3 is beside it.
  assert.equal(vehicleClear(terrain(0, [[3, 1, 0]]), at(0, 0.5, 0), 0, JEEP), true);
});

test('vehicleClear blocks a live structure but not its wreck', () => {
  const nest = { id: 'nest-1', kind: 'mgNest', position: at(0, 0.5, 0), yaw: 0 };
  assert.equal(vehicleClear(terrain(0), at(0, 0.5, 0), 0, JEEP, { structures: [nest] }), false);
  assert.equal(vehicleClear(terrain(0), at(0, 0.5, 0), 0, JEEP, { structures: [{ ...nest, wreck: true }] }), true);
  assert.equal(vehicleClear(terrain(0), at(0, 0.5, 0), 0, JEEP, { structures: [{ ...nest, position: at(8, 0.5, 0) }] }), true);
});

test('vehicleClear rejects a standing infantry body inside the footprint', () => {
  const infantry = [{ id: 'inf-1', position: at(0, 0.5, 0) }];
  assert.equal(vehicleClear(terrain(0), at(0, 0.5, 0), 0, JEEP, { players: infantry }), false);
});

test('vehicleClear ignores the driver, the dead and infantry standing clear', () => {
  const ground = terrain(0);
  const driver = [{ id: 'inf-1', position: at(0, 0.5, 0) }];
  assert.equal(vehicleClear(ground, at(0, 0.5, 0), 0, JEEP, { players: driver, ignorePlayerId: 'inf-1' }), true);
  assert.equal(vehicleClear(ground, at(0, 0.5, 0), 0, JEEP, { players: [{ ...driver[0], isDead: true }] }), true);
  assert.equal(vehicleClear(ground, at(0, 0.5, 0), 0, JEEP, { players: [{ id: 'inf-2', position: at(4, 0.5, 0) }] }), true);
});

/* ---------- exit ---------- */

test('vehicleExitSpot steps out sideways when the first ring is clear', () => {
  const spot = vehicleExitSpot(terrain(0), jeep());
  assert.ok(spot, 'expected a spot on the first ring');
  // First ring is the body half-length plus 1.5m.
  assert.ok(Math.abs(Math.hypot(spot.x, spot.z) - 3.5) < 0.01, `radius ${Math.hypot(spot.x, spot.z).toFixed(2)}`);
});

test('vehicleExitSpot falls through to a wider ring when the first is blocked', () => {
  // Bodies stand 0.3m inside each first-ring spot: close enough to rule out the
  // first ring, far enough from the second (1m clearance) to leave it open.
  const players = Array.from({ length: 8 }, (_, i) => {
    const angle = i * Math.PI / 4;
    return { id: `inf-${i}`, position: at(Math.cos(angle) * 3.2, 0.5, Math.sin(angle) * 3.2) };
  });
  const spot = vehicleExitSpot(terrain(0), jeep(), { players });
  assert.ok(spot, 'expected a spot on a wider ring');
  const radius = Math.hypot(spot.x, spot.z);
  assert.ok(radius > 4 && radius < 5, `expected the second ring, got ${radius.toFixed(2)}`);
});

test('vehicleExitSpot finds nothing when every ring is blocked', () => {
  const players = [3.2, 4.2, 5.7].flatMap((radius, ring) => Array.from({ length: 8 }, (_, i) => {
    const angle = i * Math.PI / 4;
    return { id: `inf-${ring}-${i}`, position: at(Math.cos(angle) * radius, 0.5, Math.sin(angle) * radius) };
  }));
  assert.equal(vehicleExitSpot(terrain(0), jeep(), { players }), null);
});
