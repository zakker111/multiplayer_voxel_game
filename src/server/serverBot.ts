// AI Bots for Capture The Flag
//
// Behavior model: finite state machine with personality weights.
//   ENGAGE   -> strafe & shoot visible enemies (with LOS checks)
//   FLANK    -> swing wide around the enemy before pushing in
//   CAMP     -> hold a shaded spot, pre-aim common lanes, snipe on sight
//   ADVANCE  -> push toward the objective (grab enemy flag / return own flag)
//   GRABFLAG -> head to the enemy flag and take it
//   RETURN   -> carry the flag home; build cover when pinned or mid-field
//   BUILD    -> place blocks for cover / rush towers near the enemy base
//   TRENCH   -> dig & wall a fighting trench on the midfield approach lane
//   RETREAT  -> fall back when low HP, out of ammo, or surrounded
//
// Difficulty knobs (env):
//   SERVER_BOT_COUNT  bots per team (default 2)
//   SERVER_BOT_BLOCKS building budget per bot life (default 36)
//   SERVER_BOT_HP     max HP for bots (default 130 — beefier than players)
import { ServerPlayer } from './serverPlayer';
import type { ServerWorld } from './serverWorld';

import {
  Position,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  WEAPONS,
  BLUE_FLAG_POS,
  RED_FLAG_POS,
  GROUND_LEVEL,
} from '../shared/types';

export type BotState =
  | 'ENGAGE'
  | 'FLANK'
  | 'CAMP'
  | 'ADVANCE'
  | 'GRABFLAG'
  | 'RETURN'
  | 'BUILD'
  | 'TRENCH'
  | 'RETREAT';

export interface BotTargetInfo {
  id: string;
  position: Position;
  team: 'red' | 'blue';
  isDead: boolean;
  carryingFlag: boolean;
}

export interface BotContext {
  world: ServerWorld;
  serverTime: number;
  targets: BotTargetInfo[]; // all living players (humans + other bots)
  friendlyDroppedFlagPos: Position | null; // dropped flag of MY team to return
  canSee: (from: Position, to: Position) => boolean; // LOS check (terrain raycast)
  fireWeapon: (bot: ServerBot, target: BotTargetInfo, aimDir: Position, eyeY: number) => void;
  buildBlock: (bot: ServerBot, pos: Position) => void;
}

const EYE_HEIGHT = 1.6;
const AIM_TOLERANCE_RAD = 0.14; // ~8 degrees
const VISIBLE_RANGE = 75;

// Difficulty knobs (env-overridable so Render can tune without code changes)
const BOT_MAX_HP = Number(process.env.SERVER_BOT_HP ?? 130); // beefier than players (100)
const BOT_BLOCKS = Number(process.env.SERVER_BOT_BLOCKS ?? 36); // building budget per life

export class ServerBot extends ServerPlayer {
  private botState: BotState = 'ADVANCE';
  private stateUntil: number = 0;
  private waypoint: Position | null = null;
  private campSpot: Position | null = null;
  private lastSeenEnemy: Position | null = null;
  private lastShotAt: number = -10;
  private lastBuildAt: number = -10;
  private lastCampCheck: number = -10;
  private lastDecisionAt: number = -10;
  private wanderUntil: number = 0;
  private strafeSign: number = Math.random() < 0.5 ? -1 : 1;
  private flankSide: number = Math.random() < 0.5 ? -1 : 1;
  // Threat memory: bots remember who shot them and hunt back briefly
  private lastAttackerId: string | null = null;
  private lastAttackedAt: number = -100;
  // Trench construction plan (list of cells to wall, consumed over ticks)
  private trenchPlan: Array<{ x: number; y: number; z: number }> | null = null;
  private lastTrenchCell: number = 0;

  // Personality weights (per bot, slightly randomized)
  private aggroBias: number;
  private campBias: number;
  private buildBias: number;

