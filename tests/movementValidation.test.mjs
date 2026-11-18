// Server-side movement validation (run: node --test tests/*.test.mjs)
//
// The client simulates its own movement and reports its position, so a modified
// client used to be able to teleport straight onto the enemy flag. The server
// now credits distance by elapsed time: teleports and speed hacks are clamped to
// the legal rate, while ordinary (and laggy) movement is untouched.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { PLAYER_MAX_SPEED, PLAYER_MOVE_BURST_SECONDS } = require('../dist/tests/sharedTypes.cjs');

const BURST = PLAYER_MAX_SPEED * PLAYER_MOVE_BURST_SECONDS;
const RED_FLAG = { x: 0.5, z: 160.5 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function joined() {
  const game = new ServerGame();
  const conn = { send: () => {}, isOpen: () => true, close: () => {} };
  const id = game.addPlayer(conn, '127.0.0.1');
  game.handleMessage(id, { type: 'join', team: 'blue', name: 'Walker' });
  return { game, id, player: game.players.get(id) };
}

const moveTo = (game, id, position) => game.handleMessage(id, {
  type: 'playerInput',
  input: {
    moveX: 0, moveZ: 0, jump: false, crouch: false, sprint: false,
    yaw: 0, pitch: 0, position, equipment: 'rifle',
  },
});

test('a teleport to the enemy flag does not arrive', () => {
  const { game, id, player } = joined();
  const start = { ...player.position };

  moveTo(game, id, { x: RED_FLAG.x, y: start.y, z: RED_FLAG.z });

  assert.ok(flat(player.position, RED_FLAG) > 100, 'must be nowhere near the enemy flag');
  assert.ok(flat(player.position, start) <= BURST + 0.01, 'may creep at most one burst of distance');
});

test('a speed hack gains no ground', () => {
  const { game, id, player } = joined();
  const start = { ...player.position };

  for (let i = 1; i <= 12; i++) moveTo(game, id, { x: start.x + 25 * i, y: start.y, z: start.z });

  const moved = flat(player.position, start);
  assert.ok(moved < 25, `moved ${moved.toFixed(1)}u of 300 requested`);
  assert.ok(moved > 0, 'must still move at the legal rate rather than freeze');
});

test('ordinary movement at sprint pace is accepted', async () => {
  const { game, id, player } = joined();
  const start = { ...player.position };

  // A 20 Hz client at sprint pace: 0.4u every 50ms for a second.
  for (let i = 1; i <= 20; i++) {
    moveTo(game, id, { x: start.x + 0.4 * i, y: start.y, z: start.z });
    await sleep(50);
  }

  const moved = flat(player.position, start);
  assert.ok(moved > 6, `legit movement was throttled to ${moved.toFixed(1)}u`);
  assert.ok(moved <= 20 * 0.4 + 0.5, 'must not overshoot what was asked for');
});

test('a stalled client is not frozen out of sync', async () => {
  const { game, id, player } = joined();
  const start = { ...player.position };

  await sleep(250); // one dropped packet
  moveTo(game, id, { x: start.x + 2, y: start.y, z: start.z });

  assert.ok(flat(player.position, start) > 1.5, 'a laggy step must still be accepted');
});

test('vertical is bounded so a crafted y cannot levitate', () => {
  const { game, id, player } = joined();
  const startY = player.position.y;

  moveTo(game, id, { x: player.position.x, y: startY + 40, z: player.position.z });

  assert.ok(player.position.y - startY < 4, `climbed ${(player.position.y - startY).toFixed(1)}u in one input`);
});
