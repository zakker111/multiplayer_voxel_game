// Every emplacement kind end to end at the server boundary: craft at the bench,
// place on flat ground, take damage from an enemy player's rifle and from a
// bot's rounds (and refuse a friendly shot), then come down with the X
// (dismantleEmplacement) message and refund its cost.
//
// tests/emplacements.test.mjs covers the rules of the bench and the nest/crate
// lifecycle; this file exists so no kind can silently lose the place, damage or
// dismantle path — the earlier coverage only exercised the nest and the crate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { emplacementSpec, WORKSHOP_CAPACITY } = require('../dist/tests/sharedTypes.cjs');
process.env.SERVER_BOT_COUNT = '0';

const KINDS = ['mgNest', 'cannon', 'mortar', 'supplyCrate', 'spottingPost'];
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

/** Flat spots in the mid-map band, far enough apart that footprints never meet. */
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

/** A blue player at its bench, plus a red shooter parked in the middle. */
const setup = () => {
  const game = new ServerGame();
  const blueFrames = [];
  const id = game.addPlayer({ send: (data) => blueFrames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team: 'blue' });
  const player = game.players.get(id);
  const workshop = game.getWorkshops().blue.position;
  const bench = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  player.position = { ...bench };

  const redId = game.addPlayer({ send: () => {}, isOpen: () => true });
  game.handleMessage(redId, { type: 'join', team: 'red' });
  const red = game.players.get(redId);
  red.position = { x: 0, y: groundTop(game, 0, 0) ?? 0, z: 0 };
  return { game, id, player, bench, redId, red };
};

/** Craft at the bench, then place. Opens the stockpile at capacity so a later
 *  dismantle has room to refund (a full workshop refunds nothing). */
const craftAndPlace = (game, ctx, kind, spot) => {
  ctx.player.position = { ...ctx.bench };
  game.workshopStock.blue = WORKSHOP_CAPACITY;
  game.handleMessage(ctx.id, { type: 'craftBlueprint', kind, slot: 0 });
  assert.equal(game.craftedBlueprints.get(ctx.id)?.[0], kind, `${kind} blueprints at the bench`);
  game.handleMessage(ctx.id, { type: 'placeEmplacement', kind, position: spot, yaw: 0, slot: 0 });
  const built = [...game.emplacements.values()].find(
    (e) => e.kind === kind && !e.wreck && Math.hypot(e.position.x - spot.x, e.position.z - spot.z) < 2,
  );
  assert.ok(built, `${kind} places on flat ground`);
  return built;
};

/** A muzzle position with a clear line to the build (eight compass offsets). */
const firingLine = (game, target, range) => {
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const from = {
      x: target.position.x + Math.cos(angle) * range,
      y: target.position.y,
      z: target.position.z + Math.sin(angle) * range,
    };
    const eye = { x: from.x, y: from.y + 1.6, z: from.z };
    const aim = { x: target.position.x - eye.x, y: target.position.y + 0.8 - eye.y, z: target.position.z - eye.z };
    const len = Math.hypot(aim.x, aim.y, aim.z);
    const dir = { x: aim.x / len, y: aim.y / len, z: aim.z / len };
    if (game.world.raycast(eye, dir, len + 2)) continue; // terrain in the way
    return { from, eye, dir };
  }
  return null;
};

test('every emplacement kind places, takes player and bot damage, and dismantles', () => {
  for (const kind of KINDS) {
    const spec = emplacementSpec(kind);
    const ctx = setup();
    const { game } = ctx;
    const spots = findSpots(game, 3);

    // place: full spec stats, built by the player's team
    const built = craftAndPlace(game, ctx, kind, spots[0]);
    assert.equal(built.hp, spec.maxHp, `${kind} starts at full hp`);
    assert.equal(built.ammo, spec.ammo, `${kind} carries its spec ammo`);
    assert.equal(built.team, 'blue', `${kind} belongs to the builder's team`);

    // an enemy player's rifle wrecks it
    const line = firingLine(game, built, 7);
    assert.ok(line, `${kind} has a clear firing line`);
    ctx.red.position = { ...line.from };
    for (let shots = 0; shots < 40 && !built.wreck; shots++) {
      ctx.red.currentAmmo = ctx.red.magazineSize; // ignore reload downtime
      game.lastShootTime.clear();
      game.handleMessage(ctx.redId, { type: 'shoot', origin: line.eye, direction: line.dir });
    }
    assert.ok(built.wreck, `${kind} is wrecked by an enemy player's fire`);

    // a friendly shot does nothing to the next one; a bot's rounds wreck it
    const second = craftAndPlace(game, ctx, kind, spots[1]);
    const friendlyLine = firingLine(game, second, 7);
    assert.ok(friendlyLine, `${kind} has a clear friendly line`);
    ctx.player.position = { ...friendlyLine.from };
    for (let i = 0; i < 4; i++) {
      ctx.player.currentAmmo = ctx.player.magazineSize;
      game.lastShootTime.clear();
      game.handleMessage(ctx.id, { type: 'shoot', origin: friendlyLine.eye, direction: friendlyLine.dir });
    }
    assert.equal(second.hp, spec.maxHp, `${kind} ignores friendly fire`);
    assert.equal(second.wreck, false, `${kind} is not wrecked by its owner`);

    const botLine = firingLine(game, second, 22);
    assert.ok(botLine, `${kind} has a clear line from 22m`);
    const bot = game.players.get(game.addBot('red', 'Sapper'));
    bot.position = { ...botLine.from };
    const target = {
      id: second.id,
      team: 'blue',
      position: { ...second.position },
      isDead: false,
      emplacement: { kind, manned: false },
    };
    const fire = game.getBotContext().fireWeapon;
    for (let rounds = 0; rounds < 200 && !second.wreck; rounds++) fire(bot, target, botLine.dir, 1.6);
    assert.ok(second.wreck, `${kind} is wrecked by bot fire`);

    // X: dismantle clears the build and refunds the craft cost
    const third = craftAndPlace(game, ctx, kind, spots[2]);
    const stockBefore = game.workshopStock.blue;
    ctx.player.position = { ...third.position };
    game.handleMessage(ctx.id, { type: 'dismantleEmplacement', emplacementId: third.id });
    assert.equal(game.emplacements.get(third.id), undefined, `${kind} comes down with X`);
    assert.equal(game.workshopStock.blue, stockBefore + spec.cost, `${kind} refunds its cost on X`);
  }
});