  constructor(id: string, position: Position, team: 'red' | 'blue', name: string) {
    super(id, position, team);
    this.name = name;
    this.equipment = Math.random() < 0.5 ? 'rifle' : 'smg';
    this.magazineSize = WEAPONS[this.equipment as 'rifle' | 'smg'] ? (this.equipment === 'rifle' ? 10 : 30) : 10;
    this.currentAmmo = this.magazineSize;
    this.reloadTime = this.equipment === 'rifle' ? 2.0 : 1.5;
    // Vicious: tougher than players (respawn() also honors maxHp)
    this.maxHp = BOT_MAX_HP;
    this.hp = BOT_MAX_HP;
    this.botBlocks = BOT_BLOCKS;
    // Smarter default personalities (higher aggression/building than before)
    this.aggroBias = 0.35 + Math.random() * 0.4;
    this.campBias = 0.15 + Math.random() * 0.25;
    this.buildBias = 0.3 + Math.random() * 0.35;
  }

  get stateName(): BotState {
    return this.botState;
  }

  /** Called by serverGame when this bot takes damage — enables revenge targeting. */
  noteHitBy(attackerId: string, now: number): void {
    this.lastAttackerId = attackerId;
    this.lastAttackedAt = now;
  }

  /**
   * Called every server tick instead of player.update(). Moves the bot,
   * aims, shoots, camps, flanks and builds through the provided context.
   */
  botUpdate(dt: number, ctx: BotContext): void {
    if (this.isDead) return;
    this.updateReload();

    const t = ctx.serverTime;
    const enemyFlag = this.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    const homeBase = this.team === 'blue' ? BLUE_FLAG_POS : RED_FLAG_POS;

    // --- Perception: nearest visible enemy (with threat/revenge weighting) ---
    let nearest: BotTargetInfo | null = null;
    let nearestDist = Infinity;
    const revengeActive = t - this.lastAttackedAt < 8;
    for (const cand of ctx.targets) {
      if (cand.id === this.id || cand.isDead || cand.team === this.team) continue;
      const d = Math.hypot(
        cand.position.x - this.position.x,
        cand.position.y - this.position.y,
        cand.position.z - this.position.z,
      );
      if (d > VISIBLE_RANGE) continue;
      if (!ctx.canSee(this.eyePos(), cand.position)) continue;
      // Smart targeting: flag carriers are priority; recent attackers get a
      // distance discount so bots "hunt back" toward whoever hurt them.
      let score = d;
      if (revengeActive && cand.id === this.lastAttackerId) score *= 0.45;
      if (cand.carryingFlag) score *= 0.5;
      if (score < nearestDist) {
        nearestDist = score;
        nearest = cand;
      }
    }
    if (nearest) this.lastSeenEnemy = { ...nearest.position };

    // --- Reactive overrides (checked every tick) ---
    if (this.needsRetreat(nearestDist)) {
      this.transition('RETREAT', t, 3.0);
    } else if (this.carryingFlag) {
      if (this.botState !== 'RETURN') this.transition('RETURN', t, 10);
    } else if (nearest && this.botState !== 'RETREAT') {
      this.combatReaction(nearest, nearestDist, ctx, t);
    } else if (t >= this.stateUntil) {
      this.chooseObjective(ctx, t, enemyFlag, homeBase);
    }

    // --- Act out current state ---
    switch (this.botState) {
      case 'ENGAGE':
        this.doEngage(nearest, nearestDist, ctx, t);
        break;
      case 'FLANK':
        this.doFlank(nearest, nearestDist, ctx, t);
        break;
      case 'CAMP':
        this.doCamp(nearest, nearestDist, ctx, t);
        break;
      case 'ADVANCE':
        this.doAdvance(ctx, t, enemyFlag);
        break;
      case 'GRABFLAG':
        this.doGrabFlag(ctx, enemyFlag);
        break;
      case 'RETURN':
        this.doReturn(ctx, homeBase, nearest, nearestDist, t);
        break;
      case 'BUILD':
        this.doBuild(ctx, enemyFlag, t);
        break;
      case 'TRENCH':
        this.doTrench(ctx, t);
        break;
      case 'RETREAT':
        this.doRetreat(ctx, homeBase, t);
        break;
    }

    // Keep the synced state honest so clients render reload/stance properly
    this.isSprinting = false;
    this.isCrouching = this.botState === 'CAMP' || this.botState === 'TRENCH';
    this.isGrounded = true;
  }

  // ---------------- State transitions ----------------

