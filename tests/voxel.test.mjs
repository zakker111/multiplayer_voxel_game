// Voxel placement/mining regression tests (run: node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerWorld } = require('../dist/tests/serverWorld.cjs');

function freshWorld() { return new ServerWorld(); }

test('can place block on ground surface', () => {
  const w = freshWorld();
  assert.ok(w.canBuild(20, 8, 20));
  w.setVoxel(20, 8, 20, 4, 3);
  assert.ok(w.isSolid(20, 8, 20));
});

test('can stack blocks upward', () => {
  const w = freshWorld();
  w.setVoxel(20, 8, 20, 4, 3);
  assert.ok(w.canBuild(20, 9, 20));
  w.setVoxel(20, 9, 20, 4, 3);
  assert.ok(w.isSolid(20, 9, 20));
});

test('can bridge sideways off an existing block', () => {
  const w = freshWorld();
  w.setVoxel(20, 8, 20, 4, 3);
  assert.ok(w.canBuild(21, 8, 20));
  w.setVoxel(21, 8, 20, 4, 3);
  assert.ok(w.isSolid(21, 8, 20));
});

test('mid-air placement far from support is rejected', () => {
  const w = freshWorld();
  assert.strictEqual(w.canBuild(45, 22, 45), false);
});

test('placement above build height limit is rejected', () => {
  const w = freshWorld();
  assert.strictEqual(w.canBuild(20, 40, 20), false);
});

test('occupied cell cannot be built into', () => {
  const w = freshWorld();
  assert.strictEqual(w.canBuild(20, 7, 20), false); // natural ground
});

test('ground voxel can be mined with tool damage', () => {
  const w = freshWorld();
  let destroyed = false;
  for (let i = 0; i < 10 && !destroyed; i++) destroyed = w.damageVoxel(20, 7, 20, 2);
  assert.ok(destroyed);
  assert.strictEqual(w.isSolid(20, 7, 20), false);
});

test('mining supports tower collapse check runs without error', () => {
  const w = freshWorld();
  w.setVoxel(20, 8, 20, 4, 3);
  let destroyed = false;
  for (let i = 0; i < 10 && !destroyed; i++) destroyed = w.damageVoxel(20, 7, 20, 2);
  assert.ok(destroyed);
  const collapsed = w.collapseDisconnected(20, 7, 20);
  assert.ok(Array.isArray(collapsed));
});
