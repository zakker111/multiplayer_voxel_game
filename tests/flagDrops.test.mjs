// Flag carrier lifecycle regression tests (run: node --test tests/*.test.mjs)
//
// Every way a carrier leaves play must DROP the flag: death, disconnect,
// entering spectator and teleport-respawn. Missing any one of these strands the
// flag on a ghost/frozen carrier, after which it can never be picked up,
// returned or captured again and the CTF round deadlocks.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');

const conn = () => ({ send: () => {}, isOpen: () => true, close: () => {} });

/** Fresh game with one live blue human holding the RED flag. */
function carrierHoldingEnemyFlag() {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);
  player.team = 'blue';
  player.carryingFlag = true;
  game.redFlagCarrier = id;
  return { game, id, player };
}

test('disconnecting while carrying drops the flag (no ghost carrier deadlock)', () => {
  const { game, id } = carrierHoldingEnemyFlag();
  game.removePlayer(id);

  assert.strictEqual(game.redFlagCarrier, null, 'carrier id must be cleared');
  assert.strictEqual(game.redFlagCarrier === id, false, 'carrier must not point at the removed player');
  const dropped = game.droppedFlags.filter((f) => f.team === 'red');
  assert.strictEqual(dropped.length, 1, 'exactly one dropped red flag must exist');
  assert.ok(dropped[0].respawnTimer > 0, 'dropped flag must have a return timer');
});

test('entering spectator while carrying drops the flag', () => {
  const { game, id, player } = carrierHoldingEnemyFlag();
  game.handleMessage(id, { type: 'toggleSpectator' });

  assert.strictEqual(player.isSpectating, true);
  assert.strictEqual(player.carryingFlag, false, 'spectator must not keep carrying');
  assert.strictEqual(game.redFlagCarrier, null);
  assert.strictEqual(game.droppedFlags.filter((f) => f.team === 'red').length, 1);
});

test('dying while carrying drops the flag at ground level', () => {
  const { game, id, player } = carrierHoldingEnemyFlag();
  const killerId = game.addBot('red', 'Killer');
  player.position = { x: player.position.x, y: player.position.y + 6, z: player.position.z };
  const groundY = game.world.getGroundHeight(player.position.x, player.position.z);

  game.applyDamage(id, 1000, killerId);

  assert.strictEqual(player.isDead, true);
  assert.strictEqual(game.redFlagCarrier, null);
  const dropped = game.droppedFlags.filter((f) => f.team === 'red');
  assert.strictEqual(dropped.length, 1);
  assert.ok(Math.abs(dropped[0].position.y - (groundY + 0.5)) < 0.01, 'drop must snap to ground');
});

test('requestRespawn while alive neither teleports nor heals a flag carrier', () => {
  const { game, id, player } = carrierHoldingEnemyFlag();
  player.hp = 15;
  player.position = { x: 0, y: 8, z: 60 };
  const before = { ...player.position };

  game.handleMessage(id, { type: 'requestRespawn' });

  assert.deepStrictEqual({ ...player.position }, before, 'live player must not be teleported to spawn');
  assert.strictEqual(player.hp, 15, 'live player must not be healed by requesting a respawn');
  assert.strictEqual(player.carryingFlag, true, 'legitimate carrier keeps the flag');
  assert.strictEqual(game.redFlagCarrier, id);
});

test('requestRespawn while dead spawns alive at full HP', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);
  player.team = 'blue';
  player.isDead = true;
  player.hp = 0;

  game.handleMessage(id, { type: 'requestRespawn' });

  assert.strictEqual(player.isDead, false);
  assert.strictEqual(player.hp, player.maxHp);
  assert.strictEqual(game.inventories.get(id), 20);
});

test('retiring a bot while it carries drops the flag', () => {
  const game = new ServerGame();
  const botId = game.addBot('red', 'Carrier');
  const bot = game.players.get(botId);
  bot.carryingFlag = true;
  game.blueFlagCarrier = botId;

  game.removeBot(botId);

  assert.strictEqual(game.blueFlagCarrier, null);
  assert.strictEqual(game.droppedFlags.filter((f) => f.team === 'blue').length, 1);
});
