import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { WORKSHOP_START_STOCK, WORKSHOP_CAPACITY, GROUND_LEVEL, VOXEL_BUILT } = require('../dist/tests/sharedTypes.cjs');

process.env.SERVER_BOT_COUNT = '0';
const connection = frames => ({ send: data => frames.push(JSON.parse(data)), isOpen: () => true });

function mine(game, id, x, type) {
  const player = game.players.get(id);
  player.position = { x, y: 17, z: 3 };
  player.changeEquipment('pickaxe');
  game.world.setVoxel(x, 18, 0, type, 3);
  game.lastToolTime.delete(id);
  game.handleMessage(id, { type: 'useTool', tool: 'pickaxe', target: { x, y: 18, z: 0 } });
}

test('team workshops enforce resource provenance, proximity, protection and lifecycle', () => {
  const game = new ServerGame();
  const blueFrames = [], redFrames = [];
  const blue = game.addPlayer(connection(blueFrames));
  const red = game.addPlayer(connection(redFrames));
  game.handleMessage(blue, { type: 'join', team: 'blue' });
  game.handleMessage(red, { type: 'join', team: 'red' });
  const b = game.players.get(blue), r = game.players.get(red);
  const initial = blueFrames.find(frame => frame.type === 'init');
  assert.equal(initial.depositable, 0);
  assert.equal(initial.workshops.blue.stock, WORKSHOP_START_STOCK);
  assert.equal(initial.workshops.red.stock, WORKSHOP_START_STOCK);
  assert.equal(initial.workshops.blue.capacity, WORKSHOP_CAPACITY);
  assert.equal(initial.workshops.blue.position.y, GROUND_LEVEL + 0.5);
  assert.equal(blueFrames.find(frame => frame.type === 'joined').state.team, 'blue');
  const redJoined = redFrames.find(frame => frame.type === 'joined');
  assert.equal(redJoined.state.team, 'red');
  assert.ok(redJoined.state.position.z >= 200, 'red joins at its own spawn');
  game.handleMessage(red, { type: 'join', team: 'blue', position: initial.workshops.blue.position });
  assert.equal(r.team, 'red', 'repeated joins cannot switch teams');
  const site = initial.workshops.blue.position;
  assert.ok(initial.voxelChanges.length > 0, 'terrain leveling is sent to late joiners');
  const old = game.world.getVoxel(site.x, GROUND_LEVEL, site.z);
  game.world.setVoxel(site.x, GROUND_LEVEL, site.z, 0);
  assert.equal(game.world.damageVoxel(site.x, GROUND_LEVEL, site.z, 20), false);
  assert.equal(game.world.getVoxel(site.x, GROUND_LEVEL, site.z), old);
  assert.equal(game.world.canBuild(site.x, GROUND_LEVEL + 1, site.z), false);

  // A placed block yields ordinary building stock, not depositable resources.
  mine(game, blue, 0, VOXEL_BUILT);
  assert.equal(game.depositableBlocks.get(blue), 0);
  assert.equal(game.inventories.get(blue), 21);
  mine(game, blue, 2, 1);
  assert.equal(game.depositableBlocks.get(blue), 1);
  assert.equal(game.inventories.get(blue), 21);

  // Malformed tools, spoofed tools, remote and fractional targets cannot mine.
  game.world.setVoxel(4, 18, 0, 1, 3);
  game.lastToolTime.delete(blue);
  game.handleMessage(blue, { type: 'useTool', tool: 'banana', target: { x: 4, y: 18, z: 0 } });
  game.handleMessage(blue, { type: 'useTool', tool: 'spade', target: { x: 4, y: 18, z: 0 } });
  game.handleMessage(blue, { type: 'useTool', tool: 'pickaxe', target: { x: 4.5, y: 18, z: 0 } });
  game.handleMessage(blue, { type: 'useTool', tool: 'pickaxe', target: { x: 100, y: 18, z: 0 } });
  assert.equal(game.world.getVoxel(4, 18, 0).durability, 3);
  assert.equal(game.depositableBlocks.get(blue), 1);
  b.position = { x: 4, y: 17, z: 3 };
  game.world.setVoxel(4, 18, 1, 1, 3);
  game.handleMessage(blue, { type: 'useTool', tool: 'pickaxe', target: { x: 4, y: 18, z: 0 } });
  assert.equal(game.world.getVoxel(4, 18, 0).durability, 3, 'cannot mine through a blocking voxel');
  mine(game, red, -2, 1);
  assert.equal(game.depositableBlocks.get(red), 1, 'red team also mines resources');

  // A remote, enemy, malformed, dead, or spectating depositor cannot transfer.
  game.handleMessage(blue, { type: 'depositWorkshop', team: 'blue' });
  b.position = { ...site };
  game.handleMessage(blue, { type: 'depositWorkshop', team: 'red' });
  game.handleMessage(blue, { type: 'depositWorkshop', team: 'purple' });
  b.isDead = true;
  game.handleMessage(blue, { type: 'depositWorkshop', team: 'blue' });
  b.isDead = false; b.isSpectating = true;
  game.handleMessage(blue, { type: 'depositWorkshop', team: 'blue' });
  b.isSpectating = false;
  assert.equal(game.workshopStock.blue, WORKSHOP_START_STOCK);
  assert.equal(game.depositableBlocks.get(blue), 1);

  game.handleMessage(blue, { type: 'depositWorkshop', team: 'blue' });
  assert.equal(game.workshopStock.blue, WORKSHOP_START_STOCK + 1);
  assert.equal(game.workshopStock.red, WORKSHOP_START_STOCK);
  assert.equal(game.depositableBlocks.get(blue), 0);
  assert.equal(redFrames.filter(frame => frame.type === 'workshopsUpdated').at(-1).workshops.blue.stock, WORKSHOP_START_STOCK + 1);
  const late = [];
  game.addPlayer(connection(late));
  assert.equal(late[0].workshops.blue.stock, WORKSHOP_START_STOCK + 1);

  game.depositableBlocks.set(red, 4);
  r.position = { ...game.getWorkshops().red.position };
  game.workshopStock.red = WORKSHOP_CAPACITY - 1;
  game.handleMessage(red, { type: 'depositWorkshop', team: 'red' });
  assert.equal(game.workshopStock.red, WORKSHOP_CAPACITY);
  assert.equal(game.depositableBlocks.get(red), 3);

  // Building spends free blocks first; only then does it consume mined stock.
  game.inventories.set(blue, 0);
  game.depositableBlocks.set(blue, 1);
  b.position = { x: 10, y: 9, z: 10 };
  const build = { x: 10, y: game.world.getGroundHeight(10, 12), z: 12 };
  game.handleMessage(blue, { type: 'build', position: build });
  assert.equal(game.depositableBlocks.get(blue), 0);
  assert.equal(game.world.getVoxel(build.x, build.y, build.z).type, VOXEL_BUILT);

  game.depositableBlocks.set(blue, 7);
  b.isDead = true;
  game.handleMessage(blue, { type: 'requestRespawn' });
  assert.equal(game.depositableBlocks.get(blue), 0);
  assert.equal(game.inventories.get(blue), 20);
  game.depositableBlocks.set(blue, 3);
  b.isDead = true;
  game.respawnTimers.set(blue, 0.01);
  game.update(0.05);
  assert.equal(game.depositableBlocks.get(blue), 0);
  game.depositableBlocks.set(blue, 2);
  game.startNextRound();
  assert.deepEqual(game.workshopStock, { red: WORKSHOP_START_STOCK, blue: WORKSHOP_START_STOCK });
  assert.equal(game.depositableBlocks.get(blue), 0);
  game.removePlayer(blue);
  assert.equal(game.depositableBlocks.has(blue), false);
});
