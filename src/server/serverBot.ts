// AI Bots for Capture The Flag
//
// Behavior model: finite state machine with personality weights.
//   ENGAGE   -> strafe & shoot visible enemies (with LOS checks)
//   FLANK    -> swing wide around the enemy before pushing in
//   CAMP     -> hold a shaded spot, pre-aim common lanes, snipe on sight
//   ADVANCE  -> push toward the objective (grab enemy flag / return own flag)
//   GRABFLAG -> head to the enemy flag and take it
//   RETURN   -> carry the flag home; jink, and drop cover behind when chased
//   ESCORT   -> screen our flag carrier: follow, engage pursuers, build cover
//   DEFEND   -> hold a prepared ring in front of our own stand and dig in
//   BUILD    -> engineer work: build a defensive structure near the objective
//   TRENCH   -> dig/wall a fighting position; plans come from a four-structure
//               pool (trench, L-trench, bunker, firing-port bunker) chosen by
//               affordability and terrain viability
//   RETREAT  -> fall back when low HP, out of ammo, or surrounded
//
// Difficulty knobs (env):
//   SERVER_BOT_COUNT  bots per team (default 10)
//   SERVER_BOT_BLOCKS building budget per bot life (default 36)
//   SERVER_BOT_HP     max HP for bots (default 130 — beefier than players)
import { ServerPlayer } from './serverPlayer';
import type { ServerWorld } from './serverWorld';

import {
  Position,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  WEAPONS,
  type WeaponId,
  BLUE_FLAG_POS,
  RED_FLAG_POS,
  GROUND_LEVEL,
  WORLD_SIZE,
  CHUNK_SIZE,
  VOXEL_BUILT,
} from '../shared/types';

export type BotState =
  | 'ENGAGE'
  | 'FLANK'
  | 'CAMP'
  | 'ADVANCE'
  | 'GRABFLAG'
  | 'RETURN'
  | 'ESCORT'
  | 'DEFEND'
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
  /** Optional: clear a blocking voxel (used by stuck recovery when available). */
  digBlock?: (bot: ServerBot, pos: Position) => void;
}

const EYE_HEIGHT = 1.6;
const AIM_TOLERANCE_RAD = 0.14; // ~8 degrees
// Human reaction beat when a bot switches to a different target (seconds).
const TARGET_ACQUISITION_MIN = 0.25;
const TARGET_ACQUISITION_VARIANCE = 0.3;
const VISIBLE_RANGE = 75;
// How many ticks a single placed block "costs" in trench pace. Lowering this
// makes bots wall their trench faster (one block every other tick by default).
const TRENCH_BUILD_INTERVAL = 2;
// Withdrawal: how long a bot falls back before rejoining the fight, and how
// long it waits before it is willing to fall back again.
const RETREAT_MAX_SECONDS = 6;
const RETREAT_COOLDOWN_SECONDS = 10;
// A bot running for the enemy flag only aborts the run for enemies inside this
// range. Without it, any visible enemy anywhere on the map cancelled GRABFLAG,
// so a bot-only match never reached a flag stand at all (measured: zero flag
// pickups in 10 simulated minutes with a full 10v10 roster).
const OBJECTIVE_COMMIT_RANGE = 24;
// Inside this radius of the enemy stand the pickup is worth more than a
// midfield duel, so bots keep pushing for the flag instead of brawling.
const OBJECTIVE_PUSH_RANGE = 45;
// A flag runner only abandons the run at this fraction of max HP (normal bots
// retreat at 25%). Giving up at 25% near the enemy base meant nobody ever
// arrived with the flag.
const OBJECTIVE_RETREAT_HP = 0.15;
// Assault bots ignore contacts beyond this range while running for the flag.
// Duelling every 75m sighting is what kept the roster at midfield (measured:
// zero pickups in a 10-minute 10v10 bot-only match).
const ASSAULT_IGNORE_RANGE = 9;
// A carrier re-rolls its escape lane this often, and may drop cover this often.
const CARRIER_JINK_SECONDS = 2.2;
const PANIC_COVER_COOLDOWN = 3;

// Difficulty knobs (env-overridable so Render can tune without code changes)
const BOT_MAX_HP = Number(process.env.SERVER_BOT_HP ?? 130); // beefier than players (100)
const BOT_BLOCKS = Number(process.env.SERVER_BOT_BLOCKS ?? 36); // building budget per life

type TrenchCell = { x: number; y: number; z: number; roof?: boolean };

/** Defensive structures a builder may choose from. */
export type StructureKind = 'trench' | 'l-trench' | 'bunker' | 'bunker-ports';

export class ServerBot extends ServerPlayer {
  private botState: BotState = 'ADVANCE';
  private stateUntil: number = 0;
  private waypoint: Position | null = null;
  private campSpot: Position | null = null;
  private lastSeenEnemy: Position | null = null;
  private lastShotAt: number = -10;
  private aimTargetId: string | null = null;
  private aimTargetAt: number = 0;
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
  private trenchPlan: TrenchCell[] | null = null;
  private lastTrenchCell: number = 0;
  private trenchPaceTick: number = 0;
  private trenchCenter: Position | null = null;
  private trenchDoneAt: number | null = null; // when the plan drained (hold deadline)
  private lastTrenchAt: number = -100;
  private pinnedDownUntil: number = -100; // recently shot at -> dig/roof cover
  private retreatCooldownUntil: number = -100; // don't withdraw again immediately
  // Engineer blueprint: ordered list of remaining build cells (bastion/ramp)
  private buildPlan: TrenchCell[] | null = null;
  // Assault/support split, fixed for the bot's lifetime. Deterministic from the
  // id so it costs no RNG draw and stays stable across respawns.
  private readonly role: 'assault' | 'support';
  /** Perpendicular offset (-1..1) used to spread the assault wave on approach. */
  private readonly laneSeed: number;
  /** Carrier escape waypoint + when to re-roll the jink. */
  private returnWaypoint: Position | null = null;
  private nextJinkAt: number = 0;
  private lastCoverBuildAt: number = -100;
  /** Latest position of our own flag carrier, refreshed each tick for ESCORT. */
  private escortCarrierPos: Position | null = null;
  /** Where this support bot holds the line (in front of our own flag). */
  private defendPost: Position | null = null;
  /** Support engineers build a main structure plus one annex (0 = main, 1 = annex). */
  private fortifyStage: number = 0;
  /** Dedicated engineer: only these bots start firebases (panic cover stays universal). */
  private readonly engineer: boolean;
  private readonly logistics: boolean;
  /** Last structure this bot started (for tests / diagnostics). */
  private lastStructureKind: StructureKind | null = null;
  // Stuck detection: sampled once per second, needs two strikes to act.
  private lastProgressCheckAt: number = 0;
  private progressPos: Position = { x: 0, y: 0, z: 0 };
  private stuckStrikes: number = 0;
  private lastRecoveryAt: number = -100;

