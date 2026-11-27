// Game-loop clock (run: node --test tests/*.test.mjs)
//
// The 20Hz loop used to advance one 50ms step per setInterval fire, so any tick
// that overran lost its missed time for good and the whole simulation ran in
// slow motion on a thin host. These cases pin the catch-up behaviour: steady
// ticks advance one step, a 3x-overrun tick advances three, and a long stall
// drops the backlog above the cap instead of bursting it inside one callback.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TickClock } = require('../dist/tests/tickClock.cjs');

test('a steady 20Hz loop advances one step per fire', () => {
  const clock = new TickClock(50, 10, 0);
  for (let i = 1; i <= 40; i++) {
    assert.strictEqual(clock.advance(i * 50).steps, 1, `fire ${i}`);
  }
});

test('a tick that overran 150ms catches up three steps instead of one', () => {
  const clock = new TickClock(50, 10, 0);
  // The old loop ran a single step here and lost 100ms of simulation time.
  assert.deepStrictEqual(clock.advance(150), { steps: 3, droppedSeconds: 0 });
  // Simulation now tracks the wall clock: 3 steps per 150ms fire is 20Hz.
  assert.deepStrictEqual(clock.advance(300), { steps: 3, droppedSeconds: 0 });
});

test('a long stall drops the backlog above the cap and reports it', () => {
  const clock = new TickClock(50, 10, 0);
  const { steps, droppedSeconds } = clock.advance(5000); // 100 steps due
  assert.strictEqual(steps, 10, 'capped at maxSteps inside one callback');
  assert.strictEqual(droppedSeconds, 4.5);
  assert.deepStrictEqual(clock.advance(5050), { steps: 1, droppedSeconds: 0 }, 'no lingering debt');
});

test('a fire that arrives early waits for the next whole step', () => {
  const clock = new TickClock(50, 10, 0);
  assert.strictEqual(clock.advance(45).steps, 0, '45ms is not a whole step');
  assert.strictEqual(clock.advance(55).steps, 1, 'the carried 5ms completes one');
});

test('a backwards clock jump does not rewind the simulation', () => {
  const clock = new TickClock(50, 10, 0);
  clock.advance(1000);
  assert.strictEqual(clock.advance(900).steps, 0, 'time going backwards runs nothing');
  assert.strictEqual(clock.advance(950).steps, 1, 'and the clock resumes normally');
});
