// Shared ballistics for the player-built cannon and mortar.
//
// The server owns the shell it simulates; the client draws the arc, the landing
// marker and the shell itself. Both sides use these functions so the round you
// aim is the round that lands — the mortar used to launch at a fixed 45° with a
// fixed speed, which put every shot in the same ~90 m band no matter where the
// gunner looked.
import { emplacementSpec, type Footprint, type Position } from './types';

/** Muzzle speed of a cannon round. Flat and fast: direct fire. */
export const CANNON_SHELL_SPEED = 85;
/** Muzzle speed of a mortar round. Chosen so a high-arc shot reaches the
 *  mortar's 120 m max range: v² / g = 122 m at 45°. */
export const MORTAR_SHELL_SPEED = 47;

/** How far a mortar round may fall from the aimed point, in metres. A mortar is
 *  area fire: the landing ring is the target, not a pinpoint, so a gunner who
 *  holds one aim point still walks rounds across the ring instead of drilling
 *  the same tile. Kept well inside `MORTAR_BLAST_RADIUS`. */
export const MORTAR_DISPERSION = 2.5;

/** `high` lobs over cover (mortar), `low` is the flat solution (cannon). */
export type BallisticArc = 'high' | 'low';

export interface ShellVelocity {
  x: number;
  y: number;
  z: number;
}

/**
 * Launch velocity that puts a shell of `speed` through `target` under `gravity`.
 *
 * Solves the standard projectile equation for the launch angle:
 *   tan θ = (v² ± √(v⁴ − g(g·d² + 2·y·v²))) / (g·d)
 * with `d` the horizontal distance and `y` the height gain. Returns null when
 * the point is out of reach (negative discriminant) or directly overhead.
 */
export function ballisticVelocity(
  origin: Position,
  target: Position,
  speed: number,
  gravity: number,
  arc: BallisticArc = 'high',
): ShellVelocity | null {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const flat = Math.hypot(dx, dz);
  if (
    !Number.isFinite(flat) || flat < 1e-3 ||
    !Number.isFinite(dy) ||
    !Number.isFinite(speed) || speed <= 0 ||
    !Number.isFinite(gravity) || gravity <= 0
  ) return null;

  const v2 = speed * speed;
  const discriminant = v2 * v2 - gravity * (gravity * flat * flat + 2 * dy * v2);
  if (discriminant < 0) return null; // out of range for this muzzle speed

  const root = Math.sqrt(discriminant);
  const tan = (v2 + (arc === 'high' ? root : -root)) / (gravity * flat);
  if (!Number.isFinite(tan) || tan <= 0) return null;

  const angle = Math.atan(tan);
  const horizontal = speed * Math.cos(angle);
  return {
    x: (dx / flat) * horizontal,
    y: speed * Math.sin(angle),
    z: (dz / flat) * horizontal,
  };
}

/** Flat-ground range of a shell at its best angle (v² / g). */
export function ballisticRange(speed: number, gravity: number): number {
  if (!Number.isFinite(speed) || !Number.isFinite(gravity) || gravity <= 0) return 0;
  return (speed * speed) / gravity;
}

/**
 * Where a mortar round actually bursts: the aimed point scattered inside
 * `MORTAR_DISPERSION`, clamped back into the gun's range band and snapped to
 * the ground under the final point. The server and offline play both call this,
 * so a round lands inside the ring the gunner aimed with in either mode.
 *
 * `aim` must already sit inside the range band (both callers clamp it there),
 * so the scattered point is always at least `minRange - MORTAR_DISPERSION` from
 * the gun and the clamp only has to correct the band edges.
 */
