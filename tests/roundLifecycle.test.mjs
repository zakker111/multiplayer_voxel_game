// Round lifecycle regression tests (run: node --test tests/*.test.mjs)
//
// Rounds are a fixed-length window of CTF: when the clock runs out the team with
// more captures takes the round, scoring freezes during a short intermission,
// and the next round resets captures, flags and positions. These tests drive the
// real ServerGame clock (with a shortened round) instead of waiting 30 minutes.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { INTERMISSION_SECONDS, RED_FLAG_POS, DEFAULT_ROUND_MINUTES } = require('../dist/tests/sharedTypes.cjs');

function connectedGame() {
  const game = new ServerGame();
  const messages = [];
  // readyState 1 = open: the server only delivers to connections it sees as open.
  const id = game.addPlayer({ send: (d) => messages.push(JSON.parse(d)), readyState: 1 }, '127.0.0.1');
  return { game, id, messages, player: game.players.get(id) };
}

/** Advance the authoritative loop in small steps (real ticks, fake clock). */
function advance(game, seconds, step = 0.25) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) game.update(step);
}

function shortRound(game, seconds) {
  game.roundSeconds = seconds;
  game.roundTimeLeft = seconds;
}

test('a round is at least 30 minutes long by default', () => {
  const game = new ServerGame();
  const snap = game.getRoundSnapshot();
  assert.ok(game.roundSeconds >= 30 * 60, `round must be >= 30 min, was ${game.roundSeconds}s`);
  assert.strictEqual(DEFAULT_ROUND_MINUTES * 60, game.roundSeconds, 'default comes from the shared constant');
  assert.strictEqual(snap.phase, 'live');
  assert.strictEqual(snap.round, 1);
  assert.strictEqual(snap.timeLeft, game.roundSeconds);
});

test('ROUND_MINUTES overrides the round length', () => {
  const previous = process.env.ROUND_MINUTES;
  process.env.ROUND_MINUTES = '45';
  try {
    assert.strictEqual(new ServerGame().roundSeconds, 45 * 60);
  } finally {
    if (previous === undefined) delete process.env.ROUND_MINUTES;
    else process.env.ROUND_MINUTES = previous;
  }
});

test('the clock ends the round and the leading team takes it', () => {
  const { game, messages } = connectedGame();
  shortRound(game, 4);
  game.captures = { red: 1, blue: 3 };

  advance(game, 4.5);

  const ended = messages.filter((m) => m.type === 'roundEnded').pop();
  assert.ok(ended, 'roundEnded must be broadcast when the clock runs out');
  assert.strictEqual(ended.winner, 'blue');
  assert.deepStrictEqual(ended.captures, { red: 1, blue: 3 });
  assert.strictEqual(ended.wins.blue, 1);
  assert.strictEqual(ended.wins.red, 0);

  const snap = game.getRoundSnapshot();
  assert.strictEqual(snap.phase, 'intermission');
  assert.strictEqual(snap.timeLeft, 0);
  assert.ok(snap.intermission > 0 && snap.intermission <= INTERMISSION_SECONDS);
});

test('equal captures at the whistle is a draw and wins nobody a round', () => {
  const { game, messages } = connectedGame();
  shortRound(game, 3);
  game.captures = { red: 2, blue: 2 };

  advance(game, 3.5);

  const ended = messages.filter((m) => m.type === 'roundEnded').pop();
  assert.strictEqual(ended.winner, 'draw');
  assert.strictEqual(ended.wins.blue, 0);
  assert.strictEqual(ended.wins.red, 0);
});

test('the objective is frozen between rounds', () => {
  const { game, id, messages, player } = connectedGame();
  player.position = { x: RED_FLAG_POS.x, y: 10, z: RED_FLAG_POS.z }; // standing on the enemy stand

  // Intermission: the stand does not hand out the flag.
  game.roundPhase = 'intermission';
  game.intermissionTimeLeft = INTERMISSION_SECONDS;
  messages.length = 0;
  game.handleFlagPickup(id);
  assert.strictEqual(player.carryingFlag, false, 'no pickup between rounds');
  assert.strictEqual(messages.filter((m) => m.type === 'flagPickedUp').length, 0);

  // Live round: the exact same call does hand it over, so the guard is the difference.
  game.roundPhase = 'live';
  game.handleFlagPickup(id);
  assert.strictEqual(player.carryingFlag, true, 'pickup works while the round is live');
});

test('the next round resets captures, flags and returns everyone to spawn', () => {
  const { game, messages, player } = connectedGame();
  shortRound(game, 2);
  game.captures = { red: 2, blue: 5 };
  advance(game, 2.5); // round ends, intermission starts
  assert.strictEqual(game.getRoundSnapshot().phase, 'intermission');

  messages.length = 0;
  player.isDead = true; // must come back alive for the new round

  // Advance to the exact moment round 2 starts (not 20s into it).
  let guard = 0;
  while (game.getRoundSnapshot().round === 1 && guard++ < 400) game.update(0.25);
  assert.ok(guard < 400, 'the intermission must eventually start the next round');

  const snap = game.getRoundSnapshot();
  assert.strictEqual(snap.round, 2);
  assert.strictEqual(snap.phase, 'live');
  assert.deepStrictEqual(snap.captures, { red: 0, blue: 0 }, 'captures reset for the new round');
  assert.ok(snap.timeLeft > game.roundSeconds - 1, `new round clock should be ~full, was ${snap.timeLeft}`);
  assert.deepStrictEqual(snap.wins, { red: 0, blue: 1 });

  assert.strictEqual(player.isDead, false, 'players are revived at the round start');
  assert.ok(
    player.position.z <= -190 && player.position.z >= -230,
    `blue must respawn behind its own flag, z was ${player.position.z}`,
  );

  const returned = messages.filter((m) => m.type === 'flagReturned').map((m) => m.flagTeam);
  assert.ok(returned.includes('blue') && returned.includes('red'), 'both flags return home');
});

test('clients get the round clock at least once per second', () => {
  const { game, messages } = connectedGame();
  messages.length = 0;

  advance(game, 3.25);

  const updates = messages.filter((m) => m.type === 'roundUpdate');
  assert.ok(updates.length >= 3, `expected ~3 round updates in 3s, got ${updates.length}`);
  const latest = updates.at(-1).round;
  assert.strictEqual(latest.round, 1);
  assert.ok(latest.timeLeft < game.roundSeconds, 'the clock must actually be moving');
});

test('a late joiner receives the current round and clock in init', () => {
  const { game } = connectedGame();
  game.roundNumber = 4;
  game.roundTimeLeft = 1234;

  const messages = [];
  game.addPlayer({ send: (d) => messages.push(JSON.parse(d)), readyState: 1 }, '127.0.0.1');

  const init = messages.find((m) => m.type === 'init');
  assert.ok(init, 'join must produce an init message');
  assert.ok(init.round, 'init must carry the round snapshot');
  assert.strictEqual(init.round.round, 4);
  assert.strictEqual(Math.round(init.round.timeLeft), 1234);
  assert.strictEqual(init.round.duration, game.roundSeconds);
});
