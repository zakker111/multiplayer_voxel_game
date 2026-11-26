// Cannon and mortar shells (Phase 4): server-stepped projectiles with travel
// time, terrain collisions, splash damage and the gun rules around them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { ServerBot } = require('../dist/tests/serverBot.cjs');
const {
  emplacementSpec, EMPLACEMENT_SHELL_GRAVITY, CANNON_BLAST_RADIUS, CANNON_BLAST_DAMAGE,
  MORTAR_BLAST_RADIUS, MANNED_EMPLACEMENTS, EMPLACEMENT_MG_SPREAD, emplacedShotDirection,
  WEAPONS, vehicleSpec, VOXEL_STONE, VOXEL_SHOT_DAMAGE, VOXEL_MAX_DURABILITY,
} = require('../dist/tests/sharedTypes.cjs');
const {
  shellArc, shellStopsAt, CANNON_SHELL_SPEED, MORTAR_DISPERSION, SHELL_IMPACT_SAMPLE,
} = require('../dist/tests/ballistics.cjs');
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

/** Small seeded PRNG (mulberry32). The long-range burst test swaps this in for
 *  Math.random so the belt's cone is the same every run and can never flake. */
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// A lane is only counted as open when every ray the burst itself can take is
// clear: the server starts a nest round 0.9 m ahead at 1.15 m, while the Beta
// client starts it at the barrel marker (2.08 m ahead, 1.23 m up), so both
// origins are checked. Each origin is checked at torso and head height and at
// both edges of the spread cone, and a terrain hit anywhere before the sample
// point blocks the lane. The old check looked only along the centre line and
// forgave a hit up to 0.6 m short of the target, so it counted lanes as clear
// while the cone was eating a bank a few metres in front of the target.
const LANE_CLEARANCE = 0.05;
const LANE_ORIGINS = [{ forward: 0.9, up: 1.15 }, { forward: 2.08, up: 1.23 }];
const laneOpen = (game, spot, target, yaw, range) => {
  const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const side = { x: -dir.z, z: dir.x };
  const edge = Math.tan(EMPLACEMENT_MG_SPREAD) * range;
  const samples = [
    { x: target.x, y: target.y + 1.0, z: target.z },
    { x: target.x, y: target.y + 1.55, z: target.z },
    { x: target.x + side.x * edge, y: target.y + 1.0, z: target.z + side.z * edge },
    { x: target.x - side.x * edge, y: target.y + 1.0, z: target.z - side.z * edge },
  ];
  for (const origin of LANE_ORIGINS) {
    const from = { x: spot.x + dir.x * origin.forward, y: spot.y + origin.up, z: spot.z + dir.z * origin.forward };
    for (const to of samples) {
      const vx = to.x - from.x, vy = to.y - from.y, vz = to.z - from.z;
      const len = Math.hypot(vx, vy, vz);
      const hit = game.world.raycast(from, { x: vx / len, y: vy / len, z: vz / len }, len + 1);
      if (hit && hit.distance < len - LANE_CLEARANCE) return false;
    }
  }
  return true;
};

/** A flat nest spot with a genuinely open lane to a flat target `range` metres
 *  away, so a long-range test measures the cone and not the terrain. */
const findLongLane = (game, range) => {
  for (let z = -80; z <= 80; z += 4) {
    for (let x = -80; x <= 80; x += 4) {
      if (!isFlat(game, x, z)) continue;
      const y = groundTop(game, x, z);
      for (let i = 0; i < 32; i++) {
        const yaw = (i / 32) * Math.PI * 2;
        const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
        const tx = x + dir.x * range;
        const tz = z + dir.z * range;
        if (!isFlat(game, tx, tz)) continue;
        const ty = groundTop(game, tx, tz);
        if (ty === null || Math.abs(ty - y) > 1.5) continue;
        if (!laneOpen(game, { x, y, z }, { x: tx, y: ty, z: tz }, yaw, range)) continue;
        return { x, y, z, yaw, target: { x: tx, y: ty, z: tz } };
      }
    }
  }
  return null;
};