  private transition(state: BotState, now: number, duration: number): void {
    // Never interrupt a trench mid-dig: the wall is only useful if it gets
    // finished, so random re-decisions (GRABFLAG coin-flips, BUILD rolls,
    // wander timers) must not cancel it. Explicit overrides still apply:
    // carryingFlag -> RETURN and needsRetreat -> RETREAT are checked earlier
    // in botUpdate() and call transition('RETURN'/'RETREAT'), which is allowed.
    if (this.botState === 'TRENCH') {
      if (state !== 'RETURN' && state !== 'RETREAT') {
        // Still refresh the timer so doTrench()'s "done digging" hold logic
        // doesn't expire while we're mid-wall and keep us locked in TRENCH.
        this.stateUntil = now + Math.max(duration, 2);
        return;
      }
      this.trenchPlan = null; // abandoning the dig to flee/return the flag
    }
    if (this.botState !== state) {
      this.botState = state;
      this.waypoint = null;
      if (state !== 'CAMP') this.campSpot = null;
    }
    this.stateUntil = now + duration;
  }

  private needsRetreat(nearestDist: number): boolean {
    const lowHp = this.hp <= 0.25 * this.maxHp;
    const noAmmo = this.currentAmmo <= 0 && !this.isReloading;
    const closeContact = nearestDist < 9 && this.hp <= 0.55 * this.maxHp;
    return lowHp || noAmmo || closeContact;
  }

  private combatReaction(enemy: BotTargetInfo, dist: number, ctx: BotContext, t: number): void {
    // Only re-decide occasionally so bots don't flip states every tick
    if (t - this.lastDecisionAt < 0.8) return;
    this.lastDecisionAt = t;

    // Already in an active combat state? keep it unless very close
    if ((this.botState === 'ENGAGE' || this.botState === 'FLANK') && t < this.stateUntil && dist > 6) return;

    if (dist < 14) {
      // Point blank: fight or bail sideways
      this.transition('ENGAGE', t, 2 + Math.random() * 2);
      return;
    }

    const roll = Math.random();
    if (roll < this.aggroBias) {
      // Flank: swing wide around the enemy's position
      this.flankSide = Math.random() < 0.5 ? -1 : 1;
      this.transition('FLANK', t, 5 + Math.random() * 3);
    } else if (roll < this.aggroBias + this.campBias && dist > 25 && this.botState !== 'CAMP') {
      // Camp: settle into nearby cover and pre-aim
      const spot = this.findCampSpot(ctx, enemy.position);
      if (spot) {
        this.campSpot = spot;
        this.waypoint = { ...spot };
        this.transition('CAMP', t, 6 + Math.random() * 6);
      } else {
        this.transition('ENGAGE', t, 3);
      }
    } else {
      this.transition('ENGAGE', t, 3 + Math.random() * 2);
    }
  }

  private chooseObjective(ctx: BotContext, t: number, enemyFlag: { x: number; z: number }, homeBase: { x: number; z: number }): void {
    // Priority 1: return a friendly dropped flag if one exists nearby-ish
    if (ctx.friendlyDroppedFlagPos) {
      const d = Math.hypot(ctx.friendlyDroppedFlagPos.x - this.position.x, ctx.friendlyDroppedFlagPos.z - this.position.z);
      if (d < 60 && Math.random() < 0.7) {
        this.waypoint = { ...ctx.friendlyDroppedFlagPos };
        this.transition('ADVANCE', t, 8);
        return;
      }
    }

    const distToEnemyFlag = Math.hypot(enemyFlag.x - this.position.x, enemyFlag.z - this.position.z);

    // Priority 2: grab the enemy flag when reasonably free
    if (distToEnemyFlag < 120 && Math.random() < 0.55) {
      this.transition('GRABFLAG', t, 12);
      return;
    }

    // Priority 3: build pressure near the enemy base (cover/rush wall)
    if (distToEnemyFlag < 45 && this.remainingBlocks > 6 && Math.random() < this.buildBias) {
      this.transition('BUILD', t, 4);
      return;
    }

    // Priority 3b: dig a fighting trench on the midfield lane (only when we
    // still have most of our block budget left)
    const midZ = (BLUE_FLAG_POS.z + RED_FLAG_POS.z) / 2;
    const midDist = Math.abs(this.position.z - midZ);
    if (
      midDist < 35 &&
      this.remainingBlocks >= BOT_BLOCKS * 0.5 &&
      !this.trenchPlan &&
      Math.random() < this.buildBias * 0.8
    ) {
      this.startTrench(ctx);
      return;
    }

    // Priority 4: opportunistic camping behind our forward line
    if (Math.random() < this.campBias * 0.6) {
      const campMidZ = (this.position.z + enemyFlag.z) / 2;
      const spot = this.findCampSpot(ctx, { x: enemyFlag.x, y: GROUND_LEVEL, z: enemyFlag.z });
      if (spot) {
        this.campSpot = spot;
        this.waypoint = { ...spot };
        this.transition('CAMP', t, 5 + Math.random() * 5);
        return;
      }
      void campMidZ;
    }

    // Default: advance toward the objective
    this.transition('ADVANCE', t, 6 + Math.random() * 4);
  }

