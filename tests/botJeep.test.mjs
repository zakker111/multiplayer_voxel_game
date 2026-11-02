import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { JEEP_COST, JEEP_MAX_HP, RED_FLAG_POS } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';
const conn = () => ({ send: () => {}, isOpen: () => true });

function fixture() {
  const game = new ServerGame();
  const id = game.addBot('blue', 'Driver');
  const bot = game.players.get(id);
  bot.role = 'assault'; bot.engineer = false;
  bot.position = { ...game.getWorkshops().blue.position };
  return { game, id, bot };
}
function run(game, seconds) { for (let i = 0; i < seconds * 20; i++) game.update(0.05); }

test('bots build, board and drive; engineers and support stay on foot', () => {
  const { game, id, bot } = fixture();
  const supportId = game.addBot('blue', 'Support');
  const support = game.players.get(supportId);
  support.role = 'support'; support.engineer = false;
  support.position = { ...bot.position, x: bot.position.x - 5 };
  const engineerId = game.addBot('blue', 'Engineer');
  const engineer = game.players.get(engineerId);
  engineer.role = 'assault'; engineer.engineer = true;
  engineer.position = { ...bot.position, x: bot.position.x - 5, z: bot.position.z + 3 };
  const stock = game.workshopStock.blue;
  run(game, 7);
  assert.equal(game.botJeepStats.built, 1);
  assert.equal(game.botJeepStats.entered, 1);
  assert.equal(game.workshopStock.blue, stock - JEEP_COST);
  assert.equal(game.driverJeep(id)?.driverId, id);
  assert.equal(game.driverJeep(supportId), undefined);
  assert.equal(game.driverJeep(engineerId), undefined);
  const jeep = game.driverJeep(id);
  const start = { ...jeep.position };
  run(game, 2);
  assert.ok(Math.hypot(jeep.position.x - start.x, jeep.position.z - start.z) > 1, 'bot drives the real vehicle');
  assert.deepEqual(bot.position, jeep.position, 'infantry AI does not overwrite driving position');
  jeep.position = { x: RED_FLAG_POS.x + 60, y: jeep.position.y, z: RED_FLAG_POS.z };
  game.update(0.05);
  assert.equal(jeep.driverId, null, 'bot exits near objective');
  assert.equal(game.botJeepStats.arrived, 1);
  assert.equal(bot.stateName, 'GRABFLAG');
  game.update(0.05);
  assert.equal(bot.carryingFlag, false, 'not teleported onto flag');
});

test('each team can drive across real terrain and exit near the enemy objective', () => {
  for (const team of ['blue', 'red']) {
    const game = new ServerGame();
    const id = game.addBot(team, 'Route driver');
    const bot = game.players.get(id);
    bot.role = 'assault'; bot.engineer = false;
    bot.position = { ...game.getWorkshops()[team].position };
    for (let tick = 0; tick < 80 * 20 && game.botJeepStats.arrived === 0 && game.botJeepStats.abandoned === 0; tick++) {
      game.update(0.05);
    }
    assert.equal(game.botJeepStats.entered, 1, `${team} boarded a jeep`);
    assert.equal(game.botJeepStats.arrived, 1, `${team} reached the objective area without teleporting`);
    assert.equal(game.botJeepStats.abandoned, 0);
    assert.equal(game.driverJeep(id), undefined, `${team} exited the jeep`);
    assert.equal(bot.stateName, 'GRABFLAG');
  }
});

test('nearby humans have priority and may take a stopped bot jeep at the garage', () => {
  const { game, id, bot } = fixture();
  const humanId = game.addPlayer(conn());
  // A human join replaces the newest team bot; keep the driver as the earlier bot.
  game.addBot('blue', 'Replacement slot');
  game.handleMessage(humanId, { type: 'join', team: 'blue' });
  const human = game.players.get(humanId);
  human.team = 'blue'; human.position = { ...bot.position, x: bot.position.x - 6 };
  run(game, 3);
  assert.equal(game.jeeps.size, 0, 'bot does not build near a human');
  human.position = { x: 0, y: 10, z: 0 };
  run(game, 6);
  const jeep = game.driverJeep(id);
  assert.ok(jeep);
  const workshop = game.getWorkshops().blue.position;
  jeep.position = { x: workshop.x + 11, y: workshop.y, z: workshop.z };
  jeep.speed = 0;
  bot.position = { ...jeep.position };
  human.position = { ...jeep.position, x: jeep.position.x + 3 };
  game.handleMessage(humanId, { type: 'enterJeep', vehicleId: jeep.id });
  assert.equal(jeep.driverId, humanId);
  assert.equal(game.botJeepTasks.has(id), false);
  assert.equal(game.botJeepStats.humanYields, 1);
});

test('a cooled-down garage jeep is not replaced, but a distant empty jeep does not block a new one', () => {
  const { game, id, bot } = fixture();
  run(game, 7);
  const jeep = game.driverJeep(id);
  assert.ok(jeep);
  game.finishBotJeepTask(bot, 'stuck');
  const workshop = game.getWorkshops().blue.position;
  jeep.position = { x: workshop.x + 11, y: workshop.y, z: workshop.z };
  bot.position = { ...workshop };
  game.workshopStock.blue = JEEP_COST;
  game.botJeepCooldown.set(id, 0);
  run(game, 1);
  assert.equal(game.jeeps.size, 1, 'a nearby cooled-down vehicle is not replaced');
  assert.equal(game.botJeepStats.built, 1);
  jeep.position = { x: 0, y: workshop.y, z: 0 };
  bot.position = { ...workshop };
  run(game, 1);
  assert.equal(game.jeeps.size, 2, 'a distant empty vehicle does not prevent a garage build');
  assert.equal(game.botJeepStats.built, 2);
});

test('damaged or repeatedly stuck drivers exit with bounded recovery', () => {
  const { game, id, bot } = fixture();
  run(game, 7);
  const jeep = game.driverJeep(id);
  assert.ok(jeep);
  jeep.hp = JEEP_MAX_HP * 0.2;
  game.update(0.05);
  assert.equal(jeep.driverId, null);
  assert.equal(game.botJeepStats.damagedExits, 1);
  assert.equal(bot.stateName, 'GRABFLAG');
  jeep.hp = JEEP_MAX_HP; // restore the test vehicle before starting a new trip
  game.botJeepCooldown.set(id, 0);
  // Return the vehicle to the garage so the next driver can acquire it.
  const workshop = game.getWorkshops().blue.position;
  jeep.position = { x: workshop.x + 11, y: workshop.y, z: workshop.z };
  bot.position = { ...jeep.position, x: jeep.position.x - 3 };
  run(game, 1);
  assert.equal(jeep.driverId, id);
  // Emulate a solid obstacle on all sides using the actual collision callback.
  const clear = game.jeepClear.bind(game);
  game.jeepClear = () => false;
  run(game, 35);
  game.jeepClear = clear;
  assert.equal(jeep.driverId, null, 'recovery eventually abandons the vehicle');
  assert.ok(game.botJeepStats.recoveries > 0);
  assert.ok(game.botJeepStats.abandoned > 0);
  assert.equal(game.botJeepTasks.has(id), false);
  assert.ok(game.botJeepVehicleCooldown.get(jeep.id) > game.world.serverTime, 'abandoned jeep is temporarily avoided');
});