  /** Diagnostics for headless simulations/tests (not used for gameplay). */
  blocksPlaced: number = 0;
  structuresCompleted: Record<StructureKind, number> = {
    trench: 0,
    'l-trench': 0,
    bunker: 0,
    'bunker-ports': 0,
  };
  structuresStarted: Record<StructureKind, number> = {
    trench: 0,
    'l-trench': 0,
    bunker: 0,
    'bunker-ports': 0,
  };
  private structureBlocksPlaced: number = 0;
  private recoveryAttempts: number = 0;
  /** When the current assault push started staging (null = not waiting). */
  private stagingSince: number | null = null;
  // Wall-slide state: fully blocked movement picks a perpendicular direction
  // for a moment instead of pressing into the obstacle.
  private detourUntil: number = -1;
  private detourDir: number = 1;

  // Personality weights (per bot, slightly randomized)
  private aggroBias: number;
  private campBias: number;
  private buildBias: number;

  constructor(
    id: string,
    position: Position,
    team: 'red' | 'blue',
    name: string,
    engineer?: boolean,
    logistics?: boolean,
  ) {
    super(id, position, team);
    this.name = name;
    this.isBotFlag = true; // scoreboard: mark AI combatants as bots
    this.equipment = Math.random() < 0.5 ? 'rifle' : 'smg';
    // Magazine/reload come from the shared weapon table (no hardcoded 10/30).
    const gun = WEAPONS[this.equipment as WeaponId];
    this.magazineSize = gun ? gun.magazineSize : 0;
    this.currentAmmo = this.magazineSize;
    this.reloadTime = gun ? gun.reloadTime : 0;
    // Vicious: tougher than players (respawn() also honors maxHp)
    this.maxHp = BOT_MAX_HP;
    this.hp = BOT_MAX_HP;
    this.botBlocks = BOT_BLOCKS;
    // Smarter default personalities (higher aggression/building than before)
    this.aggroBias = 0.35 + Math.random() * 0.4;
    this.campBias = 0.15 + Math.random() * 0.25;
    this.buildBias = 0.3 + Math.random() * 0.35;
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    // ~60% commit to the flag run; the rest hold the defensive ring. Leaving
    // every bot on attack meant both waves collided in midfield and neither
    // stand was ever reached (measured: 0 captures in 10 simulated minutes).
    this.role = hash % 100 < 60 ? 'assault' : 'support';
    // The server normally assigns a guaranteed two engineers per team; the
    // hash is the fallback for standalone/test bots. Engineers build the
    // firebase while the rest of the squad fights and screens it.
    this.engineer = engineer ?? (hash % 5 === 0);
    this.logistics = logistics ?? false;
    this.laneSeed = (hash % 97) / 48.5 - 1; // -1..1, stable per bot
  }

  get stateName(): BotState {
    return this.botState;
  }

  /** Assault bots push the objective; support bots hold and dig in. */
  get roleName(): 'assault' | 'support' {
    return this.role;
  }

  /** Kind of the last defensive structure this bot started. */
  get lastStructure(): StructureKind | null {
    return this.lastStructureKind;
  }

  /** Whether this bot is one of the team's dedicated firebase engineers. */
  get isEngineer(): boolean {
    return this.engineer;
  }

  /** Whether this bot has the separate workshop logistics assignment. */
  get isLogistics(): boolean {
    return this.logistics;
  }

  /** Move toward a point using normal infantry obstacle avoidance. */
  approachJeep(target: Position, ctx: BotContext, dt: number): void {
    this.moveTo(target, dt, ctx, true);
  }

  /** Vehicle travel is not an infantry stuck sample or a continuation of a job. */
  resumeAfterJeep(now: number): void {
    this.velocity = { x: 0, y: 0, z: 0 };
    this.lastProgressCheckAt = now;
    this.progressPos = { ...this.position };
    this.stuckStrikes = 0;
    this.transition('GRABFLAG', now, 15);
  }

  /** Called by serverGame when this bot takes damage — enables revenge targeting. */
  noteHitBy(attackerId: string, now: number): void {
    this.lastAttackerId = attackerId;
    this.lastAttackedAt = now;
    // Being shot at counts as "pinned down": the bot will prefer digging a
    // fighting trench (with an anti-grenade roof) on its next decision.
    this.pinnedDownUntil = now + 6;
  }

  /** Called by serverGame when an enemy bullet snaps past this bot. */
  noteIncoming(now: number): void {
    if (now > this.pinnedDownUntil) this.pinnedDownUntil = now + 3;
  }