  // ---------------- Behaviors ----------------

  private doEngage(enemy: BotTargetInfo | null, dist: number, ctx: BotContext, t: number): void {
    const step = dtOf(ctx);
    if (!enemy) {
      // Lost sight: push toward last known position, then re-decide
      if (this.lastSeenEnemy && Math.hypot(this.lastSeenEnemy.x - this.position.x, this.lastSeenEnemy.z - this.position.z) > 2) {
        this.moveTo(this.lastSeenEnemy, step, ctx, false);
      } else if (ctx.serverTime >= this.wanderUntil) {
        this.pickWander(ctx);
      } else if (this.waypoint) {
        this.moveTo(this.waypoint, step, ctx, false);
      }
      return;
    }

    // Strafe while shooting — never walk straight into the barrel
    this.strafeAround(enemy.position, step, ctx, dist);
    this.aimAndShoot(enemy, ctx, t);

    if (dist > 40 && Math.random() < 0.01) this.startReloadIfNeeded();
  }

  private doFlank(enemy: BotTargetInfo | null, dist: number, ctx: BotContext, t: number): void {
    const anchor = enemy?.position ?? this.lastSeenEnemy;
    if (!anchor) {
      this.transition('ADVANCE', ctx.serverTime, 5);
      return;
    }
    // Perpendicular offset that shrinks as we close in
    const dx = anchor.x - this.position.x;
    const dz = anchor.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    const width = Math.max(6, Math.min(22, len * 0.8));
    const shrink = Math.max(0, Math.min(1, (this.stateUntil - t) / 6));
    const target: Position = {
      x: this.position.x + dx * 0.6 + px * width * this.flankSide * shrink,
      y: GROUND_LEVEL,
      z: this.position.z + dz * 0.6 + pz * width * this.flankSide * shrink,
    };
    this.moveTo(target, dtOf(ctx), ctx, true);
    // Opportunistic shots while circling
    if (enemy) this.aimAndShoot(enemy, ctx, t, /* allowTurnPenalty */ true);
    if (dist < 10 || t >= this.stateUntil) this.transition('ENGAGE', t, 3);
  }

  private doCamp(enemy: BotTargetInfo | null, dist: number, ctx: BotContext, t: number): void {
    const step = dtOf(ctx);
    if (this.campSpot) {
      const d = Math.hypot(this.campSpot.x - this.position.x, this.campSpot.z - this.position.z);
      if (d > 1.2) {
        this.moveTo(this.campSpot, step, ctx, false);
      } else {
        // Hold position; face toward the enemy lane / enemy flag axis
        const look = enemy?.position ?? this.campSpot;
        this.faceToward(look.x, look.z);
        this.velocity = { x: 0, y: 0, z: 0 };
      }
    }
    if (enemy && dist < 60) this.aimAndShoot(enemy, ctx, t);
    // Re-check cover periodically; relocate if something stands in our lap
    if (t - this.lastCampCheck > 2.5) {
      this.lastCampCheck = t;
      const threatened = ctx.targets.some(
        (p) => !p.isDead && p.team !== this.team && Math.hypot(p.position.x - this.position.x, p.position.z - this.position.z) < 8,
      );
      if (threatened) this.transition('RETREAT', t, 2.5);
    }
  }

  private doAdvance(ctx: BotContext, t: number, enemyFlag: { x: number; z: number }): void {
    if (!this.waypoint || ctx.serverTime >= this.wanderUntil) {
      // Head somewhere between midfield and the enemy flag with jitter
      const jitterX = (Math.random() - 0.5) * 40;
      const progress = 0.45 + Math.random() * 0.35;
      const z = this.position.z + (enemyFlag.z - this.position.z) * progress;
      this.waypoint = { x: enemyFlag.x + jitterX, y: GROUND_LEVEL, z };
      this.wanderUntil = ctx.serverTime + 4 + Math.random() * 4;
    }
    this.moveTo(this.waypoint, dtOf(ctx), ctx, true);
  }

