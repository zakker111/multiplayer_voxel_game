// Offline (Beta) artillery: the flight and blast code the client runs, driven
// headlessly with a flat world and recording damage handlers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stepOfflineShells } = require('../dist/tests/localShells.cjs');
const { CANNON_BLAST_DAMAGE, CANNON_BLAST_RADIUS } = require('../dist/tests/sharedTypes.cjs');

/** A flat world at y=0: shells burst only on bodies, vehicles or builds. */
const flatWorld = { getGroundHeight: () => 0 };

/** A cannon round flying level at x=0, y=8.5; after ~0.4s it is at x=8, y=7. */
const flyingShell = (overrides = {}) => ({
  kind: 'cannon',
  team: 'blue',
  position: { x: 0, y: 8.5, z: 0 },
  velocity: { x: 20, y: 0, z: 0 },
  firedAt: 0,
  ...overrides,
});

const build = (id, team, x, kind = 'cannon', y = 7) => ({
  id,
  team,
  kind,
  position: { x, y, z: 0 },
});

const footprintObstacle = (target) => ({
  kind: 'footprint',
  team: target.team,
  position: target.position,
  footprint: { halfWidth: 1.2, halfLength: 1.6, height: 1.5 },
});

test('an offline round damages a directly hit build exactly once, at full power', () => {
  const struck = build('struck', 'red', 10);
  // A second enemy build just outside the first's footprint, still in the
  // blast, and a friendly one sitting on the same spot as the struck build.
  const nearby = build('nearby', 'red', 13);
  const friendly = build('friendly', 'blue', 10);
  const shells = [flyingShell()];
  const bot = { team: 'red', position: { x: 8, y: 7, z: 0 }, isDead: false };
  const jeep = { team: 'red', position: { x: 8, y: 7, z: 0.5 }, wreck: false };

  const buildDamage = [];
  const botDamage = [];
  const jeepDamage = [];
  const explosions = [];

  stepOfflineShells(
    shells,
    1,
    flatWorld,
    [footprintObstacle(struck)],
    0,
    {
      bots: [bot],
      jeeps: [jeep],
      builds: [struck, nearby, friendly],
    },
    {
      damageBot: (target, damage) => botDamage.push({ id: 'bot', target, damage }),
      damageJeep: (target, damage) => jeepDamage.push({ id: 'jeep', target, damage }),
      damageBuild: (target, damage) => buildDamage.push({ id: target.id, damage }),
      onExplode: (_shell, impact, radius) => explosions.push({ impact, radius }),
    },
  );

  assert.equal(shells.length, 0, 'the round is spent');

  const struckHits = buildDamage.filter((hit) => hit.id === 'struck');
  assert.equal(struckHits.length, 1, 'one round makes exactly one damage call for the struck build');
  assert.equal(struckHits[0].damage, CANNON_BLAST_DAMAGE, 'a direct hit takes one full blast, not double');

  assert.equal(buildDamage.filter((hit) => hit.id === 'friendly').length, 0, 'friendly builds are spared');
  const nearbyHit = buildDamage.filter((hit) => hit.id === 'nearby');
  assert.equal(nearbyHit.length, 1, 'a nearby enemy build is caught once');
  assert.ok(nearbyHit[0].damage > 0 && nearbyHit[0].damage < CANNON_BLAST_DAMAGE, 'and takes falloff');

  assert.equal(botDamage.length, 1, 'a bot in the blast is damaged once');
  assert.ok(botDamage[0].damage > 0 && botDamage[0].damage <= CANNON_BLAST_DAMAGE);
  assert.equal(jeepDamage.length, 1, 'a jeep in the blast is damaged once');
  assert.ok(jeepDamage[0].damage > 0 && jeepDamage[0].damage <= CANNON_BLAST_DAMAGE);

  assert.equal(explosions.length, 1, 'the blast visual is spawned once');
  assert.equal(explosions[0].radius, CANNON_BLAST_RADIUS);
  assert.ok(Math.hypot(explosions[0].impact.x - struck.position.x, explosions[0].impact.z - struck.position.z)
    < Math.hypot(1.2, 1.6), 'it bursts on the struck build');
});

test('a round that hits the ground near a build damages it once with falloff', () => {
  const target = build('bystander', 'red', 12, 'cannon', 0);
  const shells = [flyingShell({ position: { x: 0, y: 1.2, z: 0 } })];

  const buildDamage = [];
  stepOfflineShells(
    shells,
    1,
    flatWorld,
    [],
    0,
    { bots: [], jeeps: [], builds: [target] },
    {
      damageBot: () => {},
      damageJeep: () => {},
      damageBuild: (hit, damage) => buildDamage.push({ id: hit.id, damage }),
      onExplode: () => {},
    },
  );

  assert.equal(buildDamage.length, 1, 'the build is caught by splash exactly once');
  assert.equal(buildDamage[0].id, 'bystander');
  assert.ok(buildDamage[0].damage < CANNON_BLAST_DAMAGE, 'splash is not a direct hit');
  assert.ok(buildDamage[0].damage > 0);
});
