// Phase A feedback-layer regression tests (run: node --test tests/*.test.mjs)
//
// Covers spawn protection, out-of-combat regeneration, the latency probe and
// the data the HUD needs for the killfeed / damage direction. These drive the
// real ServerGame (fake clock, real 20Hz-style ticks), not mocks.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const {
  SPAWN_PROTECTION_SECONDS,
  REGEN_DELAY_SECONDS,
  REGEN_RATE,
  relativeBearingDegrees,
} = require('../dist/tests/sharedTypes.cjs');

/** Two joined players (one per team), with open connections so the server
 *  actually delivers their messages. */
function gameWithPlayers() {
  const game = new ServerGame();
  const inbox = { a: [], b: [] };
  const conn = (bucket) => ({ send: (d) => bucket.push(JSON.parse(d)), readyState: 1 });
  const aId = game.addPlayer(conn(inbox.a), '127.0.0.1');
  const bId = game.addPlayer(conn(inbox.b), '127.0.0.1');
  game.handleMessage(aId, { type: 'join', team: 'blue', name: 'A' });
  game.handleMessage(bId, { type: 'join', team: 'red', name: 'B' });
  return { game, aId, bId, a: game.players.get(aId), b: game.players.get(bId), inbox };
}

function advance(game, seconds, step = 0.25) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) game.update(step);
}

// ---------------- Spawn protection ----------------

test('joining grants a spawn shield', () => {
  const { game, aId, a } = gameWithPlayers();
  assert.strictEqual(game.isSpawnProtected(aId), true);
  assert.strictEqual(a.spawnProtected, true);
  // The client needs to see it in the authoritative state to draw the badge.
  assert.strictEqual(a.getState().spawnProtected, true);
});

test('a spawn shield soaks incoming damage', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  const fullHp = a.hp;

  game.applyDamage(aId, 50, bId);

  assert.strictEqual(a.hp, fullHp, 'shielded player must not lose HP');
  assert.strictEqual(a.isDead, false);
});

test('the shield expires and damage lands again', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);

  assert.strictEqual(game.isSpawnProtected(aId), false, 'shield must expire');
  assert.strictEqual(a.spawnProtected, false);

  game.applyDamage(aId, 30, bId);
  assert.strictEqual(a.hp, a.maxHp - 30);
});

test("firing cancels your own shield so it can't be used offensively", () => {
  const { game, aId, a } = gameWithPlayers();
  assert.strictEqual(game.isSpawnProtected(aId), true);

  game.handleShoot(aId, { ...a.position }, { x: 0, y: 0, z: 1 });

  assert.strictEqual(game.isSpawnProtected(aId), false, 'shooting drops the shield');
});

test('respawning grants a fresh shield', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);
  game.applyDamage(aId, 500, bId, true);
  assert.strictEqual(a.isDead, true);

  advance(game, 4.5); // scheduled respawn is 4s

  assert.strictEqual(a.isDead, false);
  assert.strictEqual(game.isSpawnProtected(aId), true, 'respawn must re-grant protection');
});

test('the shield also stops an ordinary gunshot (human shot path)', () => {
  const { game, aId, bId, a, b, inbox } = gameWithPlayers();
  // Put B six metres in front of A so the shot has a clean line of sight.
  b.position = { x: a.position.x, y: a.position.y, z: a.position.z + 6 };
  const origin = { x: a.position.x, y: a.position.y + 1.6, z: a.position.z };
  const direction = { x: 0, y: 0, z: 1 };
  inbox.a.length = 0;
  game.lastShootTime.set(aId, 0);

  game.handleShoot(aId, origin, direction, bId, false);

  assert.strictEqual(b.hp, b.maxHp, 'shielded target must not take bullet damage');
  assert.strictEqual(
    inbox.a.some((m) => m.type === 'hitConfirmed'),
    false,
    'a shielded hit must not report a hit marker',
  );

  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);
  assert.strictEqual(game.isSpawnProtected(bId), false);
  game.lastShootTime.set(aId, 0);
  game.handleShoot(aId, origin, direction, bId, false);
  assert.ok(b.hp < b.maxHp, 'once the shield is gone the same shot must land');
});

// ---------------- Regeneration ----------------