  private doGrabFlag(ctx: BotContext, enemyFlag: { x: number; z: number }): void {
    const wp: Position = { x: enemyFlag.x, y: GROUND_LEVEL, z: enemyFlag.z };
    this.moveTo(wp, dtOf(ctx), ctx, true);
    const d = Math.hypot(wp.x - this.position.x, wp.z - this.position.z);
    if (d < 3) {
      // Attempt pickup via context-driven game logic: rely on auto-pickup
      // in serverGame.checkFlagCaptures which runs each tick — just linger.
      this.velocity = { x: 0, y: 0, z: 0 };
    }
  }

  private doReturn(ctx: BotContext, homeBase: { x: number; z: number }, enemy: BotTargetInfo | null, dist: number, t: number): void {
    const step = dtOf(ctx);
    const wp: Position = { x: homeBase.x, y: GROUND_LEVEL, z: homeBase.z };
    this.moveTo(wp, step, ctx, true);

    // Build emergency cover when pinned down with the flag
    const remaining = this.stateUntil - t;
    if (enemy && dist < 22 && this.remainingBlocks > 2 && t - this.lastBuildAt > 2.5) {
      this.lastBuildAt = t;
      // Wall between us and the shooter
      const bx = this.position.x + (enemy.position.x - this.position.x) * 0.4;
      const bz = this.position.z + (enemy.position.z - this.position.z) * 0.4;
      this.tryBuildColumn(ctx, bx, bz, 2);
    }
    // Shoot back defensively at close range
    if (enemy && dist < 25) this.aimAndShoot(enemy, ctx, t);
    if (remaining <= 0) this.transition('GRABFLAG', t, 10);
  }

  private doBuild(ctx: BotContext, enemyFlag: { x: number; z: number }, t: number): void {
    // Move next to the enemy flag approach lane, then raise a small bastion
    const near: Position = {
      x: enemyFlag.x + (Math.random() - 0.5) * 14,
      y: GROUND_LEVEL,
      z: enemyFlag.z + (this.team === 'blue' ? 12 : -12),
    };
    const d = Math.hypot(near.x - this.position.x, near.z - this.position.z);
    if (d > 3) {
      this.moveTo(near, dtOf(ctx), ctx, true);
      return;
    }
    if (t - this.lastBuildAt > 0.6 && this.remainingBlocks > 0) {
      this.lastBuildAt = t;
      const gx = Math.round(this.position.x);
      const gz = Math.round(this.position.z);
      // Ring of cover around self, two layers high
      const cells = [
        [gx + 1, gz], [gx - 1, gz], [gx, gz + 1], [gx, gz - 1],
      ];
      const [cx, cz] = cells[Math.floor(Math.random() * cells.length)];
      const groundY = ctx.world.getGroundHeight(cx, cz);
      this.tryBuildColumnAt(ctx, cx, groundY, cz, 2);
    }
    if (t >= this.stateUntil || this.remainingBlocks <= 1) {
      this.transition('GRABFLAG', t, 10);
    }
  }

  private doRetreat(ctx: BotContext, homeBase: { x: number; z: number }, t: number): void {
    const step = dtOf(ctx);
    const wp: Position = { x: homeBase.x, y: GROUND_LEVEL, z: homeBase.z + (this.team === 'blue' ? -18 : 18) };
    this.moveTo(wp, step, ctx, true);
    if (this.hp > 45 && this.currentAmmo > 0 && t >= this.stateUntil) {
      this.transition('ADVANCE', t, 6);
    }
  }

  // ---------------- Trench building ----------------

