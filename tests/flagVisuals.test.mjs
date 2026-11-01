// Flag visual regression test (run: node --test tests/*.test.mjs)
//
// The bases used to render TWO flag posts: `addTeamFlag()` added a permanent
// static pole + banner, and `createFlagObject()` added the real animated flag
// (cloth wave + pulsing beacon) on top of it. The static copy never moved or
// disappeared when the flag was taken, so the base showed a static and an
// animated flag at once.
//
// This is a source-level guard in the same spirit as the weapon-balance test:
// the scene must build each base flag exactly once, through createFlagObject().
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const CLIENT_SRC = new URL('../src/game/game.ts', import.meta.url);
const source = readFileSync(CLIENT_SRC, 'utf8');

test('the base flag is only built by createFlagObject (no static duplicate)', () => {
  assert.ok(
    !source.includes('addTeamFlag'),
    'static flag decorator must stay deleted: it rendered a second, non-animated pole/banner',
  );
  // The static pole used a 4m, 6-segment cylinder; the animated flag uses the
  // taller 8-segment pole inside createFlagObject().
  assert.ok(
    !source.includes('CylinderGeometry(0.05, 0.05, 4, 6)'),
    'found the old static flagpole geometry — a duplicate flag post is back',
  );
});

test('the single flag object still owns the pole, cloth and animation', () => {
  const start = source.indexOf('private createFlagObject(');
  assert.ok(start > -1, 'createFlagObject must exist');
  const body = source.slice(start, start + 4000);

  assert.ok(body.includes('Flagpole') || body.includes('poleGeo'), 'flag group must include its pole');
  assert.ok(body.includes('clothMesh: cloth'), 'flag object must expose the cloth mesh');
  assert.ok(
    source.includes('clothMesh.rotation.y = Math.sin'),
    'cloth wave animation must remain wired up',
  );
  assert.ok(
    source.includes('flag.light.intensity = 2 + Math.sin'),
    'flag beacon pulse must remain wired up',
  );
});
