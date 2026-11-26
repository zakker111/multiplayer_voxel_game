// Shell resupply: cannon and mortar belts are small (10 and 6 rounds), so a
// 30-minute match needs a way to buy more. Packs are crafted at the bench or
// bought beside the gun, and a dismantle refunds the rounds a gun still has
// rather than its full cost, so tearing down and rebuilding is not a free
// reload. These drive the real ServerGame message path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.SERVER_BOT_COUNT = '0';
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const {
  SHELL_PACK_COST, SHELL_PACK_LIMIT, SHELL_PACK_ROUNDS, EMPLACEMENT_USE_REACH,
  emplacementAmmoCap, emplacementDismantleRefund, emplacementSpec,
  benchPosition, WORKSHOP_CAPACITY,
} = require('../dist/tests/sharedTypes.cjs');

/** Join at the bench with a full team stock and every message recorded. */
function benchSetup(stock = 200) {
  const frames = [];
  const game = new ServerGame();
  game.roundPhase = 'live';
  const id = game.addPlayer({
    send: (d) => frames.push(JSON.parse(d)), isOpen: () => true, close: () => {},
  }, '127.0.0.1');
  game.handleMessage(id, { type: 'join', team: 'blue', name: 'Gunner' });
  const player = game.players.get(id);
  game.spawnProtectedUntil.delete(id);
  player.position = { ...benchPosition(game.getWorkshops().blue.position) };
  game.workshopStock.blue = stock;
  return { game, id, player, frames };
}

const message = (frames, pattern) =>
  frames.some((m) => m.type === 'emplacementMessage' && pattern.test(m.message));

function gunAt(game, kind, x = 10, z = 10) {
  return game.createEmplacement('blue', emplacementSpec(kind), { x, y: 20, z }, 0);
}

test('a shell pack is bought at the bench and capped per player', () => {
  const { game, id, player, frames } = benchSetup(200);

  for (let i = 0; i < SHELL_PACK_LIMIT; i++) game.handleMessage(id, { type: 'craftShellPack' });

  assert.equal(player.shellPacks, SHELL_PACK_LIMIT, 'the player carries the packs');
  assert.equal(game.workshopStock.blue, 200 - SHELL_PACK_COST * SHELL_PACK_LIMIT, 'each pack is paid for');
  assert.equal(player.getState().shellPacks, SHELL_PACK_LIMIT, 'the HUD is told about the packs');

  game.handleMessage(id, { type: 'craftShellPack' });
  assert.equal(player.shellPacks, SHELL_PACK_LIMIT, 'the limit holds');
  assert.equal(game.workshopStock.blue, 200 - SHELL_PACK_COST * SHELL_PACK_LIMIT, 'a refused pack costs nothing');
  assert.ok(message(frames, /already carry/), 'the refusal explains the limit');
});

test('a pack cannot be bought away from the bench or without blocks', () => {
  const { game, id, player, frames } = benchSetup(200);
  player.position = { x: 90, y: 9, z: 90 };

  game.handleMessage(id, { type: 'craftShellPack' });
  assert.equal(player.shellPacks, 0);
  assert.equal(game.workshopStock.blue, 200, 'no stock is charged');
  assert.ok(message(frames, /Stand at your blueprint bench/), 'reach is enforced');

  player.position = { ...benchPosition(game.getWorkshops().blue.position) };
  game.workshopStock.blue = SHELL_PACK_COST - 1;
  game.handleMessage(id, { type: 'craftShellPack' });
  assert.equal(player.shellPacks, 0);
  assert.equal(game.workshopStock.blue, SHELL_PACK_COST - 1, 'an unaffordable pack costs nothing');
  assert.ok(message(frames, /Not enough workshop blocks/), 'the cost is explained');
});

test('beside a cannon, blocks buy a pack and load it in one action', () => {
  const { game, id, player } = benchSetup(200);
  const gun = gunAt(game, 'cannon');
  player.position = { ...gun.position };
  const start = gun.ammo;

  game.handleMessage(id, { type: 'loadShellPack', emplacementId: gun.id });

  assert.equal(gun.ammo, start + SHELL_PACK_ROUNDS.cannon, 'five shells go into the belt');
  assert.equal(game.workshopStock.blue, 200 - SHELL_PACK_COST, 'the gun purchase is paid for');
  assert.equal(player.shellPacks, 0, 'no carried pack was involved');
});