  /**
   * Lay out a trench plan: a wall line perpendicular to our advance axis,
   * centered on the bot's current position. Cells are consumed one per tick
   * in doTrench(), so the trench rises progressively like a real engineer.
   */
  private startTrench(ctx: BotContext): void {
    const enemyFlagZ = (this.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS).z;
    const towardEnemy = enemyFlagZ > this.position.z ? 1 : -1; // blue base is at -z
    const cx = Math.round(this.position.x);
    const cz = Math.round(this.position.z);
    const groundY = ctx.world.getGroundHeight(cx, cz);
    const cells: Array<{ x: number; y: number; z: number }> = [];
    // Wall spans 9 blocks left/right along X, 2 high, on the side facing away
    // from the enemy so it acts as cover for whoever holds the trench.
    const backOffset = -towardEnemy * 2;
    for (let dx = -4; dx <= 4; dx++) {
      for (let h = 0; h < 2; h++) {
        cells.push({ x: cx + dx, y: groundY + 1 + h, z: cz + backOffset });
      }
      // Small firing-step parapet at both ends
      if (Math.abs(dx) === 4) {
        cells.push({ x: cx + dx, y: groundY + 3, z: cz + backOffset });
      }
    }
    this.trenchPlan = cells;
    this.lastTrenchCell = 0;
    this.transition('TRENCH', ctx.serverTime, 14);
  }

  private doTrench(ctx: BotContext, t: number): void {
    const step = dtOf(ctx);
    if (!this.trenchPlan || this.remainingBlocks <= 0) {
      this.trenchPlan = null;
      this.transition('ADVANCE', t, 6);
      return;
    }
    // Build one cell every other tick (10 blocks/sec max), skipping cells we
    // can't legally build on (occupied / unsupported / out of bounds).
    let attempts = 0;
    while (this.lastTrenchCell < this.trenchPlan.length && attempts < 6) {
      const cell = this.trenchPlan[this.lastTrenchCell];
      this.lastTrenchCell++;
      attempts++;
      if (ctx.world.canBuild(cell.x, cell.y, cell.z)) {
        // Never bury ourselves or stand-inside cells
        if (this.cellOverlapsBody(cell)) continue;
        ctx.buildBlock(this, { x: cell.x, y: cell.y, z: cell.z });
        this.botBlocks--;
        break; // pace: one placed block per tick
      }
    }
    // Stand inside the trench center while building (crouch behind the wall)
    const center: Position = { x: this.position.x, y: GROUND_LEVEL, z: this.position.z };
    const d = Math.hypot(center.x - this.position.x, center.z - this.position.z);
    if (d > 1.5) this.moveTo(center, step, ctx, false);
    else {
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.snapToGround(ctx);
    }
    this.isCrouching = true;

    if (this.lastTrenchCell >= this.trenchPlan.length) {
      // Done digging: hold the trench briefly, scanning toward the enemy lane
      if (t >= this.stateUntil) {
        this.trenchPlan = null;
        this.transition('CAMP', t, 6);
        const enemyFlag = this.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
        const spot = this.findCampSpot(ctx, { x: enemyFlag.x, y: GROUND_LEVEL, z: enemyFlag.z });
        if (spot) {
          this.campSpot = spot;
          this.waypoint = { ...spot };
        } else {
          this.transition('ADVANCE', t, 6);
        }
      }
    }
  }

  private cellOverlapsBody(cell: { x: number; y: number; z: number }): boolean {
    const feetY = Math.floor(this.position.y);
    const headY = Math.floor(this.position.y + 1.8);
    return (
      cell.x >= Math.floor(this.position.x - 0.4) &&
      cell.x <= Math.floor(this.position.x + 0.4) &&
      cell.z >= Math.floor(this.position.z - 0.4) &&
      cell.z <= Math.floor(this.position.z + 0.4) &&
      cell.y >= feetY &&
      cell.y <= headY
    );
  }

  // ---------------- Movement / aiming primitives ----------------

  private eyePos(): Position {
    return { x: this.position.x, y: this.position.y + EYE_HEIGHT, z: this.position.z };
  }

