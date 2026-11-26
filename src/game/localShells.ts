// Offline (Beta) artillery shells: flight integration and blast resolution.
//
// This is deliberately free of THREE, the DOM and the Game class so the exact
// code the client runs can be tested headlessly. The client supplies its world,
// bodies, builds and damage callbacks; one shell impact resolves every victim
// exactly once, and a build the round struck directly takes one full-power hit.
import {
  CANNON_BLAST_DAMAGE, CANNON_BLAST_RADIUS, EMPLACEMENT_SHELL_GRAVITY,
  MORTAR_BLAST_DAMAGE, MORTAR_BLAST_RADIUS,
  type Position,
} from '../shared/types';
import { SHELL_IMPACT_SAMPLE, blastBuildHits, blastDistance, blastFalloff, shellStopsAt, type ShellObstacle } from '../shared/ballistics';

/** Fixed integration step: a cannon round covers 2.1m per 0.025s. */
export const SHELL_STEP = 0.025;
/** A shell that flies longer than this is dropped instead of falling forever. */
const SHELL_MAX_AGE = 8;

export interface OfflineShell {
  kind: 'cannon' | 'mortar';
  team: 'red' | 'blue';
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  firedAt: number;
}

export interface OfflineShellWorld {
  getGroundHeight(x: number, z: number): number;
}

export interface OfflineBotTarget {
  team: 'red' | 'blue';
  position: Position;
  isDead: boolean;
}

export interface OfflineJeepTarget {
  team: 'red' | 'blue';
  position: Position;
  wreck: boolean;
}

export interface OfflineBuildTarget {
  id: string;
  team: 'red' | 'blue';
  /** Blueprint kind, used to look up the footprint a direct hit landed on. */
  kind: string;
  position: Position;
}

export interface OfflineBlastTargets<B extends OfflineBotTarget, J extends OfflineJeepTarget, E extends OfflineBuildTarget> {
  bots: Iterable<B>;
  jeeps: Iterable<J>;
  builds: Iterable<E>;
}

export interface OfflineShellHandlers<T extends OfflineShell, B, J, E> {
  damageBot(bot: B, damage: number): void;
  damageJeep(jeep: J, damage: number): void;
  damageBuild(build: E, damage: number): void;
  /** Blast visuals and removal; damage has already been resolved. */
  onExplode(shell: T, impact: Position, radius: number): void;
}

/** Integrate every offline shell for one frame, in fixed sub-steps. */
export function stepOfflineShells<T extends OfflineShell, B extends OfflineBotTarget, J extends OfflineJeepTarget, E extends OfflineBuildTarget>(
  shells: T[],
  dt: number,
  world: OfflineShellWorld,
  obstacles: readonly ShellObstacle[],
  time: number,
  targets: OfflineBlastTargets<B, J, E>,
  handlers: OfflineShellHandlers<T, B, J, E>,
): void {
  if (dt <= 0 || shells.length === 0) return;
  const steps = Math.max(1, Math.ceil(dt / SHELL_STEP));
  for (let s = 0; s < steps; s++) stepOnce(shells, dt / steps, world, obstacles, time, targets, handlers);
}

function stepOnce<T extends OfflineShell, B extends OfflineBotTarget, J extends OfflineJeepTarget, E extends OfflineBuildTarget>(
  shells: T[],
  dt: number,
  world: OfflineShellWorld,
  obstacles: readonly ShellObstacle[],
  time: number,
  targets: OfflineBlastTargets<B, J, E>,
  handlers: OfflineShellHandlers<T, B, J, E>,
): void {
  for (let i = shells.length - 1; i >= 0; i--) {
    const shell = shells[i];
    const from = { x: shell.position.x, y: shell.position.y, z: shell.position.z };
    shell.velocity.y -= EMPLACEMENT_SHELL_GRAVITY * dt;
    shell.position.x += shell.velocity.x * dt;
    shell.position.y += shell.velocity.y * dt;
    shell.position.z += shell.velocity.z * dt;

    // Sample the whole travel of this step: a cannon round moves ~2m per step,
    // so checking only the endpoint can pass it through a one-voxel wall and
    // burst behind cover.
    const dx = shell.position.x - from.x;
    const dy = shell.position.y - from.y;
    const dz = shell.position.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    const samples = Math.max(1, Math.ceil(length / SHELL_IMPACT_SAMPLE));
    let impact: Position | null = null;
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      const point = { x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t };
      const ground = world.getGroundHeight(point.x, point.z);
      if (point.y <= ground || shellStopsAt(point, shell.team, obstacles)) {
        impact = { x: point.x, y: Math.max(ground, point.y), z: point.z };
        break;
      }
    }
    if (!impact) {
      const stale = time - shell.firedAt > SHELL_MAX_AGE;
      if (!stale) continue;
      const ground = world.getGroundHeight(shell.position.x, shell.position.z);
      impact = { x: shell.position.x, y: Math.max(ground, shell.position.y), z: shell.position.z };
    }

    const radius = applyOfflineBlast(shell, impact, targets, handlers);
    shells.splice(i, 1);
    handlers.onExplode(shell, impact, radius);
  }
}

/**
 * Resolve one blast, returning its radius. Every victim is visited once; the
 * build the round struck directly is the full-power entry, never a second pass.
 */
function applyOfflineBlast<T extends OfflineShell, B extends OfflineBotTarget, J extends OfflineJeepTarget, E extends OfflineBuildTarget>(
  shell: T,
  impact: Position,
  targets: OfflineBlastTargets<B, J, E>,
  handlers: Pick<OfflineShellHandlers<T, B, J, E>, 'damageBot' | 'damageJeep' | 'damageBuild'>,
): number {
  const isMortar = shell.kind === 'mortar';
  const radius = isMortar ? MORTAR_BLAST_RADIUS : CANNON_BLAST_RADIUS;
  const power = isMortar ? MORTAR_BLAST_DAMAGE : CANNON_BLAST_DAMAGE;
  // The same falloff and 1-point minimum the server applies.
  const splash = (distance: number) => blastFalloff(power, radius, distance);

  for (const bot of targets.bots) {
    if (bot.isDead || bot.team === shell.team) continue;
    const distance = blastDistance(impact, { x: bot.position.x, y: bot.position.y + 1, z: bot.position.z }, shell.velocity);
    if (distance > radius) continue;
    handlers.damageBot(bot, splash(distance));
  }

  for (const jeep of targets.jeeps) {
    if (jeep.wreck || jeep.team === shell.team) continue;
    const distance = blastDistance(impact, { x: jeep.position.x, y: jeep.position.y + 1, z: jeep.position.z }, shell.velocity);
    if (distance > radius) continue;
    handlers.damageJeep(jeep, splash(distance));
  }

  for (const { build, damage } of blastBuildHits(shell.team, impact, radius, power, targets.builds, shell.velocity)) {
    handlers.damageBuild(build, damage);
  }

  return radius;
}