test('a carried pack loads beside the gun without a second charge', () => {
  const { game, id, player } = benchSetup(200);
  game.handleMessage(id, { type: 'craftShellPack' });
  assert.equal(game.workshopStock.blue, 200 - SHELL_PACK_COST);

  const gun = gunAt(game, 'cannon');
  player.position = { ...gun.position };
  game.handleMessage(id, { type: 'loadShellPack', emplacementId: gun.id });

  assert.equal(gun.ammo, 15);
  assert.equal(game.workshopStock.blue, 200 - SHELL_PACK_COST, 'carrying the pack was the only charge');
  assert.equal(player.shellPacks, 0, 'the pack is spent');
});

test('a mortar loads three bombs, caps at three belts, and refuses a full gun', () => {
  const { game, id, player, frames } = benchSetup(200);
  const gun = gunAt(game, 'mortar', 20, 20);
  player.position = { ...gun.position };
  const cap = emplacementAmmoCap('mortar');

  for (let i = 0; i < 4; i++) game.handleMessage(id, { type: 'loadShellPack', emplacementId: gun.id });

  assert.equal(gun.ammo, cap, 'the belt stops at its cap');
  assert.equal(
    game.workshopStock.blue,
    200 - SHELL_PACK_COST * 4,
    'each pack is paid for',
  );

  game.handleMessage(id, { type: 'loadShellPack', emplacementId: gun.id });
  assert.equal(gun.ammo, cap);
  assert.equal(game.workshopStock.blue, 200 - SHELL_PACK_COST * 4, 'a full gun costs nothing');
  assert.ok(message(frames, /already full/), 'the full gun says so');
});

test('a resupplied cannon can fire every round it bought', () => {
  const { game, id, player } = benchSetup(200);
  const gun = gunAt(game, 'cannon');
  player.position = { ...gun.position };
  gun.gunnerId = id;
  player.rotation.pitch = 0;

  for (let i = 0; i < 4; i++) game.handleMessage(id, { type: 'loadShellPack', emplacementId: gun.id });
  assert.equal(gun.ammo, emplacementAmmoCap('cannon'));

  let fired = 0;
  while (gun.ammo > 0 && fired < 60) {
    const before = gun.ammo;
    game.handleMessage(id, { type: 'fireEmplacement' });
    if (gun.ammo < before) fired++;
    game.world.serverTime += 2.5; // outlast the cannon's reload
  }

  assert.equal(fired, emplacementAmmoCap('cannon'), 'the bought shells are real rounds');
  assert.equal(gun.ammo, 0, 'the belt drains to empty');
});

test('the gunner can load while manning, but not from across the map', () => {
  const { game, id, player, frames } = benchSetup(200);
  const cannon = gunAt(game, 'cannon', 10, 10);
  player.position = { x: 90, y: 9, z: 90 };

  game.handleMessage(id, { type: 'loadShellPack', emplacementId: cannon.id });
  assert.equal(cannon.ammo, 10, 'distance refuses a stranger');
  assert.ok(message(frames, /Walk up to the gun/));

  cannon.gunnerId = id;
  game.handleMessage(id, { type: 'loadShellPack', emplacementId: cannon.id });
  assert.equal(cannon.ammo, 15, 'the manning gunner is already at the seat');
});

test('shell packs are for cannons and mortars only, and friendlies only', () => {
  const { game, id, player, frames } = benchSetup(200);
  const nest = gunAt(game, 'mgNest', 30, 30);
  const crate = gunAt(game, 'supplyCrate', 40, 40);
  const enemyCannon = game.createEmplacement('red', emplacementSpec('cannon'), { x: 50, y: 20, z: 50 }, 0);
  player.position = { x: 30, y: 20, z: 30 };

  game.handleMessage(id, { type: 'loadShellPack', emplacementId: nest.id });
  game.handleMessage(id, { type: 'loadShellPack', emplacementId: crate.id });
  game.handleMessage(id, { type: 'loadShellPack', emplacementId: enemyCannon.id });

  assert.equal(nest.ammo, 200, 'the nest belt is untouched');
  assert.equal(crate.ammo, 0);
  assert.equal(enemyCannon.ammo, 10);
  assert.equal(game.workshopStock.blue, 200, 'no refused load is charged');
  assert.ok(message(frames, /Only cannons and mortars/), 'the kind is explained');
  assert.ok(message(frames, /other team/), 'ownership is explained');
});