const join = (game, team, frames = []) => {
  const id = game.addPlayer({ send: (data) => frames.push(JSON.parse(data)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  const workshop = game.getWorkshops()[team].position;
  player.position = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  return { id, player, frames };
};

/** Craft, place and man a gun of `kind`, returning it and the gunner. */
const manGun = (game, kind, team = 'blue') => {
  const frames = [];
  const gunner = join(game, team, frames);
  const [spot] = findSpots(game, 1);
  game.workshopStock[team] = 400;
  game.handleMessage(gunner.id, { type: 'craftBlueprint', kind, slot: 0 });
  game.handleMessage(gunner.id, { type: 'placeEmplacement', kind, position: spot, yaw: 0, slot: 0 });
  const gun = [...game.emplacements.values()][0];
  assert.ok(gun, `the ${kind} was placed`);
  gunner.player.position = { ...gun.position };
  game.handleMessage(gunner.id, { type: 'mountEmplacement', emplacementId: gun.id });
  assert.equal(gun.gunnerId, gunner.id, `the ${kind} is manned`);
  return { gun, gunner, frames };
};

/** Advance the server simulation for `seconds` at a fixed 20Hz tick. */
const run = (game, seconds) => {
  const step = 1 / 20;
  for (let t = 0; t < seconds; t += step) game.update(step);
};

test('the armed builds all carry a fire interval, the support builds none', () => {
  for (const kind of ['mgNest', 'cannon', 'mortar']) {
    assert.ok(emplacementSpec(kind).fireInterval > 0, `${kind} has a cadence`);
    assert.ok(MANNED_EMPLACEMENTS.includes(kind), `${kind} can be manned`);
  }
  for (const kind of ['supplyCrate', 'spottingPost']) {
    assert.equal(emplacementSpec(kind).fireInterval, 0, `${kind} never fires`);
    assert.equal(MANNED_EMPLACEMENTS.includes(kind), false, `${kind} is not a seat`);
  }
  assert.ok(emplacementSpec('cannon').fireInterval > emplacementSpec('mgNest').fireInterval, 'a cannon reloads slower than a belt feeds');
});

test('firing a cannon puts a shell in the air instead of a hitscan', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const startAmmo = gun.ammo;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  assert.equal(gun.ammo, startAmmo - 1, 'the shell left the barrel');
  const shells = [...game.shells.values()];
  assert.equal(shells.length, 1, 'one shell is in flight');
  assert.equal(shells[0].kind, 'cannon');
  assert.ok(shells[0].velocity.z < 0, 'yaw 0 fires down -z, like the rest of the game');
  assert.ok(Math.abs(shells[0].velocity.y) < 5, 'a cannon round is flat');
  assert.equal(gun.ammo, startAmmo - 1, 'the round cost ammo exactly once');
  assert.ok(gunner.frames.some((f) => f.type === 'shellFired'), 'clients are told a shell is up');
});

test('a shell flies for a while, falls under gravity and detonates on terrain', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const startY = gun.position.y;
  // Elevate the barrel so the round clears the flat pad it was built on.
  game.handleMessage(gunner.id, {
    type: 'playerInput',
    input: { moveX: 0, moveZ: 0, jump: false, crouch: false, sprint: false, yaw: 0, pitch: 0.3 },
  });
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  const shell = [...game.shells.values()][0];
  const firedVelocityY = shell.velocity.y;
  assert.ok(firedVelocityY > 10, 'the gunner can elevate a cannon round');

  run(game, 0.25); // five ticks

  assert.equal(game.shells.size, 1, 'still in the air after a quarter second');
  assert.ok(shell.position.z < gun.position.z - 5, 'it travelled away from the gun');
  assert.ok(shell.velocity.y < firedVelocityY - EMPLACEMENT_SHELL_GRAVITY * 0.2, 'gravity pulled it down');

  run(game, 5);

  assert.equal(game.shells.size, 0, 'the round came down');
  const impacts = gunner.frames.filter((f) => f.type === 'shellImpact');
  assert.ok(impacts.length >= 1, 'clients get the impact');
  assert.equal(impacts[0].kind, 'cannon');
  assert.equal(impacts[0].radius, CANNON_BLAST_RADIUS);
  assert.ok(gun.position.y >= startY - 1, 'the gun itself did not move');
});

test('the blast hurts enemies by distance and leaves teammates alone', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const near = join(game, 'red');
  const far = join(game, 'red');
  const mate = join(game, 'blue');
  game.spawnProtectedUntil.delete(near.id);
  game.spawnProtectedUntil.delete(far.id);
  game.spawnProtectedUntil.delete(mate.id);
  const nest = { x: gun.position.x, y: gun.position.y + 1, z: gun.position.z - 6 };
  near.player.position = { x: nest.x, y: nest.y - 1, z: nest.z };
  far.player.position = { x: nest.x + CANNON_BLAST_RADIUS - 0.5, y: nest.y - 1, z: nest.z };
  mate.player.position = { x: nest.x + 0.5, y: nest.y - 1, z: nest.z };

  const nearHp = near.player.hp;
  const farHp = far.player.hp;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  const shell = [...game.shells.values()][0];
  game.explodeShell(shell, nest);

  assert.ok(near.player.hp < nearHp, 'the enemy at the centre is hit');
  assert.ok(far.player.hp < farHp, 'the enemy at the edge is hit too');
  assert.ok(near.player.hp < far.player.hp, 'but the centre hurts more than the edge');
  assert.equal(mate.player.hp, 100, 'a teammate is never caught by a friendly shell');
  assert.ok(CANNON_BLAST_DAMAGE > 0);
});

