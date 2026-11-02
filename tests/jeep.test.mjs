import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { JEEP_COST, JEEP_MAX_HP, RED_FLAG_POS, VOXEL_BUILT } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';
const conn = frames => ({ send: data => frames.push(JSON.parse(data)), isOpen: () => true });

test('jeep construction, authority, terrain, exits, damage and lifecycle', () => {
  const game = new ServerGame();
  const frames = [], enemyFrames = [];
  const id = game.addPlayer(conn(frames));
  const enemyId = game.addPlayer(conn(enemyFrames));
  game.handleMessage(id, { type: 'join', team: 'blue' });
  game.handleMessage(enemyId, { type: 'join', team: 'red' });
  const p = game.players.get(id), enemy = game.players.get(enemyId);
  const workshop = game.getWorkshops().blue.position;
  const stock = game.workshopStock.blue;
  game.handleMessage(id, { type: 'buildJeep' });
  assert.equal(game.jeeps.size, 0, 'cannot build remotely');
  p.position = { ...workshop };
  game.workshopStock.blue = JEEP_COST - 1;
  game.handleMessage(id, { type: 'buildJeep' });
  assert.equal(game.jeeps.size, 0, 'cannot build without funds');
  game.workshopStock.blue = stock;
  const pad = { x: workshop.x + 11, y: workshop.y, z: workshop.z };
  enemy.position = { ...pad };
  game.handleMessage(id, { type: 'buildJeep' });
  assert.equal(game.jeeps.size, 0, 'occupied pad blocks spawn');
  assert.equal(game.workshopStock.blue, stock);
  enemy.position = { x: 0, y: 10, z: 0 };
  game.handleMessage(id, { type: 'buildJeep' });
  assert.equal(game.workshopStock.blue, stock - JEEP_COST);
  const jeep = [...game.jeeps.values()][0];
  assert.equal(jeep.hp, JEEP_MAX_HP);
  assert.equal(jeep.driverId, null);
  assert.equal(game.jeeps.size, 1);
  game.handleMessage(id, { type: 'buildJeep' });
  assert.equal(game.jeeps.size, 1, 'existing vehicle blocks pad');
  assert.equal(game.workshopStock.blue, stock - JEEP_COST);
  const lateFrames = [];
  game.addPlayer(conn(lateFrames));
  assert.equal(lateFrames[0].jeeps[0].id, jeep.id);

  p.position = { ...pad, x: pad.x - 3 };
  p.carryingFlag = true;
  game.handleMessage(id, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.driverId, null, 'flag carriers cannot enter');
  p.carryingFlag = false;
  enemy.position = { ...p.position };
  game.handleMessage(enemyId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.driverId, null, 'enemy cannot take jeep');
  enemy.position = { x: 0, y: 10, z: 0 };
  game.handleMessage(id, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.driverId, id);
  assert.equal(game.jeepSnapshots()[0].driverId, id);
  game.handleMessage(id, { type: 'playerInput', input: { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, position: { ...RED_FLAG_POS, y: 10 } } });
  assert.notEqual(p.position.z, RED_FLAG_POS.z, 'driver cannot spoof position');
  p.position = { ...RED_FLAG_POS, y: 10 };
  game.handleMessage(id, { type: 'pickupFlag' });
  assert.equal(p.carryingFlag, false, 'seated player cannot pick up flag');
  p.position = { ...jeep.position };
  game.handleMessage(id, { type: 'driveJeep', throttle: 'fast', steering: 0, brake: false });
  assert.equal(jeep.throttle, 0, 'malformed input rejected');
  const start = { ...jeep.position };
  for (let i = 0; i < 20; i++) {
    game.handleMessage(id, { type: 'driveJeep', throttle: 1, steering: 0, brake: false });
    game.update(0.05);
  }
  assert.ok(Math.hypot(jeep.position.x - start.x, jeep.position.z - start.z) > 1, 'vehicle moves');
  assert.deepEqual(p.position, jeep.position, 'driver is server-positioned');
  for (let i = 0; i < 40; i++) game.update(0.05);
  assert.equal(jeep.brake, true, 'stale inputs engage the brake');
  assert.equal(jeep.speed, 0, 'stale inputs brake automatically');
  const beforeWall = { ...jeep.position };
  const obstacleZ = Math.round(jeep.position.z + 4);
  const obstacleY = Math.round(jeep.position.y + 1);
  game.world.setVoxel(Math.round(jeep.position.x), obstacleY, obstacleZ, VOXEL_BUILT, 3);
  for (let i = 0; i < 40; i++) {
    game.handleMessage(id, { type: 'driveJeep', throttle: 1, steering: 0, brake: false });
    game.update(0.05);
  }
  assert.ok(jeep.position.z < obstacleZ - 2, 'jeep cannot pass through a wall');
  assert.equal(game.world.getVoxel(Math.round(beforeWall.x), obstacleY, obstacleZ).type, VOXEL_BUILT);
  game.world.setVoxel(Math.round(beforeWall.x), obstacleY, obstacleZ, 0);
  const cell = { x: Math.round(jeep.position.x), y: Math.round(jeep.position.y + 1), z: Math.round(jeep.position.z) };
  assert.equal(game.canBuildAt(cell.x, cell.y, cell.z), false, 'blocks cannot intersect jeep');
  // Trench edges and other vehicles must not be traversable or skipped.
  const jeepBeforeTrench = { ...jeep.position };
  for (let x = Math.round(jeep.position.x) - 3; x <= Math.round(jeep.position.x) + 3; x++) {
    for (let z = Math.round(jeep.position.z) + 4; z <= Math.round(jeep.position.z) + 7; z++) {
      const y = Math.round(jeep.position.y - 0.5);
      if (game.world.getVoxel(x, y, z)) game.world.setVoxel(x, y, z, 0);
      if (game.world.getVoxel(x, y - 1, z)) game.world.setVoxel(x, y - 1, z, 0);
    }
  }
  for (let i = 0; i < 40; i++) {
    game.handleMessage(id, { type: 'driveJeep', throttle: 1, steering: 0, brake: false });
    game.update(0.05);
  }
  assert.ok(jeep.position.z < jeepBeforeTrench.z + 4, 'jeep stops before the trench');
  const blocker = { ...jeep, id: 'blocker', position: { ...jeep.position, x: jeep.position.x + 4 }, driverId: null };
  game.jeeps.set(blocker.id, blocker);
  // The rectangle is 1.3m half-width, so a 3m lateral gap is genuinely passable.
  assert.equal(game.jeepClear({ ...jeep.position, x: jeep.position.x + 1 }, jeep.yaw, jeep.id, id), true, 'a passable lateral gap stays clear');
  blocker.position.x = jeep.position.x + 3;
  assert.equal(game.jeepClear({ ...jeep.position, x: jeep.position.x + 1 }, jeep.yaw, jeep.id, id), false, 'vehicle collision');
  game.jeeps.delete(blocker.id);
  const savedExit = game.safeJeepExit.bind(game);
  game.safeJeepExit = () => null;
  game.handleMessage(id, { type: 'exitJeep' });
  assert.equal(jeep.driverId, id, 'blocked exit leaves driver seated');
  game.safeJeepExit = savedExit;
  game.handleMessage(id, { type: 'exitJeep' });
  assert.equal(jeep.driverId, null);
  assert.ok(frames.some(frame => frame.type === 'jeepExited'));
  assert.ok(Math.hypot(p.position.x - jeep.position.x, p.position.z - jeep.position.z) >= 3);

  p.position = { ...jeep.position, x: jeep.position.x - 3 };
  game.handleMessage(id, { type: 'enterJeep', vehicleId: jeep.id });
  enemy.position = { x: jeep.position.x, y: jeep.position.y, z: jeep.position.z + 8 };
  enemy.changeEquipment('rifle');
  game.lastShootTime.delete(enemyId);
  game.handleMessage(enemyId, { type: 'shoot', origin: { x: enemy.position.x, y: enemy.position.y + 1.6, z: enemy.position.z }, direction: { x: 0, y: 0, z: -1 } });
  assert.ok(jeep.hp < JEEP_MAX_HP, 'enemy gunfire damages the vehicle');
  assert.equal(p.hp, 100, 'vehicle absorbs shots to its occupant');
  game.damageJeep(jeep, JEEP_MAX_HP);
  assert.equal(jeep.wreck, true);
  assert.equal(jeep.driverId, null);
  assert.equal(p.isDead, false);
  game.update(4.1);
  assert.equal(game.jeeps.size, 0, 'wreck expires');
  game.workshopStock.blue = 200;
  p.position = { ...workshop };
  game.handleMessage(id, { type: 'buildJeep' });
  const next = [...game.jeeps.values()][0];
  p.position = { ...next.position, x: next.position.x - 3 };
  game.handleMessage(id, { type: 'enterJeep', vehicleId: next.id });
  game.handleMessage(id, { type: 'toggleSpectator' });
  assert.equal(next.driverId, null, 'spectator transition releases driver');
  p.isSpectating = false;
  p.position = { ...next.position, x: next.position.x - 3 };
  game.handleMessage(id, { type: 'enterJeep', vehicleId: next.id });
  game.handlePlayerDeath(id);
  assert.equal(next.driverId, null, 'death cleanup releases driver');
  p.position = { ...next.position, x: next.position.x - 3 };
  game.handleMessage(id, { type: 'enterJeep', vehicleId: next.id });
  game.removePlayer(id);
  assert.equal(next.driverId, null, 'disconnect releases driver');
  game.startNextRound();
  assert.equal(game.jeeps.size, 0, 'round reset removes jeeps');
});