test('dismantling refunds the rounds still in the belt, not the whole build', () => {
  const { game, id, player } = benchSetup(0);
  const spec = emplacementSpec('cannon');
  const gun = gunAt(game, 'cannon');
  player.position = { ...gun.position };
  gun.ammo = 6; // four of the ten starting shells fired
  const expected = spec.cost - 4 * (SHELL_PACK_COST / 5);

  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: gun.id });

  assert.equal(game.emplacements.size, 0, 'the gun is gone');
  assert.equal(game.workshopStock.blue, expected, 'fired shells are not refunded');
  assert.equal(emplacementDismantleRefund(spec, 6), expected, 'the helper agrees');

  // An empty belt returns only the hardware's share.
  const empty = gunAt(game, 'cannon', 12, 12);
  empty.ammo = 0;
  player.position = { ...empty.position };
  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: empty.id });
  assert.equal(game.workshopStock.blue, expected + spec.cost - spec.ammo * (SHELL_PACK_COST / 5));
});

test('firing a gun dry and rebuilding it costs the belt instead of reloading free', () => {
  const { game, id, player } = benchSetup(200);
  const spec = emplacementSpec('cannon');

  // The build price is paid when the blueprint is crafted, not on placement.
  game.handleMessage(id, { type: 'craftBlueprint', kind: 'cannon', slot: 0 });
  assert.equal(game.workshopStock.blue, 200 - spec.cost, 'the first cannon is paid for');

  const gun = gunAt(game, 'cannon');
  player.position = { ...gun.position };
  gun.gunnerId = id;
  player.rotation.pitch = 0;
  for (let i = 0; i < spec.ammo; i++) {
    game.handleMessage(id, { type: 'fireEmplacement' });
    game.world.serverTime += 2.5;
  }
  assert.equal(gun.ammo, 0, 'the belt is empty');

  game.handleMessage(id, { type: 'dismantleEmplacement', emplacementId: gun.id });
  const afterDismantle = 200 - spec.cost + 30;
  assert.equal(game.workshopStock.blue, afterDismantle, 'an empty gun refunds only its hardware');

  // Rebuilding means paying the build price again. The old full refund left
  // the stock exactly where it started, which is the free reload.
  player.position = { ...benchPosition(game.getWorkshops().blue.position) };
  game.handleMessage(id, { type: 'craftBlueprint', kind: 'cannon', slot: 1 });
  assert.equal(game.workshopStock.blue, afterDismantle - spec.cost, 'the rebuild is paid for');
  assert.equal(game.workshopStock.blue, 200 - 2 * spec.cost + 30, 'the fired belt cost 60 blocks');
  assert.ok(game.workshopStock.blue < 200, 'the loop is not free');
});

test('an empty gun costs more to rebuild than its refund, closing the free reload', () => {
  const cannon = emplacementSpec('cannon');
  const mortar = emplacementSpec('mortar');
  const nest = emplacementSpec('mgNest');

  assert.equal(cannon.cost - emplacementDismantleRefund(cannon, 0), 60, 'a cannon refill costs 60 blocks');
  assert.equal(mortar.cost - emplacementDismantleRefund(mortar, 0), 60, 'a mortar refill costs 60 blocks');
  assert.equal(nest.cost - emplacementDismantleRefund(nest, 0), 40, 'an empty MG nest also loses its belt value');

  // A full build still refunds its whole cost.
  assert.equal(emplacementDismantleRefund(cannon, cannon.ammo, 0), cannon.cost);
  assert.equal(emplacementDismantleRefund(mortar, mortar.ammo, 0), mortar.cost);
  // Crate stock rides along with the refund.
  assert.equal(emplacementDismantleRefund(cannon, cannon.ammo, 12), cannon.cost + 12);
  // Purchased rounds above the starting belt are not refunded for profit.
  assert.equal(emplacementDismantleRefund(cannon, cannon.ammo + 5, 0), cannon.cost);
  assert.ok(WORKSHOP_CAPACITY > cannon.cost, 'the workshop can hold a full refund');
});