test('a shell removes the terrain it lands on and tells clients', () => {
  const game = new ServerGame();
  const frames = [];
  const { gun, gunner } = manGun(game, 'cannon', 'blue');
  join(game, 'red', frames);

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  run(game, 3);

  const voxels = frames.filter((f) => f.type === 'voxelChanged' && f.change.type === 0);
  assert.ok(voxels.length > 0, 'the crater reached the clients');
});

test('the mortar lobs on a high arc, slower than the cannon', () => {
  const game = new ServerGame();
  const { gunner } = manGun(game, 'mortar');

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  const shell = [...game.shells.values()][0];
  assert.equal(shell.kind, 'mortar');
  assert.ok(shell.velocity.y > 20, 'it goes up');
  assert.ok(Math.hypot(shell.velocity.x, shell.velocity.z) < 40, 'and forward slower than a cannon round');

  const climb = shell.position.y;
  run(game, 0.5);
  assert.ok(shell.position.y > climb, 'the round is still rising');
  assert.equal(MORTAR_BLAST_RADIUS > CANNON_BLAST_RADIUS, true, 'the mortar splashes wider');
});

test('a mortar round lands where the gunner aimed, not in a fixed band', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mortar');
  const enemy = join(game, 'red');
  game.spawnProtectedUntil.delete(enemy.id);

  // 70m down-range, on the same shelf as the gun.
  const target = { x: gun.position.x + 70, y: gun.position.y, z: gun.position.z };
  target.y = groundTop(game, target.x, target.z) ?? target.y;
  enemy.player.position = { ...target };

  gunner.frames.length = 0;
  game.handleMessage(gunner.id, { type: 'fireEmplacement', target });
  assert.equal(game.shells.size, 1, 'the round is in the air');

  // The mortar turns to face the point it is firing at: no spinning needed.
  const facing = Math.atan2(-(target.x - gun.position.x), -(target.z - gun.position.z));
  const yawError = Math.atan2(Math.sin(gun.yaw - facing), Math.cos(gun.yaw - facing));
  assert.ok(Math.abs(yawError) < 0.02, `the mortar faces its target (off by ${yawError.toFixed(3)} rad)`);

  run(game, 8);

  const impacts = gunner.frames.filter((f) => f.type === 'shellImpact');
  assert.ok(impacts.length >= 1, 'the round came down');
  const miss = Math.hypot(impacts[0].position.x - target.x, impacts[0].position.z - target.z);
  // The scattered point is inside MORTAR_DISPERSION, but the burst is the first
  // ground sample along the flight path (one SHELL_IMPACT_SAMPLE step), so a
  // round aimed at the edge of the ring can land one sample beyond it.
  assert.ok(miss <= MORTAR_DISPERSION + SHELL_IMPACT_SAMPLE + 1e-6,
    `landed ${miss.toFixed(2)}m from the marked point`);
  assert.ok(enemy.player.hp < 100, 'the enemy standing on the mark was caught by the splash');
  assert.equal(
    gunner.frames.some((f) => f.type === 'emplacementMessage' && /too close/i.test(f.message)),
    false,
    'a shot inside the range band is never refused',
  );
});

test('a mortar refuses a point closer than its minimum range', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mortar');
  const startAmmo = gun.ammo;

  game.handleMessage(gunner.id, {
    type: 'fireEmplacement',
    target: { x: gun.position.x + 2, y: gun.position.y, z: gun.position.z },
  });

  assert.equal(gun.ammo, startAmmo, 'a refused shot costs no round');
  assert.equal(game.shells.size, 0, 'and fires nothing');
  assert.ok(
    gunner.frames.some((f) => f.type === 'emplacementMessage' && /too close/i.test(f.message)),
    'the gunner is told why',
  );
});

