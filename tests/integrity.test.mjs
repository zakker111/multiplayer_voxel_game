// Protocol and state integrity regression tests (run: node --test tests/*.test.mjs)
//
// Everything here was a real defect found during the code-health sweep:
// client-controlled values reaching game state unvalidated, a duplicated flag
// capture path with divergent rules, and session handling that trusted a
// client-supplied player id on the HTTP transport.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');

/** Connection stub that records every frame the server sends to it. */
function recordingConn(frames = []) {
  return {
    send: (data) => frames.push(typeof data === 'string' ? JSON.parse(data) : data),
    isOpen: () => true,
    close: () => {},
  };
}

const conn = () => ({ send: () => {}, isOpen: () => true, close: () => {} });

/** A live blue player standing on the enemy flag stand. */
function playerOnEnemyStand() {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);
  player.team = 'blue';
  player.position = { x: 0, y: 0, z: 160 }; // RED_FLAG_POS
  return { game, id, player };
}

test('join ignores an unknown team instead of corrupting team state', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);
  const before = player.team;

  game.handleMessage(id, { type: 'join', team: 'purple', name: 'Test' });

  assert.strictEqual(player.team, before, 'team must stay valid');
  assert.ok(['red', 'blue'].includes(player.team));
});

test('join trims and bounds the display name', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);

  game.handleMessage(id, { type: 'join', team: 'blue', name: `  ${'x'.repeat(80)}  ` });

  assert.strictEqual(player.name.length, 24);
  assert.strictEqual(player.name, player.name.trim());
});

test('an unknown equipment id never reaches game state', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);

  game.handleMessage(id, { type: 'playerInput', input: { moveX: 0, moveZ: 0, equipment: 'banana' } });

  assert.strictEqual(player.equipment, 'rifle', 'invalid item must be ignored');
  game.handleMessage(id, { type: 'playerInput', input: { moveX: 0, moveZ: 0, equipment: 'smg' } });
  assert.strictEqual(player.equipment, 'smg', 'valid item must still switch');
});

test('building far outside reach is rejected', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);
  const inventoryBefore = game.inventories.get(id);
  const voxelBefore = game.world.getVoxel(0, 40, 0);

  game.handleMessage(id, { type: 'build', position: { x: 0, y: 40, z: 0 } });

  assert.strictEqual(game.inventories.get(id), inventoryBefore, 'no block may be spent');
  assert.strictEqual(game.world.getVoxel(0, 40, 0), voxelBefore, 'remote voxel must be untouched');
  assert.ok(player.isAlive());
});

test('a shot from a spoofed origin does not cost ammo', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  const player = game.players.get(id);
  const ammoBefore = player.currentAmmo;

  game.handleMessage(id, {
    type: 'shoot',
    origin: { x: 500, y: 40, z: 500 },
    direction: { x: 0, y: 0, z: 1 },
  });
  assert.strictEqual(player.currentAmmo, ammoBefore);

  // A non-unit direction vector is equally invalid (it would skew the raycast).
  game.handleMessage(id, {
    type: 'shoot',
    origin: { x: player.position.x, y: player.position.y + 1.45, z: player.position.z },
    direction: { x: 0, y: 0, z: 100 },
  });
  assert.strictEqual(player.currentAmmo, ammoBefore);

  // The legitimate shot from the shooter's own eye position must still fire.
  game.handleMessage(id, {
    type: 'shoot',
    origin: { x: player.position.x, y: player.position.y + 1.45, z: player.position.z },
    direction: { x: 0, y: 0, z: 1 },
  });
  assert.strictEqual(player.currentAmmo, ammoBefore - 1, 'valid shot must consume exactly one round');
});

test('a base pickup does not also consume a dropped flag', () => {
  const { game, id, player } = playerOnEnemyStand();
  game.droppedFlags.push({ position: { x: 0, y: 0, z: 160 }, team: 'red', respawnTimer: 60 });

  game.handleMessage(id, { type: 'pickupFlag' });

  assert.strictEqual(player.carryingFlag, true);
  assert.strictEqual(game.redFlagCarrier, id);
  assert.strictEqual(game.droppedFlags.length, 1, 'dropped entry must survive the base pickup');
});

test('an automatic capture credits the scoreboard tally', () => {
  const { game, id, player } = playerOnEnemyStand();
  player.carryingFlag = true;
  game.redFlagCarrier = id;
  game.redFlagAtBase = false;
  player.position = { x: 0, y: 0, z: -160 }; // home base

  game.update(0.05);

  assert.strictEqual(game.captures.blue, 1, 'capture must score');
  assert.strictEqual(player.carryingFlag, false);
  assert.strictEqual(game.playerStats.get(id).captures, 1, 'capture must appear on the scoreboard');
});

test('the client-driven capture path scores identically to the automatic one', () => {
  const { game, id, player } = playerOnEnemyStand();
  player.carryingFlag = true;
  game.redFlagCarrier = id;
  game.redFlagAtBase = false;
  player.position = { x: 0, y: 0, z: -160 };

  game.handleMessage(id, { type: 'captureFlag', team: 'blue' });

  assert.strictEqual(game.captures.blue, 1);
  assert.strictEqual(game.playerStats.get(id).captures, 1);
  assert.strictEqual(game.redFlagRespawnTimer, 8.0);
});

test('session tokens: issued in init, resolved for HTTP, revoked on disconnect', () => {
  const game = new ServerGame();
  const frames = [];
  const id = game.addPlayer(recordingConn(frames), '127.0.0.1');

  const init = frames.find((f) => f.type === 'init');
  assert.ok(init, 'init frame must be sent');
  assert.ok(typeof init.sessionToken === 'string' && init.sessionToken.length > 10);

  assert.strictEqual(game.resolveSessionToken(init.sessionToken), id);
  assert.strictEqual(game.resolveSessionToken('not-a-token'), null);
  assert.strictEqual(game.resolveSessionToken(undefined), null);

  game.removePlayer(id);
  assert.strictEqual(game.resolveSessionToken(init.sessionToken), null, 'token must die with the player');
});

test('per-player stats are pruned when a player leaves', () => {
  const game = new ServerGame();
  const id = game.addPlayer(conn(), '127.0.0.1');
  game.handleMessage(id, { type: 'join', team: 'blue', name: 'Gone' });
  // Tallies are created lazily by gameplay events, so seed one directly.
  game.getStats(id).deaths++;
  assert.ok(game.playerStats.has(id));

  game.removePlayer(id);

  assert.strictEqual(game.playerStats.has(id), false, 'scoreboard tallies must not leak');
});
