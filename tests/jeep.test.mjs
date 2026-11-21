import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const {
  JEEP_COST, JEEP_MAX_HP, JEEP_TEAM_LIMIT, JEEP_ENTER_REACH,
  VEHICLES, RED_FLAG_POS, VOXEL_BUILT,
} = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';
const conn = frames => ({ send: data => frames.push(JSON.parse(data)), isOpen: () => true });

test('the VEHICLES table is the single source of the jeep numbers', () => {
  // Literal values, not aliases: this pins the balance numbers themselves so a
  // change to any of them has to be deliberate.
  assert.deepEqual(VEHICLES.jeep, {
    kind: 'jeep',
    cost: 40,
    maxHp: 250,
    teamLimit: 2,
    halfWidth: 1.3,
    halfLength: 2,
    height: 2,
    enterReach: 4,
    topSpeed: 12,
    reverseSpeed: 5,
    acceleration: 10,
    turnRate: 1.4,
    fullTurnSpeed: 4,
  });
  // The public aliases stay in step with the table.
  assert.equal(JEEP_COST, VEHICLES.jeep.cost);
  assert.equal(JEEP_MAX_HP, VEHICLES.jeep.maxHp);
  assert.equal(JEEP_TEAM_LIMIT, VEHICLES.jeep.teamLimit);
  assert.equal(JEEP_ENTER_REACH, VEHICLES.jeep.enterReach);
});

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
  assert.equal(jeep.kind, 'jeep', 'snapshot names the vehicle kind');
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
  assert.equal(game.jeepClear({ ...jeep.position, x: jeep.position.x + 1 }, jeep.yaw, VEHICLES.jeep, jeep.id, id), true, 'a passable lateral gap stays clear');
  blocker.position.x = jeep.position.x + 3;
  assert.equal(game.jeepClear({ ...jeep.position, x: jeep.position.x + 1 }, jeep.yaw, VEHICLES.jeep, jeep.id, id), false, 'vehicle collision');
  // The same spot with a wider spec is blocked, so the footprint really comes
  // from the spec rather than a hardcoded jeep size.
  const wideSpec = { ...VEHICLES.jeep, halfWidth: 8, halfLength: 8 };
  assert.equal(game.jeepClear({ ...jeep.position, x: jeep.position.x + 1 }, jeep.yaw, wideSpec, jeep.id, id), false, 'collision uses the spec footprint');
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