  /**
   * Called every server tick instead of player.update(). Moves the bot,
   * aims, shoots, camps, flanks and builds through the provided context.
   */
  botUpdate(dt: number, ctx: BotContext): void {
    if (this.isDead) return;
    this.updateReload();
    // Keep the gun fed wherever we are: a dry magazine mid-run should cost a
    // reload, not the objective.
    if (this.currentAmmo <= 0 && !this.isReloading) this.startReload();
    this.checkProgress(ctx);

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

    // Our flag is on the move: support bots screen the carrier home. This is
    // what turns a lucky pickup into an actual capture — a lone carrier dies
    // to the first chaser (measured: 1 pickup, 0 captures before escorts).
    const friendlyCarrier = ctx.targets.find(
      (cand) => !cand.isDead && cand.team === this.team && cand.carryingFlag,
    ) ?? null;
    this.escortCarrierPos = friendlyCarrier
      ? { x: friendlyCarrier.position.x, y: friendlyCarrier.position.y, z: friendlyCarrier.position.z }
      : null;

    // --- Reactive overrides (checked every tick) ---
    const distToEnemyFlag = Math.hypot(
      enemyFlag.x - this.position.x,
      enemyFlag.z - this.position.z,
    );
    const onObjectiveRun = this.botState === 'GRABFLAG' || this.botState === 'RETURN';
    if (this.needsRetreat(nearestDist, onObjectiveRun)) {
      // Only START a withdrawal; re-transitioning every tick kept resetting
      // the retreat deadline, so the bot never finished falling back.
      if (this.botState !== 'RETREAT' && t >= this.retreatCooldownUntil) {
        this.transition('RETREAT', t, RETREAT_MAX_SECONDS);
      }
    } else if (this.carryingFlag) {
      // Long enough for a 320m run home; the old 10s window expired mid-run
      // and flipped the carrier back into GRABFLAG waypoint churn.
      if (this.botState !== 'RETURN') this.transition('RETURN', t, 60);
    } else if (
      this.escortCarrierPos &&
      this.botState !== 'RETREAT' &&
      this.botState !== 'ESCORT' &&
      Math.hypot(this.escortCarrierPos.x - this.position.x, this.escortCarrierPos.z - this.position.z) < 120
    ) {
      this.transition('ESCORT', t, 8);
    } else if (nearest && this.botState !== 'RETREAT') {
      // An assault runner treats distant contacts as scenery: only an enemy
      // inside ASSAULT_IGNORE_RANGE (or one carrying our flag) pulls it into a
      // fight. This is what lets a wave actually reach the stand.
      const assaultPush =
        this.role === 'assault' &&
        !nearest.carryingFlag &&
        nearestDist > ASSAULT_IGNORE_RANGE;
      if (distToEnemyFlag < OBJECTIVE_PUSH_RANGE || assaultPush) {
        // In the enemy base: take the stand. Without this a bot that saw any
        // defender within ~75m picked a duel instead and the flag was never
        // touched (measured: zero pickups in a bot-only match).
        if (this.botState !== 'GRABFLAG') this.transition('GRABFLAG', t, 15);
      } else {
        // A runner keeps running: only close contacts may pull it off the
        // objective. It still shoots back from inside doGrabFlag.
        const committedToRun =
          this.botState === 'GRABFLAG' && nearestDist > OBJECTIVE_COMMIT_RANGE;
        if (!committedToRun) this.combatReaction(nearest, nearestDist, ctx, t);
      }
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
        this.doGrabFlag(ctx, enemyFlag, nearest, nearestDist, t);
        break;
      case 'RETURN':
        this.doReturn(ctx, homeBase, nearest, nearestDist, t);
        break;
      case 'ESCORT':
        this.doEscort(ctx, nearest, nearestDist, t);
        break;
      case 'DEFEND':
        this.doDefend(ctx, homeBase, nearest, nearestDist, t);
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
    // Never interrupt an engineer mid-dig / mid-blueprint: a half-finished
    // wall is worse than none, so random re-decisions (GRABFLAG coin-flips,
    // BUILD rolls, wander timers) must not cancel it. Explicit overrides
    // still apply: carryingFlag -> RETURN and needsRetreat -> RETREAT are
    // checked earlier in botUpdate() and call transition('RETURN'/'RETREAT'),
    // which is allowed.
    if (this.botState === 'TRENCH' || this.botState === 'BUILD') {
      // The lock only holds while a plan is actually pending. Finishing (or
      // abandoning) the work clears the plan and then asks to leave
      // TRENCH/BUILD itself; blocking that trapped the bot in the state with
      // no plan left to execute, so it stood frozen for the rest of the round.
      const planPending = this.botState === 'TRENCH' ? this.trenchPlan !== null : this.buildPlan !== null;
      if (planPending && state !== 'RETURN' && state !== 'RETREAT') {
        // Still refresh the timer so doTrench()/doBuild()'s "done" hold logic
        // doesn't expire while we're mid-wall and keep us locked in state.
        this.stateUntil = now + Math.max(duration, 2);
        return;
      }
      this.trenchPlan = null; // abandoning the dig to flee/return the flag
      this.trenchCenter = null;
      this.trenchDoneAt = null;
      this.buildPlan = null;
    }
    if (this.botState !== state) {
      this.botState = state;
      this.waypoint = null;
      this.stagingSince = null;
      if (state !== 'CAMP') this.campSpot = null;
    }
    this.stateUntil = now + duration;
  }

  private needsRetreat(nearestDist: number, objectiveRun: boolean = false): boolean {
    const lowHp = this.hp <= (objectiveRun ? OBJECTIVE_RETREAT_HP : 0.25) * this.maxHp;
    // An empty magazine is NOT a reason to retreat: it used to send a runner
    // 300m home every time a mag ran dry (measured: 5-7 of 20 bots permanently
    // withdrawing). Reloading is handled in botUpdate, so only real danger
    // (low HP or a close-range beating) triggers a fallback.
    const closeContact = nearestDist < 9 && this.hp <= 0.55 * this.maxHp;
    return lowHp || closeContact;
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
    // Support role: hold the defensive ring instead of joining the attack.
    // (Returning our own dropped flag is still handled first.)
    const supportDefend = this.role === 'support';

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

    if (supportDefend) {
      this.transition('DEFEND', t, 10);
      return;
    }

    // Assault role: keep pressure on the stand. The only detours are a friendly
    // flag to return (handled above) and an occasional forward firebase dug
    // 40-95m short of the stand, so the last push starts from cover.
    if (this.role === 'assault') {
      if (
        this.engineer &&
        this.fortifyStage === 0 &&
        distToEnemyFlag > 40 && distToEnemyFlag < 95 &&
        this.remainingBlocks >= 12 &&
        t - this.lastTrenchAt > 22 &&
        Math.random() < this.buildBias * 0.5
      ) {
        this.startStructure(ctx);
        return;
      }
      this.transition('GRABFLAG', t, 15);
      return;
    }

    // Priority 2: grab the enemy flag when reasonably free. Radius scales
    // with the map (flags are now 320m apart, so midfield is ~160m out;
    // was a fixed 120 which made bots ignore the objective on the big map).
    const GRABFLAG_RADIUS = WORLD_SIZE / 2;
    if (distToEnemyFlag < GRABFLAG_RADIUS && Math.random() < 0.55) {
      this.transition('GRABFLAG', t, 12);
      return;
    }

    // Priority 3: engineer work near the enemy base (bastion + ramp). Only
    // start fresh blueprints; a bot already mid-build keeps building via the
    // TRENCH/BUILD lock in transition(). The Math.random() roll must happen
    // *after* all cheap gates — early rolls desync the deterministic RNG
    // sequences used by the trench regression test.
    if (distToEnemyFlag < 45 && this.remainingBlocks > 10 && !this.buildPlan) {
      if (Math.random() < this.buildBias) {
        this.transition('BUILD', t, 6);
        return;
      }
    }

    // Priority 3b: dig a fighting trench. Triggers are contextual now:
    //  - pinned down recently (someone just shot at us): dig almost anywhere
    //    on our side of midfield — engineers under fire earn their keep
    //  - otherwise: midfield lane hold, when most of the block budget is left
    const midZ = (BLUE_FLAG_POS.z + RED_FLAG_POS.z) / 2;
    const towardEnemy = enemyFlag.z > this.position.z ? 1 : -1;
    const signedMid = (this.position.z - midZ) * towardEnemy; // <0 = own half
    const pinned = t < this.pinnedDownUntil;
    const dugRecently = t - this.lastTrenchAt > 25;
    const midfieldTrigger =
      Math.abs(signedMid) < 40 && this.remainingBlocks >= BOT_BLOCKS * 0.5 && dugRecently;
    const reactiveTrigger =
      pinned && signedMid < 5 && distToEnemyFlag > 55 && this.remainingBlocks >= 8 && dugRecently;
    if ((midfieldTrigger || reactiveTrigger) && !this.trenchPlan) {
      if (Math.random() < this.buildBias * (pinned ? 1.6 : 0.8)) {
        this.startStructure(ctx);
      }
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
      this.aimTargetId = null;
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

    // Kiting: with an empty magazine, break line of sight and reload instead of
    // standing in the open. A rifle bot also holds its range band (see strafe).
    if (this.isReloading && dist < 26) {
      this.breakContact(enemy.position, step, ctx);
    } else {
      // Strafe while shooting — never walk straight into the barrel
      this.strafeAround(enemy.position, step, ctx, dist);
    }
    this.aimAndShoot(enemy, ctx, t);

    // Trading shots in the open at low HP: put a block between us and the gun.
    if (this.hp < this.maxHp * 0.6 && t < this.pinnedDownUntil) {
      this.buildPanicCover(enemy.position, ctx, t);
    }

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

  private doGrabFlag(
    ctx: BotContext,
    enemyFlag: { x: number; z: number },
    enemy: BotTargetInfo | null,
    dist: number,
    t: number,
  ): void {
    const startDist = Math.hypot(enemyFlag.x - this.position.x, enemyFlag.z - this.position.z);
    // Don't trickle into the stand alone: if no teammate is nearby and no
    // enemy is already in our face, pause briefly at the rally point so the
    // next wave can form up. The timer is capped, so a lone bot still attacks.
    const mateNear = ctx.targets.some((mate) =>
      mate.id !== this.id &&
      !mate.isDead &&
      mate.team === this.team &&
      Math.hypot(mate.position.x - this.position.x, mate.position.z - this.position.z) < 18,
    );
    const threatNear = enemy !== null && dist < 25;
    if (!mateNear && !threatNear && startDist > 25 && startDist < 90) {
      if (this.stagingSince === null) this.stagingSince = t;
      if (t - this.stagingSince < 2.5) {
        this.velocity.x = 0;
        this.velocity.z = 0;
        this.snapToGround(ctx);
        this.faceToward(enemyFlag.x, enemyFlag.z);
        if (enemy && dist < 45) this.aimAndShoot(enemy, ctx, t);
        return;
      }
    } else {
      this.stagingSince = null;
    }
    // Spread the approach: assault bots run their own lane far out and converge
    // near the stand, so several arrive at once instead of single file.
    // Wide lanes (±90m) keep runners out of the midfield meat grinder and
    // converge only near the stand.
    const lane = this.role === 'assault' ? this.laneSeed * 90 * Math.min(1, Math.max(0, (startDist - 25) / 120)) : 0;
    const wp: Position = { x: enemyFlag.x + lane, y: GROUND_LEVEL, z: enemyFlag.z };
    this.moveTo(wp, dtOf(ctx), ctx, true);
    // Fire on the move: a committed runner must not be a free kill.
    if (enemy && dist < 45) this.aimAndShoot(enemy, ctx, t);
    // Suppressing fire is not worth stopping for; keep the feet moving.
    const d = Math.hypot(wp.x - this.position.x, wp.z - this.position.z);
    if (d < 3) {
      // Attempt pickup via context-driven game logic: rely on auto-pickup
      // in serverGame.checkFlagCaptures which runs each tick — just linger.
      this.velocity = { x: 0, y: 0, z: 0 };
    }
  }

  private doReturn(ctx: BotContext, homeBase: { x: number; z: number }, enemy: BotTargetInfo | null, dist: number, t: number): void {
    const step = dtOf(ctx);

    // Jink: re-roll a lateral escape point so a chaser cannot hold a straight
    // line on us. Speed alone does not save a carrier (same sprint speed as the
    // chaser), so the run is about breaking line of sight, not outrunning.
    if (t >= this.nextJinkAt || !this.returnWaypoint) {
      // Evaluate a few escape lanes and prefer one the nearest threat cannot
      // see. Carriers were dying in the open to rifle fire from 60m+; walls
      // only help once the shooter is close, so terrain cover is the real kite.
      const candidates = [0, -12, 12, -26, 26];
      const threat = enemy?.position ?? null;
      let best: Position | null = null;
      let bestScore = -Infinity;
      for (const off of candidates) {
        const cand: Position = { x: homeBase.x + off, y: GROUND_LEVEL, z: homeBase.z };
        let score = 100 - Math.abs(off) * 0.25; // slight preference for a direct run
        if (threat) {
          const hidden = !ctx.canSee(
            { x: threat.x, y: threat.y + 1.1, z: threat.z },
            { x: cand.x, y: GROUND_LEVEL + 1.2, z: cand.z },
          );
          if (hidden) score += 70;
          score += Math.min(40, Math.hypot(cand.x - threat.x, cand.z - threat.z) * 0.2);
        }
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      this.returnWaypoint = best ?? { x: homeBase.x, y: GROUND_LEVEL, z: homeBase.z };
      this.nextJinkAt = t + CARRIER_JINK_SECONDS;
    }
    this.moveTo(this.returnWaypoint, step, ctx, true);

    if (enemy) {
      // Only fight what is literally in the face; duelling mid-run loses the flag.
      if (dist < 16) this.aimAndShoot(enemy, ctx, t);
      // Drop a wall between us and the shooter to break the chase. Long-range
      // rifle fire kills carriers at 60m+, so cover is worth placing early.
      if (dist < 80) this.buildPanicCover(enemy.position, ctx, t);
    }
  }

  /**
   * Screen the carrier: travel a few metres behind, shoot anything that closes
   * on it, and drop cover between the carrier and a nearby pursuer.
   */
  private doEscort(ctx: BotContext, enemy: BotTargetInfo | null, dist: number, t: number): void {
    const carrier = this.escortCarrierPos;
    if (!carrier) {
      this.transition('ADVANCE', t, 5);
      return;
    }
    const dx = carrier.x - this.position.x;
    const dz = carrier.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    // Sit behind the carrier on our own side (the carrier runs away from the
    // enemy base, so "behind" is the side the enemy will chase from).
    const wp: Position = { x: carrier.x - (dx / len) * 4.5, y: GROUND_LEVEL, z: carrier.z - (dz / len) * 4.5 };
    const d = Math.hypot(wp.x - this.position.x, wp.z - this.position.z);
    if (d > 2) this.moveTo(wp, dtOf(ctx), ctx, true);

    if (enemy) {
      if (dist < 55) this.aimAndShoot(enemy, ctx, t);
      if (dist < 30) this.buildPanicCover(enemy.position, ctx, t);
    }

    const carrierDist = Math.hypot(carrier.x - this.position.x, carrier.z - this.position.z);
    if (carrierDist > 90) this.transition(this.role === 'assault' ? 'GRABFLAG' : 'ADVANCE', t, 5);
  }

  /**
   * Hold the line: stand on a prepared post in front of our own flag, shoot the
   * approach, dig in when shot at, and break off to intercept a carrier.
   */
  private doDefend(
    ctx: BotContext,
    homeBase: { x: number; z: number },
    enemy: BotTargetInfo | null,
    dist: number,
    t: number,
  ): void {
    const towardEnemy = this.team === 'blue' ? 1 : -1;
    if (!this.defendPost) {
      this.defendPost = {
        x: homeBase.x + this.laneSeed * 22,
        y: GROUND_LEVEL,
        z: homeBase.z + towardEnemy * 26,
      };
    }
    const post = this.defendPost;

    // A carrier heading for our flag outranks the post: cut it off.
    if (enemy?.carryingFlag) {
      this.moveTo(enemy.position, dtOf(ctx), ctx, true);
      if (dist < 45) this.aimAndShoot(enemy, ctx, t);
      return;
    }

    const dPost = Math.hypot(post.x - this.position.x, post.z - this.position.z);
    if (dPost > 2.5) {
      this.moveTo(post, dtOf(ctx), ctx, false);
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.snapToGround(ctx);
      this.faceToward(homeBase.x, homeBase.z + towardEnemy * 100);
      // Build before contact, not only after being shot. A prepared engineer
      // turns the post into cover; waiting for `pinnedDownUntil` meant most
      // support bots died before placing more than a couple of blocks.
      const quietPost = !enemy || dist > 32;
      const underFire = t < this.pinnedDownUntil;
      if (
        this.engineer &&
        this.fortifyStage === 0 &&
        this.remainingBlocks >= 14 &&
        t - this.lastTrenchAt > 20 &&
        (quietPost || underFire)
      ) {
        this.startStructure(ctx);
        return;
      }
    }

    if (enemy && dist < 65) this.aimAndShoot(enemy, ctx, t);
    if (enemy && dist < 25) this.buildPanicCover(enemy.position, ctx, t);
  }

  private doBuild(ctx: BotContext, enemyFlag: { x: number; z: number }, t: number): void {
    // Engineer work: generate one blueprint (bastion + L ramp) on entry, then
    // consume it cell by cell. If a friendly structure already exists in the
    // area, link our wall onto it instead of building an isolated shed.
    if (!this.buildPlan) {
      const towardEnemy = enemyFlag.z > this.position.z ? 1 : -1;
      const center = { x: Math.round(this.position.x), z: Math.round(this.position.z) };
      const plan = this.chooseStructure(ctx, center, towardEnemy);
      this.buildPlan = plan ? plan.cells : [];
      if (plan) {
        this.lastStructureKind = plan.kind;
        this.structuresStarted[plan.kind] += 1;
        this.structureBlocksPlaced = 0;
      }
      if (this.buildPlan.length === 0) {
        this.transition('GRABFLAG', t, 10);
        return;
      }
    }
    // Move to the worksite (first cell's ground position) until we're close
    const site = this.buildPlan[0];
    const near: Position = { x: site.x + 0.5, y: GROUND_LEVEL, z: site.z + 2.5 };
    const d = Math.hypot(near.x - this.position.x, near.z - this.position.z);
    if (d > 3) {
      this.moveTo(near, dtOf(ctx), ctx, true);
      return;
    }
    // Pace: one placed block every TRENCH_BUILD_INTERVAL ticks
    this.trenchPaceTick++;
    if (this.trenchPaceTick >= TRENCH_BUILD_INTERVAL && this.remainingBlocks > 0) {
      this.trenchPaceTick = 0;
      let attempts = 0;
      while (this.buildPlan.length > 0 && attempts < 8) {
        const cell = this.buildPlan.shift()!;
        attempts++;
        if (!ctx.world.canBuild(cell.x, cell.y, cell.z)) continue;
        if (this.cellOverlapsBody(cell)) continue;
        ctx.buildBlock(this, { x: cell.x, y: cell.y, z: cell.z });
        this.botBlocks--;
        this.blocksPlaced++;
        this.structureBlocksPlaced++;
        break;
      }
    }
    if (this.buildPlan.length === 0 || this.remainingBlocks <= 1 || t >= this.stateUntil + 8) {
      if (this.buildPlan.length === 0 && this.structureBlocksPlaced > 0 && this.lastStructureKind) {
        this.structuresCompleted[this.lastStructureKind]++;
      }
      this.buildPlan = null;
      this.structureBlocksPlaced = 0;
      this.transition('GRABFLAG', t, 10);
    }
  }

  private doRetreat(ctx: BotContext, homeBase: { x: number; z: number }, t: number): void {
    const step = dtOf(ctx);
    const wp: Position = { x: homeBase.x, y: GROUND_LEVEL, z: homeBase.z + (this.team === 'blue' ? -18 : 18) };
    this.moveTo(wp, step, ctx, true);
    // The withdrawal is time-boxed. Bots never regenerate HP, so the old
    // "leave once hp > 45" gate could never be met and low-HP bots sat at the
    // rear for the rest of the round. Rejoin when the retreat window expires,
    // then only fall back again after a cooldown so they don't ping-pong.
    if (t >= this.stateUntil) {
      this.retreatCooldownUntil = t + RETREAT_COOLDOWN_SECONDS;
      this.transition('ADVANCE', t, 6);
    }
  }

  // ---------------- Trench building ----------------

  /**
   * Lay out a trench plan: a fighting position perpendicular to the advance
   * axis, centered on the bot. Smarts:
   *  - adaptive length from the remaining block budget (short wall when low)
   *  - follows the terrain contour: each column's height is measured at its
   *    own X so the wall stays exactly 2 blocks high even on slopes
   *  - parapet steps at both ends for firing over
   *  - an overhead roof strip when the bot was pinned down while digging
   * Cells are consumed one per paced tick in doTrench(), so the trench rises
   * progressively like real engineers working.
   */
  // ---------------- Defensive structure pool ----------------

  /** Every structure a builder can choose from. */
  private static readonly STRUCTURE_KINDS: StructureKind[] = [
    'trench',
    'l-trench',
    'bunker',
    'bunker-ports',
  ];

  /**
   * Start digging/building a defensive structure at the bot's position.
   * Picks randomly from the structures that are affordable and valid for the
   * terrain here; a `forced` kind is used by tests and diagnostics.
   */
  private startStructure(
    ctx: BotContext,
    forced?: StructureKind,
    centerOverride?: { x: number; z: number },
  ): void {
    const enemyFlag = this.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    const towardEnemy = enemyFlag.z > this.position.z ? 1 : -1;
    const center = centerOverride ?? { x: Math.round(this.position.x), z: Math.round(this.position.z) };
    const plan = this.chooseStructure(ctx, center, towardEnemy, forced);
    this.lastTrenchAt = ctx.serverTime;
    if (!plan) {
      // Nothing affordable or valid on this ground: don't stand around "digging".
      this.transition('ADVANCE', ctx.serverTime, 3);
      return;
    }
    this.lastStructureKind = plan.kind;
    this.structuresStarted[plan.kind]++;
    this.structureBlocksPlaced = 0;
    this.trenchPlan = plan.cells;
    this.lastTrenchCell = 0;
    this.trenchPaceTick = 0;
    this.trenchDoneAt = null;
    this.trenchCenter = { x: center.x, y: GROUND_LEVEL, z: center.z };
    this.transition('TRENCH', ctx.serverTime, 14);
  }

  /** Random valid structure for this ground and block budget (null = none). */
  private chooseStructure(
    ctx: BotContext,
    center: { x: number; z: number },
    towardEnemy: number,
    forced?: StructureKind,
  ): { kind: StructureKind; cells: TrenchCell[] } | null {
    const budget = this.remainingBlocks;
    const kinds = forced ? [forced] : ServerBot.STRUCTURE_KINDS;
    const options: Array<{ kind: StructureKind; cells: TrenchCell[] }> = [];
    for (const kind of kinds) {
      const cells = this.planStructure(ctx, kind, center, towardEnemy);
      if (cells.length === 0) continue;
      if (cells.length > budget) continue; // resource limit
      if (!this.structureIsViable(ctx, kind, cells)) continue;
      options.push({ kind, cells });
    }
    if (options.length === 0) return null;
    return options[Math.floor(Math.random() * options.length)];
  }

  private planStructure(
    ctx: BotContext,
    kind: StructureKind,
    center: { x: number; z: number },
    towardEnemy: number,
  ): TrenchCell[] {
    switch (kind) {
      case 'l-trench':
        return this.planLTrench(ctx, center, towardEnemy);
      case 'bunker':
        return this.planBunker(ctx, center, towardEnemy, false);
      case 'bunker-ports':
        return this.planBunker(ctx, center, towardEnemy, true);
      case 'trench':
      default:
        return this.planFireTrench(ctx, center, towardEnemy);
    }
  }

  /**
   * Viability: enough of the wall cells must be placeable on this ground, and
   * bunkers need a roughly flat footprint (roof cells are skipped — they only
   * become buildable once their wall exists).
   */
  private structureIsViable(ctx: BotContext, kind: StructureKind, cells: TrenchCell[]): boolean {
    const walls = cells.filter((c) => !c.roof);
    if (walls.length === 0) return false;
    let placeable = 0;
    for (const c of walls) if (ctx.world.canBuild(c.x, c.y, c.z)) placeable++;
    const ratio = placeable / walls.length;
    if (kind === 'bunker' || kind === 'bunker-ports') {
      if (ratio < 0.5) return false;
      const grounds = walls.map((c) => ctx.world.getGroundHeight(c.x, c.z));
      return Math.max(...grounds) - Math.min(...grounds) <= 2;
    }
    return ratio >= 0.4;
  }

  /**
   * Straight fighting wall: adaptive width, 2 high, parapets at the ends and a
   * roof strip when dug under fire. Cells rest at `getGroundHeight()` (the first
   * air cell), which is what `canBuild()` accepts as supported.
   */
  private planFireTrench(
    ctx: BotContext,
    center: { x: number; z: number },
    towardEnemy: number,
  ): TrenchCell[] {
    const cells: TrenchCell[] = [];
    const underFire = ctx.serverTime < this.pinnedDownUntil;
    const budget = this.remainingBlocks;
    const half = budget >= 24 ? 4 : budget >= 16 ? 3 : budget >= 10 ? 2 : 1;
    // The wall goes BETWEEN the bot and the enemy; the bot crouches behind it.
    const wallZ = center.z + towardEnemy * 2;
    for (let dx = -half; dx <= half; dx++) {
      const groundY = ctx.world.getGroundHeight(center.x + dx, wallZ);
      for (let h = 0; h < 2; h++) {
        cells.push({ x: center.x + dx, y: groundY + h, z: wallZ });
      }
      if (Math.abs(dx) === half && budget >= 16) {
        cells.push({ x: center.x + dx, y: groundY + 2, z: wallZ });
      }
    }
    if (underFire && budget >= 20) {
      const roofY = ctx.world.getGroundHeight(center.x, center.z) + 3;
      for (let dx = -1; dx <= 1; dx++) {
        cells.push({ x: center.x + dx, y: roofY, z: wallZ, roof: true });
      }
    }
    return cells;
  }

  /** L-shaped trench: a short front wall plus a perpendicular return arm. */
  private planLTrench(
    ctx: BotContext,
    center: { x: number; z: number },
    towardEnemy: number,
  ): TrenchCell[] {
    const cells: TrenchCell[] = [];
    const half = 2;
    const wallZ = center.z + towardEnemy * 2;
    for (let dx = -half; dx <= half; dx++) {
      const groundY = ctx.world.getGroundHeight(center.x + dx, wallZ);
      for (let h = 0; h < 2; h++) {
        cells.push({ x: center.x + dx, y: groundY + h, z: wallZ });
      }
    }
    // Return arm on the bot's preferred side, running back toward friendly ground.
    const side = this.laneSeed >= 0 ? 1 : -1;
    const armX = center.x + side * half;
    for (let i = 1; i <= 3; i++) {
      const z = wallZ - towardEnemy * i;
      const groundY = ctx.world.getGroundHeight(armX, z);
      for (let h = 0; h < 2; h++) {
        cells.push({ x: armX, y: groundY + h, z });
      }
    }
    return cells;
  }

  /**
   * Small bunker: front wall, two short side walls, and a roofed front row.
   * The `ports` variant is one block taller and leaves two head-height firing
   * slits in the front wall. The back stays open so the bot can walk in.
   */
  private planBunker(
    ctx: BotContext,
    center: { x: number; z: number },
    towardEnemy: number,
    ports: boolean,
  ): TrenchCell[] {
    const cells: TrenchCell[] = [];
    // Basic bunker is 3 wide / 2 high; the firing-port variant is 5 wide /
    // 3 high with two head-height slits (at dx -1 and +1).
    const offsets = ports ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
    const height = ports ? 3 : 2;
    const wallZ = center.z + towardEnemy * 2;
    const sideZ = center.z + towardEnemy;

    for (const dx of offsets) {
      const groundY = ctx.world.getGroundHeight(center.x + dx, wallZ);
      for (let h = 0; h < height; h++) {
        const isFiringPort = ports && h === 1 && (dx === -1 || dx === 1);
        if (isFiringPort) continue;
        cells.push({ x: center.x + dx, y: groundY + h, z: wallZ });
      }
    }
    for (const side of [offsets[0], offsets[offsets.length - 1]]) {
      for (const z of [wallZ, sideZ]) {
        const groundY = ctx.world.getGroundHeight(center.x + side, z);
        for (let h = 0; h < 2; h++) {
          cells.push({ x: center.x + side, y: groundY + h, z });
        }
      }
    }
    // Roof only over the front row: those cells sit on the finished wall, which
    // is what the support check requires. Built last, so it arrives supported.
    const roofY = ctx.world.getGroundHeight(center.x, center.z) + height;
    for (const dx of offsets) {
      cells.push({ x: center.x + dx, y: roofY, z: wallZ, roof: true });
    }
    return cells;
  }

  // ---------------- Stuck detection & recovery ----------------

  /** Sample movement once per second; two dead samples in a row mean stuck. */
  private checkProgress(ctx: BotContext): void {
    const t = ctx.serverTime;
    if (t - this.lastProgressCheckAt < 1) return;
    this.lastProgressCheckAt = t;
    const moved = Math.hypot(
      this.position.x - this.progressPos.x,
      this.position.z - this.progressPos.z,
    );
    this.progressPos = { x: this.position.x, y: this.position.y, z: this.position.z };

    // These states are supposed to stand still (digging, holding a post, or
    // waiting at the enemy stand for the automatic flag pickup). Treating the
    // stand wait as "stuck" made runners abandon a flag they were touching.
    const objectiveStand = this.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    const waitingAtStand =
      this.botState === 'GRABFLAG' &&
      Math.hypot(objectiveStand.x - this.position.x, objectiveStand.z - this.position.z) < 4;
    const stationaryByDesign =
      this.botState === 'CAMP' ||
      this.botState === 'TRENCH' ||
      this.botState === 'BUILD' ||
      this.botState === 'DEFEND' ||
      waitingAtStand;
    if (stationaryByDesign || moved > 0.6) {
      this.stuckStrikes = 0;
      if (moved > 0.6) this.recoveryAttempts = 0;
      return;
    }
    this.stuckStrikes++;
    if (this.stuckStrikes >= 2) this.recoverFromStuck(ctx, t);
  }

  /**
   * Bounded recovery: clear a block ahead if possible, otherwise re-route to a
   * fresh waypoint. Attempts are rate-limited and capped; once the cap is hit
   * the bot drops its current task and re-plans instead of retrying forever.
   */
  private recoverFromStuck(ctx: BotContext, t: number): void {
    this.stuckStrikes = 0;
    if (t - this.lastRecoveryAt < 2.5) return; // no retry storms
    this.lastRecoveryAt = t;
    this.recoveryAttempts++;

    const fwd = this.forwardDir();
    const aheadX = this.position.x + fwd.x * 1.4;
    const aheadZ = this.position.z + fwd.z * 1.4;
    const bodyY = Math.round(this.position.y + 1);

    // 1. Clear the obstruction if the server allows digging and we haven't
    //    already spent this recovery cycle's attempts on blocks.
    if (ctx.digBlock && this.recoveryAttempts <= 3) {
      for (const y of [bodyY, bodyY - 1]) {
        const gx = Math.round(aheadX);
        const gz = Math.round(aheadZ);
        if (ctx.world.isSolid(gx, y, gz)) {
          ctx.digBlock(this, { x: gx, y, z: gz });
          this.detourDir *= -1; // try the other side once the block is gone
          return;
        }
      }
    }

    // 2. Reposition: a new waypoint off to the side forces a fresh path.
    const side = this.detourDir;
    const wx = this.position.x + -fwd.z * side * 10 + fwd.x * 4;
    const wz = this.position.z + fwd.x * side * 10 + fwd.z * 4;
    this.waypoint = { x: wx, y: GROUND_LEVEL, z: wz };
    this.wanderUntil = t + 4;
    this.transition('ADVANCE', t, 4);

    // 3. Repeated failures: ditch the task, clear plans and re-plan from scratch.
    if (this.recoveryAttempts >= 4) {
      this.recoveryAttempts = 0;
      this.trenchPlan = null;
      this.buildPlan = null;
      this.defendPost = null;
      this.botState = 'ADVANCE';
      this.stateUntil = t + 5;
      this.waypoint = null;
    }
  }

  private doTrench(ctx: BotContext, t: number): void {
    const step = dtOf(ctx);
    if (!this.trenchPlan || this.remainingBlocks <= 0) {
      this.finishTrench(ctx, t);
      return;
    }
    // Pace construction: one placed block every TRENCH_BUILD_INTERVAL ticks,
    // skipping cells we can't legally build on (occupied / unsupported / OOB).
    this.trenchPaceTick++;
    if (this.trenchPaceTick >= TRENCH_BUILD_INTERVAL) {
      this.trenchPaceTick = 0;
      let attempts = 0;
      while (this.lastTrenchCell < this.trenchPlan.length && attempts < 8) {
        const cell = this.trenchPlan[this.lastTrenchCell];
        this.lastTrenchCell++;
        attempts++;
        if (ctx.world.canBuild(cell.x, cell.y, cell.z)) {
          // Never bury ourselves or occupy stand-inside cells
          if (this.cellOverlapsBody(cell)) continue;
          ctx.buildBlock(this, { x: cell.x, y: cell.y, z: cell.z });
          this.botBlocks--;
          this.blocksPlaced++;
          this.structureBlocksPlaced++;
          break; // one placed block per paced tick
        }
      }
    }
    // Stand inside the trench center while building (crouch behind the wall).
    // The center is captured at layout time so walking there never cancels
    // the dig (the old code compared the bot against its own position —
    // distance always 0 — which silently froze progress once it moved).
    const center = this.trenchCenter ?? { x: this.position.x, y: GROUND_LEVEL, z: this.position.z };
    const d = Math.hypot(center.x - this.position.x, center.z - this.position.z);
    if (d > 1.5) this.moveTo(center, step, ctx, false);
    else {
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.snapToGround(ctx);
    }
    this.isCrouching = true;

    if (this.lastTrenchCell >= this.trenchPlan.length) {
      // Done digging: hold the trench briefly, scanning toward the enemy lane.
      // The hold has its own deadline: combat re-decisions refresh stateUntil,
      // so waiting on that timer could postpone the exit forever.
      if (this.trenchDoneAt === null) {
        this.trenchDoneAt = t;
        if (this.structureBlocksPlaced > 0 && this.lastStructureKind) {
          this.structuresCompleted[this.lastStructureKind]++;
        }
      }
      if (t - this.trenchDoneAt >= 2) {
        this.finishTrench(ctx, t);
      }
    }
  }

  /** Cleanly exit the dig: clear the plan and transition onward. */
  private finishTrench(ctx: BotContext, t: number): void {
    this.trenchPlan = null;
    this.trenchCenter = null;
    const enemyFlag = this.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;

    // A support engineer's job is a position, not a single wall. When the
    // first structure is finished and the site is quiet, add an annex 10m to
    // the side using the remaining blocks. This turns a single small wall
    // into a real two-part firebase instead of one shed.
    if (
      this.engineer &&
      this.role === 'support' &&
      this.fortifyStage === 0 &&
      this.remainingBlocks >= 10 &&
      !this.hasNearbyEnemy(ctx, 28)
    ) {
      this.fortifyStage = 1;
      this.startStructure(ctx, undefined, {
        x: Math.round(this.position.x) + 10,
        z: Math.round(this.position.z),
      });
      return;
    }
    // One firebase per life: never let an engineer chain-build across the map.
    this.fortifyStage = 2;

    const spot = this.findCampSpot(ctx, { x: enemyFlag.x, y: GROUND_LEVEL, z: enemyFlag.z });
    if (spot && this.remainingBlocks > 0) {
      // Hold our own new trench as a camp first — don't wander off cover
      this.campSpot = { x: this.position.x, y: GROUND_LEVEL, z: this.position.z };
      this.waypoint = { ...this.campSpot };
      this.transition('CAMP', t, 6);
    } else {
      this.transition('ADVANCE', t, 6);
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
      [nx * 0.7 + 0.7 * -nz, nz * 0.7 + 0.7 * nx], // left 45
      [nx * 0.7 - 0.7 * -nz, nz * 0.7 - 0.7 * nx], // right 45
      [-nz, nx], // hard left
      [nz, -nx], // hard right
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
      // Fully blocked (wall / trench line). Pressing straight into it just pins
      // the bot against the block, so slide along it and look for a gap.
      const now = ctx.serverTime;
      if (now >= this.detourUntil) {
        this.detourDir = Math.random() < 0.5 ? -1 : 1;
        this.detourUntil = now + 0.8;
      }
      chosen = [-nz * this.detourDir, nx * this.detourDir];
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
    // Weapon-aware spacing: the rifle holds a marksman band and kites away from
    // SMG range; the SMG closes to knife range instead of duelling at 30m.
    const preferred = this.equipment === 'rifle' ? 34 : 9;
    const band = this.equipment === 'rifle' ? 14 : 5;
    if (dist < preferred - band) { mx -= (dx / len) * 0.9; mz -= (dz / len) * 0.9; }
    else if (dist > preferred + band) { mx += (dx / len) * 0.6; mz += (dz / len) * 0.6; }
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

  /**
   * Kiting fallback: move away from the threat, preferring a step that puts a
   * solid block between us and it. Used while reloading, when standing still
   * and aiming is strictly worse than repositioning.
   */
  private breakContact(enemyPos: Position, dt: number, ctx: BotContext): void {
    const dx = this.position.x - enemyPos.x;
    const dz = this.position.z - enemyPos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ax = dx / len;
    const az = dz / len;
    const candidates: Array<[number, number]> = [
      [ax, az],
      [ax * 0.7 - az * 0.7, az * 0.7 + ax * 0.7],
      [ax * 0.7 + az * 0.7, az * 0.7 - ax * 0.7],
    ];
    let best: Position | null = null;
    let bestScore = -Infinity;
    for (const [px, pz] of candidates) {
      const wx = this.position.x + px * 7;
      const wz = this.position.z + pz * 7;
      const gy = ctx.world.getGroundHeight(Math.round(wx), Math.round(wz));
      // Cover counts if a solid block sits between the destination and the enemy.
      const covered = ctx.world.isSolid(
        Math.round(wx - ax * 1.5),
        Math.round(gy + 1),
        Math.round(wz - az * 1.5),
      );
      const score = (covered ? 3 : 0) + (px * ax + pz * az);
      if (score > bestScore) {
        bestScore = score;
        best = { x: wx, y: GROUND_LEVEL, z: wz };
      }
    }
    if (best) this.moveTo(best, dt, ctx, true);
  }

  /**
   * Emergency combat engineering: drop a 2-high block between us and a shooter.
   * Throttled by PANIC_COVER_COOLDOWN and the per-life block budget.
   */
  private buildPanicCover(enemyPos: Position, ctx: BotContext, t: number): void {
    if (this.remainingBlocks < 3 || t - this.lastCoverBuildAt < PANIC_COVER_COOLDOWN) return;
    const dx = enemyPos.x - this.position.x;
    const dz = enemyPos.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const gx = Math.round(this.position.x + (dx / len) * 2.4);
    const gz = Math.round(this.position.z + (dz / len) * 2.4);
    const gy = ctx.world.getGroundHeight(gx, gz);
    if (this.cellOverlapsBody({ x: gx, y: gy, z: gz })) return;
    this.lastCoverBuildAt = t;
    this.tryBuildColumnAt(ctx, gx, gy, gz, 2);
  }

  private aimAndShoot(enemy: BotTargetInfo, ctx: BotContext, t: number, allowTurnPenalty = false): void {
    const weapon = WEAPONS[this.equipment as 'rifle' | 'smg'];
    if (!weapon) return;
    if (this.isReloading) return;
    if (t - this.lastShotAt < weapon.fireRate) return;

    // Reaction time: acquiring a different target costs a short human beat.
    if (this.aimTargetId !== enemy.id) {
      this.aimTargetId = enemy.id;
      this.aimTargetAt = t + TARGET_ACQUISITION_MIN + Math.random() * TARGET_ACQUISITION_VARIANCE;
    }
    const acquiring = t < this.aimTargetAt;

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
    if (acquiring) return; // still reacting; do not fire until the beat elapses

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
      this.blocksPlaced++;
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

  private hasNearbyEnemy(ctx: BotContext, range: number): boolean {
    return ctx.targets.some((cand) =>
      !cand.isDead &&
      cand.team !== this.team &&
      Math.hypot(cand.position.x - this.position.x, cand.position.z - this.position.z) < range,
    );
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
    // Stay inside the (enlarged) battlefield bounds with a margin; the old
    // hardcoded half=100 kept bots penned in on the 448-wide map.
    const half = WORLD_SIZE / 2 - CHUNK_SIZE;
    this.waypoint = {
      x: Math.max(-half, Math.min(half, this.position.x + (Math.random() - 0.5) * 40)),
      y: GROUND_LEVEL,
      z: Math.max(-half, Math.min(half, this.position.z + (Math.random() - 0.5) * 40)),
    };
    this.wanderUntil = ctx.serverTime + 3 + Math.random() * 4;
  }

  refillBlocks(): void {
    this.botBlocks = BOT_BLOCKS;
    this.aimTargetId = null;
    this.trenchPlan = null; // drop any half-built trench on death/respawn
    this.buildPlan = null; // ...and any unfinished bastion blueprint
    this.structureBlocksPlaced = 0;
    this.fortifyStage = 0;
    this.stagingSince = null;
    this.trenchCenter = null;
    this.trenchDoneAt = null;
  }
}

// dt helper: bots run at fixed server tick rate
const TICK_DT = 1 / 20;
function dtOf(_ctx: BotContext): number {
  return TICK_DT;
}
