// Digging / building round-trip coverage (run: node --test tests/*.test.mjs)
//
// In online and Beta play the client only sends `useTool` / `build` messages;
// the server decides whether the voxel changes and then broadcasts the result.
// If either half of that loop breaks the player "cannot dig", which had no test
// at all. These tests send the real client messages and assert both the server
// state change and the broadcast every client renders from.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { VOXEL_AIR } = require('../dist/tests/sharedTypes.cjs');

// Flat patch of generated terrain: ground voxels end at y=7, so a player stands
// at y=8 and the block they build into is (20, 8, 20).
const STAND = { x: 20, y: 8, z: 20 };
const GROUND_VOXEL = { x: 20, y: 7, z: 20 };
// Beside the player, not under them: the server refuses a cell the player's own
// body overlaps, so placement targets the adjacent cell on top of the ground.
const PLACE = { x: 21, y: 8, z: 20 };

/** Join like the routes do, then stand at a known spot holding `equipment`. */
function joined(equipment = 'pickaxe') {
  const sent = [];
  const conn = { send: (d) => sent.push(JSON.parse(d)), isOpen: () => true, close: () => {} };
  const game = new ServerGame();
  const id = game.addPlayer(conn, '127.0.0.1');
  game.handleMessage(id, { type: 'join', team: 'blue', name: 'Digger' });

  const player = game.players.get(id);
  player.position = { ...STAND };
  player.equipment = equipment;
  sent.length = 0; // ignore join/init chatter
  return { game, id, sent, player };
}

const voxelChangedFor = (sent, v) =>
  sent.find((m) => m.type === 'voxelChanged' && m.change
    && m.change.x === v.x && m.change.y === v.y && m.change.z === v.z);

test('digging round-trips: the server mines the voxel and broadcasts it', () => {
  const { game, id, sent } = joined('pickaxe');
  assert.ok(game.world.isSolid(GROUND_VOXEL.x, GROUND_VOXEL.y, GROUND_VOXEL.z),
    'precondition: the ground voxel exists');

  game.handleMessage(id, { type: 'useTool', tool: 'pickaxe', target: { ...GROUND_VOXEL } });

  assert.strictEqual(
    game.world.isSolid(GROUND_VOXEL.x, GROUND_VOXEL.y, GROUND_VOXEL.z), false,
    'the server must remove the mined voxel',
  );

  const change = voxelChangedFor(sent, GROUND_VOXEL);
  assert.ok(change, 'the removal must be broadcast so every client updates its world');
  assert.strictEqual(change.change.type, VOXEL_AIR, 'the broadcast carries the new air voxel');
});

test('mining natural terrain yields a depositable block', () => {
  const { game, id, sent } = joined('pickaxe');
  game.handleMessage(id, { type: 'useTool', tool: 'pickaxe', target: { ...GROUND_VOXEL } });

  const resources = sent.find((m) => m.type === 'resourcesUpdated');
  assert.ok(resources, 'mining must report the harvested block back to the client');
  assert.strictEqual(resources.depositable, 1, 'natural blocks are workshop-depositable');
});

test('digging is refused when the tool is not equipped (the "cannot dig" failure)', () => {
  const { game, id, sent } = joined('rifle');

  game.handleMessage(id, { type: 'useTool', tool: 'pickaxe', target: { ...GROUND_VOXEL } });

  assert.ok(game.world.isSolid(GROUND_VOXEL.x, GROUND_VOXEL.y, GROUND_VOXEL.z),
    'a rifle must not mine');
  assert.strictEqual(voxelChangedFor(sent, GROUND_VOXEL), undefined, 'nothing to broadcast');
});

test('building round-trips: the server places the block, spends inventory, broadcasts', () => {
  const { game, id, sent } = joined('pickaxe');
  assert.ok(game.world.canBuild(PLACE.x, PLACE.y, PLACE.z), 'precondition: the cell is buildable');

  game.handleMessage(id, { type: 'build', position: { ...PLACE } });

  assert.ok(game.world.isSolid(PLACE.x, PLACE.y, PLACE.z), 'the server must place the block');

  const inventory = sent.find((m) => m.type === 'inventoryUpdated');
  assert.ok(inventory, 'building must report the new inventory');
  assert.strictEqual(inventory.inventory, 19, 'a fresh player has 20 blocks; placing spends one');

  assert.ok(voxelChangedFor(sent, PLACE), 'the placement must be broadcast to other clients');
});

test('a modified client cannot build where the server says no', () => {
  const { game, id, sent } = joined('pickaxe');
  const far = { x: 45, y: 40, z: 45 };

  game.handleMessage(id, { type: 'build', position: far });

  assert.strictEqual(game.world.isSolid(far.x, far.y, far.z), false);
  assert.strictEqual(voxelChangedFor(sent, far), undefined);
});
