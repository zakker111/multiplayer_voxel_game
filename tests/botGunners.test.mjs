// Bot gun crews (Phase 4 / stage 7).
//
// Engineers leave nests behind; bots have to work them. A defender near a free
// friendly nest takes the seat, aims the gun inside its arc and fires, and the
// seat stays server-owned: occupancy, ammo, reload and the safe exit are the
// same checks a human gunner goes through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { emplacementSpec, EMPLACEMENT_MOUNT_REACH } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';

const SAMPLES = [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]];

const groundTop = (game, x, z) => {
  for (let y = 40; y > -20; y--) if (game.world.isSolid(Math.round(x), y, Math.round(z))) return y + 0.5;
  return null;
};

const isFlat = (game, x, z) => {
  const tops = SAMPLES.map(([ox, oz]) => groundTop(game, x + ox, z + oz));
  if (tops.some((top) => top === null)) return false;
  return Math.max(...tops) - Math.min(...tops) <= 0 && Math.max(...tops) > 0;
};

/** Flat mid-map spots clear of the bases, workshops and flag stands. */
const findSpots = (game, count) => {
  const spots = [];
  for (let z = -30; z <= 30; z += 3) {
    for (let x = -60; x <= 60; x += 3) {
      if (Math.abs(x) < 15 || Math.abs(z) > 50) continue;
      if (!isFlat(game, x, z)) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 8)) continue;
      spots.push({ x, y: groundTop(game, x, z), z });
      if (spots.length >= count) return spots;
    }
  }
  return spots;
};

/** A support bot that is not on the separate workshop logistics assignment. */
const supportBot = (game, team = 'blue') => {
  for (let i = 0; i < 22; i++) {
    const id = game.addBot(team, `Gunner ${i}`);
    const bot = game.players.get(id);
    if (bot.roleName === 'support' && !bot.isLogistics) return bot;
  }
  throw new Error('no support bot drawn');
};

/** Build a nest for `team` at a flat spot and return it. */
const placeNest = (game, bot, spot) => {
  game.workshopStock[bot.team] = 500;
  assert.equal(game.botPlaceEmplacement(bot, 'mgNest', spot, 0), true, 'the nest was placed');
  return [...game.emplacements.values()][0];
};

/** Pick a spot around the nest with a clear line of fire and the yaw to it. */
const findShot = (game, gun) => {
  const origin = { x: gun.position.x, y: gun.position.y + 1.15, z: gun.position.z };
  for (const radius of [10, 12, 16, 20]) {
    for (let i = 0; i < 16; i++) {
      const angle = (i * Math.PI) / 8;
      const x = gun.position.x + Math.cos(angle) * radius;
      const z = gun.position.z + Math.sin(angle) * radius;
      if (Math.abs(x) > 200 || Math.abs(z) > 200) continue;
      const y = groundTop(game, x, z);
      if (y === null) continue;
      const aim = { x, y: y + 1, z };
      if (!game.hasLineOfSight(origin, aim)) continue;
      return { x, y, z, yaw: Math.atan2(-(x - gun.position.x), -(z - gun.position.z)) };
    }
  }
  return null;
};

test('bots only see free, loaded friendly nests as seats', () => {
  const game = new ServerGame();
  const bot = supportBot(game);
  const [spot] = findSpots(game, 1);
  const gun = placeNest(game, bot, spot);
  const ctx = game.getBotContext();
  assert.equal(typeof ctx.guns.manned, 'function', 'bots get the gun hooks');

  bot.position = { x: gun.position.x + 2, y: gun.position.y, z: gun.position.z };
  assert.equal(ctx.guns.freeNear(bot, 10)?.id, gun.id, 'a free nest nearby is a seat');
  assert.equal(ctx.guns.freeNear(bot, 1), null, 'out of the search radius');

  const enemy = supportBot(game, 'red');
  enemy.position = { ...bot.position };
  assert.equal(ctx.guns.freeNear(enemy, 10), null, 'a nest belongs to its own team');

  gun.ammo = 0;
  assert.equal(ctx.guns.freeNear(bot, 10), null, 'a dry nest is not worth a walk');
  gun.ammo = 100;
  gun.gunnerId = 'someone-else';
  assert.equal(ctx.guns.freeNear(bot, 10), null, 'an occupied nest has no seat to take');
});

