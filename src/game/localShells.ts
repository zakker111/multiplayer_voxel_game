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
import { blastBuildHits, directBuildHit, shellStopsAt, type ShellObstacle } from '../shared/ballistics';

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
    shell.velocity.y -= EMPLACEMENT_SHELL_GRAVITY * dt;
    shell.position.x += shell.velocity.x * dt;
    shell.position.y += shell.velocity.y * dt;
    shell.position.z += shell.velocity.z * dt;

    const ground = world.getGroundHeight(shell.position.x, shell.position.z);
    const stopped = shellStopsAt(shell.position, shell.team, obstacles);
    const stale = time - shell.firedAt > SHELL_MAX_AGE;
    if (shell.position.y > ground && !stopped && !stale) continue;

    const impact = { x: shell.position.x, y: Math.max(ground, shell.position.y), z: shell.position.z };
    const radius = applyOfflineBlast(shell, impact, targets, handlers);
    shells.splice(i, 1);
    handlers.onExplode(shell, impact, radius);
  }
}

/**
 * Resolve one blast, returning its radius. Every victim is visited once; the
 * build the round struck directly is the full-power entry, never a second pass.
 */
export function applyOfflineBlast<T extends OfflineShell, B extends OfflineBotTarget, J extends OfflineJeepTarget, E extends OfflineBuildTarget>(
  shell: T,
  impact: Position,
  targets: OfflineBlastTargets<B, J, E>,
  handlers: Pick<OfflineShellHandlers<T, B, J, E>, 'damageBot' | 'damageJeep' | 'damageBuild'>,
): number {
  const isMortar = shell.kind === 'mortar';
  const radius = isMortar ? MORTAR_BLAST_RADIUS : CANNON_BLAST_RADIUS;
  const power = isMortar ? MORTAR_BLAST_DAMAGE : CANNON_BLAST_DAMAGE;
  const splash = (distance: number) => Math.max(power * 0.25, power * (1 - distance / radius));

  for (const bot of targets.bots) {
    if (bot.isDead || bot.team === shell.team) continue;
    const distance = Math.hypot(
      bot.position.x - impact.x,
      bot.position.y + 1 - impact.y,
      bot.position.z - impact.z,
    );
    if (distance > radius) continue;
    handlers.damageBot(bot, splash(distance));
  }

  for (const jeep of targets.jeeps) {
    if (jeep.wreck || jeep.team === shell.team) continue;
    const distance = Math.hypot(
      jeep.position.x - impact.x,
      jeep.position.y + 1 - impact.y,
      jeep.position.z - impact.z,
    );
    if (distance > radius) continue;
    handlers.damageJeep(jeep, splash(distance));
  }

  const direct = directBuildHit(shell.team, impact, targets.builds);
  for (const { build, damage } of blastBuildHits(shell.team, impact, radius, power, targets.builds, direct?.id)) {
    handlers.damageBuild(build, Math.max(power * 0.25, damage));
  }

  return radius;
}