test('a mortar shell wrecks a workshop-built jeep', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mortar', 'blue');
  const red = join(game, 'red');
  game.workshopStock.red = 200;
  const workshop = game.getWorkshops().red.position;
  red.player.position = { x: workshop.x, y: workshop.y, z: workshop.z };
  game.handleMessage(red.id, { type: 'buildJeep' });
  const jeep = [...game.jeeps.values()][0];
  assert.ok(jeep, 'the jeep was built');

  // Park it in the mortar's range band and shell it until it burns.
  jeep.position = { x: gun.position.x + 40, y: gun.position.y, z: gun.position.z };
  for (let shot = 0; shot < 5 && !jeep.wreck; shot++) {
    if (shot > 0) game.world.updateTime(emplacementSpec('mortar').fireInterval + 0.1);
    game.handleMessage(gunner.id, { type: 'fireEmplacement', target: { ...jeep.position } });
    run(game, 8);
  }

  assert.ok(jeep.wreck, 'sustained mortar fire destroys a workshop vehicle');
  assert.ok(
    red.frames.some((f) => f.type === 'jeepsUpdated' && f.jeeps.some((j) => j.id === jeep.id && j.wreck)),
    'clients are told the jeep is a wreck',
  );
});

test('a cannon cannot fire twice inside its reload', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  const startAmmo = gun.ammo;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  assert.equal(gun.ammo, startAmmo - 1, 'the reload holds the second round');

  game.world.updateTime(emplacementSpec('cannon').fireInterval + 0.1);
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  assert.equal(gun.ammo, startAmmo - 2, 'and lets it go once the reload is done');
});

test('an empty cannon stays silent', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'cannon');
  gun.ammo = 1;

  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  game.world.updateTime(5);
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  assert.equal(gun.ammo, 0, 'ammo never goes negative');
  assert.ok(
    gunner.frames.some((f) => f.type === 'emplacementMessage' && /out of rounds/i.test(f.message)),
    'the gunner hears the click',
  );
});

test('the MG nest cone stays centred on the aim and is actually used', () => {
  assert.ok(EMPLACEMENT_MG_SPREAD > 0, 'a belt-fed nest has a spread cone');
  const aim = emplacedShotDirection(0, 0, 0);
  assert.ok(Math.abs(aim.x) < 1e-9 && Math.abs(aim.y) < 1e-9 && aim.z < -0.99, 'yaw 0 fires down -z');

  let widest = 0;
  for (let i = 0; i < 200; i++) {
    const direction = emplacedShotDirection(0, 0);
    assert.ok(Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) < 1e-9, 'directions stay unit length');
    // Each axis offset is at most `spread`, so the cone's edge is < 1.5x it.
    widest = Math.max(widest, Math.acos(Math.min(1, -direction.z)));
  }
  assert.ok(widest > EMPLACEMENT_MG_SPREAD * 0.5, 'rounds walk off the aim line');
  assert.ok(widest < EMPLACEMENT_MG_SPREAD * 1.5, 'but never leave the cone');
});

test('a held MG nest trigger fans its rounds instead of drilling one line', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mgNest');
  const observer = join(game, 'red');
  gunner.frames.length = 0;
  assert.ok(gun.ammo >= 20, 'the belt has rounds to spare');

  for (let i = 0; i < 20; i++) {
    game.handleMessage(gunner.id, { type: 'fireEmplacement' });
    game.world.updateTime(0.1); // clear the nest's fire interval
  }

  const shots = observer.frames.filter((frame) => frame.type === 'playerShot' && frame.weapon === 'mgNest');
  assert.equal(shots.length, 20, 'the observer saw every round');
  const lanes = new Set(shots.map((shot) => shot.direction.x.toFixed(3)));
  assert.ok(lanes.size > 5, 'the burst covers several lanes');
  for (const shot of shots) {
    assert.ok(Math.acos(Math.min(1, -shot.direction.z)) < EMPLACEMENT_MG_SPREAD * 1.5, 'every round is inside the cone');
  }
});

