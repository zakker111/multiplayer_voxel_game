import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { WORKSHOP_START_STOCK, WORKSHOP_CENTERS, GROUND_LEVEL } = require('../dist/tests/sharedTypes.cjs');

process.env.SERVER_BOT_COUNT = '0';

test('separate logistics bot gathers natural blocks and deposits them at its workshop', () => {
  const game = new ServerGame();
  for (const id of [...game.players.keys()]) game.removeBot(id);
  const first = game.addBot('blue', 'Engineer one');
  const second = game.addBot('blue', 'Engineer two');
  const logisticsId = game.addBot('blue', 'Logistics');
  const firstBot = game.players.get(first);
  const secondBot = game.players.get(second);
  const logistics = game.players.get(logisticsId);
  assert.ok(firstBot.isBotFlag && firstBot.isEngineer);
  assert.ok(secondBot.isBotFlag && secondBot.isEngineer);
  assert.ok(logistics.isBotFlag && logistics.isLogistics);
  assert.equal(logistics.isEngineer, false);

  game.workshopStock.blue = 0;
  const workshop = WORKSHOP_CENTERS.blue;
  logistics.position = { x: workshop.x, y: game.world.getGroundHeight(workshop.x, workshop.z), z: workshop.z + 9 };
  game.update(0.05);
  assert.ok(game.botLogisticsTasks.has(logisticsId), 'low stock assigns a separate logistics task');

  for (let i = 0; i < 1800 && game.workshopStock.blue === 0; i++) game.update(0.05);
  assert.ok(game.workshopStock.blue > 0, 'harvested blocks are returned to the workshop');
  assert.equal(game.workshopStock.red, WORKSHOP_START_STOCK);
  assert.ok((game.depositableBlocks.get(logisticsId) ?? 0) >= 0);
});
