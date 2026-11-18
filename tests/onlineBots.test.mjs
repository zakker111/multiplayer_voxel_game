// Beta/online bot coverage (run: node --test tests/*.test.mjs)
//
// Beta and online play are server-authoritative: the client renders whatever
// the server tells it about. Nothing proved that a joining client is actually
// handed the bot roster or the ongoing bot positions, so "there are no bots"
// was untested. These tests drive the same code path the WebSocket and SSE
// routes use (addPlayer -> join) and assert the client is sent the bots.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');

const isBot = (entry) => entry.id.startsWith('bot_');

/** Connect and join exactly as the WS/SSE routes do, capturing what is sent. */
function joinMatch(team = 'blue') {
  const sent = [];
  const conn = { send: (d) => sent.push(JSON.parse(d)), isOpen: () => true, close: () => {} };
  const game = new ServerGame();
  const id = game.addPlayer(conn, '127.0.0.1');
  game.handleMessage(id, { type: 'join', team, name: 'Probe' });
  return { game, id, conn, sent };
}

test('a joining client is handed every bot in the match', () => {
  const { sent } = joinMatch();
  const init = sent.find((m) => m.type === 'init');

  assert.ok(init, 'the client must receive init');
  assert.ok(Array.isArray(init.players), 'init must carry the roster');

  const bots = init.players.filter(isBot);
  assert.strictEqual(bots.length, 20, 'a full 10v10 bot match must be in the roster');

  const teams = [...new Set(bots.map((b) => b.state.team))].sort();
  assert.deepStrictEqual(teams, ['blue', 'red'], 'both teams must be represented');

  for (const bot of bots) {
    assert.ok(bot.state.position, `${bot.id} must carry a position to render at`);
    assert.strictEqual(typeof bot.state.position.x, 'number');
  }
});

test('a human takes a bot slot, so their team stays full of bots', () => {
  const { game } = joinMatch('blue');
  const blue = [...game.players.values()].filter((p) => p.team === 'blue');

  assert.strictEqual(blue.length, 10, 'the human must not make blue 11 strong');
  assert.strictEqual(blue.filter((p) => p.id.startsWith('bot_')).length, 9,
    'one bot retires for the human, nine keep playing');
});

test('bot positions keep streaming, which is what keeps them on screen', () => {
  const { game, sent } = joinMatch();
  sent.length = 0; // drop join/init chatter

  game.update(0.05);
  game.broadcastState();

  const updates = sent.filter((m) => m.type === 'playerUpdated');
  const botUpdates = updates.filter((m) => m.playerId.startsWith('bot_'));

  assert.ok(botUpdates.length >= 10,
    `expected ongoing bot updates, received ${botUpdates.length}`);
  for (const update of botUpdates) {
    assert.ok(update.state?.position, 'every update carries a position');
  }
});

test('bots reach both teams even when the human joins red', () => {
  const { game, sent } = joinMatch('red');
  const init = sent.find((m) => m.type === 'init');
  const redBots = init.players.filter((p) => isBot(p) && p.state.team === 'red');
  const blueBots = init.players.filter((p) => isBot(p) && p.state.team === 'blue');

  assert.ok(redBots.length >= 9 && blueBots.length === 10, 'each team keeps a bot presence');
  assert.strictEqual([...game.players.values()].filter((p) => p.team === 'red').length, 10);
});