  /**
   * Steer toward a target using simple collision avoidance: probe the next
   * step plus two diagonals, pick the first non-solid option.
   */
  private moveTo(target: Position, dt: number, ctx: BotContext, sprint: boolean): void {
    const speed = PLAYER_SPEED * (sprint ? SPRINT_MULTIPLIER : 1);
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.4) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.snapToGround(ctx);
      return;
    }
    const nx = dx / dist;
    const nz = dz / dist;

    const probes: Array<[number, number]> = [
      [nx, nz],
      [nx * 0.7 + 0.7 * -nz, nz * 0.7 + 0.7 * nx], // left
      [nx * 0.7 - 0.7 * -nz, nz * 0.7 - 0.7 * nx], // right
    ];

    const lookAhead = 1.4;
    let chosen: [number, number] | null = null;
    for (const [px, pz] of probes) {
      const tx = this.position.x + px * lookAhead;
      const tz = this.position.z + pz * lookAhead;
      const ty = this.groundProbe(ctx, tx, tz);
      if (!ctx.world.isSolid(Math.round(tx), Math.round(ty + 0.8), Math.round(tz)) &&
          !ctx.world.isSolid(Math.round(tx), Math.round(ty + 1.6), Math.round(tz))) {
        chosen = [px, pz];
        break;
      }
    }
    if (!chosen) {
      // Fully blocked: hop over low walls by climbing onto the block
      chosen = [nx, nz];
    }

    this.velocity.x = chosen[0] * speed;
    this.velocity.z = chosen[1] * speed;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.snapToGround(ctx);
    this.faceToward(target.x, target.z);
  }

  private strafeAround(enemyPos: Position, dt: number, ctx: BotContext, dist: number): void {
    const dx = enemyPos.x - this.position.x;
    const dz = enemyPos.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    // Tangent direction (perpendicular to enemy vector)
    let mx = (-dz / len) * this.strafeSign;
    let mz = (dx / len) * this.strafeSign;
    // Maintain preferred distance: back off if too close, close in if far
    if (dist < 10) { mx -= (dx / len) * 0.8; mz -= (dz / len) * 0.8; }
    else if (dist > 30) { mx += (dx / len) * 0.6; mz += (dz / len) * 0.6; }
    const mlen = Math.hypot(mx, mz) || 1;
    const speed = PLAYER_SPEED * 0.9;
    this.velocity.x = (mx / mlen) * speed;
    this.velocity.z = (mz / mlen) * speed;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.snapToGround(ctx);
    this.faceToward(enemyPos.x, enemyPos.z);
    // Occasionally swap strafe direction to look unpredictable
    if (Math.random() < 0.02) this.strafeSign *= -1;
  }

  private faceToward(x: number, z: number): void {
    this.rotation.yaw = Math.atan2(-(x - this.position.x), -(z - this.position.z));
  }

  private forwardDir(): Position {
    // Matches rotation.yaw convention used by the client camera
    return { x: -Math.sin(this.rotation.yaw), y: 0, z: -Math.cos(this.rotation.yaw) };
  }

  private aimAndShoot(enemy: BotTargetInfo, ctx: BotContext, t: number, allowTurnPenalty = false): void {
    const weapon = WEAPONS[this.equipment as 'rifle' | 'smg'];
    if (!weapon) return;
    if (this.isReloading) return;
    if (t - this.lastShotAt < weapon.fireRate) return;

    const eye = this.eyePos();
    const aimPoint: Position = { x: enemy.position.x, y: enemy.position.y + 1.1, z: enemy.position.z };
    const fwd = this.forwardDir();
    const dx = aimPoint.x - eye.x;
    const dy = aimPoint.y - eye.y;
    const dz = aimPoint.z - eye.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const dot = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / dist;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle > AIM_TOLERANCE_RAD) {
      // Snap-turn faster when not flanking; flanking bots lead with movement
      const turnSpeed = allowTurnPenalty ? 6 : 12;
      const desired = Math.atan2(-dx, -dz);
      let diff = desired - this.rotation.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.rotation.yaw += diff * Math.min(1, turnSpeed * dtOf(ctx));
      return;
    }

    if (!ctx.canSee(eye, aimPoint)) return;

    // Accuracy: hit chance falls off with distance; rifles are more accurate
    const baseAcc = this.equipment === 'rifle' ? 0.92 : 0.8;
    const acc = baseAcc - Math.max(0, (dist - 20) / 120);
    if (Math.random() > acc) {
      // Missed deliberately: still consume ammo and broadcast the shot
      if (this.useAmmo()) {
        this.lastShotAt = t;
        this.isShooting = true;
        ctx.fireWeapon(this, enemy, { x: dx / dist, y: dy / dist, z: dz / dist }, EYE_HEIGHT);
        // tracer missed — handled by caller via randomness
      } else {
        this.startReloadIfNeeded();
      }
      return;
    }

    if (this.useAmmo()) {
      this.lastShotAt = t;
      this.isShooting = true;
      ctx.fireWeapon(this, enemy, { x: dx / dist, y: dy / dist, z: dz / dist }, EYE_HEIGHT);
    } else {
      this.startReloadIfNeeded();
    }
  }

  private startReloadIfNeeded(): void {
    if (!this.isReloading && this.currentAmmo < this.magazineSize) {
      this.startReload();
    }
  }

  // ---------------- Building helpers ----------------

  private get remainingBlocks(): number {
    // Bots get a per-life building budget tracked externally; default 12
    return this.botBlocks;
  }
  private botBlocks: number = 12;

  private tryBuildColumn(ctx: BotContext, x: number, z: number, height: number): void {
    const gx = Math.round(x);
    const gz = Math.round(z);
    const gy = ctx.world.getGroundHeight(gx, gz);
    this.tryBuildColumnAt(ctx, gx, gy, gz, height);
  }

  private tryBuildColumnAt(ctx: BotContext, gx: number, gy: number, gz: number, height: number): void {
    for (let i = 0; i < height; i++) {
      if (this.botBlocks <= 0) return;
      const y = gy + i;
      if (!ctx.world.canBuild(gx, y, gz)) continue;
      // Don't bury ourselves
      if (Math.abs(gx - this.position.x) < 0.9 && Math.abs(gz - this.position.z) < 0.9 && y <= Math.ceil(this.position.y + 1.7)) continue;
      ctx.buildBlock(this, { x: gx, y, z: gz });
      this.botBlocks--;
    }
  }

  // ---------------- Misc ----------------

  private snapToGround(ctx: BotContext): void {
    const g = ctx.world.getGroundHeightBelow(this.position.x, this.position.y, this.position.z);
    // Smooth vertical follow: climb steps, fall quickly
    if (this.position.y < g) {
      this.position.y = Math.min(g, this.position.y + Math.max(0.25, 6 * dtOf(ctx)));
    } else if (this.position.y > g + 0.05) {
      this.position.y = Math.max(g, this.position.y - Math.min(9 * dtOf(ctx), this.position.y - g));
    } else {
      this.position.y = g;
    }
  }

  private groundProbe(ctx: BotContext, x: number, z: number): number {
    return ctx.world.getGroundHeightBelow(x, this.position.y, z);
  }

  private findCampSpot(ctx: BotContext, threat: Position): Position | null {
    // Look for a solid block within 12m that has clear LOS toward the threat
    const ix = Math.round(this.position.x);
    const iz = Math.round(this.position.z);
    let best: Position | null = null;
    let bestScore = -Infinity;
    for (let r = 2; r <= 12; r++) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const cx = ix + Math.round(Math.cos(ang) * r);
        const cz = iz + Math.round(Math.sin(ang) * r);
        const cy = ctx.world.getGroundHeight(cx, cz);
        // Need cover adjacent (solid at head height next to spot) but spot itself open
        if (ctx.world.isSolid(cx, Math.round(cy + 0.8), cz)) continue;
        const hasWallBehind =
          ctx.world.isSolid(cx + Math.round(Math.cos(ang)), Math.round(cy + 0.8), cz + Math.round(Math.sin(ang)));
        const seesThreat = ctx.canSee({ x: cx, y: cy + EYE_HEIGHT, z: cz }, threat);
        if (!seesThreat) continue;
        const score = (hasWallBehind ? 2 : 0) + Math.random();
        if (score > bestScore) {
          bestScore = score;
          best = { x: cx, y: cy, z: cz };
        }
      }
    }
    return best;
  }

  private pickWander(ctx: BotContext): void {
    const half = 100;
    this.waypoint = {
      x: Math.max(-half, Math.min(half, this.position.x + (Math.random() - 0.5) * 40)),
      y: GROUND_LEVEL,
      z: Math.max(-half, Math.min(half, this.position.z + (Math.random() - 0.5) * 40)),
    };
    this.wanderUntil = ctx.serverTime + 3 + Math.random() * 4;
  }

  refillBlocks(): void {
    this.botBlocks = BOT_BLOCKS;
    this.trenchPlan = null; // drop any half-built trench on death/respawn
  }
}

// dt helper: bots run at fixed server tick rate
const TICK_DT = 1 / 20;
function dtOf(_ctx: BotContext): number {
  return TICK_DT;
}