test('an 88m burst still kills a 130 HP bot inside the 200-round belt', () => {
  const game = new ServerGame();
  const lane = findLongLane(game, 88);
  assert.ok(lane, 'the map has an 88m lane between flat spots');

  const frames = [];
  const gunner = join(game, 'blue', frames);
  game.workshopStock.blue = 400;
  game.handleMessage(gunner.id, { type: 'craftBlueprint', kind: 'mgNest', slot: 0 });
  game.handleMessage(gunner.id, {
    type: 'placeEmplacement', kind: 'mgNest', position: { x: lane.x, y: lane.y, z: lane.z }, yaw: lane.yaw, slot: 0,
  });
  const gun = [...game.emplacements.values()][0];
  assert.ok(gun, 'the nest was placed on the lane');
  gunner.player.position = { ...gun.position };
  game.handleMessage(gunner.id, { type: 'mountEmplacement', emplacementId: gun.id });
  assert.equal(gun.gunnerId, gunner.id, 'the nest is manned');

  // Server bots carry 130 HP, so this is the target a gunner actually faces.
  const target = join(game, 'red');
  target.player.maxHp = 130;
  target.player.hp = 130;
  game.spawnProtectedUntil.delete(target.id);
  game.spawnProtectedUntil.delete(gunner.id);

  const belt = emplacementSpec('mgNest').ammo;
  assert.equal(belt, 200, 'a nest belt holds 200 rounds');
  assert.ok(
    EMPLACEMENT_MG_SPREAD > WEAPONS.rifle.spread * 5,
    'the belt still sprays much wider than a rifle',
  );

  gun.yaw = lane.yaw;
  gun.baseYaw = lane.yaw;
  gunner.player.rotation = {
    yaw: lane.yaw,
    pitch: Math.atan2(lane.target.y + 1.0 - (gun.position.y + 1.15), 88),
  };

  // Several seeded bursts: the same cone every run, sampled widely enough to
  // catch a cone that has grown back out to a whole-belt spray.
  const originalRandom = Math.random;
  const bursts = [];
  try {
    for (let burst = 0; burst < 8; burst++) {
      target.player.position = { ...lane.target };
      target.player.maxHp = 130;
      target.player.hp = 130;
      target.player.isDead = false;
      game.spawnProtectedUntil.delete(target.id);
      game.respawnTimers.delete(target.id);
      gun.ammo = belt;
      game.emplacementFireAt.clear();
      Math.random = mulberry32(0x5eed88 + burst * 7919);
      let fired = 0;
      while (!target.player.isDead && fired < belt) {
        game.handleMessage(gunner.id, { type: 'fireEmplacement' });
        fired++;
        game.world.updateTime(0.1);
      }
      bursts.push({ fired, killed: target.player.isDead });
    }
  } finally {
    Math.random = originalRandom;
  }

  for (const burst of bursts) {
    assert.ok(burst.killed, `the burst killed inside the belt (${burst.fired}/200 rounds)`);
  }
  const rounds = bursts.map((burst) => burst.fired).sort((a, b) => a - b);
  const median = rounds[Math.floor(rounds.length / 2)];
  assert.ok(median <= 50, `the cone still lands: median ${median} of ${belt} rounds`);
});

test('a round reset takes the shells with it', () => {
  const game = new ServerGame();
  const { gunner } = manGun(game, 'mortar');
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  assert.equal(game.shells.size, 1);

  game.startNextRound();

  assert.equal(game.shells.size, 0, 'no shells outlive the round');
  assert.equal(game.emplacements.size, 0);
});

