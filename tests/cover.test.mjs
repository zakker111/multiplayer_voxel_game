// Cover: the first voxel a round meets takes the hit. A body behind it is
// spared, and a voxel behind the front one is untouched. These drive the real
// ServerGame shot pipeline (human claim + fallback, and the bot path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const {
  VOXEL_AIR, VOXEL_BUILT, VOXEL_MAX_DURABILITY, VOXEL_SHOT_DAMAGE,
} = require('../dist/tests/sharedTypes.cjs');

/** Two players on a cleared lane: A (blue) at z=10, B (red) at z=16. */
function arena() {
  const game = new ServerGame();
  const inbox = { a: [], b: [] };
  const conn = (bucket) => ({ send: (d) => bucket.push(JSON.parse(d)), readyState: 1 });
  const aId = game.addPlayer(conn(inbox.a), '127.0.0.1');
  const bId = game.addPlayer(conn(inbox.b), '127.0.0.1');
  game.handleMessage(aId, { type: 'join', team: 'blue', name: 'A' });
  game.handleMessage(bId, { type: 'join', team: 'red', name: 'B' });
  const a = game.players.get(aId);
  const b = game.players.get(bId);
  const y = game.world.getGroundHeight(10, 10);
  a.position = { x: 10, y, z: 10 };
  b.position = { x: 10, y, z: 16 };
  game.spawnProtectedUntil.delete(aId);
  game.spawnProtectedUntil.delete(bId);

  const origin = { x: 10, y: y + 1.6, z: 10 };
  // Carve a clean tunnel down the lane so only the wall under test can block.
  const wallY = Math.round(origin.y);
  for (let z = 10; z <= 16; z++) {
    for (let dy = -1; dy <= 1; dy++) game.world.setVoxel(10, wallY + dy, z, VOXEL_AIR);
  }
  return { game, aId, bId, a, b, inbox, origin, wallY };
}

function putWall(game, x, y, z) {
  game.world.setVoxel(x, y, z, VOXEL_BUILT, VOXEL_MAX_DURABILITY);
  return game.world.getVoxel(x, y, z);
}

function shoot(env, targetId) {
  env.inbox.a.length = 0;
  env.game.lastShootTime.set(env.aId, 0);
  env.game.handleShoot(env.aId, env.origin, { x: 0, y: 0, z: 1 }, targetId, false);
}

test('a voxel between shooter and target takes the round, the body is spared', () => {
  const env = arena();
  const front = putWall(env.game, 10, env.wallY, 13);
  const before = env.b.hp;

  // A client claiming the target behind the wall must not push damage through.
  shoot(env, env.bId);
  assert.equal(env.b.hp, before, 'the claimed body behind the wall takes nothing');
  assert.equal(front.durability, VOXEL_MAX_DURABILITY - VOXEL_SHOT_DAMAGE, 'the wall took the round');
  assert.equal(
    env.inbox.a.some((m) => m.type === 'hitConfirmed'),
    false,
    'no hit marker for a round the wall stopped',
  );

  // The server-side fallback (no client claim) must agree.
  shoot(env);
  assert.equal(env.b.hp, before, 'the fallback ray stops at the wall too');
  assert.ok(
    Math.abs(front.durability - (VOXEL_MAX_DURABILITY - 2 * VOXEL_SHOT_DAMAGE)) < 1e-9,
    'the second round hit the wall',
  );
});

test('cover hugging the target still stops the round', () => {
  const env = arena();
  const front = putWall(env.game, 10, env.wallY, 15); // one metre in front of B
  const before = env.b.hp;

  shoot(env, env.bId);

  assert.equal(env.b.hp, before, 'a wall against the body still blocks the round');
  assert.equal(front.durability, VOXEL_MAX_DURABILITY - VOXEL_SHOT_DAMAGE, 'the hugging wall takes it');
});