test('a defender walks to a free nest and mans it', () => {
  const game = new ServerGame();
  const bot = supportBot(game);
  const [spot] = findSpots(game, 1);
  const gun = placeNest(game, bot, spot);

  // Too far to mount from here, close enough to recruit.
  bot.position = { x: gun.position.x + 8, y: gun.position.y, z: gun.position.z };
  assert.ok(8 > EMPLACEMENT_MOUNT_REACH, 'the test starts outside mount reach');

  for (let i = 0; i < 120 && gun.gunnerId !== bot.id; i++) game.update(1 / 20);

  assert.equal(gun.gunnerId, bot.id, 'the defender took the seat');
  assert.equal(bot.stateName, 'MAN_GUN');
  assert.ok(
    Math.hypot(bot.position.x - gun.position.x, bot.position.z - gun.position.z) < 1.2,
    'the server snapped the gunner onto the nest',
  );
});

test('a bot gunner fires the nest at an enemy inside its arc', () => {
  const game = new ServerGame();
  const bot = supportBot(game);
  const [spot] = findSpots(game, 1);
  const gun = placeNest(game, bot, spot);

  const shot = findShot(game, gun);
  assert.ok(shot, 'there is a clear line of fire near the nest');
  gun.baseYaw = shot.yaw;
  gun.yaw = shot.yaw;
  bot.position = { x: gun.position.x + 1, y: gun.position.y, z: gun.position.z };

  const frames = [];
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team: 'red' });
  const enemy = game.players.get(id);
  enemy.position = { x: shot.x, y: shot.y, z: shot.z };

  // Spawn protection covers the first 2.5s; the nest still has to work.
  let died = false;
  for (let i = 0; i < 200 && !died; i++) {
    game.update(1 / 20);
    died = enemy.isDead;
  }

  assert.equal(gun.gunnerId, bot.id, 'the bot stayed in the seat');
  assert.ok(gun.ammo < emplacementSpec('mgNest').ammo, 'the nest spent rounds');
  assert.ok(died, 'the rounds killed the enemy');
});

test('a dry nest sends its gunner back to the post', () => {
  const game = new ServerGame();
  const bot = supportBot(game);
  const [spot] = findSpots(game, 1);
  const gun = placeNest(game, bot, spot);
  bot.position = { x: gun.position.x + 1, y: gun.position.y, z: gun.position.z };

  for (let i = 0; i < 60 && gun.gunnerId !== bot.id; i++) game.update(1 / 20);
  assert.equal(gun.gunnerId, bot.id, 'manned the nest');

  gun.ammo = 0;
  game.update(1 / 20);
  assert.equal(gun.gunnerId, null, 'a dry gun is abandoned');
  assert.notEqual(bot.stateName, 'MAN_GUN');
});

test('a bot leaves a nest alone while a human is manning it', () => {
  const game = new ServerGame();
  const frames = [];
  const humanId = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(humanId, { type: 'join', team: 'blue' });
  const human = game.players.get(humanId);

  const bot = supportBot(game);
  const [spot] = findSpots(game, 1);
  const gun = placeNest(game, bot, spot);

  human.position = { ...gun.position };
  game.handleMessage(humanId, { type: 'mountEmplacement', emplacementId: gun.id });
  assert.equal(gun.gunnerId, humanId, 'the human took the seat');

  bot.position = { x: gun.position.x + 6, y: gun.position.y, z: gun.position.z };
  for (let i = 0; i < 60; i++) game.update(1 / 20);

  assert.equal(gun.gunnerId, humanId, 'the seat still belongs to the human');
  assert.notEqual(bot.stateName, 'MAN_GUN');
});
