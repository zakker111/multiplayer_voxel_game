// Ammo economy: every gun loads from a pouch, magazines are bought at the
// team's blueprint bench with workshop blocks, and bots pay for theirs from the
// same stockpile. A refused purchase must never charge the team.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const { WEAPONS, GROUND_LEVEL } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';

/** A joined player standing at their team's bench, plus the frames sent. */
const join = (game, team = 'blue') => {
  const frames = [];
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  const workshop = game.getWorkshops()[team].position;
  player.position = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  return { id, player, frames };
};

const buy = (game, id) => game.handleMessage(id, { type: 'craftAmmo' });

const ammoMessage = (frames, text) =>
  frames.filter((f) => f.type === 'ammoMessage' && f.message === text);

test("a swap keeps a gun's own rounds; a respawn is what refills them", () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const rifle = WEAPONS.rifle;
  const smg = WEAPONS.smg;
  const riflePouch = rifle.magazineSize * rifle.reserveMagazines;
  const smgPouch = smg.magazineSize * smg.reserveMagazines;
  assert.equal(player.currentAmmo, rifle.magazineSize);
  assert.equal(player.reserveAmmo, riflePouch);

  // Tap 2 and 1 after spending part of the rifle's supply: a swap must hand
  // back exactly what the rifle left with. Refilling here was free ammo, so two
  // key presses bought what the bench charges blocks for.
  player.currentAmmo = 4;
  player.reserveAmmo = 12;
  game.handleMessage(id, { type: 'playerInput', input: { equipment: 'smg' } });
  assert.equal(player.reserveAmmo, smgPouch, 'the SMG starts at its own loadout');
  // The client keeps no pouch of its own, so the swap must report the new one.
  assert.equal(frames.filter((f) => f.type === 'playerUpdated' && f.state?.reserveAmmo === smgPouch).length, 1);

  game.handleMessage(id, { type: 'playerInput', input: { equipment: 'rifle' } });
  assert.equal(player.currentAmmo, 4, 'the rifle magazine is not refilled by a swap');
  assert.equal(player.reserveAmmo, 12, 'and neither is its pouch');

  player.respawn({ x: 0, y: GROUND_LEVEL, z: 0 });
  assert.equal(player.reserveAmmo, riflePouch, 'a respawn is the refill');
});

test('a reload spends pouch rounds, and an empty pouch cannot reload', () => {
  const game = new ServerGame();
  const { player } = join(game);
  const pouch = player.reserveAmmo;

  player.currentAmmo = 0;
  assert.equal(player.startReload(), true);
  player.reloadStartTime = 0; // the reload clock is wall time
  player.updateReload();
  assert.equal(player.currentAmmo, WEAPONS.rifle.magazineSize, 'magazine refilled');
  assert.equal(player.reserveAmmo, pouch - WEAPONS.rifle.magazineSize, 'pouch paid for it');

  player.currentAmmo = 0;
  player.reserveAmmo = 0;
  assert.equal(player.startReload(), false, 'nothing left to load from');
});

test('the bench sells one magazine per purchase out of team stock', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const stats = WEAPONS.rifle;
  const pouch = player.reserveAmmo;
  game.workshopStock.blue = stats.ammoCost;

  buy(game, id);
  assert.equal(game.workshopStock.blue, 0, 'one magazine charged');
  assert.equal(player.reserveAmmo, pouch + stats.magazineSize);

  // Empty stock: the refusal is free, pouch untouched.
  buy(game, id);
  assert.equal(player.reserveAmmo, pouch + stats.magazineSize);
  assert.equal(ammoMessage(frames, 'Not enough workshop blocks for a magazine').length, 1);
});

test('a purchase away from the bench costs nothing', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  game.workshopStock.blue = 100;
  const pouch = player.reserveAmmo;
  player.position = { x: 60, y: GROUND_LEVEL, z: 60 };

  buy(game, id);
  assert.equal(game.workshopStock.blue, 100, 'no charge when refused');
  assert.equal(player.reserveAmmo, pouch);
  assert.equal(ammoMessage(frames, 'Stand at your blueprint bench to buy ammo').length, 1);
});

test('the pouch stops at its magazine cap', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  game.workshopStock.blue = 500;
  player.reserveAmmo = player.reserveCapacity() - WEAPONS.rifle.magazineSize + 1;

  buy(game, id);
  assert.equal(game.workshopStock.blue, 500, 'a full pouch is not charged');
  assert.equal(ammoMessage(frames, 'Your ammo pouch is full').length, 1);
});

test('a dry bot buys a magazine from team stock, above the build floor', () => {
  const game = new ServerGame();
  const ctx = game.getBotContext();
  const bot = new ServerBot('dry-bot', { x: 0, y: GROUND_LEVEL, z: 0 }, 'red', 'Dry', true);
  bot.changeEquipment('rifle');
  const stats = WEAPONS.rifle;

  game.workshopStock.red = 400;
  bot.currentAmmo = 0;
  bot.reserveAmmo = 0;
  assert.equal(ctx.requestAmmo(bot), true, 'armoury issues a magazine');
  assert.equal(game.workshopStock.red, 400 - stats.ammoCost, 'paid from team stock');
  assert.equal(bot.reserveAmmo, stats.magazineSize);

  // Below the build floor the squad keeps its blocks and the bot stays dry.
  game.workshopStock.red = stats.ammoCost + 20;
  bot.reserveAmmo = 0;
  assert.equal(ctx.requestAmmo(bot), false);
  assert.equal(game.workshopStock.red, stats.ammoCost + 20, 'nothing was charged');
});