test('the cannon preview ring bursts on the jeep it draws the arc through', () => {
  const game = new ServerGame();

  // A cannon round is flat, so the lane has to be level far enough for the
  // shell to reach a jeep: find one by flying the preview itself, not by
  // trusting a torso-height ray.
  const previewFrom = (spot, yaw) => {
    const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const origin = { x: spot.x + forward.x * 1.6, y: spot.y + 1.2, z: spot.z + forward.z * 1.6 };
    const velocity = { x: forward.x * CANNON_SHELL_SPEED, y: 0, z: forward.z * CANNON_SHELL_SPEED };
    return shellArc(origin, velocity, {
      gravity: EMPLACEMENT_SHELL_GRAVITY,
      step: 0.025,
      maxTime: 3,
      groundAt: (x, z) => game.world.getGroundHeight(x, z),
      solidAt: (point) => game.world.isSolid(Math.round(point.x), Math.round(point.y), Math.round(point.z)),
    });
  };
  let lane = null;
  for (const spot of findSpots(game, 60)) {
    for (let i = 0; i < 16 && !lane; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      const arc = previewFrom(spot, yaw);
      const reach = Math.hypot(arc.impact.x - spot.x, arc.impact.z - spot.z);
      if (reach > 18) lane = { spot, yaw };
    }
    if (lane) break;
  }
  assert.ok(lane, 'the map has a level lane long enough for a cannon round');

  // Cannon on the lane, aimed down it, with a red jeep parked on the firing line.
  const frames = [];
  const gunner = join(game, 'blue', frames);
  game.workshopStock.blue = 400;
  game.handleMessage(gunner.id, { type: 'craftBlueprint', kind: 'cannon', slot: 0 });
  game.handleMessage(gunner.id, {
    type: 'placeEmplacement',
    kind: 'cannon',
    position: { x: lane.spot.x, y: lane.spot.y, z: lane.spot.z },
    yaw: lane.yaw,
    slot: 0,
  });
  const gun = [...game.emplacements.values()][0];
  assert.ok(gun, 'the cannon was placed');
  gunner.player.position = { ...gun.position };
  gunner.player.rotation.pitch = 0;
  game.handleMessage(gunner.id, { type: 'mountEmplacement', emplacementId: gun.id });
  assert.equal(gun.gunnerId, gunner.id, 'the cannon is manned');

  const red = join(game, 'red');
  game.workshopStock.red = 200;
  const workshop = game.getWorkshops().red.position;
  red.player.position = { x: workshop.x, y: workshop.y, z: workshop.z };
  game.handleMessage(red.id, { type: 'buildJeep' });
  const jeep = [...game.jeeps.values()][0];
  assert.ok(jeep, 'the jeep was built');
  const forward = { x: -Math.sin(gun.yaw), z: -Math.cos(gun.yaw) };
  jeep.position = { x: gun.position.x + forward.x * 12, y: gun.position.y, z: gun.position.z + forward.z * 12 };

  // Exactly what `updateShellPreview` draws for a cannon: muzzle 1.6 m ahead
  // and 1.2 m up, flat look, shared speed, gravity and stop rule.
  const origin = {
    x: gun.position.x + forward.x * 1.6,
    y: gun.position.y + 1.2,
    z: gun.position.z + forward.z * 1.6,
  };
  const velocity = { x: forward.x * CANNON_SHELL_SPEED, y: 0, z: forward.z * CANNON_SHELL_SPEED };
  const obstacles = [
    { kind: 'footprint', team: 'red', position: jeep.position, footprint: vehicleSpec('jeep') },
  ];
  const preview = shellArc(origin, velocity, {
    gravity: EMPLACEMENT_SHELL_GRAVITY,
    step: 0.025,
    maxTime: 10,
    groundAt: (x, z) => game.world.getGroundHeight(x, z),
    solidAt: (point) => game.world.isSolid(Math.round(point.x), Math.round(point.y), Math.round(point.z)),
    stopAt: (point) => shellStopsAt(point, 'blue', obstacles),
  });
  const ringToJeep = Math.hypot(preview.impact.x - jeep.position.x, preview.impact.z - jeep.position.z);
  assert.ok(ringToJeep < Math.hypot(1.3, 2) + 0.01, `the marker stops on the jeep (${ringToJeep.toFixed(2)}m)`);
  const last = preview.points[preview.points.length - 1];
  assert.ok(
    Math.hypot(last.x - preview.impact.x, last.y - preview.impact.y, last.z - preview.impact.z) < 1e-9,
    'the preview line ends at the cover it stops on, not through it',
  );

  gunner.frames.length = 0;
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });
  run(game, 2);
  const impact = gunner.frames.find((frame) => frame.type === 'shellImpact');
  assert.ok(impact, 'the round came down');
  const miss = Math.hypot(impact.position.x - preview.impact.x, impact.position.z - preview.impact.z);
  assert.ok(miss < 0.05, `the live round burst ${miss.toFixed(3)}m from the preview ring`);
});

test('the mortar aim snaps to the ground under the mark, not the gun level', () => {
  const game = new ServerGame();
  const { gun } = manGun(game, 'mortar');
  const tx = gun.position.x + 60;
  const tz = gun.position.z;
  const base = groundTop(game, tx, tz);
  assert.ok(base !== null, 'the mark starts on solid ground');

  // Raise a 9x9 pad six blocks tall on the mark: the round has to be solved
  // for the raised surface, not for the gun's own height. The pad is wider than
  // the mortar's dispersion so the scattered burst still lands on it.
  const baseVoxel = Math.floor(base);
  for (let ox = -4; ox <= 4; ox++) {
    for (let oz = -4; oz <= 4; oz++) {
      for (let h = 1; h <= 6; h++) {
        game.world.setVoxel(tx + ox, baseVoxel + h, tz + oz, VOXEL_STONE, 3);
      }
    }
  }
  const raised = game.world.getGroundHeight(tx, tz);
  assert.ok(raised > base + 5, 'the mark now sits on the raised pad');

  const solution = game.mortarAimPoint(gun, { x: tx, y: raised, z: tz });
  assert.ok('point' in solution, 'the shot is solvable');
  assert.equal(solution.point.y, raised, 'the aim uses the ground under the mark, not the gun height');
});

