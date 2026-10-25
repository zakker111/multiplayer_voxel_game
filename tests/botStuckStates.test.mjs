// Bot state-exit regression tests (run: node --test tests/*.test.mjs)
//
// Bots used to freeze in place a couple of minutes into a round:
//  - an engineer that finished its trench could not leave TRENCH, because the
//    "don't interrupt a half-built wall" guard also swallowed its own exit;
//  - a low-HP bot fell back to the rear and never returned, because the
//    withdraw decision re-fired every tick, pushing the retreat deadline
//    forward forever, and bots never regenerate HP to clear the old hp gate.
// Both left the whole bot population standing still while still taking damage.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');

/** A game with one bot we can poke at (fields are private in TS, live in JS). */
function gameWithBot(team = 'blue') {
  const game = new ServerGame();
  const id = game.addBot(team, 'Tester');
  return { game, id, bot: game.players.get(id) };
}

test('a half-built trench still cannot be cancelled by a re-decision', () => {
  const { bot } = gameWithBot();
  bot.botState = 'TRENCH';
  bot.trenchPlan = [{ x: 0, y: 8, z: -2 }];

  bot.transition('CAMP', 100, 6);

  assert.strictEqual(bot.botState, 'TRENCH', 'mid-dig re-decisions must not cancel the work');
});

test('a finished engineer can leave TRENCH (used to freeze forever)', () => {
  const { bot } = gameWithBot();
  bot.botState = 'TRENCH';
  bot.trenchPlan = [{ x: 0, y: 8, z: -2 }];

  // finishTrench() clears the plan and then asks to leave.
  bot.trenchPlan = null;
  bot.transition('CAMP', 100, 6);

  assert.notStrictEqual(bot.botState, 'TRENCH', 'bot must not stay stuck in TRENCH with no plan');
});

test('a finished blueprint lets the bot leave BUILD', () => {
  const { bot } = gameWithBot();
  bot.botState = 'BUILD';
  bot.buildPlan = [{ x: 0, y: 8, z: -2 }];

  bot.buildPlan = null;
  bot.transition('GRABFLAG', 100, 10);

  assert.notStrictEqual(bot.botState, 'BUILD', 'bot must not stay stuck in BUILD with no plan');
});

test('low-HP bot rejoins the fight when its retreat window expires', () => {
  const { game, bot } = gameWithBot();
  // Bots never regenerate HP, so this state used to be permanent.
  bot.hp = 5;
  bot.botState = 'RETREAT';
  bot.stateUntil = 0;
  bot.retreatCooldownUntil = 0;

  for (let i = 0; i < 10; i++) game.update(1 / 20);

  assert.notStrictEqual(bot.botState, 'RETREAT', 'withdrawal must be time-boxed, not permanent');
  assert.ok(bot.retreatCooldownUntil > game.world.serverTime, 'must not immediately withdraw again');
});

test('the retreat deadline is set once, not pushed forward every tick', () => {
  const { game, bot } = gameWithBot();
  bot.hp = 5;

  game.update(1 / 20);
  assert.strictEqual(bot.botState, 'RETREAT', 'low HP should trigger a withdrawal');
  const deadline = bot.stateUntil;
  assert.ok(deadline > game.world.serverTime, 'retreat must have a deadline');

  for (let i = 0; i < 20; i++) game.update(1 / 20);

  assert.strictEqual(bot.stateUntil, deadline, 'the deadline must not be refreshed while retreating');
});
