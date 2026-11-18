// Transport limits (run: node --test tests/*.test.mjs)
//
// The WebSocket path registers a player per socket and feeds every frame into
// the 20Hz loop, so it needs the same bounds the SSE fallback already has: a
// connection cap (global and per IP) and a per-socket message budget.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TokenBucket, ConnectionLimiter } = require('../dist/tests/limits.cjs');

test('a burst is allowed, then the sustained rate applies', () => {
  const bucket = new TokenBucket(10, 5, 0); // 10/s, burst 5
  for (let i = 0; i < 5; i++) assert.ok(bucket.tryConsume(0), `burst frame ${i}`);
  assert.strictEqual(bucket.tryConsume(0), false, 'burst exhausted within the same instant');
  assert.ok(bucket.tryConsume(100), 'one token is back after 100ms at 10/s');
});

test('sustained spam is capped to the rate', () => {
  const bucket = new TokenBucket(20, 30, 0);
  let allowed = 0;
  for (let ms = 0; ms < 1000; ms++) if (bucket.tryConsume(ms)) allowed++;

  assert.ok(allowed <= 30 + 20, `allowed ${allowed} of 1000 frames in one second`);
  assert.ok(allowed >= 25, `a normal 20Hz client must still fit (got ${allowed})`);
});

test('idle time never banks more than the burst', () => {
  const bucket = new TokenBucket(10, 5, 0);
  bucket.tryConsume(0);

  let allowed = 0;
  for (let i = 0; i < 100; i++) if (bucket.tryConsume(60_000)) allowed++;

  assert.strictEqual(allowed, 5, 'a long idle refills only up to the burst');
});

test('each socket gets its own budget', () => {
  const noisy = new TokenBucket(10, 2, 0);
  const quiet = new TokenBucket(10, 2, 0);

  noisy.tryConsume(0);
  noisy.tryConsume(0);
  assert.strictEqual(noisy.tryConsume(0), false);

  assert.ok(quiet.tryConsume(0), 'one client exhausting its budget must not affect another');
});

test('per-IP cap refuses the extra connection', () => {
  const limiter = new ConnectionLimiter(10, 2);
  assert.ok(limiter.tryAdd('1.1.1.1'));
  assert.ok(limiter.tryAdd('1.1.1.1'));

  assert.strictEqual(limiter.canAccept('1.1.1.1'), false, 'third socket from the same IP is refused');
  assert.ok(limiter.canAccept('2.2.2.2'), 'other clients are unaffected');
});

test('the global cap applies across IPs', () => {
  const limiter = new ConnectionLimiter(3, 10);
  assert.ok(limiter.tryAdd('a'));
  assert.ok(limiter.tryAdd('b'));
  assert.ok(limiter.tryAdd('c'));

  assert.strictEqual(limiter.canAccept('d'), false, 'global ceiling reached');
  limiter.remove('b');
  assert.ok(limiter.canAccept('d'), 'a freed slot is reusable');
});

test('a refused connection never takes a slot', () => {
  const limiter = new ConnectionLimiter(1, 1);
  assert.ok(limiter.tryAdd('a'));

  assert.strictEqual(limiter.tryAdd('b'), false, 'global cap is full');
  assert.strictEqual(limiter.total, 1, 'the refusal did not count');
  assert.strictEqual(limiter.countFor('b'), 0);

  limiter.remove('a');
  assert.ok(limiter.tryAdd('b'), 'the freed slot goes to the next client');
});

test('upgrades racing for the last slots cannot overshoot the cap', () => {
  const limiter = new ConnectionLimiter(2, 10);
  let accepted = 0;
  for (const ip of ['a', 'b', 'c', 'd', 'e']) if (limiter.tryAdd(ip)) accepted++;

  assert.strictEqual(accepted, 2);
  assert.strictEqual(limiter.total, 2, 'total matches the cap exactly');
});

test('releasing an unknown key is a no-op', () => {
  const limiter = new ConnectionLimiter(5, 2);
  limiter.remove('ghost');

  assert.strictEqual(limiter.total, 0);
  assert.strictEqual(limiter.countFor('ghost'), 0);
});

test('a closed connection frees exactly one slot', () => {
  const limiter = new ConnectionLimiter(5, 2);
  assert.ok(limiter.tryAdd('ip'));
  assert.ok(limiter.tryAdd('ip'));

  limiter.remove('ip');
  assert.strictEqual(limiter.countFor('ip'), 1);
  assert.strictEqual(limiter.total, 1);
  assert.ok(limiter.canAccept('ip'), 'the IP may reconnect');

  limiter.remove('ip');
  limiter.remove('ip'); // double release after close+error must not go negative
  assert.strictEqual(limiter.total, 0);
});
