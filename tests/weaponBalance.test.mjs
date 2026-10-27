// Weapon balance / shotgun-consistency regression tests
// (run: node --test tests/*.test.mjs)
//
// The client used to keep its own copy of the weapon stats: the SMG dealt
// 34/100 damage in a local bot match but 20/34 on the server, for the same gun.
// The table in src/shared/types.ts is now the only definition, and these tests
// guard both the numbers and the "don't re-declare them" rule.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WEAPONS, weaponDamage, rangeMultiplier } = require('../dist/tests/sharedTypes.cjs');
const { ServerGame } = require('../dist/tests/serverGame.cjs');

const CLIENT_SRC = new URL('../src/game/game.ts', import.meta.url);

/** Shots needed to kill a target with a weapon's body damage at `distance`. */
function bodyShots(weapon, hp, distance = 0) {
  const perShot = weaponDamage(weapon, false, distance);
  return Math.ceil(hp / perShot);
}

function dps(weapon, distance) {
  return weaponDamage(weapon, false, distance) / weapon.fireRate;
}

test('both guns are defined in the shared table with complete stats', () => {
  for (const id of ['rifle', 'smg']) {
    const w = WEAPONS[id];
    assert.ok(w, `${id} missing from WEAPONS`);
    for (const field of ['fireRate', 'spread', 'magazineSize', 'reloadTime', 'fullRange', 'falloffRange', 'minMultiplier']) {
      assert.strictEqual(typeof w[field], 'number', `${id}.${field} must be a number`);
    }
    assert.ok(w.damage.body > 0 && w.damage.head >= w.damage.body, `${id} damage must be sane`);
  }
});

test('shared damage is used without falloff inside full range', () => {
  assert.strictEqual(weaponDamage(WEAPONS.rifle, false, 0), WEAPONS.rifle.damage.body);
  assert.strictEqual(weaponDamage(WEAPONS.rifle, true, 120), WEAPONS.rifle.damage.head);
  assert.strictEqual(weaponDamage(WEAPONS.smg, false, 10), WEAPONS.smg.damage.body);
  assert.strictEqual(weaponDamage(WEAPONS.smg, true, 10), WEAPONS.smg.damage.head);
});

test('damage falls off monotonically between fullRange and falloffRange', () => {
  const midSmg = (WEAPONS.smg.fullRange + WEAPONS.smg.falloffRange) / 2;
  const mult = rangeMultiplier(WEAPONS.smg, midSmg);
  assert.ok(mult > WEAPONS.smg.minMultiplier && mult < 1, `mid multiplier was ${mult}`);

  let previous = Infinity;
  for (let d = 0; d <= 80; d += 2) {
    const dmg = weaponDamage(WEAPONS.smg, false, d);
    assert.ok(dmg <= previous, `damage rose from ${previous} to ${dmg} at ${d}m`);
    previous = dmg;
  }
  // Past falloffRange the multiplier is frozen, not zeroed.
  assert.strictEqual(
    weaponDamage(WEAPONS.smg, false, 400),
    Math.round(WEAPONS.smg.damage.body * WEAPONS.smg.minMultiplier),
  );
});

test('the two guns have distinct roles: SMG wins close, rifle wins far', () => {
  const smgClose = dps(WEAPONS.smg, 0);
  const rifleDps = dps(WEAPONS.rifle, 0);
  assert.ok(smgClose > rifleDps * 1.5, `SMG (${smgClose}) must clearly out-DPS the rifle (${rifleDps}) up close`);

  const smgFar = dps(WEAPONS.smg, 50);
  assert.ok(rifleDps > smgFar, `rifle (${rifleDps}) must out-DPS the SMG at 50m (${smgFar})`);
});

test('rifle is a two-body-shot kill, SMG needs sustained fire', () => {
  // 100 HP player, no falloff.
  assert.strictEqual(bodyShots(WEAPONS.rifle, 100), 2);
  assert.strictEqual(bodyShots(WEAPONS.rifle, 100), 2, 'rifle must not need a third shot');
  assert.strictEqual(bodyShots(WEAPONS.smg, 100), 5);
  // One rifle headshot kills a full-health player; one SMG headshot must not.
  assert.ok(weaponDamage(WEAPONS.rifle, true, 100) >= 100);
  assert.ok(weaponDamage(WEAPONS.smg, true, 10) < 100);
});

test('the client no longer re-declares gun stats (the desync that started this)', () => {
  const src = readFileSync(CLIENT_SRC, 'utf8');
  assert.ok(src.includes('makeWeapon(WEAPONS.rifle)'), 'client must build its weapons from the shared table');
  assert.ok(src.includes('makeWeapon(WEAPONS.smg)'), 'client must build its weapons from the shared table');
  // No hardcoded gun damage literals left in the client.
  for (const banned of ['damage: { head: 100', 'damage: { head: 34']) {
    assert.strictEqual(src.includes(banned), false, `client re-declares gun damage: ${banned}`);
  }
  // Client damage to bots must go through the shared helper.
  assert.ok(/weaponDamage\(\s*weapon,/.test(src), 'client bot damage must use weaponDamage()');
});

test('server player magazines and reload times come from the table', () => {
  const game = new ServerGame();
  const id = game.addBot('red', 'MagCheck');
  const bot = game.players.get(id);
  for (const gun of ['rifle', 'smg']) {
    bot.changeEquipment(gun);
    assert.strictEqual(bot.magazineSize, WEAPONS[gun].magazineSize, `${gun} magazine`);
    assert.strictEqual(bot.currentAmmo, WEAPONS[gun].magazineSize, `${gun} loaded ammo`);
    assert.strictEqual(bot.reloadTime, WEAPONS[gun].reloadTime, `${gun} reload time`);
  }
});

test('a rate-limited shot costs no ammo and cannot beat the fire rate', () => {
  const game = new ServerGame();
  const id = game.addPlayer({ send() {} }, '127.0.0.1');
  const player = game.players.get(id);
  player.changeEquipment('rifle');
  const origin = { x: player.position.x, y: player.position.y + 1.5, z: player.position.z };
  const direction = { x: 0, y: 0, z: 1 };

  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const before = player.currentAmmo;
    game.handleShoot(id, origin, direction);
    assert.strictEqual(player.currentAmmo, before - 1, 'an accepted shot spends one round');

    // 20% of the rifle's cycle early: rejected, and the round is NOT spent
    // (it used to be deducted before the rate check).
    clock += Math.round(WEAPONS.rifle.fireRate * 0.8 * 1000);
    game.handleShoot(id, origin, direction);
    assert.strictEqual(player.currentAmmo, before - 1, 'a rejected shot must not consume ammo');

    // 95% of the cycle: accepted again (network-jitter tolerance).
    clock += Math.round(WEAPONS.rifle.fireRate * 0.15 * 1000);
    game.handleShoot(id, origin, direction);
    assert.strictEqual(player.currentAmmo, before - 2, 'a legitimate follow-up shot fires');
  } finally {
    Date.now = realNow;
  }
});
