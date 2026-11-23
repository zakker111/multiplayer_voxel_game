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
    velocityY.value -= options.gravity * step;
    point.x += velocityX * step;
    point.y += velocityY.value * step;
    point.z += velocityZ * step;
    points.push({ ...point });

    if (options.solidAt?.(point)) return { points, impact: { ...point } };
    if (options.stopAt?.(point)) return { points, impact: { ...point } };
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

/**
 * The enemy build a burst landed on, if any. Its footprint is the circumscribed
 * circle the projectile stops on, so the burst centre sits up to that radius
 * from the build's centre; a direct hit still counts as distance zero.
 */
export function directBuildHit<T extends BlastBuildTarget & { kind: string }>(
  team: 'red' | 'blue', point: Position, builds: Iterable<T>,
): T | undefined {
  for (const build of builds) {
    if (build.team === team) continue;
    const spec = emplacementSpec(build.kind);
    if (!spec) continue;
    if (shellHitsObstacle(point, team, { kind: 'footprint', team: build.team, position: build.position, footprint: spec })) {
      return build;
    }
  }
  return undefined;
}

/**
 * Enemy builds caught by one blast, each exactly once, with its linear falloff
 * damage (callers apply their own minimum). A build the round struck directly
 * is the full-power entry — `directBuildId` — so the projectile step must never
 * damage it a second time on top of this list.
 */
export function blastBuildHits<T extends BlastBuildTarget>(
  team: 'red' | 'blue', impact: Position, radius: number, power: number, builds: Iterable<T>,
  directBuildId?: string,
): Array<{ build: T; damage: number }> {
  const hits: Array<{ build: T; damage: number }> = [];
  for (const build of builds) {
    if (build.team === team) continue;
    const distance = build.id === directBuildId
      ? 0
      : Math.hypot(
        build.position.x - impact.x,
        build.position.y + 0.6 - impact.y,
        build.position.z - impact.z,
      );
    if (distance > radius) continue;
    hits.push({ build, damage: Math.max(0, power * (1 - distance / radius)) });
  }
  return hits;
}
