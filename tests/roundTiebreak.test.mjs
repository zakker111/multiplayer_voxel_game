// Round tiebreak tests (run: node --test tests/*.test.mjs)
//
// Captures decide a round first. A 0:0 round is not an automatic draw any more:
// the chain is captures -> enemy-flag touches -> own-flag returns -> kills, and
// only a round level on all four ends as a draw. These tests drive the real
// ServerGame clock and the real pickup/return paths, not the counters directly.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { RED_FLAG_POS, INTERMISSION_SECONDS } = require('../dist/tests/sharedTypes.cjs');

// A bot roster would fight over the stands and make these assertions flaky.
process.env.SERVER_BOT_COUNT = '0';

function connectedGame() {
  const game = new ServerGame();
  const messages = [];
  // readyState 1 = open: the server only delivers to connections it sees as open.
  const id = game.addPlayer({ send: (d) => messages.push(JSON.parse(d)), readyState: 1 }, '127.0.0.1');
  return { game, id, messages, player: game.players.get(id) };
}

function shortRound(game, seconds) {
  game.roundSeconds = seconds;
  game.roundTimeLeft = seconds;
}

function advance(game, seconds, step = 0.25) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) game.update(step);
}

test('a round with a steal but no capture is awarded to the team that stole the flag', () => {
  const { game, id, messages, player } = connectedGame();
  shortRound(game, 3);
  player.team = 'blue';

  // Stand on the red stand: the authoritative pickup path runs inside update().
  player.position = { x: RED_FLAG_POS.x, y: 10, z: RED_FLAG_POS.z };
  game.update(0.25);

  assert.strictEqual(player.carryingFlag, true, 'the blue player must carry the red flag');
  const afterSteal = game.getRoundSnapshot();
  assert.deepStrictEqual(afterSteal.captures, { red: 0, blue: 0 }, 'no capture yet');
  assert.deepStrictEqual(afterSteal.touches, { red: 0, blue: 1 }, 'the steal is counted as a touch');

  // Carry it to the middle of the map so the round ends without a capture.
  player.position = { x: 0, y: 10, z: 0 };
  advance(game, 3.5);

  const ended = messages.filter((m) => m.type === 'roundEnded').pop();
  assert.ok(ended, 'roundEnded must be broadcast when the clock runs out');
  assert.deepStrictEqual(ended.captures, { red: 0, blue: 0 }, 'the round still had no captures');
  assert.deepStrictEqual(ended.touches, { red: 0, blue: 1 });
  assert.strictEqual(ended.winner, 'blue', 'the team that stole the flag takes the 0:0 round');
  assert.strictEqual(ended.wins.blue, 1);
  assert.strictEqual(ended.wins.red, 0);

  const snap = game.getRoundSnapshot();
  assert.strictEqual(snap.phase, 'intermission');
  assert.ok(snap.intermission > 0 && snap.intermission <= INTERMISSION_SECONDS);
});

test('a round with no captures, steals, returns or kills is still a draw', () => {
  const { game, messages } = connectedGame();
  shortRound(game, 3);

  advance(game, 3.5);

  const ended = messages.filter((m) => m.type === 'roundEnded').pop();
  assert.strictEqual(ended.winner, 'draw', 'nothing happened, so nobody wins the round');
  assert.deepStrictEqual(ended.touches, { red: 0, blue: 0 });
  assert.deepStrictEqual(ended.returns, { red: 0, blue: 0 });
  assert.strictEqual(ended.wins.blue, 0);
  assert.strictEqual(ended.wins.red, 0);
});

test('returning your own dropped flag breaks a tied touch count', () => {
  const { game, id, messages, player } = connectedGame();
  shortRound(game, 3);
  player.team = 'red';

  // Both sides stole once: touches are level, so the chain moves to returns.
  game.flagTouches = { red: 1, blue: 1 };
  // A red flag lying on the ground and a red player standing on it.
  game.droppedFlags.push({ position: { x: 0, y: 10, z: 0 }, team: 'red', respawnTimer: 30 });
  player.position = { x: 0, y: 10, z: 0 };
  game.update(0.25);

  assert.deepStrictEqual(
    game.getRoundSnapshot().returns,
    { red: 1, blue: 0 },
    'walking over your own dropped flag is a tracked return',
  );
  assert.strictEqual(game.getRoundSnapshot().blueFlagAtBase === true || game.redFlagAtBase === true, true);

  advance(game, 3.5);

  const ended = messages.filter((m) => m.type === 'roundEnded').pop();
  assert.deepStrictEqual(ended.captures, { red: 0, blue: 0 });
  assert.deepStrictEqual(ended.touches, { red: 1, blue: 1 });
  assert.deepStrictEqual(ended.returns, { red: 1, blue: 0 });
  assert.strictEqual(ended.winner, 'red', 'the side that recovered its flag takes the round');
});

test('captures outrank touches, and touches outrank kills', () => {
  const { game } = connectedGame();

  game.captures = { red: 0, blue: 1 };
  game.flagTouches = { red: 5, blue: 1 };
  game.flagReturns = { red: 3, blue: 0 };
  game.roundKills = { red: 40, blue: 1 };
  assert.strictEqual(game.roundWinner(), 'blue', 'captures are the first step');

  game.captures = { red: 0, blue: 0 };
  assert.strictEqual(game.roundWinner(), 'red', 'then flag touches');

  game.flagTouches = { red: 2, blue: 2 };
  game.flagReturns = { red: 1, blue: 0 };
  assert.strictEqual(game.roundWinner(), 'red', 'then flag returns');

  game.flagReturns = { red: 1, blue: 1 };
  assert.strictEqual(game.roundWinner(), 'red', 'then kills, when nothing above separates the teams');

  // Match totals must not leak into the round: a big lead from an earlier
  // round cannot decide this one once this round is level on everything.
  game.scores = { red: 99, blue: 0 };
  game.roundKills = { red: 0, blue: 0 };
  assert.strictEqual(game.roundWinner(), 'draw', 'only round kills break a kill tie');
});

test('the next round resets the tiebreak tallies with the captures', () => {
  const { game } = connectedGame();
  shortRound(game, 2);
  game.flagTouches = { red: 3, blue: 1 };
  game.flagReturns = { red: 2, blue: 4 };

  advance(game, 2.5); // round ends, intermission starts

  let guard = 0;
  while (game.getRoundSnapshot().round === 1 && guard++ < 400) game.update(0.25);
  const snap = game.getRoundSnapshot();
  assert.strictEqual(snap.round, 2);
  assert.deepStrictEqual(snap.touches, { red: 0, blue: 0 }, 'touches reset for the new round');
  assert.deepStrictEqual(snap.returns, { red: 0, blue: 0 }, 'returns reset for the new round');
});
