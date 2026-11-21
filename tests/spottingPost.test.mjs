// Spotting post (Phase 4): a live post marks enemies inside its radius for the
// owning team only, bots included, and the markers clear when it is destroyed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { SPOTTING_POST_RADIUS } = require('../dist/tests/sharedTypes.cjs');
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
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 6)) continue;
      spots.push({ x, y: groundTop(game, x, z), z });
      if (spots.length >= count) return spots;
    }
  }
  return spots;
};

const join = (game, team, frames = []) => {
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  const workshop = game.getWorkshops()[team].position;
  player.position = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  return { id, player, frames };
};

/** Craft and place one spotting post; returns the live emplacement. */
const placePost = (game, owner, spot) => {
  game.workshopStock[owner.player.team] = 400;
  game.handleMessage(owner.id, { type: 'craftBlueprint', kind: 'spottingPost', slot: 0 });
  owner.player.position = { x: spot.x - 4, y: spot.y, z: spot.z };
  game.handleMessage(owner.id, {
    type: 'placeEmplacement', kind: 'spottingPost', position: spot, yaw: 0, slot: 0,
  });
  const post = [...game.emplacements.values()].find((e) => e.kind === 'spottingPost');
  assert.ok(post, 'the spotting post was placed');
  return post;
};

const lastReport = (frames) => frames.filter((frame) => frame.type === 'spotReport').at(-1);

const standAt = (game, player, x, z) => {
  player.position = { x, y: groundTop(game, x, z), z };
};

test('a spotting post marks only enemies inside its radius, for its own team', () => {
  const game = new ServerGame();
  const blue = join(game, 'blue');
  const red = join(game, 'red');
  const spot = findSpots(game, 1)[0];
  const post = placePost(game, blue, spot);

  standAt(game, red.player, spot.x + 30, spot.z);
  game.update(0.3);

  const inside = lastReport(blue.frames);
  assert.ok(inside, 'the owning team received a spot report');
  assert.deepEqual(inside.contacts.map((c) => c.id), [red.id], 'only the enemy in range is marked');
  const contact = inside.contacts[0];
  assert.equal(contact.team, 'red');
  assert.ok(Math.abs(contact.position.x - red.player.position.x) < 0.001, 'the report carries the enemy position');
  assert.ok(Math.abs(contact.position.z - red.player.position.z) < 0.001);
  assert.equal(
    red.frames.filter((frame) => frame.type === 'spotReport').length, 0,
    'the enemy team gets no free radar',
  );

  standAt(game, red.player, spot.x + SPOTTING_POST_RADIUS + 10, spot.z);
  game.update(0.3);
  assert.deepEqual(lastReport(blue.frames).contacts, [], 'an enemy outside the radius is not marked');

  assert.equal(post.kind, 'spottingPost');
});

test('a post marks bots and its markers clear when it is destroyed', () => {
  const game = new ServerGame();
  const blue = join(game, 'blue');
  const spot = findSpots(game, 1)[0];
  const post = placePost(game, blue, spot);

  const botId = game.addBot('red', '🤖 Spotter Test');
  const bot = game.players.get(botId);
  standAt(game, bot, spot.x + 10, spot.z + 10);
  game.update(0.3);

  const marked = lastReport(blue.frames);
  assert.ok(marked.contacts.some((c) => c.id === botId), 'a bot inside the radius is marked');

  bot.isDead = true;
  game.update(0.3);
  assert.ok(
    !lastReport(blue.frames).contacts.some((c) => c.id === botId),
    'a dead enemy drops off the report',
  );
  bot.isDead = false;

  game.damageEmplacement(post.id, 9999);
  assert.equal([...game.emplacements.values()].some((e) => e.kind === 'spottingPost'), false, 'the post was destroyed');
  game.update(0.3);
  assert.deepEqual(lastReport(blue.frames).contacts, [], 'destroying the post clears its markers');
});
