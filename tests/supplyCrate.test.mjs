// Forward supply crate (Phase 4 / stage 8): mined blocks go in, build blocks
// come out. The server owns team ownership, reach, capacity and the exchange,
// so a modified client cannot fill a full crate or drain an enemy one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const {
  emplacementSpec,
  SUPPLY_CRATE_CAPACITY,
  SUPPLY_CRATE_DRAW,
} = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';

const join = (game, team = 'blue') => {
  const frames = [];
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  return { id, player: game.players.get(id), frames };
};

/** A crate of `team` at the player's feet (createEmplacement skips placement
 *  rules, which are covered by tests/emplacements.test.mjs). */
const crateAtPlayer = (game, player, team = player.team) =>
  game.createEmplacement(team, emplacementSpec('supplyCrate'), { ...player.position }, 0);

test('mined blocks can be deposited into a forward crate', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  game.depositableBlocks.set(id, 7);
  frames.length = 0;
  game.useSupplyCrate(id, crate.id, 'deposit');

  assert.equal(crate.stock, 7, 'the crate holds what was mined');
  assert.equal(game.depositableBlocks.get(id), 0, 'the player no longer carries it');
  assert.equal(frames.filter((f) => f.type === 'resourcesUpdated').pop()?.depositable, 0,
    'the HUD is told the carried count dropped');
  const update = frames.filter((f) => f.type === 'emplacementsUpdated').pop();
  assert.equal(update?.emplacements.find((e) => e.id === crate.id)?.stock, 7,
    'other teammates see the new stock');
});

test('a crate stops at its capacity and leaves the rest carried', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  crate.stock = SUPPLY_CRATE_CAPACITY - 2;
  game.depositableBlocks.set(id, 5);
  frames.length = 0;
  game.useSupplyCrate(id, crate.id, 'deposit');

  assert.equal(crate.stock, SUPPLY_CRATE_CAPACITY);
  assert.equal(game.depositableBlocks.get(id), 3, 'the overflow stays on the player');
  assert.equal(frames.filter((f) => f.type === 'resourcesUpdated').pop()?.depositable, 3);
});

test('a full crate refuses a deposit without spending it', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  crate.stock = SUPPLY_CRATE_CAPACITY;
  game.depositableBlocks.set(id, 4);
  frames.length = 0;
  game.useSupplyCrate(id, crate.id, 'deposit');

  assert.equal(crate.stock, SUPPLY_CRATE_CAPACITY);
  assert.equal(game.depositableBlocks.get(id), 4);
  assert.match(frames.find((f) => f.type === 'emplacementMessage')?.message ?? '', /full/i);
});

test('drawing from a crate feeds the build inventory', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  crate.stock = 12;
  const before = game.inventories.get(id);
  frames.length = 0;
  game.useSupplyCrate(id, crate.id, 'draw');

  assert.equal(crate.stock, 12 - SUPPLY_CRATE_DRAW, 'the crate is lighter');
  assert.equal(game.inventories.get(id), before + SUPPLY_CRATE_DRAW, 'the player can build');
  assert.equal(frames.filter((f) => f.type === 'inventoryUpdated').pop()?.inventory, before + SUPPLY_CRATE_DRAW);

  // A crate with less than a full draw hands over what is left.
  crate.stock = 3;
  game.useSupplyCrate(id, crate.id, 'draw');
  assert.equal(crate.stock, 0);
  assert.equal(game.inventories.get(id), before + SUPPLY_CRATE_DRAW + 3);
});

test('an empty crate refuses a draw', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  const before = game.inventories.get(id);
  frames.length = 0;
  game.useSupplyCrate(id, crate.id, 'draw');

  assert.equal(game.inventories.get(id), before);
  assert.match(frames.find((f) => f.type === 'emplacementMessage')?.message ?? '', /empty/i);
});

test('an enemy crate cannot be filled or drained', () => {
  const game = new ServerGame();
  const blue = join(game, 'blue');
  const red = join(game, 'red');
  const crate = crateAtPlayer(game, blue.player, 'blue');

  red.player.position = { ...blue.player.position };
  game.depositableBlocks.set(red.id, 6);
  crate.stock = 10;
  red.frames.length = 0;

  game.useSupplyCrate(red.id, crate.id, 'deposit');
  game.useSupplyCrate(red.id, crate.id, 'draw');

  assert.equal(crate.stock, 10, 'nothing moved');
  assert.equal(game.depositableBlocks.get(red.id), 6, 'the red player keeps its blocks');
  assert.match(red.frames.find((f) => f.type === 'emplacementMessage')?.message ?? '', /other team/i);
});

test('a crate out of reach is refused', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  player.position = { x: crate.position.x + 20, y: crate.position.y, z: crate.position.z };
  game.depositableBlocks.set(id, 5);
  frames.length = 0;
  game.useSupplyCrate(id, crate.id, 'deposit');

  assert.equal(crate.stock, 0);
  assert.equal(game.depositableBlocks.get(id), 5);
  assert.match(frames.find((f) => f.type === 'emplacementMessage')?.message ?? '', /walk up/i);
});

test('only supply crates are usable this way', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const nest = game.createEmplacement('blue', emplacementSpec('mgNest'), { ...player.position }, 0);

  game.depositableBlocks.set(id, 5);
  frames.length = 0;
  game.useSupplyCrate(id, nest.id, 'deposit');

  assert.equal(nest.stock, 0);
  assert.equal(game.depositableBlocks.get(id), 5);
  assert.match(frames.find((f) => f.type === 'emplacementMessage')?.message ?? '', /supply crate/i);
});

test('malformed crate requests are ignored without spending anything', () => {
  const game = new ServerGame();
  const { id, player, frames } = join(game);
  const crate = crateAtPlayer(game, player);

  crate.stock = 8;
  game.depositableBlocks.set(id, 4);
  frames.length = 0;

  assert.doesNotThrow(() => {
    game.handleMessage(id, { type: 'useSupplyCrate', emplacementId: crate.id, action: 'sell' });
    game.handleMessage(id, { type: 'useSupplyCrate', emplacementId: {}, action: 'draw' });
    game.handleMessage(id, { type: 'useSupplyCrate', emplacementId: 'emp_missing', action: 'draw' });
    game.handleMessage(id, { type: 'useSupplyCrate' });
  });

  assert.equal(crate.stock, 8);
  assert.equal(game.depositableBlocks.get(id), 4);
});

test('a destroyed crate takes its stock with it', () => {
  const game = new ServerGame();
  const { id, player } = join(game);
  const crate = crateAtPlayer(game, player);

  crate.stock = 25;
  game.damageEmplacement(crate.id, 9999);
  assert.equal(game.emplacements.size, 0, 'the wreck is gone');

  game.depositableBlocks.set(id, 3);
  const before = game.inventories.get(id);
  assert.doesNotThrow(() => game.useSupplyCrate(id, crate.id, 'draw'));
  assert.equal(game.inventories.get(id), before);
  assert.equal(game.depositableBlocks.get(id), 3);
});
