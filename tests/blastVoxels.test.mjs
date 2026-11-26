// Explosives crater blocks by distance from the burst, through the same shared
// helper cannon, mortar and any future explosive use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const {
  VOXEL_BLAST_TOUGHNESS, blastVoxelDamage, blastVoxelHits,
} = require('../dist/tests/ballistics.cjs');
const {
  CANNON_BLAST_DAMAGE, CANNON_BLAST_RADIUS, MORTAR_BLAST_DAMAGE, MORTAR_BLAST_RADIUS,
  VOXEL_BUILT, VOXEL_MAX_DURABILITY,
} = require('../dist/tests/sharedTypes.cjs');

const block = (game, x, y, z) => game.world.setVoxel(x, y, z, VOXEL_BUILT, VOXEL_MAX_DURABILITY);
const shellAt = (kind, impact) => ({
  id: `blast-${kind}`,
  kind,
  team: 'blue',
  ownerId: null,
  position: { ...impact },
  velocity: { x: 0, y: 0, z: 1 },
  firedAt: 0,
});

test('block blast damage falls off with distance and has no floor', () => {
  const centre = blastVoxelDamage(CANNON_BLAST_DAMAGE, CANNON_BLAST_RADIUS, 0);
  assert.equal(centre, CANNON_BLAST_DAMAGE / VOXEL_BLAST_TOUGHNESS);
  assert.ok(centre > 1, 'the centre breaks a block');
  assert.ok(blastVoxelDamage(CANNON_BLAST_DAMAGE, CANNON_BLAST_RADIUS, 4) < 1, 'the ring only chips');
  assert.equal(
    blastVoxelDamage(CANNON_BLAST_DAMAGE, CANNON_BLAST_RADIUS, CANNON_BLAST_RADIUS),
    0,
    'outside the radius nothing is hurt',
  );
});

test('the shared helper picks blocks by distance and shelters buried rock', () => {
  const key = (x, y, z) => `${x},${y},${z}`;
  const solids = new Set();
  const add = (x, y, z) => solids.add(key(x, y, z));
  add(0, 0, 0); // at the burst
  add(4, 0, 0); // exposed ring
  add(7, 0, 0); // only inside the mortar's wider ring
  add(-4, 0, 0); // buried ring block
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    add(-4 + dx, dy, dz);
  }
  const isSolid = (x, y, z) => solids.has(key(x, y, z));
  const impact = { x: 0, y: 0, z: 0 };
  const at = (hits, x, y, z) => hits.find((hit) => hit.x === x && hit.y === y && hit.z === z);

  const cannon = blastVoxelHits(impact, CANNON_BLAST_RADIUS, CANNON_BLAST_DAMAGE, isSolid);
  assert.ok(at(cannon, 0, 0, 0).damage > 1, 'the block at the burst breaks');
  const ring = at(cannon, 4, 0, 0);
  assert.ok(ring && ring.damage > 0 && ring.damage < 1, 'the ring block is only chipped');
  assert.equal(at(cannon, 7, 0, 0), undefined, 'outside a cannon radius nothing is touched');
  assert.equal(at(cannon, -4, 0, 0), undefined, 'a buried block in the ring is shielded');

  const mortar = blastVoxelHits(impact, MORTAR_BLAST_RADIUS, MORTAR_BLAST_DAMAGE, isSolid);
  assert.ok(at(mortar, 7, 0, 0), 'the wider mortar blast reaches further');
  assert.equal(at(mortar, -4, 0, 0), undefined, 'buried rock is still shielded');
});

test('a cannon shell breaks the block it lands on and chips the ring', () => {
  const game = new ServerGame();
  const impact = { x: 10, y: 30, z: 10 };
  block(game, 10, 30, 10);
  block(game, 14, 30, 10);
  block(game, 17, 30, 10);

  game.explodeShell(shellAt('cannon', impact), impact);

  assert.equal(game.world.isSolid(10, 30, 10), false, 'the block at the burst is broken');
  const chipped = game.world.getVoxel(14, 30, 10);
  assert.ok(
    chipped && chipped.durability > 0 && chipped.durability < VOXEL_MAX_DURABILITY,
    `the ring block is chipped (${chipped && chipped.durability})`,
  );
  assert.equal(
    game.world.getVoxel(17, 30, 10).durability,
    VOXEL_MAX_DURABILITY,
    'a block outside the blast is untouched',
  );
});

test('a mortar reaches blocks a cannon leaves alone', () => {
  const game = new ServerGame();
  const impact = { x: 10, y: 30, z: 10 };
  block(game, 17, 30, 10);

  game.explodeShell(shellAt('mortar', impact), impact);

  const chipped = game.world.getVoxel(17, 30, 10);
  assert.ok(
    chipped.durability < VOXEL_MAX_DURABILITY,
    `the wider blast reaches the far block (${chipped.durability})`,
  );
});