export function mortarImpactPoint(
  aim: Pick<Position, 'x' | 'z'>,
  from: Position,
  spec: { minRange: number; maxRange: number },
  groundAt: (x: number, z: number) => number,
  random: () => number = Math.random,
): Position {
  const angle = random() * Math.PI * 2;
  // sqrt keeps the scatter uniform over the disc instead of piling it up in
  // the middle of the ring.
  const radius = Math.sqrt(random()) * MORTAR_DISPERSION;
  let x = aim.x + Math.cos(angle) * radius;
  let z = aim.z + Math.sin(angle) * radius;

  const dx = x - from.x;
  const dz = z - from.z;
  const flat = Math.hypot(dx, dz);
  const capped = Math.min(Math.max(flat, spec.minRange), spec.maxRange);
  x = from.x + (dx / flat) * capped;
  z = from.z + (dz / flat) * capped;
  return { x, y: groundAt(x, z), z };
}

export interface ShellArcOptions {
  gravity: number;
  /** Integration step in seconds; the server steps shells at 0.05 or less. */
  step?: number;
  /** Give up after this many seconds of flight. */
  maxTime?: number;
  /** Terrain height at a column, or null over a hole. */
  groundAt?: (x: number, z: number) => number | null;
  /** True when a point is inside solid terrain. */
  solidAt?: (point: Position) => boolean;
  /** True when a point is inside something that stops a shell without being
   *  terrain: an enemy body, a jeep or an enemy build. */
  stopAt?: (point: Position) => boolean;
}

export interface ShellArc {
  /** Sampled flight path, starting at the muzzle. */
  points: Position[];
  /** Where the path ends: ground, terrain or the last sample. */
  impact: Position;
}

/** How finely the flight inside one integration step is sampled for collisions.
 *  A cannon round covers over two metres per step, so testing only the endpoint
 *  can skip a one-voxel wall. Shared so the server, the offline shells and the
 *  preview ring all stop at the same point. */
export const SHELL_IMPACT_SAMPLE = 0.25;

/**
 * Sample the flight path of a shell. Uses the same semi-implicit integration
 * (gravity first, then move) as the server's `updateShells`, so a preview drawn
 * with this lands where the authoritative shell does.
 */
export function shellArc(
  origin: Position,
  velocity: ShellVelocity,
  options: ShellArcOptions,
): ShellArc {
  const step = options.step ?? 0.05;
  const maxTime = options.maxTime ?? 8;
  const points: Position[] = [{ ...origin }];
  const point: Position = { ...origin };
  const velocityY = { value: velocity.y };
  const velocityX = velocity.x;
  const velocityZ = velocity.z;

  for (let t = step; t <= maxTime; t += step) {
    const from = { ...point };
    velocityY.value -= options.gravity * step;
    point.x += velocityX * step;
    point.y += velocityY.value * step;
    point.z += velocityZ * step;
    // Walk the stretch just flown in short samples, as the server and offline
    // shells do: an endpoint-only test at cannon speed can skip a wall and put
    // the ring on the far side of cover. Record the hit point as the line's last
    // point, so the preview never draws through the wall it just stopped on.
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const dz = point.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    const samples = Math.max(1, Math.ceil(length / SHELL_IMPACT_SAMPLE));
    for (let i = 1; i <= samples; i++) {
      const f = i / samples;
      const sample = { x: from.x + dx * f, y: from.y + dy * f, z: from.z + dz * f };
      if (options.solidAt?.(sample) || options.stopAt?.(sample)) {
        points.push({ ...sample });
        return { points, impact: { ...sample } };
      }
    }
    points.push({ ...point });
    // Ground keeps its integration-point test: the arc is solved for the step
    // grid, and refining this crossing would change where a lofted shot is
    // reported to land relative to the grid it was solved on.
    const ground = options.groundAt?.(point.x, point.z);
    if (ground !== null && ground !== undefined && point.y <= ground + 0.05) {
      return { points, impact: { x: point.x, y: ground, z: point.z } };
    }
  }
  return { points, impact: { ...point } };
}

/** Radius of an infantry body a shell bursts on, measured at torso height. */
export const SHELL_BODY_RADIUS = 0.7;