test('an MG nest chips the terrain it hits', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mgNest');
  const yaw = gun.yaw;
  const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const fromX = gun.position.x + dir.x * 0.9;
  const fromZ = gun.position.z + dir.z * 0.9;

  // A three-wide, three-high block wall a couple of metres down the lane. A
  // single round must break the block it strikes and tell clients about it.
  const wallX = Math.round(fromX + dir.x * 2.5);
  const wallZ = Math.round(fromZ + dir.z * 2.5);
  const baseY = Math.floor(gun.position.y + 1);
  const wall = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy < 3; dy++) {
        const x = wallX + dx, y = baseY + dy, z = wallZ + dz;
        // One round's worth of pool: this test is about a round carving exactly
        // the block it struck, not about how many rounds a full block takes.
        game.world.setVoxel(x, y, z, VOXEL_STONE, VOXEL_SHOT_DAMAGE);
        wall.push({ x, y, z });
      }
    }
  }

  gunner.frames.length = 0;
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  const holes = wall.filter((voxel) => !game.world.isSolid(voxel.x, voxel.y, voxel.z));
  assert.equal(holes.length, 1, 'one round removes exactly the block it hit');
  assert.ok(
    gunner.frames.some((f) => f.type === 'voxelChanged' && f.change.x === holes[0].x && f.change.y === holes[0].y && f.change.z === holes[0].z),
    'clients are told the block broke',
  );
});

test('an MG nest tells clients about chip damage before the block breaks', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mgNest');
  const dir = { x: -Math.sin(gun.yaw), z: -Math.cos(gun.yaw) };
  const fromX = gun.position.x + dir.x * 0.9;
  const fromZ = gun.position.z + dir.z * 0.9;
  const wallX = Math.round(fromX + dir.x * 2.5);
  const wallZ = Math.round(fromZ + dir.z * 2.5);
  const baseY = Math.floor(gun.position.y + 1);
  const wall = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy < 3; dy++) {
        const x = wallX + dx, y = baseY + dy, z = wallZ + dz;
        game.world.setVoxel(x, y, z, VOXEL_STONE, VOXEL_MAX_DURABILITY);
        wall.push({ x, y, z });
      }
    }
  }

  gunner.frames.length = 0;
  game.handleMessage(gunner.id, { type: 'fireEmplacement' });

  const chipped = wall.filter((v) => {
    const voxel = game.world.getVoxel(v.x, v.y, v.z);
    return voxel && voxel.durability < VOXEL_MAX_DURABILITY;
  });
  assert.equal(chipped.length, 1, 'one round chips exactly the block it hit');
  assert.ok(
    gunner.frames.some((f) => f.type === 'voxelChanged'
      && f.change.x === chipped[0].x && f.change.y === chipped[0].y && f.change.z === chipped[0].z
      && f.change.durability > 0 && f.change.durability < VOXEL_MAX_DURABILITY),
    'the chip reaches clients with its fractional durability',
  );
  assert.equal(game.world.isSolid(chipped[0].x, chipped[0].y, chipped[0].z), true, 'the block is still standing');
});

test('a mortar shell damages bots caught in the blast', () => {
  const game = new ServerGame();
  const { gun, gunner } = manGun(game, 'mortar', 'blue');
  const target = { x: gun.position.x + 60, y: 0, z: gun.position.z };
  target.y = groundTop(game, target.x, target.z);

  const bot = new ServerBot('blast-target', { ...target }, 'red', 'BlastBot');
  bot.botUpdate = () => {}; // hold still so the shell lands on the mark
  game.players.set(bot.id, bot);
  game.spawnProtectedUntil.delete(bot.id);
  const before = bot.hp;

  game.handleMessage(gunner.id, { type: 'fireEmplacement', target });
  run(game, 8);

  assert.ok(bot.hp < before, `the blast hurt the bot (${before} -> ${bot.hp})`);
});

