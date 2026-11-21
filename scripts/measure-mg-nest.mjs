// Measures the MG nest's real kill reliability across range with the live
// spread constant, using the server's actual hitscan/fire path.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.SERVER_BOT_COUNT = '0';

const { ServerGame } = require('../dist/tests/serverGame.cjs');
const { EMPLACEMENT_MG_SPREAD, emplacementSpec, SPAWN_PROTECTION_SECONDS } = require('../dist/tests/sharedTypes.cjs');

const RANGES = [30, 45, 60, 75, 88];
const TRIALS = Number(process.env.TRIALS || 60);
// Beta bots spawn at 130 HP (players have 100), so the bots are the harder case.
const TARGET_HP = Number(process.env.TARGET_HP || 130);

const join = (game, team, frames = []) => {
  const id = game.addPlayer({ send: (d) => frames.push(JSON.parse(d)), isOpen: () => true });
  game.handleMessage(id, { type: 'join', team });
  const player = game.players.get(id);
  const workshop = game.getWorkshops()[team].position;
  player.position = { x: workshop.x - 3, y: workshop.y, z: workshop.z + 5 };
  return { id, player, frames };
};

const ground = (game, x, z) => game.world.getGroundHeight(Math.round(x), Math.round(z));
const flatAt = (game, x, z) => {
  const g = ground(game, x, z);
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    if (ground(game, x + ox, z + oz) !== g) return null;
  }
  return g;
};

const game = new ServerGame();
const gunner = join(game, 'blue');
const target = join(game, 'red');
game.workshopStock.blue = 400;
game.handleMessage(gunner.id, { type: 'craftBlueprint', kind: 'mgNest', slot: 0 });

// Place the nest on flat open ground using the real placement rules.
let gun = null;
for (let z = -80; z <= 80 && !gun; z += 6) {
  for (let x = -80; x <= 80 && !gun; x += 6) {
    const y = flatAt(game, x, z);
    if (y === null) continue;
    // Step off the footprint: the player's own capsule blocks placement.
    gunner.player.position = { x: x - 4, y, z };
    gunner.frames.length = 0;
    game.handleMessage(gunner.id, { type: 'placeEmplacement', kind: 'mgNest', position: { x, y, z }, yaw: 0, slot: 0 });
    gun = [...game.emplacements.values()][0] || null;
  }
}
if (!gun) {
  console.error('placement frames', JSON.stringify(gunner.frames.slice(-3)));
  throw new Error('nest was not placed');
}
console.log('nest at', JSON.stringify(gun.position));

const dirAt = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
// Pick a lane with clear LOS at every test range.
let laneYaw = null;
for (let i = 0; i < 48 && laneYaw === null; i++) {
  const yaw = (i / 48) * Math.PI * 2;
  const dir = dirAt(yaw);
  let ok = true;
  for (const d of RANGES) {
    const tx = gun.position.x + dir.x * d;
    const tz = gun.position.z + dir.z * d;
    if (Math.abs(tx) > 150 || Math.abs(tz) > 150) { ok = false; break; }
    const ty = ground(game, tx, tz);
    if (Math.abs(ty - gun.position.y) > 1.5) { ok = false; break; }
    const origin = { x: gun.position.x + dir.x * 0.9, y: gun.position.y + 1.15, z: gun.position.z + dir.z * 0.9 };
    const vx = tx - origin.x, vy = ty + 1.0 - origin.y, vz = tz - origin.z;
    const len = Math.hypot(vx, vy, vz);
    const hit = game.world.raycast(origin, { x: vx / len, y: vy / len, z: vz / len }, len + 1);
    if (hit && hit.distance < len - 0.6) { ok = false; break; }
  }
  if (ok) laneYaw = yaw;
}
if (laneYaw === null) throw new Error('no clear lane from the nest');
console.log('lane yaw', laneYaw.toFixed(3), 'spread', EMPLACEMENT_MG_SPREAD, 'targetHp', TARGET_HP);

gunner.player.position = { ...gun.position };
game.handleMessage(gunner.id, { type: 'mountEmplacement', emplacementId: gun.id });
if (gun.gunnerId !== gunner.id) throw new Error('gunner did not mount');
game.update(SPAWN_PROTECTION_SECONDS + 0.3);

const dir = dirAt(laneYaw);
const spec = emplacementSpec('mgNest');

function trial(range) {
  const tx = gun.position.x + dir.x * range;
  const tz = gun.position.z + dir.z * range;
  const ty = ground(game, tx, tz);
  target.player.position = { x: tx, y: ty, z: tz };
  target.player.hp = TARGET_HP;
  target.player.maxHp = TARGET_HP;
  target.player.isDead = false;
  game.respawnTimers?.delete(target.id);
  game.spawnProtectedUntil?.delete(target.id);
  gun.ammo = spec.ammo;
  game.emplacementFireAt.clear();
  gun.yaw = laneYaw;
  gun.baseYaw = laneYaw;
  gunner.player.rotation = { yaw: laneYaw, pitch: Math.atan2(ty + 1.0 - (gun.position.y + 1.15), range) };
  gunner.frames.length = 0;

  let t = 0;
  let killed = false;
  while (t < 12) {
    // 50 Hz client-ish cadence; the server clamps to the nest's interval.
    game.handleMessage(gunner.id, { type: 'fireEmplacement' });
    if (target.player.isDead) { killed = true; break; }
    game.update(0.02);
    t += 0.02;
  }
  return {
    killed,
    ttk: killed ? t : null,
    rounds: spec.ammo - gun.ammo,
    hits: gunner.frames.filter((f) => f.type === 'hitConfirmed').length,
  };
}

for (const range of RANGES) {
  const out = [];
  for (let i = 0; i < TRIALS; i++) out.push(trial(range));
  const killed = out.filter((o) => o.killed);
  const ttks = killed.map((o) => o.ttk).sort((a, b) => a - b);
  const rounds = killed.map((o) => o.rounds).sort((a, b) => a - b);
  const hits = out.reduce((n, o) => n + o.hits, 0);
  const fired = out.reduce((n, o) => n + o.rounds, 0);
  console.log(JSON.stringify({
    range,
    killRate: `${killed.length}/${TRIALS}`,
    medianSeconds: ttks.length ? Number(ttks[Math.floor(ttks.length / 2)].toFixed(2)) : null,
    worstSeconds: ttks.length ? Number(ttks[ttks.length - 1].toFixed(2)) : null,
    medianRounds: rounds.length ? rounds[Math.floor(rounds.length / 2)] : null,
    stalled: out.filter((o) => !o.killed).length,
    hitRate: `${((hits / Math.max(1, fired)) * 100).toFixed(1)}%`,
  }));
}