test('the second seat is server-authoritative and keeps flag rules intact', () => {
  const game = new ServerGame();
  const frames = [], passengerFrames = [], thirdFrames = [], enemyFrames = [];
  const driverId = game.addPlayer(conn(frames));
  const passengerId = game.addPlayer(conn(passengerFrames));
  const thirdId = game.addPlayer(conn(thirdFrames));
  const enemyId = game.addPlayer(conn(enemyFrames));
  game.handleMessage(driverId, { type: 'join', team: 'blue' });
  game.handleMessage(passengerId, { type: 'join', team: 'blue' });
  game.handleMessage(thirdId, { type: 'join', team: 'blue' });
  game.handleMessage(enemyId, { type: 'join', team: 'red' });
  const driver = game.players.get(driverId), passenger = game.players.get(passengerId);
  const third = game.players.get(thirdId), enemy = game.players.get(enemyId);
  driver.position = { ...game.getWorkshops().blue.position };
  game.handleMessage(driverId, { type: 'buildJeep' });
  const jeep = [...game.jeeps.values()][0];
  assert.equal(jeep.passengerId, null);

  driver.position = { ...jeep.position, x: jeep.position.x - 3 };
  game.handleMessage(driverId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.driverId, driverId);

  passenger.position = { ...jeep.position, x: jeep.position.x + 3 };
  game.handleMessage(passengerId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.passengerId, passengerId, 'a second player takes the passenger seat');
  assert.equal(game.jeepSnapshots()[0].passengerId, passengerId, 'snapshot carries the passenger');

  // Full jeep and enemy boarders are turned away.
  third.position = { ...jeep.position, z: jeep.position.z + 3 };
  game.handleMessage(thirdId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.driverId, driverId);
  assert.equal(jeep.passengerId, passengerId);
  enemy.position = { ...jeep.position, x: jeep.position.x + 2 };
  game.handleMessage(enemyId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.passengerId, passengerId, 'enemy cannot take the second seat');
  enemy.position = { x: 0, y: 10, z: 0 };

  // A passenger cannot drive, spoof position or pick up a flag.
  game.handleMessage(passengerId, { type: 'driveJeep', throttle: 1, steering: 0, brake: false });
  assert.equal(jeep.throttle, 0, 'passenger cannot drive');
  passenger.position = { x: 0, y: 10, z: 0 };
  game.update(0.05);
  assert.deepEqual(passenger.position, jeep.position, 'passenger is server-positioned');
  passenger.position = { ...RED_FLAG_POS, y: 10 };
  game.handleMessage(passengerId, { type: 'pickupFlag' });
  assert.equal(passenger.carryingFlag, false, 'passenger cannot pick up a flag');
  passenger.position = { ...jeep.position };

  // A blocked exit keeps the passenger seated; a clear one puts them out.
  const savedExit = game.safeJeepExit.bind(game);
  game.safeJeepExit = () => null;
  game.handleMessage(passengerId, { type: 'exitJeep' });
  assert.equal(jeep.passengerId, passengerId, 'blocked exit leaves the passenger seated');
  game.safeJeepExit = savedExit;
  passenger.position = { ...jeep.position };
  game.handleMessage(passengerId, { type: 'exitJeep' });
  assert.equal(jeep.passengerId, null);
  assert.equal(jeep.driverId, driverId, 'passenger exit leaves the driver');
  assert.ok(passengerFrames.some(frame => frame.type === 'jeepExited'));
  assert.ok(Math.hypot(passenger.position.x - jeep.position.x, passenger.position.z - jeep.position.z) >= 2);

  // Flag carriers may not board either seat.
  passenger.position = { ...jeep.position, x: jeep.position.x + 3 };
  passenger.carryingFlag = true;
  game.handleMessage(passengerId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.passengerId, null, 'flag carrier cannot take the passenger seat');
  passenger.carryingFlag = false;
  game.handleMessage(passengerId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.passengerId, passengerId);

  // The occupied footprint is ignored while driving: the jeep does not collide
  // with the passenger sitting inside it.
  third.position = { x: 0, y: 10, z: 0 };
  const start = { ...jeep.position };
  for (let i = 0; i < 10; i++) {
    game.handleMessage(driverId, { type: 'driveJeep', throttle: 1, steering: 0, brake: false });
    game.update(0.05);
  }
  assert.ok(Math.hypot(jeep.position.x - start.x, jeep.position.z - start.z) > 0.5, 'occupied jeep still drives');
  assert.deepEqual(passenger.position, jeep.position);

  // Driver leaving releases the passenger too: no driverless occupied jeep.
  game.handleMessage(driverId, { type: 'exitJeep' });
  assert.equal(jeep.driverId, null);
  assert.equal(jeep.passengerId, null, 'driver exit releases the passenger');
  assert.ok(passengerFrames.filter(frame => frame.type === 'jeepExited').length >= 2);
});

test('bots can take the passenger seat and leave with the driver', () => {
  const game = new ServerGame();
  const frames = [];
  const driverId = game.addPlayer(conn(frames));
  game.handleMessage(driverId, { type: 'join', team: 'blue' });
  const driver = game.players.get(driverId);
  driver.position = { ...game.getWorkshops().blue.position };
  game.handleMessage(driverId, { type: 'buildJeep' });
  const jeep = [...game.jeeps.values()][0];
  game.workshopStock.blue = 0; // no second jeep errand to pull the rider away
  driver.position = { ...jeep.position, x: jeep.position.x - 3 };
  game.handleMessage(driverId, { type: 'enterJeep', vehicleId: jeep.id });

  const squad = [];
  for (let i = 0; i < 4; i++) squad.push(game.players.get(game.addBot('blue', `Passenger ${i}`)));
  const rider = squad.find(bot => !bot.isEngineer && !bot.isLogistics);
  assert.ok(rider, 'a line bot is available to ride');
  rider.hp = rider.maxHp;
  rider.position = { ...jeep.position, x: jeep.position.x + 2 };
  assert.equal(game.maybeBoardBotPassenger(rider), true, 'a bot boards a driven jeep with a free seat');
  assert.equal(jeep.passengerId, rider.id);
  assert.equal(game.botJeepStats.passengerRides, 1);

  rider.position = { x: 0, y: 10, z: 0 };
  game.update(0.05);
  assert.deepEqual(rider.position, jeep.position, 'riding bot is pinned to the jeep, not walked by its AI');

  game.handleMessage(driverId, { type: 'exitJeep' });
  assert.equal(jeep.driverId, null);
  assert.equal(jeep.passengerId, null, 'bot passenger is released with the driver');
  assert.ok(Math.hypot(rider.position.x - jeep.position.x, rider.position.z - jeep.position.z) >= 2);
});