test('health regenerates only after the out-of-combat delay', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);

  game.applyDamage(aId, 40, bId);
  const hurt = a.hp;
  assert.strictEqual(hurt, a.maxHp - 40);

  advance(game, REGEN_DELAY_SECONDS - 1.5);
  assert.strictEqual(a.hp, hurt, 'no healing while still in combat');

  advance(game, 3);
  assert.ok(a.hp > hurt, 'healing starts once combat has been quiet long enough');
});

test('regeneration rate matches the shared constant and caps at max HP', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);
  game.applyDamage(aId, 70, bId);

  advance(game, REGEN_DELAY_SECONDS + 2);
  // ~2s of healing at REGEN_RATE (minus the tick granularity of one step).
  const healed = a.hp - (a.maxHp - 70);
  assert.ok(healed > 0 && healed <= REGEN_RATE * 2.5, `unexpected heal ${healed}`);

  advance(game, 30);
  assert.strictEqual(a.hp, a.maxHp, 'never overshoots max HP');
});

test('taking damage restarts the regeneration delay', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);

  game.applyDamage(aId, 50, bId);
  advance(game, REGEN_DELAY_SECONDS - 1);
  const beforeSecondHit = a.hp;

  game.applyDamage(aId, 10, bId); // re-opens the fight
  advance(game, REGEN_DELAY_SECONDS - 1);

  assert.strictEqual(a.hp, beforeSecondHit - 10, 'healing must be paused by the new hit');
});

test('a dead player does not regenerate', () => {
  const { game, aId, bId, a } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);
  game.applyDamage(aId, 500, bId, true);
  assert.strictEqual(a.isDead, true);

  const deadHp = a.hp;
  // Stay short of the 4s respawn timer so this measures regen, not respawning.
  advance(game, 3);
  assert.strictEqual(a.isDead, true);
  assert.strictEqual(a.hp, deadHp);
});

// ---------------- Latency probe ----------------

test('ping is echoed back unchanged as pong', () => {
  const { game, aId, inbox } = gameWithPlayers();
  inbox.a.length = 0;

  game.handleMessage(aId, { type: 'ping', t: 987654 });

  const pong = inbox.a.find((m) => m.type === 'pong');
  assert.ok(pong, 'server must answer a ping');
  assert.strictEqual(pong.t, 987654);
});

// ---------------- Killfeed data ----------------

test('playerDied carries the killer weapon and headshot flag', () => {
  const { game, aId, bId, b, inbox } = gameWithPlayers();
  advance(game, SPAWN_PROTECTION_SECONDS + 0.5);
  b.equipment = 'smg';
  inbox.a.length = 0;

  game.applyDamage(aId, 500, bId, true);

  const died = inbox.a.find((m) => m.type === 'playerDied' && m.playerId === aId);
  assert.ok(died, 'death event must be broadcast');
  assert.strictEqual(died.killerId, bId);
  assert.strictEqual(died.weapon, 'smg');
  assert.strictEqual(died.isHeadshot, true);
});

// ---------------- Damage direction math ----------------

test('relativeBearingDegrees maps world offsets onto screen bearings', () => {
  const origin = { x: 0, z: 0 };
  const forward = { x: 0, z: -1 }; // looking down -Z

  assert.strictEqual(relativeBearingDegrees(origin, forward, { x: 0, z: -10 }), 0);
  assert.strictEqual(relativeBearingDegrees(origin, forward, { x: 10, z: 0 }), 90);
  assert.strictEqual(relativeBearingDegrees(origin, forward, { x: -10, z: 0 }), -90);
  assert.strictEqual(Math.abs(relativeBearingDegrees(origin, forward, { x: 0, z: 10 })), 180);
  // Stands on top of you: no meaningful direction, must not produce NaN.
  assert.strictEqual(relativeBearingDegrees(origin, forward, { x: 0, z: 0 }), 0);
});

test('damage bearing follows the view direction as the player turns', () => {
  const origin = { x: 0, z: 0 };
  const target = { x: 0, z: -10 }; // due north

  assert.strictEqual(relativeBearingDegrees(origin, { x: 0, z: -1 }, target), 0);
  assert.strictEqual(relativeBearingDegrees(origin, { x: 1, z: 0 }, target), -90);
  // Directly behind reports +/-180 depending on the sign of zero.
  assert.strictEqual(Math.abs(relativeBearingDegrees(origin, { x: 0, z: 1 }, target)), 180);
});
