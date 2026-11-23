// Shared ballistics: the mortar's arc is solved from the point the gunner
// aimed at, and the client draws the same path the server simulates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  ballisticVelocity, ballisticRange, shellArc, blastBuildHits, MORTAR_SHELL_SPEED, CANNON_SHELL_SPEED,
} = require('../dist/tests/ballistics.cjs');
const { CANNON_BLAST_RADIUS, CANNON_BLAST_DAMAGE } = require('../dist/tests/sharedTypes.cjs');

const GRAVITY = 18; // EMPLACEMENT_SHELL_GRAVITY

test('a mortar solution lands on the point it was aimed at', () => {
  const origin = { x: 0, y: 10, z: 0 };
  for (const range of [30, 60, 90, 120]) {
    const target = { x: range, y: 10, z: 0 };
    const velocity = ballisticVelocity(origin, target, MORTAR_SHELL_SPEED, GRAVITY, 'high');
    assert.ok(velocity, `a ${range}m shot is solvable`);
    const arc = shellArc(origin, velocity, {
      gravity: GRAVITY, step: 0.05, maxTime: 12, groundAt: () => 10,
    });
    const miss = Math.hypot(arc.impact.x - target.x, arc.impact.z - target.z);
    assert.ok(miss < 1.5, `landed ${miss.toFixed(2)}m from a ${range}m target`);
  }
});

test('the mortar can reach its full range band and refuses the impossible', () => {
  assert.ok(ballisticRange(MORTAR_SHELL_SPEED, GRAVITY) >= 120, 'max range 120m is reachable');
  assert.equal(
    ballisticVelocity({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, MORTAR_SHELL_SPEED, GRAVITY),
    null,
    'no horizontal distance has no solution',
  );
  assert.equal(
    ballisticVelocity({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 }, MORTAR_SHELL_SPEED, GRAVITY),
    null,
    'a point past the muzzle speed is unreachable',
  );
});

test('the high arc clears cover and the low arc stays flat', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const target = { x: 50, y: 0, z: 0 };
  const high = ballisticVelocity(origin, target, MORTAR_SHELL_SPEED, GRAVITY, 'high');
  const low = ballisticVelocity(origin, target, CANNON_SHELL_SPEED, GRAVITY, 'low');
  assert.ok(high.y > 20, 'the mortar launches steeply');
  assert.ok(low.y < 6, 'the cannon round is nearly flat');

  const highPeak = Math.max(...shellArc(origin, high, { gravity: GRAVITY, step: 0.05, maxTime: 12 }).points.map((p) => p.y));
  const lowPeak = Math.max(...shellArc(origin, low, { gravity: GRAVITY, step: 0.05, maxTime: 12 }).points.map((p) => p.y));
  assert.ok(highPeak > lowPeak, 'the mortar arc peaks higher');
});

test('one blast damages a directly hit build exactly once at full power', () => {
  // The build sits at the impact height (its 0.6m body offset included), so the
  // centre of the blast is a direct hit at distance zero.
  const impact = { x: 4, y: 10.6, z: 0 };
  const builds = [
    { id: 'struck', team: 'red', position: { x: 4, y: 10, z: 0 } },
    { id: 'near', team: 'red', position: { x: 7, y: 10, z: 0 } },
    { id: 'friendly', team: 'blue', position: { x: 4, y: 10, z: 0 } },
    { id: 'far', team: 'red', position: { x: 30, y: 10, z: 0 } },
  ];

  const hits = blastBuildHits('blue', impact, CANNON_BLAST_RADIUS, CANNON_BLAST_DAMAGE, builds);
  const struck = hits.filter((hit) => hit.build.id === 'struck');
  assert.equal(struck.length, 1, 'the struck build appears exactly once: no second direct-hit pass');
  assert.equal(struck[0].damage, CANNON_BLAST_DAMAGE, 'it takes one full blast, not double');

  assert.equal(hits.filter((hit) => hit.build.id === 'friendly').length, 0, 'friendly builds are spared');
  assert.equal(hits.filter((hit) => hit.build.id === 'far').length, 0, 'builds outside the radius are spared');
  const near = hits.find((hit) => hit.build.id === 'near');
  assert.ok(near && near.damage > 0 && near.damage < CANNON_BLAST_DAMAGE, 'splash falls off with distance');
});

test('a shot lands earlier when the ground is raised', () => {
  const origin = { x: 0, y: 20, z: 0 };
  const target = { x: 40, y: 20, z: 0 };
  const velocity = ballisticVelocity(origin, target, MORTAR_SHELL_SPEED, GRAVITY, 'high');
  const flat = shellArc(origin, velocity, { gravity: GRAVITY, step: 0.05, maxTime: 12, groundAt: () => 0 });
  const hill = shellArc(origin, velocity, { gravity: GRAVITY, step: 0.05, maxTime: 12, groundAt: () => 18 });
  assert.ok(hill.impact.x < flat.impact.x, 'terrain in the way stops the shell sooner');
  assert.ok(hill.points.length < flat.points.length);
});