/**
 * Something a shell can burst on that is not terrain. The server projectile,
 * the offline projectile and the preview ring all test the same list with the
 * same geometry, so the ring is where the round actually stops.
 */
export type ShellObstacle =
  | { kind: 'body'; team: 'red' | 'blue'; position: Position }
  | { kind: 'footprint'; team: 'red' | 'blue'; position: Position; footprint: Footprint };

/** True when a shell sample lands on this enemy body, vehicle or build. */
export function shellHitsObstacle(point: Position, team: 'red' | 'blue', obstacle: ShellObstacle): boolean {
  if (obstacle.team === team) return false;
  if (obstacle.kind === 'body') {
    return Math.hypot(
      point.x - obstacle.position.x,
      point.y - (obstacle.position.y + 1),
      point.z - obstacle.position.z,
    ) < SHELL_BODY_RADIUS;
  }
  const footprint = obstacle.footprint;
  // A box's height is its vertical half-window (the same rule the server has
  // always used for jeeps), and its horizontal reach is the circumscribed
  // circle, so a shell cannot slip past a corner.
  if (Math.abs(obstacle.position.y - point.y) >= footprint.height) return false;
  return Math.hypot(point.x - obstacle.position.x, point.z - obstacle.position.z) <
    Math.hypot(footprint.halfWidth, footprint.halfLength);
}

/** True when a shell sample lands on any enemy body, vehicle or build. */
export function shellStopsAt(point: Position, team: 'red' | 'blue', obstacles: readonly ShellObstacle[]): boolean {
  return obstacles.some((obstacle) => shellHitsObstacle(point, team, obstacle));
}

export interface BlastBuildTarget {
  id: string;
  team: 'red' | 'blue';
  position: Position;
  /** Blueprint kind; needed to test whether the impact landed on this build. */
  kind?: string;
}

/** A burst is an oval, not a sphere: the shockwave spreads across the ground
 *  further than it reaches upward, and a round still travelling at impact
 *  carries it further along its flight line. Damage therefore stays highest in
 *  the shallow oval that hugs the ground where the shell lands. */
export const BLAST_GROUND_STRETCH = 1.2;
export const BLAST_PATH_STRETCH = 1.25;

/** Distance from a burst, measured on that oval: a point 1.2m across the ground
 *  counts as 1m, a point 1.5m ahead along `direction` counts as 1m, and height
 *  counts unchanged. `direction` is the round's velocity at impact, so a cannon
 *  round stretches its burst along the line it was fired on while a mortar's
 *  steep drop leaves a wide, flat oval around the crater. */
export function blastDistance(impact: Position, point: Position, direction?: Position): number {
  const dx = point.x - impact.x;
  const dz = point.z - impact.z;
  const dy = point.y - impact.y;
  const flat = direction ? Math.hypot(direction.x, direction.z) : 0;
  if (!direction || flat < 1e-6) {
    return Math.hypot(dx / BLAST_GROUND_STRETCH, dy, dz / BLAST_GROUND_STRETCH);
  }
  const fx = direction.x / flat;
  const fz = direction.z / flat;
  const along = dx * fx + dz * fz;
  const side = -dx * fz + dz * fx;
  return Math.hypot(
    along / (BLAST_GROUND_STRETCH * BLAST_PATH_STRETCH),
    side / BLAST_GROUND_STRETCH,
    dy,
  );
}

/**
 * Blast damage at a distance: linear falloff from the centre, with a minimum of
 * 1 so anything inside the radius is hurt. Both the server and the offline
 * blast call this, so their numbers cannot drift apart. The fraction is kept
 * because player and bot HP is a float pool.
 */
export function blastFalloff(power: number, radius: number, distance: number): number {
  if (!(radius > 0) || distance > radius) return 0;
  return Math.max(1, power * (1 - distance / radius));
}

/**
 * Enemy builds caught by one blast, each exactly once, already at the shared
 * falloff and minimum. A build whose footprint contains the burst is a direct
 * hit: the projectile stops on its circumscribed circle, so a burst centre can
 * sit up to that radius from the build's centre, but it still counts as
 * distance zero and full power. The projectile step must never damage a build
 * on top of this list.
 */
