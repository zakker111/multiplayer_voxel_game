// Spotting-post HUD coverage: ground distance, view-relative bearing, and
// picking this team's single post out of the emplacement list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { spotPostCoverage } = require('../dist/tests/spotting.cjs');

const at = (x, y, z) => ({ x, y, z });
const post = (team, x, z, kind = 'spottingPost', y = 8.5) => ({ kind, team, position: at(x, y, z) });
/** Looking toward -z; +x is then the player's right. */
const FORWARD = { x: 0, z: -1 };

test('coverage uses ground distance and view-relative bearing', () => {
  const coverage = spotPostCoverage(
    [post('blue', 13, -24, 'spottingPost', 999)],
    'blue',
    at(10, 6.5, -20),
    FORWARD,
  );
  assert.ok(coverage);
  assert.equal(coverage.distance, 5, 'height is ignored (3-4-5 ground triangle)');
  assert.equal(coverage.bearing, 37, 'post is ahead and to the right');
});

test('bearing is 0 ahead, +90 right, -90 left and 180 behind', () => {
  const bearingTo = (x, z) => spotPostCoverage(
    [post('blue', x, z)],
    'blue',
    at(0, 6.5, 0),
    FORWARD,
  ).bearing;
  assert.equal(bearingTo(0, -10), 0);
  assert.equal(bearingTo(10, 0), 90);
  assert.equal(bearingTo(-10, 0), -90);
  assert.equal(bearingTo(0, 10), 180);
});

test('only the first own spotting post is used; enemies and other builds are ignored', () => {
  const posts = [
    post('red', 0, -5),
    post('blue', 0, -5, 'mgNest'),
    post('blue', 30, 0),
    post('blue', 60, 0),
  ];
  const coverage = spotPostCoverage(posts, 'blue', at(0, 6.5, 0), FORWARD);
  assert.deepEqual(coverage, { distance: 30, bearing: 90 });

  assert.equal(
    spotPostCoverage([post('red', 0, -5), post('blue', 10, 0, 'mgNest')], 'blue', at(0, 6.5, 0), FORWARD),
    null,
    'no own spotting post means no HUD coverage',
  );
});

test('a wrecked spotting post no longer gives HUD coverage', () => {
  const wrecked = { ...post('blue', 30, 0), wreck: true };
  assert.equal(
    spotPostCoverage([wrecked], 'blue', at(0, 6.5, 0), FORWARD),
    null,
    'a smoking post spots nothing',
  );
  assert.deepEqual(
    spotPostCoverage([wrecked, post('blue', 10, 0)], 'blue', at(0, 6.5, 0), FORWARD),
    { distance: 10, bearing: 90 },
    'a live replacement still provides coverage',
  );
});
