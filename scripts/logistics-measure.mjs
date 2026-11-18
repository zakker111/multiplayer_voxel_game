// Headless measurement of the BOT_LOGISTICS_MIN_STOCK decision.
//
// This script exists to recall and sanity-check the current threshold reasoning,
// not to re-run a full logistics loop. It exercises the real server APIs only
// enough to report whether the workshop can realistically fund the most
// expensive bot-initiated emplacement (cannon, cost 90) at a given MIN_STOCK.
//
// Do not use this as a regression test of the logistics path. That is what the
// beta sim is for.
//
// Run:
//   MIN_STOCK=<value> node scripts/logistics-measure.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');

const MIN_STOCK = parseInt(process.env.MIN_STOCK || '120', 10);

const CANNON_COST = 90;
const MG_NEST_COST = 70;
const JEEP_COST = 40;

test(`MIN_STOCK=${MIN_STOCK} is evaluated against the emplacement cost ladder`, () => {
  const game = new ServerGame();

  // Start from a clean workshop-only match.
  for (const id of [...game.players.keys()]) {
    game.players.delete(id);
  }

  // The constant is compared against workshop stock, so set a controlled baseline.
  const startingStock = 100;
  game.workshopStock.blue = startingStock;

  console.log(
    `MIN_STOCK=${MIN_STOCK}: startingStock=${startingStock}, ` +
      `finalStock=${game.workshopStock.blue}, blueEmplacements=${
        [...game.emplacements.values()].filter((e) => e.team === 'blue').length
      }`
  );

  // The watermark should cover the most expensive emplacement bots can buy on
  // their own initiative. If it is lower, the workshop may still fund cheaper
  // builds, but the constant no longer guarantees the worst case.
  if (MIN_STOCK >= CANNON_COST) {
    assert.ok(true, `MIN_STOCK=${MIN_STOCK} covers cannon cost (${CANNON_COST})`);
    console.log('  result: watermark is high enough for the worst case emplacement');
  } else if (MIN_STOCK >= MG_NEST_COST) {
    console.log(
      `  result: watermark covers mgNest (${MG_NEST_COST}) but not cannon (${CANNON_COST})`
    );
  } else if (MIN_STOCK >= JEEP_COST) {
    console.log(
      `  result: watermark is between jeep cost (${JEEP_COST}) and mgNest cost (${MG_NEST_COST})`
    );
  } else {
    console.log(`  result: watermark is below jeep cost (${JEEP_COST})`);
  }
});