export function blastBuildHits<T extends BlastBuildTarget>(
  team: 'red' | 'blue', impact: Position, radius: number, power: number, builds: Iterable<T>,
  direction?: Position,
): Array<{ build: T; damage: number }> {
  const hits: Array<{ build: T; damage: number }> = [];
  for (const build of builds) {
    if (build.team === team) continue;
    const spec = build.kind ? emplacementSpec(build.kind) : undefined;
    const direct = !!spec && shellHitsObstacle(impact, team, {
      kind: 'footprint', team: build.team, position: build.position, footprint: spec,
    });
    const distance = direct
      ? 0
      : blastDistance(impact, { x: build.position.x, y: build.position.y + 0.6, z: build.position.z }, direction);
    if (distance > radius) continue;
    hits.push({ build, damage: blastFalloff(power, radius, distance) });
  }
  return hits;
}

/** Power a blast needs at its centre to break one full block. Blast power is
 *  anti-personnel HP, while a block's pool is one unit, so this keeps a cannon
 *  to a ~2.4m break radius with a chipped ring instead of deleting everything
 *  inside its anti-personnel radius. */
export const VOXEL_BLAST_TOUGHNESS = 60;

/** Damage one blast does to the block at `distance` from its centre, in block
 *  durability units. Unlike `blastFalloff` there is no 1-point floor: the ring
 *  outside the break radius is only chipped, and the client's durability shade
 *  shows it. */
export function blastVoxelDamage(power: number, radius: number, distance: number): number {
  if (!(radius > 0) || !(power > 0) || distance >= radius) return 0;
  return (power * (1 - distance / radius)) / VOXEL_BLAST_TOUGHNESS;
}

export interface BlastVoxelHit {
  x: number;
  y: number;
  z: number;
  /** Durability to subtract, already at the shared distance falloff. */
  damage: number;
}

/** Solid blocks a blast damages, each at the damage its distance earns. The
 *  caller supplies its own world lookup, so the server, the offline client and
 *  any future explosive carve the same shape.
 *
 *  Blocks inside the break radius are damaged even when buried. In the chipped
 *  ring only exposed blocks are touched, so a blast chips the crater it can
 *  reach instead of quietly pre-damaging rock behind cover. */
export function blastVoxelHits(
  impact: Position,
  radius: number,
  power: number,
  isSolid: (x: number, y: number, z: number) => boolean,
  direction?: Position,
): BlastVoxelHit[] {
  const hits: BlastVoxelHit[] = [];
  if (!(radius > 0) || !(power > 0)) return hits;
  // Horizontal reach includes both oval stretches; vertical reach is the radius.
  const reach = radius * BLAST_GROUND_STRETCH * BLAST_PATH_STRETCH;
  const exposed = (x: number, y: number, z: number): boolean =>
    !isSolid(x + 1, y, z) || !isSolid(x - 1, y, z) ||
    !isSolid(x, y + 1, z) || !isSolid(x, y - 1, z) ||
    !isSolid(x, y, z + 1) || !isSolid(x, y, z - 1);

  for (let x = Math.floor(impact.x - reach); x <= Math.ceil(impact.x + reach); x++) {
    for (let y = Math.floor(impact.y - radius); y <= Math.ceil(impact.y + radius); y++) {
      for (let z = Math.floor(impact.z - reach); z <= Math.ceil(impact.z + reach); z++) {
        if (!isSolid(x, y, z)) continue;
        const distance = blastDistance(impact, { x, y, z }, direction);
        if (distance >= radius) continue;
        const damage = blastVoxelDamage(power, radius, distance);
        if (damage <= 0) continue;
        if (damage < 1 && !exposed(x, y, z)) continue;
        hits.push({ x, y, z, damage });
      }
    }
  }
  return hits;
}