test('a mortar scatters around the mark while a cannon fires exactly where aimed', () => {
  // Mortar: indirect fire is area fire, so repeated rounds at one mark walk
  // around it instead of drilling the centre tile.
  const mortarGame = new ServerGame();
  const { gun } = manGun(mortarGame, 'mortar');
  const target = { x: gun.position.x, y: gun.position.y, z: gun.position.z - 60 };

  const points = [];
  for (let i = 0; i < 40; i++) {
    const solution = mortarGame.mortarAimPoint(gun, target);
    assert.ok('point' in solution, 'the mortar can solve the mark');
    points.push(solution.point);
  }
  const misses = points.map((p) => Math.hypot(p.x - target.x, p.z - target.z));
  assert.ok(
    Math.max(...misses) <= MORTAR_DISPERSION + 1e-6,
    `every round stays inside the landing ring (${Math.max(...misses).toFixed(2)}m)`,
  );
  // A single round can land near the centre by chance (the scatter is a disc),
  // so check the pattern rather than the closest sample: a pinpoint gun would
  // average ~0 while a ring scatters about 2R/3 out.
  const meanMiss = misses.reduce((sum, miss) => sum + miss, 0) / misses.length;
  assert.ok(meanMiss > 1, `rounds scatter around the mark (mean ${meanMiss.toFixed(2)}m)`);
  assert.ok(
    new Set(points.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`)).size >= 30,
    'consecutive rounds land in different spots',
  );

  // Cannon: direct fire has no dispersion. The same aim and pitch give the
  // identical shot every time, so a good gunner puts rounds on the same spot.
  const cannonGame = new ServerGame();
  const cannon = manGun(cannonGame, 'cannon');
  const fire = () => cannonGame.fireShell(cannon.gun, cannon.gunner.player, cannon.gun.yaw, 0.15, null);
  fire();
  fire();
  const [first, second] = [...cannonGame.shells.values()];
  assert.deepEqual(first.velocity, second.velocity, 'identical cannon shots have identical velocity');
  assert.deepEqual(first.position, second.position, 'and leave from the same muzzle point');
  assert.ok(Math.abs(first.velocity.x) < 1e-9, 'the round leaves down the gun line, not off to a side');
  assert.ok(first.velocity.z < 0, 'yaw 0 fires down -z');
});

test('cannon and mortar blasts damage players, vehicles, structures and voxels', () => {
  for (const kind of ['cannon', 'mortar']) {
    const game = new ServerGame();
    const blue = join(game, 'blue');
    const red = join(game, 'red');
    game.spawnProtectedUntil.delete(red.id);
    blue.player.position = { x: -80, y: 9, z: -80 }; // clear of the blast

    // One of each target, all inside the burst: a body at the centre, a jeep
    // and a structure just off it, and a block exactly at the impact.
    const impact = { x: 10, y: 30, z: 10 };
    red.player.position = { x: 10, y: 29, z: 10 };

    const jeepSpec = vehicleSpec('jeep');
    const jeep = {
      id: 'blast-jeep', kind: 'jeep', team: 'red', position: { x: 11, y: 29, z: 10 }, yaw: 0,
      speed: 0, hp: jeepSpec.maxHp, driverId: null, passengerId: null, wreck: false,
      throttle: 0, steering: 0, brake: false, lastInput: 0, wreckUntil: 0,
    };
    game.jeeps.set(jeep.id, jeep);

    const nestSpec = emplacementSpec('mgNest');
    const structure = game.createEmplacement('red', nestSpec, { x: 12, y: 29, z: 10 }, 0);
    game.world.setVoxel(10, 30, 10, VOXEL_STONE, VOXEL_MAX_DURABILITY);

    const playerHp = red.player.hp;
    game.explodeShell({
      id: `blast-${kind}`, kind, team: 'blue', ownerId: blue.id,
      position: { ...impact }, velocity: { x: 0, y: 0, z: 1 }, firedAt: 0,
    }, impact);

    assert.ok(red.player.hp < playerHp || red.player.isDead, `${kind} hurts a player`);
    assert.ok(jeep.wreck || jeep.hp < jeepSpec.maxHp, `${kind} hurts a vehicle`);
    assert.ok(structure.hp < nestSpec.maxHp, `${kind} hurts a structure`);
    assert.equal(game.world.isSolid(10, 30, 10), false, `${kind} breaks a voxel`);
  }
});