test('only the first voxel in the path is damaged', () => {
  const env = arena();
  const front = putWall(env.game, 10, env.wallY, 13);
  const behind = putWall(env.game, 10, env.wallY, 14);
  const before = env.b.hp;

  shoot(env, env.bId);

  assert.equal(env.b.hp, before, 'the body behind both blocks is spared');
  assert.ok(front.durability < VOXEL_MAX_DURABILITY, 'the front block is damaged');
  assert.equal(behind.durability, VOXEL_MAX_DURABILITY, 'the block behind it is untouched');
});

test('with the cover gone the same shot lands on the body', () => {
  const env = arena();
  const front = putWall(env.game, 10, env.wallY, 13);
  const before = env.b.hp;

  shoot(env, env.bId);
  assert.equal(env.b.hp, before, 'blocked while the wall stands');

  env.game.world.setVoxel(10, env.wallY, 13, VOXEL_AIR);
  assert.equal(env.game.world.getVoxel(10, env.wallY, 13), null);
  shoot(env, env.bId);
  assert.ok(env.b.hp < before, 'the round reaches the body once the wall is gone');
  assert.equal(front.durability, VOXEL_MAX_DURABILITY - VOXEL_SHOT_DAMAGE, 'the removed wall is not hit again');
});

test('a cannon round bursts on the first voxel wall in its path', () => {
  const env = arena();
  // A cannon round covers ~3m in one 0.05s tick; an endpoint-only collision
  // test would pass straight through this block.
  const shellY = env.a.position.y + 1.2;
  putWall(env.game, 10, Math.round(shellY), 13);
  env.game.shells.set('cover-shell', {
    id: 'cover-shell',
    kind: 'cannon',
    team: 'blue',
    ownerId: env.aId,
    position: { x: 10, y: shellY, z: 10 },
    velocity: { x: 0, y: 0, z: 60 },
    firedAt: 0,
  });
  env.inbox.a.length = 0;

  env.game.updateShells(0.05);

  assert.equal(env.game.shells.size, 0, 'the wall spent the round');
  const impact = env.inbox.a.find((m) => m.type === 'shellImpact');
  assert.ok(impact, 'clients are told where it burst');
  assert.ok(
    impact.position.z > 12 && impact.position.z < 13.5,
    `it bursts at the wall (z=${impact.position.z})`,
  );
});

test('a bot round is stopped by cover the same way', () => {
  const env = arena();
  const bot = new ServerBot('cover-bot', { x: 10, y: env.a.position.y, z: 10 }, 'blue', 'CoverBot');
  env.game.players.set(bot.id, bot);
  env.game.spawnProtectedUntil.delete(bot.id);
  const origin = { x: 10, y: env.a.position.y + 1.6, z: 10 };
  // Bots fire along the line to the target's torso, so the test sends that aim
  // (the server validates cover on the bullet's own line, not a side ray).
  const aimLength = Math.hypot(env.b.position.x - origin.x, env.b.position.y + 1.0 - origin.y, env.b.position.z - origin.z);
  const botAim = {
    x: (env.b.position.x - origin.x) / aimLength,
    y: (env.b.position.y + 1.0 - origin.y) / aimLength,
    z: (env.b.position.z - origin.z) / aimLength,
  };
  const before = env.b.hp;

  // Bots aim at the torso, so their cover sits at torso height (one block
  // below the human eye line used above).
  const torsoY = env.wallY - 1;
  const mid = putWall(env.game, 10, torsoY, 13);
  env.game.botShoot(bot.id, origin, botAim, env.bId);
  assert.equal(env.b.hp, before, 'the bot round does not reach the body behind the wall');
  assert.ok(mid.durability < VOXEL_MAX_DURABILITY, 'the wall took the bot round');

  // Same geometry, but the wall is right against the target.
  env.game.world.setVoxel(10, torsoY, 13, VOXEL_AIR);
  const hugging = putWall(env.game, 10, torsoY, 15);
  env.game.botShoot(bot.id, origin, botAim, env.bId);
  assert.equal(env.b.hp, before, 'a hugging wall stops the bot round too');
  assert.ok(hugging.durability < VOXEL_MAX_DURABILITY, 'the hugging wall takes the bot round');
});
