import { WebSocket } from 'ws';
import { ServerPlayer } from './serverPlayer';
import { ServerWorld } from './serverWorld';
import { ServerBot, BotContext, BotTargetInfo, BotGunContext, BotGunSeat } from './serverBot';
import { createLogger } from './logger';
const log = createLogger('game');

/** Shape check for client-supplied positions/vectors.
 *
 *  Message payloads arrive from untrusted sockets: a null `origin`, `target` or
 *  `position` used to throw inside the raycast/build handlers and log an
 *  `error handling message` line for every bad frame. Reject them quietly at
 *  the protocol boundary instead. */
function isVec3(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Team ids are a closed set. An unknown value from a client must never reach
 *  spawn logic, scoring or spawn-protection lookups. */
function isTeam(value: unknown): value is 'red' | 'blue' {
  return value === 'red' || value === 'blue';
}
import { BanStore, normalizeIp } from './banStore';
import {
  ClientMessage,
  ServerMessage,
  PlayerState,
  PlayerStats,
  Position,
  WEAPONS,
  TOOLS,
  weaponDamage,
  RoundPhase,
  RoundSnapshot,
  RoundWinner,
  DEFAULT_ROUND_MINUTES,
  INTERMISSION_SECONDS,
  SPAWN_PROTECTION_SECONDS,
  REGEN_DELAY_SECONDS,
  REGEN_RATE,
  VOXEL_AIR,
  BLUE_SPAWN_Z_MIN,
  BLUE_SPAWN_Z_MAX,
  RED_SPAWN_Z_MIN,
  RED_SPAWN_Z_MAX,
  SPAWN_X_RANGE,
  BLUE_FLAG_POS,
  RED_FLAG_POS,
  VOXEL_BUILT,
  WORKSHOP_CENTERS,
  WORKSHOP_START_STOCK,
  WORKSHOP_CAPACITY,
  WORKSHOP_REACH,
  GROUND_LEVEL,
  isWorkshopProtectedCell,
  Workshops,
  JeepSnapshot,
  WORLD_HALF, vehicleSpec, emplacementSpec, BENCH_REACH, benchPosition, EmplacementKind,
  MANNED_EMPLACEMENTS, EMPLACEMENT_MOUNT_REACH, EMPLACEMENT_USE_REACH,
  SUPPLY_CRATE_CAPACITY, SUPPLY_CRATE_DRAW, SPOTTING_POST_RADIUS,
  EMPLACEMENT_FIRE_INTERVAL, EMPLACEMENT_ROUND_DAMAGE, EMPLACEMENT_MAX_PITCH, emplacedShotDirection,
  EMPLACEMENT_SHELL_GRAVITY, CANNON_BLAST_RADIUS, CANNON_BLAST_DAMAGE, MORTAR_BLAST_RADIUS, MORTAR_BLAST_DAMAGE,
  type VehicleSpec, type Footprint, type EmplacementSpec, type EmplacementSnapshot, type BlueprintSlots, type SpotContact,
} from '../shared/types';
import { surfaceGround, vehicleClear, vehicleExitSpot, vehicleGround, vehicleRectsOverlap } from '../shared/vehiclePhysics';

export interface GameConnection {
  send(data: string): void;
  isOpen?: () => boolean;
  readyState?: number;
  /** Optional close hook — SSE connections use this to end the HTTP response. */
  close?(code?: number, reason?: string): void;
}

type BotJeepTask = {
  phase: 'approach' | 'drive' | 'reverse' | 'detour';
  jeepId: string | null;
  startedAt: number;
  lastProgressAt: number;
  lastPosition: Position;
  recoveries: number;
  recoveryUntil: number;
  detour: Position | null;
  nextSteeringAt: number;
  plannedSteering: number;
  plannedThrottle: number;
};

const BOT_JEEP_MAX_DRIVERS_PER_TEAM = 1;
const BOT_JEEP_HUMAN_PRIORITY_RADIUS = 24;
const BOT_JEEP_COOLDOWN = 25;
const BOT_LOGISTICS_PER_TEAM = 1;
const BOT_LOGISTICS_CAPACITY = 12;
// Watermark the logistics bots keep the workshop stocked to. It has to cover
// the most expensive thing a bot buys on its own initiative: an emplacement
// (cannon, cost 90). Lower values starve emplacements; higher values waste
// mining trips on stock the bots cannot spend on their own.
const BOT_LOGISTICS_MIN_STOCK = 90;
const BOT_LOGISTICS_MINE_RADIUS = 8;

// Emplacement placement rules (Phase 4). Your own base may be fortified, but
// nothing goes near the enemy base, on the flag stand or on the workshop pad.
const EMPLACEMENT_ENEMY_BASE_RING = 40;
const EMPLACEMENT_OWN_FLAG_CLEARANCE = 10;
const EMPLACEMENT_WORKSHOP_CLEARANCE = 8;
const EMPLACEMENT_SEPARATION = 0.5;
/** Minimum gap between ghost validity replies for one player, in ms. */
const EMPLACEMENT_PREVIEW_INTERVAL = 90;

/** One shell in flight. Stepped on the server tick, drawn on the client from the
 *  same spawn point, velocity and gravity. */
interface ServerShell {
  id: string;
  kind: EmplacementKind;
  team: 'red' | 'blue';
  ownerId: string;
  position: Position;
  velocity: Position;
  /** Server clock when it left the barrel, for the flight timeout. */
  firedAt: number;
}

interface ServerJeep extends JeepSnapshot {
  throttle: number;
  steering: number;
  brake: boolean;
  lastInput: number;
  wreckUntil: number;
}

export class ServerGame {
  private players: Map<string, ServerPlayer> = new Map();
  private world: ServerWorld;
  private connections: Map<string, WebSocket | GameConnection> = new Map();
  private scores = { red: 0, blue: 0 };
  private captures = { red: 0, blue: 0 };
  /** Enemy-flag pickups per team, per round: a steal that never finished. First
   *  tiebreak step after captures, so a round where one side crossed the map
   *  and touched the flag is not scored as a 0:0 draw. */
  private flagTouches = { red: 0, blue: 0 };
  /** Own dropped flag walked back home by a teammate, per round. Second
   *  tiebreak step: defence that actually recovered the flag counts. Automatic
   *  returns (the drop timer) are not a team action and are not counted. */
  private flagReturns = { red: 0, blue: 0 };
  /** Kills this round. `scores` is the running match total, so it cannot be the
   *  last tiebreak step: using it would let an earlier round decide this one. */
  private roundKills = { red: 0, blue: 0 };

  // ---------------- Rounds ----------------
  // A round is a fixed-length window of CTF. When the clock runs out the round
  // is decided by captures, then by flag touches, then by flag returns, then by
  // kills; only a round level on all four is a draw. Everything resets during a
  // short intermission and the next round starts. Rounds are long on purpose:
  // the arena is 448m wide and a flag run crosses ~320m, so shorter rounds
  // would mostly be travel.
  private roundSeconds: number = Math.max(
    60,
    (Number(process.env.ROUND_MINUTES) || DEFAULT_ROUND_MINUTES) * 60,
  );
  private roundNumber: number = 1;
  private roundPhase: RoundPhase = 'live';
  private roundTimeLeft: number = this.roundSeconds;
  private intermissionTimeLeft: number = 0;
  private roundWins = { red: 0, blue: 0 };
  /** Throttles the periodic roundUpdate broadcast to ~1Hz. */
  private roundSyncAccumulator: number = 0;

  // ---------------- Spawn protection & regeneration ----------------
  /** world.serverTime at which each player's spawn shield expires. */
  private spawnProtectedUntil = new Map<string, number>();
  /** world.serverTime of each player's last damage (drives regen delay). */
  private lastDamagedAt = new Map<string, number>();
  /** Last integer HP broadcast, so regen syncs at ~1-2Hz instead of 20Hz. */
  private lastHpBroadcast = new Map<string, number>();

  /** Per-combatant kill/death/capture tallies for the Tab scoreboard. */
  private playerStats: Map<string, PlayerStats> = new Map();
  /** Opaque per-connection tokens for the HTTP/SSE transport. A WebSocket
   *  frame is already bound to its socket; a POSTed message was not, so it
   *  used to trust a client-supplied playerId (anyone could act as anyone). */
  private sessionTokens: Map<string, string> = new Map();
  private lastShootTime: Map<string, number> = new Map();
  private lastToolTime: Map<string, number> = new Map();
  private inventories: Map<string, number> = new Map();
  /** Natural blocks carried for deposit (and optionally ordinary building). */
  private depositableBlocks = new Map<string, number>();
  private joinedPlayers = new Set<string>();
  private workshopStock = { red: WORKSHOP_START_STOCK, blue: WORKSHOP_START_STOCK };
  /** Crafted-but-unplaced blueprints the player carries. Consumed on placement,
   *  cleared on round reset with no refund — they are spent supply, like a
   *  bought jeep that rolled off the shop floor. */
  private craftedBlueprints = new Map<string, BlueprintSlots>();
  private jeeps = new Map<string, ServerJeep>();
  private jeepSequence = 0;
  private emplacements = new Map<string, EmplacementSnapshot>();
  private emplacementSequence = 0;
  private emplacementPreviewAt = new Map<string, number>();
  /** Last round fired per emplacement, on the server clock. */
  private emplacementFireAt = new Map<string, number>();
  private shells = new Map<string, ServerShell>();
  private shellSequence = 0;
  private emplacementSync = 0;
  /** Throttles spotting reports to 4Hz; markers are HUD hints, not physics. */
  private spotSync = 0;
  /** Whether each team had a live spotting post on the last report, so the
   *  frame that clears stale markers is sent exactly once. */
  private spotHadPost = { red: false, blue: false };
  private jeepSync = 0;
  private botJeepTasks = new Map<string, BotJeepTask>();
  private botJeepCooldown = new Map<string, number>();
  private botJeepVehicleCooldown = new Map<string, number>();
  private botLogisticsTasks = new Map<string, { target: Position | null; phase: 'gather' | 'return'; nextMineAt: number }>();
  /** Cumulative diagnostics used by the headless match measurement. */
  readonly botJeepStats = { built: 0, entered: 0, arrived: 0, damagedExits: 0, recoveries: 0, abandoned: 0, humanYields: 0 };

  private jeepSnapshots(): JeepSnapshot[] {
    return [...this.jeeps.values()].map(({ id, kind, team, position, yaw, speed, hp, driverId, wreck }) =>
      ({ id, kind, team, position: { ...position }, yaw, speed, hp, driverId, wreck }));
  }

  private broadcastJeeps(): void {
    this.broadcast({ type: 'jeepsUpdated', jeeps: this.jeepSnapshots() });
  }

  private emplacementSnapshots(): EmplacementSnapshot[] {
    return [...this.emplacements.values()].map(e => ({ ...e, position: { ...e.position } }));
  }

  private broadcastEmplacements(): void {
    this.broadcast({ type: 'emplacementsUpdated', emplacements: this.emplacementSnapshots() });
  }

  /** Enemy contacts for each team that owns a live spotting post. Only that
   *  team receives the positions, so a tower spots for its own side and the
   *  other team never gets a free radar. When a team's last post goes down one
   *  empty report clears its markers instead of leaving them on the HUD. */
  private broadcastSpotReports(): void {
    const posts: Record<'red' | 'blue', EmplacementSnapshot[]> = { red: [], blue: [] };
    for (const emplacement of this.emplacements.values()) {
      if (emplacement.kind === 'spottingPost' && emplacement.hp > 0) posts[emplacement.team].push(emplacement);
    }
    const hasPost = { red: posts.red.length > 0, blue: posts.blue.length > 0 };

    for (const [id, player] of this.players) {
      if (player instanceof ServerBot || player.isDead || player.isSpectating) continue;
      if (!hasPost[player.team]) {
        if (this.spotHadPost[player.team]) this.sendToPlayer(id, { type: 'spotReport', contacts: [] });
        continue;
      }
      const contacts: SpotContact[] = [];
      for (const other of this.players.values()) {
        if (other.team === player.team || other.isDead || other.isSpectating) continue;
        const seen = posts[player.team].some((post) =>
          Math.hypot(other.position.x - post.position.x, other.position.z - post.position.z) <= SPOTTING_POST_RADIUS);
        if (seen) contacts.push({ id: other.id, team: other.team, position: { ...other.position } });
      }
      this.sendToPlayer(id, { type: 'spotReport', contacts });
    }
    this.spotHadPost = hasPost;
  }

  private emplacementMessage(playerId: string, message: string): void {
    this.sendToPlayer(playerId, { type: 'emplacementMessage', message });
  }

  /**
   * Place player-built hardware from a blueprint. The server owns every rule:
   * where it may stand, whether the ground fits, and what it costs. Nothing is
   * charged unless the build is accepted, so a rejected ghost costs nothing.
   */
  private emplacementSpotVerdict(
    playerId: string, kind: unknown, position: unknown, yaw: unknown,
  ): { ok: true; spec: EmplacementSpec; spot: Position; rotation: number } | { ok: false; reason: string } {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.roundPhase !== 'live') return { ok: false, reason: 'Cannot build right now' };
    if (typeof kind !== 'string' || !isVec3(position)) return { ok: false, reason: 'Bad blueprint' };
    const spec = emplacementSpec(kind);
    if (!spec) return { ok: false, reason: 'Unknown blueprint' };

    const extent = Math.hypot(spec.halfWidth, spec.halfLength);
    if (Math.abs(position.x) > WORLD_HALF - extent - 1 || Math.abs(position.z) > WORLD_HALF - extent - 1) {
      return { ok: false, reason: 'Outside the map' };
    }

    const ownFlag = player.team === 'blue' ? BLUE_FLAG_POS : RED_FLAG_POS;
    const enemyFlag = player.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    if (Math.hypot(position.x - enemyFlag.x, position.z - enemyFlag.z) < EMPLACEMENT_ENEMY_BASE_RING) {
      return { ok: false, reason: 'Too close to the enemy base' };
    }
    if (Math.hypot(position.x - ownFlag.x, position.z - ownFlag.z) < EMPLACEMENT_OWN_FLAG_CLEARANCE) {
      return { ok: false, reason: 'Too close to your flag stand' };
    }
    const workshop = this.getWorkshops()[player.team].position;
    if (Math.hypot(position.x - workshop.x, position.z - workshop.z) < EMPLACEMENT_WORKSHOP_CLEARANCE) {
      return { ok: false, reason: 'Keep the workshop pad clear' };
    }

    // Snap to the ground the server sees, never to the client's y.
    const ground = surfaceGround(this.world, position.x, position.z, position.y);
    if (ground === null) return { ok: false, reason: 'Needs flat, solid ground' };
    const spot = { x: position.x, y: ground, z: position.z };
    const rotation = typeof yaw === 'number' && Number.isFinite(yaw) ? yaw : 0;

    if (!this.jeepClear(spot, rotation, spec)) return { ok: false, reason: 'No room there' };
    const padded = { ...spec, halfWidth: spec.halfWidth + EMPLACEMENT_SEPARATION, halfLength: spec.halfLength + EMPLACEMENT_SEPARATION };
    for (const other of this.emplacements.values()) {
      const otherSpec = emplacementSpec(other.kind) ?? spec;
      if (Math.abs(other.position.y - ground) >= (spec.height + otherSpec.height) / 2) continue;
      if (vehicleRectsOverlap(spot.x, spot.z, rotation, padded, other.position.x, other.position.z, other.yaw, otherSpec)) {
        return { ok: false, reason: 'Too close to another emplacement' };
      }
    }

    const built = [...this.emplacements.values()].filter(e => e.team === player.team && e.kind === spec.kind).length;
    if (built >= spec.teamLimit) return { ok: false, reason: 'Team limit for that build reached' };

    return { ok: true, spec, spot, rotation };
  }

  private emplacementVerdict(
    playerId: string, kind: unknown, position: unknown, yaw: unknown, slot: unknown,
  ): { ok: true; spec: EmplacementSpec; spot: Position; rotation: number; slot: number } | { ok: false; reason: string } {
    const spotVerdict = this.emplacementSpotVerdict(playerId, kind, position, yaw);
    if (!spotVerdict.ok) return spotVerdict;

    // Placement consumes a crafted blueprint (one charge in the bench) instead
    // of drawing from the team stockpile directly. The bench is the only place
    // supply turns into deployment rights.
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > 2) {
      return { ok: false, reason: 'No blueprint in that slot' };
    }
    if (!this.hasBlueprint(playerId, slot, spotVerdict.spec.kind)) {
      return { ok: false, reason: 'No blueprint in that slot' };
    }

    return { ...spotVerdict, ok: true, slot };
  }

  private placeEmplacement(playerId: string, kind: unknown, position: unknown, yaw: unknown, slot: unknown): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const verdict = this.emplacementVerdict(playerId, kind, position, yaw, slot);
    if (!verdict.ok) return this.emplacementMessage(playerId, verdict.reason);

    this.consumeBlueprint(playerId, verdict.slot);
    this.createEmplacement(player.team, verdict.spec, verdict.spot, verdict.rotation);
    this.broadcastBlueprints(playerId);
    this.broadcastWorkshops();
  }

  private createEmplacement(team: 'red' | 'blue', spec: EmplacementSpec, spot: Position, rotation: number): EmplacementSnapshot {
    const emplacement: EmplacementSnapshot = {
      id: `emp_${++this.emplacementSequence}`,
      kind: spec.kind,
      team,
      position: spot,
      yaw: rotation,
      hp: spec.maxHp,
      ammo: spec.ammo,
      stock: 0,
      baseYaw: rotation,
      gunnerId: null,
    };
    this.emplacements.set(emplacement.id, emplacement);
    this.broadcastEmplacements();
    return emplacement;
  }

  /** Bots skip the bench but not the bill: a bot build pays the team stock
   *  directly, through the same placement rules a player's ghost is judged by. */
  private botPlaceEmplacement(bot: ServerBot, kind: unknown, position: unknown, yaw: unknown): boolean {
    if (typeof kind !== 'string') return false;
    const spec = emplacementSpec(kind);
    if (!spec) return false;
    const verdict = this.emplacementSpotVerdict(bot.id, kind, position, yaw);
    if (!verdict.ok) return false;
    if (this.workshopStock[bot.team] < spec.cost) return false;
    this.workshopStock[bot.team] -= spec.cost;
    this.createEmplacement(bot.team, verdict.spec, verdict.spot, verdict.rotation);
    this.broadcastWorkshops();
    return true;
  }

  /** Consume one crafted blueprint slot. Called only on a successful
   *  placement — the verdict already asserts the slot holds that kind. */
  private consumeBlueprint(playerId: string, slot: number): void {
    const slots = this.craftedBlueprints.get(playerId);
    if (!slots || slots[slot] === null) return;
    slots[slot] = null;
    this.broadcastBlueprints(playerId);
  }

  /** True when the player holds that kind in the requested slot. */
  private hasBlueprint(playerId: string, slot: number, kind: string): boolean {
    const slots = this.craftedBlueprints.get(playerId);
    return Boolean(slots && slots[slot] === kind);
  }

  /** Same rules as a real placement, so the ghost tint can be trusted. The
   *  slot is checked the same way as a placement uses it, so a ghost over an
   *  empty slot goes red with 'No blueprint in that slot'. */
  private previewEmplacement(playerId: string, kind: unknown, position: unknown, yaw: unknown, slot: unknown): void {
    const now = Date.now();
    if (now - (this.emplacementPreviewAt.get(playerId) ?? 0) < EMPLACEMENT_PREVIEW_INTERVAL) return;
    this.emplacementPreviewAt.set(playerId, now);
    const verdict = this.emplacementVerdict(playerId, kind, position, yaw, slot);
    this.sendToPlayer(
      playerId,
      verdict.ok
        ? { type: 'emplacementPreview', ok: true, position: verdict.spot, yaw: verdict.rotation }
        : { type: 'emplacementPreview', ok: false, reason: verdict.reason },
    );
  }

  /** The nest this player is manning, if any. */
  private gunnerEmplacement(playerId: string): EmplacementSnapshot | undefined {
    for (const emplacement of this.emplacements.values()) {
      if (emplacement.gunnerId === playerId) return emplacement;
    }
    return undefined;
  }

  /** The nearest nest this player could climb into right now (own team only). */
  nearestMannableEmplacement(playerId: string): EmplacementSnapshot | undefined {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating) return undefined;
    let best: EmplacementSnapshot | undefined;
    let bestDistance = Infinity;
    for (const emplacement of this.emplacements.values()) {
      if (!MANNED_EMPLACEMENTS.includes(emplacement.kind) || emplacement.team !== player.team) continue;
      const occupant = emplacement.gunnerId ? this.players.get(emplacement.gunnerId) : undefined;
      if (occupant && occupant.id !== playerId && !occupant.isDead && !occupant.isSpectating) continue;
      const distance = Math.hypot(
        player.position.x - emplacement.position.x,
        player.position.y - emplacement.position.y,
        player.position.z - emplacement.position.z,
      );
      if (distance <= EMPLACEMENT_MOUNT_REACH && distance < bestDistance) { best = emplacement; bestDistance = distance; }
    }
    return best;
  }

  /** Climb into an MG nest. The server owns the seat: ownership, distance and
   *  occupancy are all checked here, and the gunner is snapped onto the nest so
   *  a modified client cannot man it from across the map. */
  private mountEmplacement(playerId: string, emplacementId: unknown): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || typeof emplacementId !== 'string') return;
    if (this.driverJeep(playerId) || this.gunnerEmplacement(playerId)) return;
    if (player.carryingFlag) return this.emplacementMessage(playerId, 'Drop the flag before manning a nest');
    const emplacement = this.emplacements.get(emplacementId);
    if (!emplacement) return;
    if (!MANNED_EMPLACEMENTS.includes(emplacement.kind)) return this.emplacementMessage(playerId, 'That build cannot be manned');
    if (emplacement.team !== player.team) return this.emplacementMessage(playerId, 'That nest belongs to the other team');
    const occupant = emplacement.gunnerId ? this.players.get(emplacement.gunnerId) : undefined;
    if (occupant && !occupant.isDead && !occupant.isSpectating) return this.emplacementMessage(playerId, 'That nest is already manned');
    const seat = emplacement.position;
    if (Math.hypot(player.position.x - seat.x, player.position.y - seat.y, player.position.z - seat.z) > EMPLACEMENT_MOUNT_REACH) {
      return this.emplacementMessage(playerId, 'Walk up to the nest to man it');
    }

    emplacement.gunnerId = playerId;
    emplacement.yaw = emplacement.baseYaw;
    player.position = { x: seat.x, y: seat.y, z: seat.z };
    player.velocity = { x: 0, y: 0, z: 0 };
    this.clearSpawnProtection(playerId);
    this.sendToPlayer(playerId, {
      type: 'emplacementMounted',
      emplacementId: emplacement.id,
      position: { ...seat },
      yaw: emplacement.yaw,
    });
    this.broadcast({ type: 'playerUpdated', playerId, state: player.getState() });
    this.broadcastEmplacements();
  }

  /** Stand clear of the nest. Mirrors the jeep exit: try a ring of spots, and
   *  only fall back to the team spawn when the exit is forced (death, reset). */
  private safeEmplacementExit(emplacement: EmplacementSnapshot, playerId: string): Position | null {
    const player = this.players.get(playerId);
    const spec = emplacementSpec(emplacement.kind);
    if (!player || !spec) return null;
    const base = Math.hypot(spec.halfWidth, spec.halfLength);
    for (const radius of [base + 1.2, base + 2.2, base + 3.4]) {
      for (let i = 0; i < 8; i++) {
        const angle = emplacement.yaw + i * Math.PI / 4;
        const x = emplacement.position.x + Math.cos(angle) * radius;
        const z = emplacement.position.z + Math.sin(angle) * radius;
        const y = surfaceGround(this.world, x, z, emplacement.position.y);
        if (y === null || Math.abs(x) >= WORLD_HALF - 1 || Math.abs(z) >= WORLD_HALF - 1) continue;
        let clear = true;
        for (const dx of [-0.45, 0.45]) for (const dz of [-0.45, 0.45]) for (const dy of [0.3, 1, 1.8]) {
          if (this.world.isSolid(Math.round(x + dx), Math.round(y + dy), Math.round(z + dz))) clear = false;
        }
        if (!clear || [...this.players.values()].some(p => p.id !== playerId && !p.isDead && !p.isSpectating && Math.abs(p.position.y - y) < 2 && Math.hypot(p.position.x - x, p.position.z - z) < 1)) continue;
        if ([...this.emplacements.values()].some(e => e.id !== emplacement.id && Math.abs(e.position.y - y) < 2 && Math.hypot(e.position.x - x, e.position.z - z) < 2)) continue;
        return { x, y, z };
      }
    }
    return null;
  }

  private dismountEmplacement(playerId: string, forced = false): boolean {
    const emplacement = this.gunnerEmplacement(playerId);
    if (!emplacement) return false;
    const player = this.players.get(playerId);
    const exit = this.safeEmplacementExit(emplacement, playerId);
    if (!exit && !forced) { this.emplacementMessage(playerId, 'No clear way out of the nest'); return false; }
    emplacement.gunnerId = null;
    emplacement.yaw = emplacement.baseYaw;
    this.emplacementFireAt.delete(emplacement.id);
    if (player && !player.isDead) {
      player.position = exit ?? this.getSpawnPosition(player.team);
      this.sendToPlayer(playerId, { type: 'emplacementExited', position: { ...player.position } });
      this.broadcast({ type: 'playerUpdated', playerId, state: player.getState() });
    }
    this.broadcastEmplacements();
    return true;
  }

  /** Aim the manned nest from the gunner's look direction, clamped to its arc. */
  private aimEmplacement(playerId: string, yaw: number, pitch: number): void {
    const emplacement = this.gunnerEmplacement(playerId);
    const spec = emplacement ? emplacementSpec(emplacement.kind) : undefined;
    if (!emplacement || !spec) return;
    const half = Math.max(0, spec.arc) / 2;
    const offset = Math.atan2(Math.sin(yaw - emplacement.baseYaw), Math.cos(yaw - emplacement.baseYaw));
    const clamped = offset > half || offset < -half ? emplacement.baseYaw + Math.sign(offset) * half : yaw;
    emplacement.yaw = clamped;
    void pitch; // pitch is read at fire time from the gunner's rotation
  }

  /** Fire one round from the manned nest. Direction comes from the nest's own
   *  yaw and the gunner's pitch, never from the client's ray. */
  private fireEmplacement(playerId: string): void {
    const emplacement = this.gunnerEmplacement(playerId);
    const player = this.players.get(playerId);
    if (!emplacement || !player || player.isDead || player.isSpectating || this.roundPhase !== 'live') return;
    const spec = emplacementSpec(emplacement.kind);
    if (!spec) return;
    if (emplacement.ammo <= 0) return this.emplacementMessage(playerId, 'The nest is out of rounds');
    const now = this.world.serverTime;
    const interval = spec.fireInterval || EMPLACEMENT_FIRE_INTERVAL;
    // No previous shot means the first round is always allowed; a -1 sentinel
    // silently blocked long reloads while the server clock was still near zero.
    const lastFire = this.emplacementFireAt.get(emplacement.id);
    if (lastFire !== undefined && now - lastFire < interval) return;
    this.emplacementFireAt.set(emplacement.id, now);
    emplacement.ammo -= 1;

    const yaw = emplacement.yaw;
    const pitch = Math.max(-EMPLACEMENT_MAX_PITCH, Math.min(EMPLACEMENT_MAX_PITCH, player.rotation.pitch ?? 0));

    // Cannon and mortar lob a shell the whole server steps; only the nest is
    // hitscan, because a 200-round belt cannot be 200 projectiles.
    if (emplacement.kind === 'cannon' || emplacement.kind === 'mortar') {
      this.fireShell(emplacement, player, yaw, pitch, spec);
      return;
    }

    // Every round walks off the aim line inside the nest's spread cone, so a
    // held trigger hoses an area instead of drilling one point.
    const direction = emplacedShotDirection(yaw, pitch);
    const origin = {
      x: emplacement.position.x + direction.x * 0.9,
      y: emplacement.position.y + 1.15,
      z: emplacement.position.z + direction.z * 0.9,
    };

    // Tracers and muzzle sound reuse the existing player-shot event.
    this.broadcastExcept(playerId, { type: 'playerShot', playerId, origin, direction, weapon: 'mgNest' });

    const terrainHit = this.world.raycast(origin, direction, spec.maxRange);
    const maxDist = terrainHit ? terrainHit.distance : spec.maxRange;
    const vehicleHit = this.hitJeep(origin, direction, maxDist, emplacement.team);
    const structureHit = this.hitEmplacement(origin, direction, maxDist, emplacement.team);

    // Enemy hardware stops the round: whichever build is nearer takes it, and
    // nothing behind that build can be hit by the same burst.
    let limit = maxDist;
    if (structureHit && (!vehicleHit || structureHit.distance <= vehicleHit.distance)) {
      limit = structureHit.distance;
      this.damageEmplacement(structureHit.emplacement.id, EMPLACEMENT_ROUND_DAMAGE);
    } else if (vehicleHit) {
      limit = vehicleHit.distance;
      this.damageJeep(vehicleHit.jeep, EMPLACEMENT_ROUND_DAMAGE);
    }

    // Nearest enemy body intersecting the round; torso and head are sampled so a
    // shot that clips the head counts as one.
    let best: { id: string; distance: number; headshot: boolean } | null = null;
    for (const [id, target] of this.players) {
      if (id === playerId || target.isDead || target.isSpectating || target.team === emplacement.team) continue;
      for (const [height, headshot] of [[1.55, true], [1.0, false]] as const) {
        const to = {
          x: target.position.x - origin.x,
          y: target.position.y + height - origin.y,
          z: target.position.z - origin.z,
        };
        const along = to.x * direction.x + to.y * direction.y + to.z * direction.z;
        if (along <= 0 || along > limit) continue;
        const perp = Math.hypot(
          to.x - direction.x * along,
          to.y - direction.y * along,
          to.z - direction.z * along,
        );
        if (perp > (headshot ? 0.35 : 0.6)) continue;
        if (!best || along < best.distance) best = { id, distance: along, headshot };
      }
    }

    if (best) {
      const damage = EMPLACEMENT_ROUND_DAMAGE * (best.headshot ? 1.5 : 1);
      // applyDamage already confirms the hit to the shooter.
      this.applyDamage(best.id, damage, playerId, best.headshot);
    }
  }

  /** Put a shell in the air. Cannon rounds are flat and fast; mortar rounds go
   *  up at 45 degrees so they clear cover and fall on the far side. */
  private fireShell(emplacement: EmplacementSnapshot, player: ServerPlayer, yaw: number, pitch: number, spec: EmplacementSpec): void {
    const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const isMortar = emplacement.kind === 'mortar';
    const speed = isMortar ? 42 : 85;
    const launchPitch = isMortar ? Math.max(pitch, Math.PI / 4) : pitch;
    const cosPitch = Math.cos(launchPitch);
    const velocity = {
      x: forward.x * speed * cosPitch,
      y: Math.sin(launchPitch) * speed,
      z: forward.z * speed * cosPitch,
    };
    // Start clear of the barrel so the shell cannot explode on its own nest.
    const muzzle = isMortar ? 1.0 : 1.6;
    const position = {
      x: emplacement.position.x + forward.x * muzzle,
      y: emplacement.position.y + 1.2,
      z: emplacement.position.z + forward.z * muzzle,
    };
    const id = `shell_${++this.shellSequence}`;
    this.shells.set(id, {
      id,
      kind: emplacement.kind,
      team: emplacement.team,
      ownerId: player.id,
      position,
      velocity,
      firedAt: this.world.serverTime,
    });
    // Muzzle flash and report reuse the shot event every client already draws.
    this.broadcast({ type: 'playerShot', playerId: player.id, origin: position, direction: { ...velocity }, weapon: emplacement.kind });
    this.broadcast({ type: 'shellFired', id, kind: emplacement.kind, position: { ...position }, velocity: { ...velocity } });
    void spec;
  }

  /** Advance every shell and resolve what it ran into. */
  private updateShells(dt: number): void {
    if (this.shells.size === 0) return;
    const step = Math.min(dt, 0.05);
    for (const shell of [...this.shells.values()]) {
      // Two integration substeps keep a fast cannon round from tunnelling
      // through a one-voxel wall.
      for (let i = 0; i < 2; i++) {
        const half = step / 2;
        shell.velocity.y -= EMPLACEMENT_SHELL_GRAVITY * half;
        const next = {
          x: shell.position.x + shell.velocity.x * half,
          y: shell.position.y + shell.velocity.y * half,
          z: shell.position.z + shell.velocity.z * half,
        };
        const impact = this.shellImpactAt(shell, next);
        if (impact) {
          this.explodeShell(shell, impact);
          break;
        }
        shell.position = next;
      }
      if (!this.shells.has(shell.id)) continue;
      if (this.world.serverTime - shell.firedAt > 8 || Math.abs(shell.position.y) > 80) {
        this.shells.delete(shell.id);
        this.broadcast({ type: 'shellImpact', id: shell.id, kind: shell.kind, position: { ...shell.position }, radius: 0 });
      }
    }
  }

  /** Where a shell would stop, or null when the path is clear. */
  private shellImpactAt(shell: ServerShell, next: Position): Position | null {
    if (Math.abs(next.x) >= WORLD_HALF || Math.abs(next.z) >= WORLD_HALF) return next;
    if (this.world.isSolid(Math.round(next.x), Math.round(next.y), Math.round(next.z))) return shell.position;
    for (const [id, player] of this.players) {
      if (id === shell.ownerId || player.isDead || player.isSpectating) continue;
      if (player.team === shell.team) continue;
      if (Math.hypot(player.position.x - next.x, player.position.y + 1 - next.y, player.position.z - next.z) < 0.7) return next;
    }
    for (const jeep of this.jeeps.values()) {
      if (jeep.wreck || jeep.team === shell.team) continue;
      const spec = vehicleSpec(jeep.kind);
      if (Math.abs(jeep.position.y - next.y) < spec.height &&
        Math.hypot(jeep.position.x - next.x, jeep.position.z - next.z) < Math.hypot(spec.halfWidth, spec.halfLength)) return next;
    }
    return null;
  }

  /** Blast: enemies only, falling off with distance. Terrain and rounds are
   *  permanent, players are not, so the same shell can ruin a trench and soften
   *  the squad behind it. */
  private explodeShell(shell: ServerShell, position: Position): void {
    this.shells.delete(shell.id);
    const isMortar = shell.kind === 'mortar';
    const radius = isMortar ? MORTAR_BLAST_RADIUS : CANNON_BLAST_RADIUS;
    const maxDamage = isMortar ? MORTAR_BLAST_DAMAGE : CANNON_BLAST_DAMAGE;

    for (const [id, target] of this.players) {
      if (target.isDead || target.isSpectating || target.team === shell.team) continue;
      const distance = Math.hypot(target.position.x - position.x, target.position.y + 1 - position.y, target.position.z - position.z);
      if (distance > radius) continue;
      const damage = Math.max(1, Math.round(maxDamage * (1 - distance / radius)));
      this.applyDamage(id, damage, shell.ownerId, false);
    }
    for (const jeep of this.jeeps.values()) {
      if (jeep.wreck || jeep.team === shell.team) continue;
      const distance = Math.hypot(jeep.position.x - position.x, jeep.position.y + 1 - position.y, jeep.position.z - position.z);
      if (distance > radius) continue;
      this.damageJeep(jeep, Math.max(1, Math.round(maxDamage * (1 - distance / radius))));
    }
    for (const emplacement of [...this.emplacements.values()]) {
      if (emplacement.team === shell.team) continue;
      const distance = Math.hypot(emplacement.position.x - position.x, emplacement.position.y + 0.6 - position.y, emplacement.position.z - position.z);
      if (distance > radius) continue;
      this.damageEmplacement(emplacement.id, Math.max(1, Math.round(maxDamage * (1 - distance / radius))));
    }
    // Terrain damage is the point of a shell: carve the voxels it lands on.
    const ground = Math.round(position.y);
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [0, -1, 0]]) {
      const x = Math.round(position.x) + dx, y = ground + dy, z = Math.round(position.z) + dz;
      if (!this.world.isSolid(x, y, z)) continue;
      if (this.world.damageVoxel(x, y, z, 99)) {
        // A shell that removed terrain must reach clients, or their world
        // diverges from the server's from then on.
        this.broadcast({ type: 'voxelChanged', change: { x, y, z, type: VOXEL_AIR, durability: 0 } });
      }
    }
    this.broadcast({ type: 'shellImpact', id: shell.id, kind: shell.kind, position: { ...position }, radius });
  }

  private driverJeep(playerId: string): ServerJeep | undefined {
    return [...this.jeeps.values()].find(jeep => jeep.driverId === playerId && !jeep.wreck);
  }

  private jeepMessage(playerId: string, message: string): void {
    this.sendToPlayer(playerId, { type: 'jeepMessage', message });
  }

  /** Ground, footprint and body collisions all come from the shared vehicle
   *  rules, so the offline client judges a jeep exactly the way this server
   *  does. The wrappers only hand the helpers this game's world and bodies. */
  private jeepClear(position: Position, yaw: number, spec: Footprint, ignoreId?: string, ignorePlayerId?: string): boolean {
    return vehicleClear(this.world, position, yaw, spec, {
      vehicles: this.jeeps.values(),
      players: this.players.values(),
      ignoreVehicleId: ignoreId ?? null,
      ignorePlayerId: ignorePlayerId ?? null,
    });
  }

  private jeepGround(position: Position, yaw: number, spec: Footprint): number | null {
    return vehicleGround(this.world, position, yaw, spec);
  }

  private buildJeep(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.driverJeep(playerId) || this.roundPhase !== 'live') return;
    const workshop = this.getWorkshops()[player.team];
    if (Math.hypot(player.position.x - workshop.position.x, player.position.y - workshop.position.y, player.position.z - workshop.position.z) > WORKSHOP_REACH) return;
    const spec = vehicleSpec('jeep');
    if (this.workshopStock[player.team] < spec.cost) return this.jeepMessage(playerId, 'Not enough workshop blocks');
    if ([...this.jeeps.values()].filter(v => v.team === player.team && !v.wreck).length >= spec.teamLimit) return this.jeepMessage(playerId, 'Team jeep limit reached');
    const position = { x: workshop.position.x + 11, y: workshop.position.y, z: workshop.position.z };
    const yaw = player.team === 'blue' ? Math.PI : 0;
    if (this.jeepGround(position, yaw, spec) === null || !this.jeepClear(position, yaw, spec)) return this.jeepMessage(playerId, 'Garage pad is blocked');
    const jeep: ServerJeep = { id: `jeep_${++this.jeepSequence}`, kind: spec.kind, team: player.team, position, yaw, speed: 0, hp: spec.maxHp, driverId: null, wreck: false, throttle: 0, steering: 0, brake: false, lastInput: this.world.serverTime, wreckUntil: 0 };
    this.workshopStock[player.team] -= spec.cost;
    this.jeeps.set(jeep.id, jeep);
    this.broadcastWorkshops();
    this.broadcastJeeps();
  }

  private humanNearJeep(team: 'red' | 'blue', position: Position): boolean {
    return [...this.players.values()].some(p => !(p instanceof ServerBot) && p.team === team && !p.isDead && !p.isSpectating &&
      Math.hypot(p.position.x - position.x, p.position.y - position.y, p.position.z - position.z) <= BOT_JEEP_HUMAN_PRIORITY_RADIUS);
  }

  private enterJeep(playerId: string, vehicleId: unknown): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || player.carryingFlag || this.blueFlagCarrier === playerId || this.redFlagCarrier === playerId || this.driverJeep(playerId) || typeof vehicleId !== 'string') return;
    if (!(player instanceof ServerBot) && !this.joinedPlayers.has(playerId)) return;
    const jeep = this.jeeps.get(vehicleId);
    if (!jeep || jeep.wreck || jeep.team !== player.team || Math.hypot(player.position.x - jeep.position.x, player.position.y - jeep.position.y, player.position.z - jeep.position.z) > vehicleSpec(jeep.kind).enterReach) return;
    if (jeep.driverId && !(player instanceof ServerBot)) {
      const occupant = this.players.get(jeep.driverId);
      const workshop = this.getWorkshops()[player.team].position;
      if (occupant instanceof ServerBot && Math.hypot(jeep.position.x - workshop.x, jeep.position.z - workshop.z) <= BOT_JEEP_HUMAN_PRIORITY_RADIUS && Math.abs(jeep.speed) < 1) {
        this.finishBotJeepTask(occupant, 'human');
      }
    }
    if (jeep.driverId) return;
    jeep.driverId = playerId;
    jeep.lastInput = this.world.serverTime;
    jeep.throttle = 0; jeep.steering = 0; jeep.brake = false; jeep.speed = 0;
    player.position = { ...jeep.position };
    this.clearSpawnProtection(playerId);
    this.broadcastJeeps();
  }

  private safeJeepExit(jeep: ServerJeep, playerId: string): Position | null {
    if (!this.players.has(playerId)) return null;
    return vehicleExitSpot(this.world, jeep, {
      vehicles: this.jeeps.values(),
      players: this.players.values(),
      ignoreVehicleId: jeep.id,
      ignorePlayerId: playerId,
    });
  }

  private exitJeep(playerId: string, forced = false): boolean {
    const jeep = this.driverJeep(playerId);
    if (!jeep) return false;
    const player = this.players.get(playerId);
    const exit = this.safeJeepExit(jeep, playerId);
    if (!exit && !forced) { this.jeepMessage(playerId, 'No safe exit: move the jeep first'); return false; }
    jeep.driverId = null;
    jeep.speed = 0;
    jeep.throttle = 0;
    if (player && !player.isDead) {
      player.position = exit ?? this.getSpawnPosition(player.team);
      this.sendToPlayer(playerId, { type: 'jeepExited', position: { ...player.position } });
      this.broadcast({ type: 'playerUpdated', playerId, state: player.getState() });
    }
    this.broadcastJeeps();
    return true;
  }

  private updateJeeps(dt: number): void {
    if (this.jeeps.size === 0) return;
    const step = Math.min(dt, 0.05);
    let removed = false;
    for (const jeep of this.jeeps.values()) {
      if (jeep.wreck) { if (this.world.serverTime >= jeep.wreckUntil) { this.jeeps.delete(jeep.id); this.botJeepVehicleCooldown.delete(jeep.id); removed = true; } continue; }
      const driver = jeep.driverId ? this.players.get(jeep.driverId) : undefined;
      if (!driver || driver.isDead || driver.isSpectating) { if (jeep.driverId) this.exitJeep(jeep.driverId, true); continue; }
      if (this.world.serverTime - jeep.lastInput > 0.5) { jeep.throttle = 0; jeep.steering = 0; jeep.brake = true; }
      const spec = vehicleSpec(jeep.kind);
      const targetSpeed = jeep.brake ? 0 : jeep.throttle * (jeep.throttle < 0 ? spec.reverseSpeed : spec.topSpeed);
      jeep.speed += Math.max(-spec.acceleration * step, Math.min(spec.acceleration * step, targetSpeed - jeep.speed));
      const turn = jeep.steering * Math.min(Math.abs(jeep.speed) / spec.fullTurnSpeed, 1) * (jeep.speed < 0 ? -1 : 1) * spec.turnRate * step;
      const yaw = jeep.yaw + turn;
      const x = jeep.position.x - Math.sin(yaw) * jeep.speed * step;
      const z = jeep.position.z - Math.cos(yaw) * jeep.speed * step;
      const y = this.jeepGround({ x, y: jeep.position.y, z }, yaw, spec);
      if (y !== null && this.jeepClear({ x, y, z }, yaw, spec, jeep.id, driver.id)) {
        jeep.position = { x, y, z }; jeep.yaw = yaw;
      } else jeep.speed = 0;
      driver.position = { ...jeep.position };
    }
    this.jeepSync += dt;
    if (removed || this.jeepSync >= 0.1) { this.jeepSync = 0; this.broadcastJeeps(); }
  }

  private damageJeep(jeep: ServerJeep, damage: number): void {
    if (jeep.wreck) return;
    jeep.hp = Math.max(0, jeep.hp - damage);
    if (jeep.hp === 0) {
      if (jeep.driverId) this.exitJeep(jeep.driverId, true);
      jeep.wreck = true; jeep.speed = 0; jeep.wreckUntil = this.world.serverTime + 4;
    }
    this.broadcastJeeps();
  }

  /** Spent rounds hurt structures too; at zero hp the squad loses the build. */
  private damageEmplacement(emplacementId: string, damage: number): void {
    const emplacement = this.emplacements.get(emplacementId);
    if (!emplacement || damage <= 0) return;
    const maxHp = emplacementSpec(emplacement.kind)?.maxHp ?? 0;
    emplacement.hp = Math.max(0, emplacement.hp - damage);
    // Send a discrete hit event so the client can flash the build and show a
    // health bar; the full-list broadcast that follows is only for position/
    // yaw sync and removal, not for damage feedback.
    this.broadcast({
      type: 'emplacementDamaged',
      emplacementId,
      damage,
      hp: emplacement.hp,
      maxHp,
    });
    if (emplacement.hp > 0) {
      this.broadcastEmplacements();
      return;
    }
    // A gunner inside a wrecked nest is put back on the ground, not trapped.
    if (emplacement.gunnerId) this.dismountEmplacement(emplacement.gunnerId, true);
    this.emplacements.delete(emplacementId);
    this.emplacementFireAt.delete(emplacementId);
    this.broadcastEmplacements();
  }

  /** Ray versus a placed structure; terrain still occludes hits. */
  private hitEmplacement(origin: Position, direction: Position, maxDist: number, team: 'red' | 'blue'): { emplacement: EmplacementSnapshot; distance: number } | null {
    let best: { emplacement: EmplacementSnapshot; distance: number } | null = null;
    for (const emplacement of this.emplacements.values()) {
      if (emplacement.team === team) continue;
      const spec = emplacementSpec(emplacement.kind);
      if (!spec) continue;
      let near = 0;
      let far = maxDist;
      const cos = Math.cos(emplacement.yaw);
      const sin = Math.sin(emplacement.yaw);
      const dx = origin.x - emplacement.position.x;
      const dz = origin.z - emplacement.position.z;
      const localX = cos * dx - sin * dz;
      const localZ = sin * dx + cos * dz;
      const localDirX = cos * direction.x - sin * direction.z;
      const localDirZ = sin * direction.x + cos * direction.z;
      const slabs: Array<[number, number, number, number]> = [
        [localX, localDirX, -spec.halfWidth, spec.halfWidth],
        [origin.y, direction.y, emplacement.position.y, emplacement.position.y + spec.height],
        [localZ, localDirZ, -spec.halfLength, spec.halfLength],
      ];
      for (const [o, d, low, high] of slabs) {
        if (Math.abs(d) < 1e-8) {
          if (o < low || o > high) { far = -1; break; }
          continue;
        }
        const a = (low - o) / d;
        const b = (high - o) / d;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
      if (near <= far && near <= maxDist && (!best || near < best.distance)) best = { emplacement, distance: near };
    }
    return best;
  }

  /** Ray versus a rotated jeep bounding box; terrain still occludes hits. */
  private hitJeep(origin: Position, direction: Position, maxDist: number, team: 'red' | 'blue'): { jeep: ServerJeep; distance: number } | null {
    let best: { jeep: ServerJeep; distance: number } | null = null;
    for (const jeep of this.jeeps.values()) {
      if (jeep.wreck || jeep.team === team) continue;
      let near = 0, far = maxDist;
      const dx = origin.x - jeep.position.x, dz = origin.z - jeep.position.z;
      const cos = Math.cos(jeep.yaw), sin = Math.sin(jeep.yaw);
      const localX = cos * dx - sin * dz, localZ = sin * dx + cos * dz;
      const localDirX = cos * direction.x - sin * direction.z, localDirZ = sin * direction.x + cos * direction.z;
      const spec = vehicleSpec(jeep.kind);
      for (const [o, d, low, high] of [[localX, localDirX, -spec.halfWidth, spec.halfWidth], [origin.y, direction.y, jeep.position.y, jeep.position.y + spec.height], [localZ, localDirZ, -spec.halfLength, spec.halfLength]]) {
        if (Math.abs(d) < 1e-8) { if (o < low || o > high) { far = -1; break; } continue; }
        const a = (low - o) / d, b = (high - o) / d;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      }
      if (near <= far && near <= maxDist && (!best || near < best.distance)) best = { jeep, distance: near };
    }
    return best;
  }

  private getWorkshops(): Workshops {
    const make = (team: 'red' | 'blue') => {
      const { x, z } = WORKSHOP_CENTERS[team];
      return { position: { x, y: GROUND_LEVEL + 0.5, z }, stock: this.workshopStock[team], capacity: WORKSHOP_CAPACITY };
    };
    return { red: make('red'), blue: make('blue') };
  }

  private broadcastWorkshops(): void {
    this.broadcast({ type: 'workshopsUpdated', workshops: this.getWorkshops() });
  }

  /** Blueprints are per player: only the crafter sees their own bench slots. */
  private broadcastBlueprints(playerId: string): void {
    this.sendToPlayer(playerId, {
      type: 'blueprintsUpdated',
      blueprints: [...(this.craftedBlueprints.get(playerId) ?? [null, null, null])] as BlueprintSlots,
    });
  }

  private resetResources(playerId: string): void {
    this.depositableBlocks.set(playerId, 0);
    this.sendToPlayer(playerId, { type: 'resourcesUpdated', depositable: 0 });
  }

  /** Craft one blueprint into the requested slot at this team's bench. Charges
   *  the full spec cost from that team's stockpile and stores the kind in the
   *  slot so subsequent placement can consume it. Rejected (cheap) rejections
   *  never touch stock — the bench is expensive and final. */
  private craftBlueprint(playerId: string, kind: unknown, slot: unknown): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.roundPhase !== 'live') {
      return this.emplacementMessage(playerId, 'Cannot craft right now');
    }
    if (typeof kind !== 'string' || !emplacementSpec(kind)) {
      return this.emplacementMessage(playerId, 'That is not a real blueprint');
    }
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > 2) {
      return this.emplacementMessage(playerId, 'Choose slot 1, 2 or 3');
    }

    const bench = benchPosition(this.getWorkshops()[player.team].position);
    if (Math.hypot(player.position.x - bench.x, player.position.y - bench.y, player.position.z - bench.z) > BENCH_REACH) {
      return this.emplacementMessage(playerId, 'Stand at your blueprint bench to craft');
    }

    const slots = this.craftedBlueprints.get(playerId) ?? [null, null, null];
    if (slots[slot] !== null) {
      return this.emplacementMessage(playerId, 'That slot already has a blueprint in it');
    }

    const spec = emplacementSpec(kind)!;
    if (this.workshopStock[player.team] < spec.cost) {
      return this.emplacementMessage(playerId, 'Not enough workshop blocks for that build');
    }

    this.workshopStock[player.team] -= spec.cost;
    slots[slot] = spec.kind;
    this.craftedBlueprints.set(playerId, slots);
    this.broadcastWorkshops();
    this.broadcastBlueprints(playerId);
  }

  
  private depositWorkshop(playerId: string, team: unknown): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || !isTeam(team) || player.team !== team) return;
    const position = this.getWorkshops()[team].position;
    if (Math.hypot(player.position.x - position.x, player.position.y - position.y, player.position.z - position.z) > WORKSHOP_REACH) return;
    const amount = Math.min(this.depositableBlocks.get(playerId) ?? 0, WORKSHOP_CAPACITY - this.workshopStock[team]);
    if (amount <= 0) return;
    this.depositableBlocks.set(playerId, (this.depositableBlocks.get(playerId) ?? 0) - amount);
    this.workshopStock[team] += amount;
    this.sendToPlayer(playerId, { type: 'resourcesUpdated', depositable: this.depositableBlocks.get(playerId)! });
    this.broadcastWorkshops();
  }

  /** A forward supply crate: mined blocks go in so a squad can resupply away
   *  from the workshop, and teammates draw them back into build inventory.
   *  Server-validated team, reach and capacity; the crate's stock dies with it. */
  private useSupplyCrate(playerId: string, emplacementId: unknown, action: unknown): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.roundPhase !== 'live') return;
    if (typeof emplacementId !== 'string' || (action !== 'deposit' && action !== 'draw')) return;
    const crate = this.emplacements.get(emplacementId);
    if (!crate || crate.kind !== 'supplyCrate') return this.emplacementMessage(playerId, 'That build is not a supply crate');
    if (crate.team !== player.team) return this.emplacementMessage(playerId, 'That crate belongs to the other team');
    const distance = Math.hypot(
      player.position.x - crate.position.x,
      player.position.y - crate.position.y,
      player.position.z - crate.position.z,
    );
    if (distance > EMPLACEMENT_USE_REACH) return this.emplacementMessage(playerId, 'Walk up to the crate to use it');

    if (action === 'deposit') {
      const carried = this.depositableBlocks.get(playerId) ?? 0;
      const amount = Math.min(carried, SUPPLY_CRATE_CAPACITY - crate.stock);
      if (amount <= 0) {
        return this.emplacementMessage(playerId, carried > 0 ? 'The crate is full' : 'Mine blocks to fill the crate');
      }
      crate.stock += amount;
      this.depositableBlocks.set(playerId, carried - amount);
      this.sendToPlayer(playerId, { type: 'resourcesUpdated', depositable: carried - amount });
    } else {
      if (crate.stock <= 0) return this.emplacementMessage(playerId, 'The crate is empty');
      const amount = Math.min(SUPPLY_CRATE_DRAW, crate.stock);
      crate.stock -= amount;
      const inventory = (this.inventories.get(playerId) ?? 0) + amount;
      this.inventories.set(playerId, inventory);
      this.sendToPlayer(playerId, { type: 'inventoryUpdated', inventory });
    }
    this.broadcastEmplacements();
  }
  
  // Flag positions (must match client)
  private readonly BLUE_FLAG_POS = BLUE_FLAG_POS;
  private readonly RED_FLAG_POS = RED_FLAG_POS;
  private readonly CAPTURE_DISTANCE = 7.0; // Pickup radius (matches client)
  /** Distance from home base that scores. One rule for the automatic and the
   *  client-driven path; they used to disagree (6.5 vs 7.0). */
  private readonly CAPTURE_SCORE_RADIUS = 7.0;
  /** How far from the player's body a build request may target. */
  private readonly BUILD_REACH = 6.5;
  
  // Flag state tracking
  private blueFlagAtBase: boolean = true;
  private redFlagAtBase: boolean = true;
  private blueFlagCarrier: string | null = null; // Player ID carrying blue flag
  private redFlagCarrier: string | null = null; // Player ID carrying red flag
  private blueFlagRespawnTimer: number = 0; // Disappears while respawning after capture
  private redFlagRespawnTimer: number = 0; // Disappears while respawning after capture
  private droppedFlags: Array<{ position: Position; team: 'red' | 'blue'; respawnTimer: number }> = [];

  // Respawn timers for networked players (client is authoritative on movement;
  // the server schedules respawns itself so dead players don't ghost-update)
  private respawnTimers: Map<string, number> = new Map();

  /** Persistent IP ban list shared with the admin CLI via BAN_FILE. */
  readonly bans: BanStore = BanStore.default();

  constructor() {
    this.world = new ServerWorld();
    this.bans.loadFromDisk();
    log.info(`initialized (ban file: ${this.bans.filePath}, bans active: ${this.bans.list().length})`);
    this.spawnDefaultBots();
  }

  // ---------------- AI Bots ----------------

  /** Spawn a balanced set of AI bots (flank / camp / build / trench behaviors).
   *  Default fills the match to 10v10; humans replacing bots via makeRoomForHuman(). */
  spawnDefaultBots(countPerTeam: number = Number(process.env.SERVER_BOT_COUNT ?? 10)): void {
    const names = [
      'Rook', 'Vex', 'Milo', 'Dana', 'Cinder', 'Flint', 'Echo', 'Wren',
      'Bishop', 'Kite', 'Onyx', 'Pike', 'Quill', 'Riven', 'Sable', 'Talon',
      'Umbra', 'Volt', 'Wisp', 'Zephyr', 'Ash', 'Bramble', 'Cobalt', 'Dusk',
    ];
    let i = 0;
    for (const team of ['blue', 'red'] as const) {
      for (let n = 0; n < countPerTeam; n++) {
        this.addBot(team, `🤖 ${names[i % names.length]}`);
        i++;
      }
    }
  }

  /** Kick one bot off the human's newly chosen team so teams stay balanced
   *  and total roster size stays constant (e.g. 10 per side in a 10v10). */
  private makeRoomForHuman(team: 'red' | 'blue'): void {
    if (!team) return;
    const bots = [...this.players.values()].filter(
      (p): p is ServerBot => p instanceof ServerBot && p.team === team,
    );
    if (bots.length === 0) return; // no bots left on this team — allow overflow
    // Remove the most recently added bot (last spawned) for a stable feel.
    const victim = bots[bots.length - 1];
    log.info(`human joined ${team} — retiring bot "${victim.name}" (${victim.id}) to keep balance`);
    this.removeBot(victim.id);
  }

  addBot(team: 'red' | 'blue', name: string): string {
    const botId = `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const spawnPos = this.getSpawnPosition(team);
    const teamBots = [...this.players.values()].filter(
      (p): p is ServerBot => p instanceof ServerBot && p.team === team,
    );
    const engineerCount = teamBots.filter((p) => p.isEngineer).length;
    const logisticsCount = teamBots.filter((p) => p.isLogistics).length;
    // Keep logistics assignment separate from the two firebase engineers.
    const bot = new ServerBot(botId, spawnPos, team, name, engineerCount < 2, engineerCount >= 2 && logisticsCount < 1);
    this.players.set(botId, bot);
    this.inventories.set(botId, 0);
    this.depositableBlocks.set(botId, 0);
    // No connection entry: broadcasts/sendToPlayer naturally skip bots,
    // and their state flows to clients via playerUpdated/broadcastState.
    this.broadcast({
      type: 'playerJoined',
      playerId: botId,
      state: bot.getState(),
    });
    log.info(`bot spawned id=${botId} name=${name} team=${team} total=${this.players.size}`);
    return botId;
  }

  removeBot(botId: string): void {
    if (!this.players.has(botId)) return;
    this.botJeepTasks.delete(botId);
    this.botJeepCooldown.delete(botId);
    this.handlePlayerDeath(botId); // drops any carried flag properly
    this.players.delete(botId);
    this.respawnTimers.delete(botId);
    this.lastShootTime.delete(botId);
    this.lastToolTime.delete(botId);
    this.inventories.delete(botId);
    this.depositableBlocks.delete(botId);
    this.botLogisticsTasks.delete(botId);
    this.depositableBlocks.delete(botId);
    this.spawnProtectedUntil.delete(botId);
    this.lastDamagedAt.delete(botId);
    this.lastHpBroadcast.delete(botId);
    // Keep retired bots' stats until they rejoin — the scoreboard still shows
    // their kills/captures for the match (they remain part of the battle).
    this.broadcast({ type: 'playerLeft', playerId: botId });
  }

  /** Snapshot a gun for the AI: only what aiming and firing need. */
  private botGunSeat(emplacement: EmplacementSnapshot | undefined): BotGunSeat | null {
    if (!emplacement) return null;
    const spec = emplacementSpec(emplacement.kind);
    if (!spec) return null;
    return {
      id: emplacement.id,
      kind: emplacement.kind,
      position: { ...emplacement.position },
      yaw: emplacement.yaw,
      baseYaw: emplacement.baseYaw,
      ammo: emplacement.ammo,
      arc: spec.arc,
      minRange: spec.minRange,
      maxRange: spec.maxRange,
    };
  }

  /** The gun hooks bots use. Mount, aim and fire all go through the same
   *  private seat methods humans use, so a bot can never do more than a player.
   *  Only the hitscan nest is bot-crewed for now: cannon and mortar shells need
   *  ballistic aiming, which is a separate problem from taking a seat. */
  private botGunContext(): BotGunContext {
    const crewable = (emplacement: EmplacementSnapshot) => emplacement.kind === 'mgNest';
    return {
      manned: (bot) => this.botGunSeat(this.gunnerEmplacement(bot.id)),
      freeNear: (bot, radius) => {
        let best: EmplacementSnapshot | undefined;
        let bestDistance = radius;
        for (const emplacement of this.emplacements.values()) {
          if (emplacement.team !== bot.team || !crewable(emplacement) || emplacement.ammo <= 0) continue;
          if (emplacement.gunnerId && emplacement.gunnerId !== bot.id) continue;
          const distance = Math.hypot(
            emplacement.position.x - bot.position.x,
            emplacement.position.z - bot.position.z,
          );
          if (distance <= bestDistance) { best = emplacement; bestDistance = distance; }
        }
        return this.botGunSeat(best);
      },
      mount: (bot, emplacementId) => {
        this.mountEmplacement(bot.id, emplacementId);
        return this.gunnerEmplacement(bot.id)?.id === emplacementId;
      },
      leave: (bot) => {
        this.dismountEmplacement(bot.id);
      },
      aim: (bot, point) => {
        const gun = this.gunnerEmplacement(bot.id);
        if (!gun) return;
        const dx = point.x - gun.position.x;
        const dz = point.z - gun.position.z;
        const yaw = Math.atan2(-dx, -dz);
        const flat = Math.hypot(dx, dz) || 1;
        const pitch = Math.atan2(point.y - (gun.position.y + 1.15), flat);
        bot.rotation.yaw = yaw;
        bot.rotation.pitch = pitch;
        this.aimEmplacement(bot.id, yaw, pitch);
      },
      fire: (bot) => {
        this.fireEmplacement(bot.id);
      },
    };
  }

  private getBotContext(): BotContext {
    const targets: BotTargetInfo[] = [];
    for (const [id, p] of this.players) {
      targets.push({
        id,
        position: { ...p.position },
        team: p.team,
        isDead: p.isDead || p.isSpectating,
        carryingFlag: p.carryingFlag,
      });
    }
    // Emplacements are valid targets and obstacles for bots; a manned nest in
    // particular must be fightable, not invisible. Both teams' builds are listed
    // and each bot filters its own side out in perception (same as players).
    for (const e of this.emplacements.values()) {
      targets.push({
        id: e.id,
        position: { ...e.position },
        team: e.team,
        isDead: false,
        carryingFlag: false,
        emplacement: {
          id: e.id,
          kind: e.kind,
          manned: e.gunnerId !== null,
        },
      });
    }
    const ctx: BotContext = {
      world: this.world,
      serverTime: this.world.serverTime,
      targets,
      friendlyDroppedFlagPos: null, // filled per-bot below via closure default
      canSee: (from, to) => this.hasLineOfSight(from, to),
      fireWeapon: (bot, target, aimDir, eyeY) => {
        const origin = { x: bot.position.x, y: bot.position.y + eyeY, z: bot.position.z };
        const spread = bot.equipment === 'smg' ? 0.03 : 0.004;
        const dir = {
          x: aimDir.x + (Math.random() - 0.5) * spread,
          y: aimDir.y + (Math.random() - 0.5) * spread,
          z: aimDir.z + (Math.random() - 0.5) * spread,
        };
        this.botShoot(bot.id, origin, dir, target.id);
      },
      buildBlock: (bot, pos) => {
        this.botBuild(bot.id, pos);
      },
      digBlock: (bot, pos) => {
        this.botDig(bot.id, pos);
      },
      placeEmplacement: (bot, kind, position, yaw) => this.botPlaceEmplacement(bot, kind, position, yaw),
      guns: this.botGunContext(),
      // Bots walk around built structures instead of grinding into them; a
      // manned nest especially must not be steppable, or a bot would stand
      // inside a gun that is shooting at its friends.
      blockedBy: (x, z) => {
        for (const emplacement of this.emplacements.values()) {
          const spec = emplacementSpec(emplacement.kind);
          if (!spec) continue;
          const cos = Math.cos(emplacement.yaw);
          const sin = Math.sin(emplacement.yaw);
          const dx = x - emplacement.position.x;
          const dz = z - emplacement.position.z;
          const localX = cos * dx - sin * dz;
          const localZ = sin * dx + cos * dz;
          if (Math.abs(localX) <= spec.halfWidth + 0.5 && Math.abs(localZ) <= spec.halfLength + 0.5) return true;
        }
        return false;
      },
    };
    return ctx;
  }

  private hasLineOfSight(from: Position, to: Position): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = this.world.raycast(from, dir, dist);
    return !hit || hit.distance >= dist - 1.0;
  }

  /** Bot fired at a validated target: apply weapon damage through the same
   *  authoritative pipeline used for humans (no client-reported hits). The target
   *  may be a player or an emplacement; an emplacement blocks shots aimed through
   *  it, and if the emplacement itself is the target the round damages it directly. */
  private botShoot(botId: string, origin: Position, direction: Position, targetId: string): void {
    const bot = this.players.get(botId);
    if (!bot) return;

    const weapon = WEAPONS[bot.equipment as 'rifle' | 'smg'];
    if (!weapon) return;

    // Broadcast the shot so other clients render tracer/flash/sound
    this.broadcastExcept(botId, {
      type: 'playerShot',
      playerId: botId,
      origin,
      direction,
      weapon: bot.equipment,
    });
    this.broadcast({ type: 'playerUpdated', playerId: botId, state: bot.getState() });

    // When the target is a build, shoot the build instead of sampling a player body.
    if (targetId.startsWith('emplace-')) {
      const emplacement = this.emplacements.get(targetId);
      if (!emplacement || emplacement.team === bot.team) return;
      const aimPoint = { x: emplacement.position.x, y: emplacement.position.y + 0.8, z: emplacement.position.z };
      if (!this.hasLineOfSight(origin, aimPoint)) {
        const hit = this.world.raycast(origin, direction, 350);
        if (hit && hit.voxelPos) this.damageAndBroadcastVoxel(hit.voxelPos);
        return;
      }
      const dist = Math.hypot(aimPoint.x - origin.x, aimPoint.y - origin.y, aimPoint.z - origin.z);
      const structureHit = this.hitEmplacement(origin, direction, dist, bot.team);
      if (structureHit && structureHit.emplacement.id === targetId) {
        this.damageEmplacement(targetId, weaponDamage(weapon, false, dist));
      }
      return;
    }

    const targetPlayer = this.players.get(targetId);
    if (!targetPlayer || bot.isDead || targetPlayer.isDead) return;
    if (targetPlayer.team === bot.team) return;

    // Terrain must not block the bullet
    if (!this.hasLineOfSight(origin, { x: targetPlayer.position.x, y: targetPlayer.position.y + 1.1, z: targetPlayer.position.z })) {
      // Hit wall instead — damage voxel along the ray
      const hit = this.world.raycast(origin, direction, 350);
      if (hit && hit.voxelPos) this.damageAndBroadcastVoxel(hit.voxelPos);
      return;
    }

    const dist = Math.hypot(
      targetPlayer.position.x - origin.x,
      targetPlayer.position.y + 1.1 - origin.y,
      targetPlayer.position.z - origin.z,
    );
    // Headshot chance scales with accuracy distance
    const isHeadshot = dist < 25 && Math.random() < 0.18;
    const damage = weaponDamage(weapon, isHeadshot, dist);

    // An enemy structure lined up in front of the target takes the round.
    const structureHit = this.hitEmplacement(origin, direction, dist, bot.team);
    if (structureHit) {
      this.damageEmplacement(structureHit.emplacement.id, weaponDamage(weapon, false, structureHit.distance));
      return;
    }

    this.clearSpawnProtection(botId);
    const occupiedJeep = this.driverJeep(targetId);
    if (occupiedJeep) this.damageJeep(occupiedJeep, weaponDamage(weapon, false, dist));
    else this.applyDamage(targetId, damage, botId, isHeadshot);
  }


  private damageAndBroadcastVoxel(pos: Position): void {
    const { x, y, z } = pos;
    const destroyed = this.world.damageVoxel(x, y, z, 1);
    const voxel = this.world.getVoxel(x, y, z);
    this.broadcast({
      type: 'voxelChanged',
      change: { x, y, z, type: voxel ? voxel.type : VOXEL_AIR, durability: voxel ? voxel.durability : 0 },
    });
    if (destroyed) {
      const collapsed = this.world.collapseDisconnected(x, y, z);
      for (const change of collapsed) {
        this.broadcast({ type: 'voxelChanged', change });
      }
    }
  }

  /** Centralized damage application (used by bot shots). Human shots keep
   *  their own path but respect the same death/respawn bookkeeping. */
  private applyDamage(targetId: string, damage: number, attackerId: string, isHeadshot: boolean = false): void {
    const target = this.players.get(targetId);
    const attacker = this.players.get(attackerId);
    if (!target || target.isDead) return;
    if (this.isSpawnProtected(targetId)) return; // shield soaks the round

    target.takeDamage(damage);
    this.noteDamaged(targetId);

    // Threat memory for bot victims: they hunt back toward their attacker
    if (target instanceof ServerBot && attackerId) {
      target.noteHitBy(attackerId, this.world.serverTime);
    }

    // Confirm the hit to the SHOOTER, not the victim: the client renders the
    // hit marker + headshot sound from this event, so sending it to the victim
    // made players see "you hit someone" feedback whenever a bot shot them.
    this.sendToPlayer(attackerId, { type: 'hitConfirmed', targetId, damage, isHeadshot });

    this.broadcast({ type: 'playerDamaged', playerId: targetId, damage, attackerId });
    this.broadcast({ type: 'playerUpdated', playerId: targetId, state: target.getState() });

    if (target.isDead) {
      this.handlePlayerDeath(targetId);
      if (attacker) {
        if (attacker.team === 'red') this.addTeamScore('red');
        else this.addTeamScore('blue');
        this.getStats(attacker.id).kills++;
        this.broadcastStats();
      }
      this.broadcast({
        type: 'playerDied',
        playerId: targetId,
        killerId: attackerId,
        weapon: attacker?.equipment,
        isHeadshot,
      });
      this.respawnTimers.set(targetId, 4.0);
    }
  }

  // ---------------- Spawn protection & regeneration ----------------

  /** Give a freshly spawned/joined player a short invulnerability window. */
  private grantSpawnProtection(playerId: string): void {
    this.spawnProtectedUntil.set(playerId, this.world.serverTime + SPAWN_PROTECTION_SECONDS);
    const player = this.players.get(playerId);
    if (player) player.spawnProtected = true;
  }

  /** Drop the shield early — a player's own shot cancels it, so it can never be
   *  used as an attack shield from inside cover. */
  private clearSpawnProtection(playerId: string): void {
    if (!this.spawnProtectedUntil.delete(playerId)) return;
    const player = this.players.get(playerId);
    if (player) player.spawnProtected = false;
  }

  private isSpawnProtected(playerId: string): boolean {
    const until = this.spawnProtectedUntil.get(playerId) ?? 0;
    return until > this.world.serverTime;
  }

  /** Reset the regeneration delay for a player that just took damage. */
  private noteDamaged(playerId: string): void {
    this.lastDamagedAt.set(playerId, this.world.serverTime);
  }

  /** Tick spawn shields and out-of-combat regeneration. */
  private updateHealth(dt: number): void {
    const now = this.world.serverTime;
    for (const player of this.players.values()) {
      // Shield expiry: flip the flag and tell clients the shield is gone.
      const until = this.spawnProtectedUntil.get(player.id) ?? 0;
      if (until > 0 && until <= now && player.spawnProtected) {
        player.spawnProtected = false;
        this.spawnProtectedUntil.delete(player.id);
        this.broadcast({ type: 'playerUpdated', playerId: player.id, state: player.getState() });
      }

      if (player.isDead || player.isSpectating || player.spawnProtected) continue;
      if (player.hp >= player.maxHp) continue;

      const lastHit = this.lastDamagedAt.get(player.id) ?? -Infinity;
      if (now - lastHit < REGEN_DELAY_SECONDS) continue;

      player.hp = Math.min(player.maxHp, player.hp + REGEN_RATE * dt);
      // Sync only when the visible integer changes (and on the final full heal).
      const shown = Math.floor(player.hp);
      if (this.lastHpBroadcast.get(player.id) !== shown) {
        this.lastHpBroadcast.set(player.id, shown);
        this.broadcast({ type: 'playerUpdated', playerId: player.id, state: player.getState() });
      }
    }
  }

  // ---------------- Round lifecycle ----------------

  /** Authoritative round snapshot (join payload + every roundUpdate). */
  getRoundSnapshot(): RoundSnapshot {
    return {
      round: this.roundNumber,
      phase: this.roundPhase,
      timeLeft: this.roundTimeLeft,
      intermission: this.intermissionTimeLeft,
      captures: { ...this.captures },
      touches: { ...this.flagTouches },
      returns: { ...this.flagReturns },
      wins: { ...this.roundWins },
      duration: this.roundSeconds,
    };
  }

  private broadcastRound(): void {
    this.broadcast({ type: 'roundUpdate', round: this.getRoundSnapshot() });
  }

  /** Round clock and phase transitions, driven from the game loop. */
  private updateRound(dt: number): void {
    if (this.roundPhase === 'live') {
      this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt);
      if (this.roundTimeLeft <= 0) {
        this.endRound();
        return;
      }
    } else {
      this.intermissionTimeLeft = Math.max(0, this.intermissionTimeLeft - dt);
      if (this.intermissionTimeLeft <= 0) {
        this.startNextRound();
        return;
      }
    }

    this.roundSyncAccumulator += dt;
    if (this.roundSyncAccumulator >= 1) {
      this.roundSyncAccumulator = 0;
      this.broadcastRound();
    }
  }

  /** Who takes the round when the whistle blows.
   *
   *  Captures decide it first, as they always have. A 0:0 round is no longer an
   *  automatic draw: the tiebreak chain is captures, then enemy-flag touches
   *  (steals that did not finish), then returns of your own dropped flag, then
   *  kills. Only a round level on all four ends as a draw. */
  private roundWinner(): RoundWinner {
    const leader = (tally: { red: number; blue: number }): RoundWinner | null => {
      if (tally.red === tally.blue) return null;
      return tally.red > tally.blue ? 'red' : 'blue';
    };
    for (const tally of [this.captures, this.flagTouches, this.flagReturns, this.roundKills]) {
      const winner = leader(tally);
      if (winner) return winner;
    }
    return 'draw';
  }

  /** Time is up: decide with the tiebreak chain and start the intermission. */
  private endRound(): void {
    const { red, blue } = this.captures;
    const winner = this.roundWinner();
    if (winner !== 'draw') this.roundWins[winner]++;

    this.roundPhase = 'intermission';
    this.roundTimeLeft = 0;
    this.intermissionTimeLeft = INTERMISSION_SECONDS;
    this.roundSyncAccumulator = 0;

    this.resetFlags();
    this.broadcast({
      type: 'roundEnded',
      round: this.roundNumber,
      winner,
      captures: { ...this.captures },
      touches: { ...this.flagTouches },
      returns: { ...this.flagReturns },
      wins: { ...this.roundWins },
    });
    this.broadcastRound();
    log.info(
      `ROUND ${this.roundNumber} ENDED — winner=${winner} ` +
      `(caps blue:${blue} red:${red}, touches blue:${this.flagTouches.blue} red:${this.flagTouches.red}, ` +
      `returns blue:${this.flagReturns.blue} red:${this.flagReturns.red}) ` +
      `rounds blue:${this.roundWins.blue} red:${this.roundWins.red}`,
    );
  }

  private startNextRound(): void {
    this.roundNumber++;
    this.captures = { red: 0, blue: 0 };
    this.flagTouches = { red: 0, blue: 0 };
    this.flagReturns = { red: 0, blue: 0 };
    this.roundKills = { red: 0, blue: 0 };
    this.roundPhase = 'live';
    this.roundTimeLeft = this.roundSeconds;
    this.intermissionTimeLeft = 0;
    this.roundSyncAccumulator = 0;

    this.resetFlags();
    this.botJeepTasks.clear();
    this.botJeepCooldown.clear();
    this.botJeepVehicleCooldown.clear();
    for (const jeep of this.jeeps.values()) if (jeep.driverId) this.exitJeep(jeep.driverId, true);
    // Emplacements are spent supply, like a wrecked vehicle: nothing refunded.
    if (this.emplacements.size > 0) {
      for (const emplacement of this.emplacements.values()) {
        if (emplacement.gunnerId) this.dismountEmplacement(emplacement.gunnerId, true);
      }
      this.emplacements.clear();
      this.emplacementFireAt.clear();
      this.shells.clear();
      this.broadcastEmplacements();
    }
    this.jeeps.clear();
    this.broadcastJeeps();
    this.workshopStock = { red: WORKSHOP_START_STOCK, blue: WORKSHOP_START_STOCK };
    this.broadcastWorkshops();
    this.resetPlayersForRound();
    this.broadcastRound();
    log.info(`ROUND ${this.roundNumber} STARTED — ${Math.round(this.roundSeconds / 60)} minute round`);
  }

  /** Flags back on their stands: nothing carried, nothing lying on the ground.
   *  Crafted-but-unplaced blueprints are spent supply: they survive the player
   *  respawning, but the round reset clears them with no refund, matching the
   *  emplacements and workshop stock that also reset. */
  private resetFlags(): void {
    this.blueFlagAtBase = true;
    this.redFlagAtBase = true;
    this.blueFlagCarrier = null;
    this.redFlagCarrier = null;
    this.blueFlagRespawnTimer = 0;
    this.redFlagRespawnTimer = 0;
    this.droppedFlags = [];
    for (const player of this.players.values()) {
      player.carryingFlag = false;
    }
    this.craftedBlueprints.clear();
    // Clients reposition the flag meshes from these events.
    this.broadcast({ type: 'flagReturned', flagTeam: 'blue' });
    this.broadcast({ type: 'flagReturned', flagTeam: 'red' });
  }

  /** Every combatant restarts the round alive at their own spawn. */
  private resetPlayersForRound(): void {
    for (const player of this.players.values()) {
      this.resetResources(player.id);
      if (player.isSpectating) continue; // spectators keep watching
      this.respawnTimers.delete(player.id);
      const spawnPos = this.getSpawnPosition(player.team);
      player.respawn(spawnPos);
      this.grantSpawnProtection(player.id);
      this.inventories.set(player.id, 20);
      if (player instanceof ServerBot) player.refillBlocks();
      this.broadcast({ type: 'playerRespawned', playerId: player.id, position: spawnPos });
      this.sendToPlayer(player.id, { type: 'inventoryUpdated', inventory: 20 });
    }
  }

  /**
   * Increment a team's kill score and broadcast the authoritative totals to
   * every client. Without this sync, clients only learn scores at `init`, so
   * kill feeds / HUD scores drift out of sync for everyone but the local
   * killer (whose optimistic increment never matches the server tally).
   */
  private addTeamScore(team: 'red' | 'blue'): void {
    this.scores[team]++;
    this.roundKills[team]++;
    this.broadcast({ type: 'scoreUpdate', scores: { ...this.scores } });
  }

  /** Get (creating if needed) the scoreboard tally record for a combatant. */
  private getStats(id: string): PlayerStats {
    let s = this.playerStats.get(id);
    if (!s) {
      s = { kills: 0, deaths: 0, captures: 0 };
      this.playerStats.set(id, s);
    }
    return s;
  }

  /** Push authoritative per-player K/D/captures to every client so the Tab
   *  scoreboard stays in sync across all viewers (not just local estimates). */
  private broadcastStats(): void {
    const stats: Record<string, PlayerStats> = {};
    for (const [id, s] of this.playerStats) stats[id] = { ...s };
    this.broadcast({ type: 'statsUpdate', stats });
  }

  /** Bot places a building block (validated like human builds). */
  private botBuild(botId: string, position: Position): void {
    const bot = this.players.get(botId);
    if (!bot || !(bot instanceof ServerBot) || bot.isDead) return;
    const { x, y, z } = position;
    if (!this.canBuildAt(x, y, z)) return;
    this.world.setVoxel(x, y, z, 4, 3); // VOXEL_BUILT
    this.broadcast({
      type: 'voxelChanged',
      change: { x, y, z, type: 4, durability: 3 },
    });
  }

  /**
   * Bot clears one voxel it is jammed against. Reach-limited and only used by
   * stuck recovery, so it cannot be used to chew through the map remotely.
   */
  private botDig(botId: string, position: Position): void {
    const bot = this.players.get(botId);
    if (!bot || !(bot instanceof ServerBot) || bot.isDead || bot.isSpectating) return;
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    const z = Math.round(position.z);
    if (!this.world.isSolid(x, y, z) || isWorkshopProtectedCell(x, z)) return;
    if (Math.hypot(x - bot.position.x, z - bot.position.z) > 3.5) return;
    this.world.setVoxel(x, y, z, VOXEL_AIR);
    this.broadcast({
      type: 'voxelChanged',
      change: { x, y, z, type: VOXEL_AIR, durability: 0 },
    });
  }

  private finishBotJeepTask(bot: ServerBot, reason: 'arrived' | 'damaged' | 'stuck' | 'human' | 'unavailable'): void {
    const task = this.botJeepTasks.get(bot.id);
    if (!task) return;
    if (this.driverJeep(bot.id) && !this.exitJeep(bot.id)) {
      // Try to move to a safe exit first. After bounded retries, forced cleanup
      // uses the existing safe team-spawn fallback rather than trapping the bot.
      if (reason === 'human' || task.recoveries >= 3) this.exitJeep(bot.id, true);
      else {
        task.recoveries++;
        task.phase = 'reverse';
        task.recoveryUntil = this.world.serverTime + 2;
        return;
      }
    }
    this.botJeepTasks.delete(bot.id);
    this.botJeepCooldown.set(bot.id, this.world.serverTime + BOT_JEEP_COOLDOWN);
    if (reason === 'stuck' && task.jeepId) this.botJeepVehicleCooldown.set(task.jeepId, this.world.serverTime + 60);
    if (reason === 'arrived') this.botJeepStats.arrived++;
    else if (reason === 'damaged') this.botJeepStats.damagedExits++;
    else if (reason === 'human') this.botJeepStats.humanYields++;
    else if (reason === 'stuck') this.botJeepStats.abandoned++;
    bot.resumeAfterJeep(this.world.serverTime);
  }

  private assignBotJeepTasks(): void {
    if (this.roundPhase !== 'live') return;
    for (const team of ['blue', 'red'] as const) {
      if ([...this.botJeepTasks.keys()].filter(id => this.players.get(id)?.team === team).length >= BOT_JEEP_MAX_DRIVERS_PER_TEAM) continue;
      const workshop = this.getWorkshops()[team].position;
      if (this.humanNearJeep(team, workshop)) continue;
      const jeepSpec = vehicleSpec('jeep');
      const available = [...this.jeeps.values()].find(j => j.team === team && !j.wreck && j.hp > jeepSpec.maxHp * 0.3 && !j.driverId && this.world.serverTime >= (this.botJeepVehicleCooldown.get(j.id) ?? 0) &&
        Math.hypot(j.position.x - workshop.x, j.position.z - workshop.z) <= 35 && !this.humanNearJeep(team, j.position));
      if (!available && (this.workshopStock[team] < jeepSpec.cost || [...this.jeeps.values()].some(j => j.team === team && !j.wreck && !j.driverId &&
        Math.hypot(j.position.x - workshop.x, j.position.z - workshop.z) <= 35))) continue;
      const target = available?.position ?? workshop;
      const candidates = [...this.players.values()].filter((p): p is ServerBot =>
        p instanceof ServerBot && p.team === team && p.roleName === 'assault' && !p.isEngineer && !p.isLogistics && !p.isDead && !p.isSpectating &&
        !p.carryingFlag && !this.botJeepTasks.has(p.id) && this.world.serverTime >= (this.botJeepCooldown.get(p.id) ?? 0) &&
        p.hp > p.maxHp * 0.5 && p.stateName !== 'TRENCH' && p.stateName !== 'BUILD' && p.stateName !== 'ESCORT' &&
        Math.hypot(p.position.x - target.x, p.position.z - target.z) < 90);
      candidates.sort((a, b) => Math.hypot(a.position.x - target.x, a.position.z - target.z) - Math.hypot(b.position.x - target.x, b.position.z - target.z));
      const bot = candidates[0];
      if (!bot) continue;
      this.botJeepTasks.set(bot.id, { phase: 'approach', jeepId: available?.id ?? null, startedAt: this.world.serverTime,
        lastProgressAt: this.world.serverTime, lastPosition: { ...bot.position }, recoveries: 0, recoveryUntil: 0, detour: null,
        nextSteeringAt: 0, plannedSteering: 0, plannedThrottle: 1 });
    }
  }

  /** Evaluate reachable turning arcs using the same ground and collision checks as driving. */
  private planBotJeepSteering(jeep: ServerJeep, target: { x: number; z: number }): { steering: number; throttle: number } {
    let bestScore = -Infinity;
    let best = { steering: 0, throttle: 1 };
    const initialDistance = Math.hypot(target.x - jeep.position.x, target.z - jeep.position.z);
    for (const steering of [0, -0.5, 0.5, -1, 1]) {
      for (const throttle of [1, 0.45]) {
        let { x, y, z } = jeep.position;
        let yaw = jeep.yaw, speed = jeep.speed, travelled = 0;
        let blocked = false;
        // The physics runs at 20 Hz; use the same steps to avoid skipping obstacles.
        for (let step = 0; step < 40; step++) {
          speed += Math.max(-0.5, Math.min(0.5, throttle * 12 - speed));
          yaw += steering * Math.min(Math.abs(speed) / 4, 1) * (speed < 0 ? -1 : 1) * 1.4 * 0.05;
          const nx = x - Math.sin(yaw) * speed * 0.05;
          const nz = z - Math.cos(yaw) * speed * 0.05;
          const ground = this.jeepGround({ x: nx, y, z: nz }, yaw, vehicleSpec(jeep.kind));
          if (ground === null || !this.jeepClear({ x: nx, y: ground, z: nz }, yaw, vehicleSpec(jeep.kind), jeep.id, jeep.driverId ?? undefined)) { blocked = true; break; }
          travelled += Math.hypot(nx - x, nz - z);
          x = nx; y = ground; z = nz;
        }
        const progress = initialDistance - Math.hypot(target.x - x, target.z - z);
        const score = progress + travelled * 0.08 - (blocked ? 7 : 0) - Math.abs(steering) * 0.15;
        if (score > bestScore) { bestScore = score; best = { steering, throttle }; }
      }
    }
    return best;
  }

  private updateBotJeepTask(bot: ServerBot, ctx: BotContext): boolean {
    const task = this.botJeepTasks.get(bot.id);
    if (!task) return false;
    const now = this.world.serverTime;
    const workshop = this.getWorkshops()[bot.team].position;
    const nearHuman = this.humanNearJeep(bot.team, workshop);
    if (task.phase === 'approach') {
      if (this.roundPhase !== 'live' || bot.carryingFlag || bot.hp <= bot.maxHp * 0.5 || nearHuman || now - task.startedAt > 22) {
        this.finishBotJeepTask(bot, nearHuman ? 'human' : 'unavailable'); return false;
      }
      let jeep = task.jeepId ? this.jeeps.get(task.jeepId) : undefined;
      if (!jeep && task.jeepId) { this.finishBotJeepTask(bot, 'unavailable'); return false; }
      if (!jeep) {
        if (Math.hypot(bot.position.x - workshop.x, bot.position.z - workshop.z) > WORKSHOP_REACH - 1) {
          bot.approachJeep(workshop, ctx, this.tickDt); return true;
        }
        const before = new Set(this.jeeps.keys());
        this.buildJeep(bot.id);
        jeep = [...this.jeeps.values()].find(j => !before.has(j.id));
        if (!jeep) { this.finishBotJeepTask(bot, 'unavailable'); return false; }
        this.botJeepStats.built++;
        task.jeepId = jeep.id;
      }
      if (jeep.wreck || jeep.hp <= vehicleSpec(jeep.kind).maxHp * 0.3 || jeep.driverId || this.humanNearJeep(bot.team, jeep.position)) {
        this.finishBotJeepTask(bot, 'unavailable'); return false;
      }
      const distance = Math.hypot(bot.position.x - jeep.position.x, bot.position.y - jeep.position.y, bot.position.z - jeep.position.z);
      if (distance <= vehicleSpec(jeep.kind).enterReach - 0.25) {
        this.enterJeep(bot.id, jeep.id);
        if (jeep.driverId === bot.id) {
          this.botJeepStats.entered++;
          task.phase = 'drive'; task.lastPosition = { ...jeep.position }; task.lastProgressAt = now;
        }
      } else bot.approachJeep(jeep.position, ctx, this.tickDt);
      return true;
    }

    const jeep = task.jeepId ? this.jeeps.get(task.jeepId) : undefined;
    if (!jeep || jeep.driverId !== bot.id || jeep.wreck) {
      this.finishBotJeepTask(bot, 'unavailable'); return false;
    }
    const enemyFlag = bot.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    const distance = Math.hypot(jeep.position.x - enemyFlag.x, jeep.position.z - enemyFlag.z);
    if (distance < 75 || jeep.hp <= vehicleSpec(jeep.kind).maxHp * 0.3 || this.roundPhase !== 'live') {
      this.finishBotJeepTask(bot, distance < 75 ? 'arrived' : 'damaged'); return this.botJeepTasks.has(bot.id);
    }
    if (nearHuman && Math.hypot(jeep.position.x - workshop.x, jeep.position.z - workshop.z) < BOT_JEEP_HUMAN_PRIORITY_RADIUS && Math.abs(jeep.speed) < 1) {
      this.finishBotJeepTask(bot, 'human'); return this.botJeepTasks.has(bot.id);
    }
    if (now - task.startedAt > 80) { this.finishBotJeepTask(bot, 'stuck'); return this.botJeepTasks.has(bot.id); }

    if (now - task.lastProgressAt >= 2) {
      const moved = Math.hypot(jeep.position.x - task.lastPosition.x, jeep.position.z - task.lastPosition.z);
      task.lastPosition = { ...jeep.position }; task.lastProgressAt = now;
      if (moved < 1 && task.phase !== 'reverse') {
        task.recoveries++;
        if (task.recoveries > 3) { this.finishBotJeepTask(bot, 'stuck'); return this.botJeepTasks.has(bot.id); }
        this.botJeepStats.recoveries++;
        task.phase = 'reverse'; task.recoveryUntil = now + 2; task.detour = null;
      }
    }
    if (task.phase === 'reverse') {
      jeep.throttle = -1; jeep.steering = task.recoveries % 2 ? 1 : -1; jeep.brake = false; jeep.lastInput = now;
      if (now >= task.recoveryUntil) {
        const side = task.recoveries % 2 ? 1 : -1;
        task.detour = { x: jeep.position.x + Math.cos(jeep.yaw) * side * 14, y: jeep.position.y, z: jeep.position.z - Math.sin(jeep.yaw) * side * 14 };
        task.phase = 'detour'; task.recoveryUntil = now + 6;
      }
      return true;
    }
    if (task.phase === 'detour' && (now >= task.recoveryUntil || (task.detour && Math.hypot(task.detour.x - jeep.position.x, task.detour.z - jeep.position.z) < 4))) {
      task.phase = 'drive'; task.detour = null;
    }
    const target = task.detour ?? enemyFlag;
    if (now >= task.nextSteeringAt) {
      const plan = this.planBotJeepSteering(jeep, target);
      task.plannedSteering = plan.steering; task.plannedThrottle = plan.throttle;
      task.nextSteeringAt = now + 0.25;
    }
    jeep.steering = task.plannedSteering;
    jeep.throttle = task.plannedThrottle;
    jeep.brake = false; jeep.lastInput = now;
    return true;
  }

  private assignBotLogisticsTasks(): void {
    if (this.roundPhase !== 'live') return;
    for (const team of ['blue', 'red'] as const) {
      const active = [...this.botLogisticsTasks.keys()].filter(id => this.players.get(id)?.team === team).length;
      if (active >= BOT_LOGISTICS_PER_TEAM || this.workshopStock[team] >= BOT_LOGISTICS_MIN_STOCK) continue;
      const candidate = [...this.players.values()].find((p): p is ServerBot =>
        p instanceof ServerBot && p.team === team && p.isLogistics && !p.isDead && !p.isSpectating &&
        !p.carryingFlag && !this.botJeepTasks.has(p.id) && !this.botLogisticsTasks.has(p.id) &&
        !p.stateName.match(/^(TRENCH|BUILD|RETURN|RETREAT|ESCORT)$/),
      );
      if (candidate) this.botLogisticsTasks.set(candidate.id, { target: null, phase: 'gather', nextMineAt: 0 });
    }
  }

  private updateBotLogisticsTask(bot: ServerBot, ctx: BotContext): boolean {
    const task = this.botLogisticsTasks.get(bot.id);
    if (!task) return false;
    const stock = this.workshopStock[bot.team];
    const carried = this.depositableBlocks.get(bot.id) ?? 0;
    const workshop = this.getWorkshops()[bot.team].position;
    const enemies = ctx.targets.filter(target => !target.isDead && target.team !== bot.team);
    const threat = enemies.some(enemy => Math.hypot(enemy.position.x - bot.position.x, enemy.position.z - bot.position.z) < 18);
    if (this.roundPhase !== 'live' || bot.carryingFlag || threat) {
      this.botLogisticsTasks.delete(bot.id);
      return false;
    }
    if (stock >= BOT_LOGISTICS_MIN_STOCK && carried === 0) {
      this.botLogisticsTasks.delete(bot.id);
      return false;
    }
    if (carried >= BOT_LOGISTICS_CAPACITY || stock >= BOT_LOGISTICS_MIN_STOCK) task.phase = 'return';
    if (stock >= WORKSHOP_CAPACITY) {
      this.botLogisticsTasks.delete(bot.id);
      return false;
    }
    if (task.phase === 'return' && !task.target) task.target = { ...workshop };
    if (task.phase === 'gather' && carried >= BOT_LOGISTICS_CAPACITY) {
      task.phase = 'return';
      task.target = { ...workshop };
    }
    if (task.phase === 'gather' && carried > 0 && this.workshopStock[bot.team] >= BOT_LOGISTICS_MIN_STOCK - 1) {
      task.phase = 'return';
      task.target = { ...workshop };
    }
    if (!task.target) {
      const bx = Math.round(bot.position.x), bz = Math.round(bot.position.z);
      let best: Position | null = null, bestDistance = Infinity;
      for (let dx = -BOT_LOGISTICS_MINE_RADIUS; dx <= BOT_LOGISTICS_MINE_RADIUS; dx++) {
        for (let dz = -BOT_LOGISTICS_MINE_RADIUS; dz <= BOT_LOGISTICS_MINE_RADIUS; dz++) {
          const x = bx + dx, z = bz + dz;
          if (Math.hypot(dx, dz) > BOT_LOGISTICS_MINE_RADIUS || isWorkshopProtectedCell(x, z)) continue;
          const y = this.world.getGroundHeight(x, z) - 1;
          const voxel = this.world.getVoxel(x, y, z);
          if (!voxel || voxel.type === VOXEL_AIR || voxel.type === VOXEL_BUILT) continue;
          const distance = Math.hypot(x - bot.position.x, z - bot.position.z);
          if (distance < bestDistance) { best = { x, y, z }; bestDistance = distance; }
        }
      }
      if (!best) { this.botLogisticsTasks.delete(bot.id); return false; }
      task.target = best;
    }
    const target = task.target;
    if (task.phase === 'gather') {
      const voxel = this.world.getVoxel(target.x, target.y, target.z);
      if (!voxel || voxel.type === VOXEL_BUILT || isWorkshopProtectedCell(target.x, target.z)) {
        task.target = null;
        return true;
      }
    }
    if (Math.hypot(target.x - bot.position.x, target.z - bot.position.z) > 2.8) {
      bot.approachJeep(target, ctx, this.tickDt);
      return true;
    }
    if (task.phase === 'return') {
      if (Math.hypot(bot.position.x - workshop.x, bot.position.y - workshop.y, bot.position.z - workshop.z) > WORKSHOP_REACH) {
        bot.approachJeep(workshop, ctx, this.tickDt);
        return true;
      }
      this.depositableBlocks.set(bot.id, carried);
      if (carried > 0) {
        const deposited = Math.min(carried, WORKSHOP_CAPACITY - this.workshopStock[bot.team]);
        if (deposited > 0) {
          this.depositableBlocks.set(bot.id, carried - deposited);
          this.workshopStock[bot.team] += deposited;
          this.broadcastWorkshops();
        }
      }
      this.botLogisticsTasks.delete(bot.id);
      return false;
    }
    if (this.world.serverTime >= task.nextMineAt) {
      const voxel = this.world.getVoxel(target.x, target.y, target.z);
      if (voxel && voxel.type !== VOXEL_BUILT && !isWorkshopProtectedCell(target.x, target.z)) {
        const destroyed = this.world.damageVoxel(target.x, target.y, target.z, TOOLS.pickaxe.damage);
        task.nextMineAt = this.world.serverTime + TOOLS.pickaxe.cooldown;
        if (destroyed) {
          this.depositableBlocks.set(bot.id, carried + 1);
          this.broadcast({ type: 'voxelChanged', change: { x: target.x, y: target.y, z: target.z, type: VOXEL_AIR, durability: 0 } });
          task.target = carried + 1 >= BOT_LOGISTICS_CAPACITY ? { ...workshop } : null;
        }
      } else task.target = null;
    }
    return true;
  }

  private updateBots(ctx: BotContext): void {
    this.assignBotLogisticsTasks();
    this.assignBotJeepTasks();
    for (const [id, player] of this.players) {
      if (!(player instanceof ServerBot)) continue;
      if (player.isDead) { this.botJeepTasks.delete(id); this.botLogisticsTasks.delete(id); continue; }
      // A bot in a gun is run by the seat, not by the jeep/logistics tasks.
      if (this.gunnerEmplacement(id)) {
        this.botJeepTasks.delete(id);
        this.botLogisticsTasks.delete(id);
      } else {
        if (this.updateBotJeepTask(player, ctx)) continue;
        if (this.updateBotLogisticsTask(player, ctx)) continue;
      }
      // Per-bot view of dropped flags belonging to its own team
      const own = ctx.friendlyDroppedFlagPos;
      const drop = this.droppedFlags.find((f) => f.team === player.team);
      ctx.friendlyDroppedFlagPos = drop ? drop.position : own;
      player.botUpdate(this.tickDt, ctx);
      ctx.friendlyDroppedFlagPos = null;
    }
  }

  private readonly tickDt: number = 1 / 20;

  /** Issue the opaque token the HTTP transport must present with messages. */
  issueSessionToken(playerId: string): string {
    const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    this.sessionTokens.set(token, playerId);
    return token;
  }

  /** Resolve a POSTed token back to its player; unknown tokens resolve to null. */
  resolveSessionToken(token: unknown): string | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    return this.sessionTokens.get(token) ?? null;
  }

  addPlayer(ws: WebSocket | GameConnection, ip?: string): string {
    const playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const spawnPos = this.getSpawnPosition('blue');
    
    const player = new ServerPlayer(playerId, spawnPos, 'blue');
    player.ip = normalizeIp(ip);
    this.players.set(playerId, player);
    this.connections.set(playerId, ws);
    this.inventories.set(playerId, 20);
    this.depositableBlocks.set(playerId, 0);
    
    // Send full init state to the new player
    const existingPlayersList: Array<{ id: string; state: PlayerState }> = [];
    for (const [id, p] of this.players) {
      existingPlayersList.push({ id, state: p.getState() });
    }

    this.sendToPlayer(playerId, {
      type: 'init',
      playerId,
      sessionToken: this.issueSessionToken(playerId),
      state: player.getState(),
      players: existingPlayersList,
      scores: this.scores,
      captures: this.captures,
      stats: Object.fromEntries(
        [...this.playerStats].map(([id, s]) => [id, { ...s }]),
      ),
      inventory: this.inventories.get(playerId) ?? 20,
      depositable: this.depositableBlocks.get(playerId) ?? 0,
      workshops: this.getWorkshops(),
      jeeps: this.jeepSnapshots(),
      emplacements: this.emplacementSnapshots(),
      blueprints: [...(this.craftedBlueprints.get(playerId) ?? [null, null, null])] as BlueprintSlots,
      voxelChanges: this.world.getModifiedVoxels(),
      // Full authoritative flag snapshot so late joiners see flags that were
      // picked up / dropped / captured BEFORE they connected (events alone
      // would leave their visuals desynced).
      flags: {
        blue: {
          atBase: this.blueFlagAtBase,
          carrierId: this.blueFlagCarrier,
          respawnTimer: this.blueFlagRespawnTimer,
          droppedPosition: this.droppedFlags.find(f => f.team === 'blue')?.position ?? null,
        },
        red: {
          atBase: this.redFlagAtBase,
          carrierId: this.redFlagCarrier,
          respawnTimer: this.redFlagRespawnTimer,
          droppedPosition: this.droppedFlags.find(f => f.team === 'red')?.position ?? null,
        },
      },
      // Late joiners need the current round/clock immediately, otherwise their
      // HUD shows round 1 with a full clock until the next 1Hz sync.
      round: this.getRoundSnapshot(),
    });
    
    log.info(`player connected id=${playerId} ip=${player.ip} name=${player.name ?? 'unnamed'} total=${this.players.size}`);
    return playerId;
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);

    // Drop any carried flag BEFORE the player is deleted. handlePlayerDeath()
    // bails out when the player is already gone, which used to strand the flag
    // on a disconnected ghost carrier and deadlock the round.
    this.dropCarriedFlag(playerId);
    this.exitJeep(playerId, true);
    this.dismountEmplacement(playerId, true);
    this.botJeepTasks.delete(playerId);
    this.botJeepCooldown.delete(playerId);

    this.players.delete(playerId);
    this.craftedBlueprints.delete(playerId);
    this.connections.delete(playerId);
    this.inventories.delete(playerId);
    this.depositableBlocks.delete(playerId);
    this.joinedPlayers.delete(playerId);
    this.lastShootTime.delete(playerId);
    // Scoreboard tallies and session tokens must not outlive the player: bots
    // churn on every join/leave, so keeping them leaked memory (and bandwidth —
    // broadcastStats ships the whole map on every death).
    this.playerStats.delete(playerId);
    for (const [token, id] of this.sessionTokens) {
      if (id === playerId) this.sessionTokens.delete(token);
    }
    this.lastToolTime.delete(playerId);
    this.respawnTimers.delete(playerId);
    this.spawnProtectedUntil.delete(playerId);
    this.lastDamagedAt.delete(playerId);
    this.lastHpBroadcast.delete(playerId);
    
    this.broadcast({
      type: 'playerLeft',
      playerId,
    });
    
    log.info(`player left id=${playerId} ip=${player?.ip ?? '?'} name=${player?.name ?? 'unnamed'} total=${this.players.size}`);

    // Maintain the 10v10 roster: when a human vacates a slot, backfill it
    // with a fresh bot on the SAME team so teams never fall short.
    const team = player?.team;
    const wasHuman = !!player && !(player instanceof ServerBot);
    if (wasHuman && team) {
      const countOnTeam = [...this.players.values()].filter((p) => p.team === team).length;
      const target = Number(process.env.SERVER_BOT_COUNT ?? 10);
      if (countOnTeam < target) {
        const names = ['Rook', 'Vex', 'Milo', 'Dana', 'Cinder', 'Flint', 'Echo', 'Wren',
          'Bishop', 'Kite', 'Onyx', 'Pike', 'Quill', 'Riven', 'Sable', 'Talon'];
        this.addBot(team, `🤖 ${names[Math.floor(Math.random() * names.length)]}`);
        log.info(`backfill bot spawned for team=${team} to keep ${target}v${target}`);
      }
    }
  }

  /**
   * Forcibly disconnect a player. If `ban` is true, their IP is also added to
   * the persistent ban list (which live-reloads from BAN_FILE so the CLI can
   * edit it while the server runs).
   */
  kickPlayer(playerId: string, reason = 'kicked by admin', ban = false): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    if (ban && player.ip) {
      this.bans.add('ip', player.ip, reason);
      log.warn(`BANNED ${player.ip} (${playerId}) reason="${reason}" file=${this.bans.filePath}`);
    } else {
      log.warn(`KICKED ${playerId} ip=${player.ip ?? '?'} name=${player.name ?? 'unnamed'} reason="${reason}"`);
    }

    // Tell the client why it was disconnected before closing the socket.
    this.sendToPlayer(playerId, {
      type: 'kicked',
      reason,
      banned: ban,
    });
    this.closeConnection(playerId);
    this.removePlayer(playerId);
    return true;
  }

  banIp(ip: string, reason = 'banned by admin'): void {
    this.bans.add('ip', normalizeIp(ip), reason);
    log.warn(`BAN added ip=${normalizeIp(ip)} reason="${reason}"`);
    // Also kick anyone currently connected with that IP.
    for (const [id, p] of [...this.players]) {
      if (!(p instanceof ServerBot) && p.ip === normalizeIp(ip)) {
        this.kickPlayer(id, reason, false);
      }
    }
  }

  unbanIp(ip: string): boolean {
    const removed = this.bans.remove('ip', normalizeIp(ip));
    if (removed) log.info(`UNBAN ip=${normalizeIp(ip)}`);
    return removed;
  }

  isIpBanned(ip: string | undefined): boolean {
    return this.bans.isIpBanned(normalizeIp(ip)) !== null;
  }

  /** Head-count of the live roster for ops: bots included, per team and total.
   *
   *  `connectedPlayers` in /api/status is `wss.clients.size`, so a healthy
   *  bot-filled match reports 0 there. This is the number a human sees on the
   *  scoreboard: both sides of the map, humans and bots together. */
  getRosterCounts(): { red: number; blue: number; total: number; humans: number; bots: number } {
    let red = 0;
    let blue = 0;
    let humans = 0;
    let bots = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') red++;
      else blue++;
      if (p instanceof ServerBot) bots++;
      else humans++;
    }
    return { red, blue, total: red + blue, humans, bots };
  }

  /** Snapshot of connected (non-bot) players for logs / status endpoint / CLI. */
  listPlayers(): Array<{ id: string; name: string; team: string; ip: string; hp: number; isDead: boolean; isSpectating: boolean }> {
    const out: Array<{ id: string; name: string; team: string; ip: string; hp: number; isDead: boolean; isSpectating: boolean }> = [];
    for (const [id, p] of this.players) {
      if (p instanceof ServerBot) continue;
      out.push({
        id,
        name: p.name ?? 'unnamed',
        team: p.team,
        ip: p.ip ?? 'unknown',
        hp: Math.round(p.hp),
        isDead: p.isDead,
        isSpectating: p.isSpectating,
      });
    }
    return out;
  }

  private closeConnection(playerId: string): void {
    const conn = this.connections.get(playerId);
    if (!conn) return;
    try {
      // WebSocket has .close(); SSE connections created by server.ts also
      // expose an optional close() that ends the HTTP response. Prefer the
      // explicit close hook so kicked SSE clients stop receiving events and
      // the browser's EventSource actually terminates (previously we only
      // sent a sentinel message and left the stream open forever).
      if (typeof conn.close === 'function') {
        conn.close(4000, 'kicked');
      } else if ('close' in conn && typeof (conn as WebSocket).close === 'function') {
        (conn as WebSocket).close(4000, 'kicked');
      } else if (typeof conn.send === 'function') {
        // Legacy SSE connection without a close hook — send sentinel then
        // end via isOpen contract.
        conn.send(JSON.stringify({ type: 'kicked', reason: 'kicked', banned: false }));
      }
    } catch {
      /* ignore */
    }
  }

  handleMessage(playerId: string, message: ClientMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (message.type) {
      case 'join':
        if (this.joinedPlayers.has(playerId)) break;
        this.joinedPlayers.add(playerId);
        // Team selection and the display name come from the client, so both are
        // validated here: an unknown team breaks every comparison downstream,
        // and an unbounded name ends up in logs and on every scoreboard.
        {
          const team = isTeam(message.team) ? message.team : player.team;
          player.team = team;
          // Keep teams balanced: retire one bot from this team so the human
          // takes their slot (e.g. stays 10v10 with bots filling the roster).
          this.makeRoomForHuman(team);
          if (typeof message.name === 'string' && message.name.trim()) {
            const name = message.name.trim().slice(0, 24);
            player.name = name;
            // Name-based ban check: kick + extend to an IP ban for this session.
            const nameBan = this.bans.list().find(
              (b) => b.kind === 'name' && b.value.toLowerCase() === name.toLowerCase(),
            );
            if (nameBan) {
              log.warn(`Rejected join by banned name "${name}" from ${player.ip ?? '?'}`);
              this.kickPlayer(playerId, `Banned account: ${nameBan.reason}`, false);
              return;
            }
          }
          // Never accept a client-selected spawn: it could bypass workshop reach
          // and other server-side proximity checks.
          player.position = this.getSpawnPosition(team);
        }
        // Rejoining connections must never start life dead/eliminated: clear any
        // stale death/spectate state and pending respawn timers from a previous
        // session before the join is acknowledged ("spawn already dead" bug).
        this.respawnTimers.delete(playerId);
        if (!player.isSpectating) {
          player.respawn(player.position);
          this.grantSpawnProtection(playerId);
        } else {
          player.hp = player.maxHp;
          player.isDead = false;
        }
        this.sendToPlayer(playerId, { type: 'joined', state: player.getState() });
        this.broadcast({
          type: 'playerUpdated',
          playerId,
          state: player.getState(),
        });
        this.broadcastExcept(playerId, {
          type: 'playerJoined',
          playerId,
          state: player.getState(),
        });
        break;

      case 'playerInput': {
        // A gunner may look around but not walk: the nest owns their position.
        const manned = this.gunnerEmplacement(playerId);
        if (manned) {
          if (Number.isFinite(message.input?.yaw) && Number.isFinite(message.input?.pitch)) {
            player.rotation.yaw = message.input.yaw;
            player.rotation.pitch = message.input.pitch;
            this.aimEmplacement(playerId, message.input.yaw, message.input.pitch);
          }
          break;
        }
        // Reject movement from dead players (prevents ghost position updates
        // while the respawn timer runs) and spectators (no world presence)
        if (message.input && typeof message.input === 'object'
          && !player.isDead && !player.isSpectating && !this.driverJeep(playerId)) {
          const pos = message.input.position;
          if (isVec3(pos) && [...this.jeeps.values()].some(jeep => {
            const spec = vehicleSpec(jeep.kind);
            return Math.abs(pos.y - jeep.position.y) < spec.height &&
              Math.hypot(pos.x - jeep.position.x, pos.z - jeep.position.z) < Math.hypot(spec.halfWidth, spec.halfLength) + 0.45;
          })) {
            const { position: _blocked, ...input } = message.input;
            player.applyInput(input);
          } else player.applyInput(message.input);
        }
        break;
      }

      case 'buildJeep':
        this.buildJeep(playerId);
        break;
      case 'placeEmplacement':
        this.placeEmplacement(playerId, message.kind, message.position, message.yaw, message.slot);
        break;
      case 'previewEmplacement':
        this.previewEmplacement(playerId, message.kind, message.position, message.yaw, message.slot);
        break;
      case 'craftBlueprint':
        this.craftBlueprint(playerId, message.kind, message.slot);
        break;
      case 'mountEmplacement':
        this.mountEmplacement(playerId, message.emplacementId);
        break;
      case 'dismountEmplacement':
        this.dismountEmplacement(playerId);
        break;
      case 'fireEmplacement':
        this.fireEmplacement(playerId);
        break;
      case 'enterJeep':
        this.enterJeep(playerId, message.vehicleId);
        break;
      case 'exitJeep':
        this.exitJeep(playerId);
        break;
      case 'driveJeep': {
        const jeep = this.driverJeep(playerId);
        if (!jeep || player.isDead || player.isSpectating || typeof message.throttle !== 'number' || !Number.isFinite(message.throttle) || typeof message.steering !== 'number' || !Number.isFinite(message.steering) || typeof message.brake !== 'boolean') break;
        jeep.throttle = Math.max(-1, Math.min(1, message.throttle));
        jeep.steering = Math.max(-1, Math.min(1, message.steering));
        jeep.brake = message.brake;
        jeep.lastInput = this.world.serverTime;
        break;
      }
      case 'shoot':
        if (!isVec3(message.origin) || !isVec3(message.direction)) break;
        this.handleShoot(playerId, message.origin, message.direction, message.targetId, message.isHeadshot);
        break;

      case 'useTool':
        if (!isVec3(message.target)) break;
        this.handleUseTool(playerId, message.tool, message.target);
        break;

      case 'build':
        if (!isVec3(message.position)) break;
        this.handleBuild(playerId, message.position);
        break;

      case 'depositWorkshop':
        this.depositWorkshop(playerId, message.team);
        break;

      case 'useSupplyCrate':
        this.useSupplyCrate(playerId, message.emplacementId, message.action);
        break;

      case 'reload':
        if (!this.driverJeep(playerId) && player.startReload()) {
          this.broadcast({
            type: 'playerUpdated',
            playerId,
            state: player.getState(),
          });
        }
        break;

      case 'pickupFlag':
        this.handleFlagPickup(playerId);
        break;

      case 'captureFlag':
        this.handleFlagCapture(playerId);
        break;

      case 'toggleSpectator':
        // A spectator is frozen out of play, so a flag they were carrying would
        // be stranded on a non-moving player forever — drop it first.
        if (!player.isSpectating) { this.dropCarriedFlag(playerId); this.exitJeep(playerId, true); }
        player.isSpectating = !player.isSpectating;
        this.broadcast({
          type: 'spectatorToggled',
          playerId,
          isSpectating: player.isSpectating,
        });
        log.info(`player ${playerId} ${player.isSpectating ? 'entered' : 'exited'} spectator mode`);
        break;

      case 'footstep': {
        // Cosmetic but still client-controlled: clamp so a crafted frame cannot
        // broadcast NaN or an ear-splitting volume to everyone else.
        const volume = Number(message.volume);
        const pitch = Number(message.pitch);
        if (!Number.isFinite(volume) || !Number.isFinite(pitch)) break;
        this.broadcastExcept(playerId, {
          type: 'footstep',
          playerId,
          volume: Math.min(1, Math.max(0, volume)),
          pitch: Math.min(2, Math.max(0.5, pitch)),
        });
        break;
      }

      case 'requestRespawn':
        // Server-authoritative safe spawn. The client fires this right after
        // joining so the player materializes at a terrain-checked team spawn
        // instead of a stale (or hostile) client-reported position that could
        // place them inside enemy lines/terrain where hazards kill them on
        // the very first tick ("instant elimination on join" bug).
        {
          if (!player.isDead) {
            if (this.driverJeep(playerId)) break;
            // Already alive: the server owns this player's position. Re-assert
            // it so a client that wrongly believes it died (e.g. a local
            // void-fall) recovers, but never teleport a live player back to
            // spawn — that was a free full-heal + escape (and let a flag
            // carrier teleport home with the enemy flag).
            this.broadcast({
              type: 'playerRespawned',
              playerId,
              position: { ...player.position },
            });
            this.broadcast({
              type: 'playerUpdated',
              playerId,
              state: player.getState(),
            });
            log.info(`player ${playerId} requested respawn while alive — re-asserted position`);
            break;
          }

          // Dead: drop anything they were carrying at the death spot first.
          this.dropCarriedFlag(playerId);

          const spawnPos = this.getSpawnPosition(player.team);
          player.respawn(spawnPos);
          this.grantSpawnProtection(playerId);
          // Clear any pending respawn timer so the scheduled respawn doesn't
          // fire redundantly on top of this one.
          this.respawnTimers.delete(playerId);
          this.inventories.set(playerId, 20);
          this.resetResources(playerId);
          this.broadcast({
            type: 'playerRespawned',
            playerId,
            position: spawnPos,
          });
          this.sendToPlayer(playerId, {
            type: 'inventoryUpdated',
            inventory: 20,
          });
          this.broadcast({
            type: 'playerUpdated',
            playerId,
            state: player.getState(),
          });
          log.info(`player ${playerId} requested respawn at safe spawn`);
        }
        break;

      case 'ping':
        // Echo the client's timestamp back for a latency readout (no state).
        this.sendToPlayer(playerId, { type: 'pong', t: message.t });
        break;

      case 'disconnect':
        this.removePlayer(playerId);
        break;
    }
  }

  private handleShoot(playerId: string, origin: Position, direction: Position, clientTargetId?: string, clientIsHeadshot?: boolean): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.driverJeep(playerId)) return;

    // The muzzle position and direction are client-supplied. Require the shot
    // to start at the shooter's own eye position (tolerance covers one tick of
    // movement plus lag) so a crafted frame cannot raycast from inside a wall or
    // from the far side of the map.
    const eyeOffset = 1.6;
    const originDx = origin.x - player.position.x;
    const originDz = origin.z - player.position.z;
    const originDy = origin.y - (player.position.y + eyeOffset);
    if (Math.hypot(originDx, originDz) > 4.0 || Math.abs(originDy) > 2.5) return;
    const dirLength = Math.hypot(direction.x, direction.y, direction.z);
    if (!(dirLength > 0.9 && dirLength < 1.1)) return;

    const now = Date.now() / 1000;
    const weapon = WEAPONS[player.equipment as 'rifle' | 'smg'];
    if (!weapon) return;

    // Check magazine state
    if (player.isReloading) return;

    // Rate limit BEFORE consuming ammo: a shot rejected here must not cost a
    // round (spamming the trigger under lag used to silently drain magazines).
    const lastTime = this.lastShootTime.get(playerId) || 0;
    // Tolerance is for network jitter only. It used to be 25%, which let a
    // modified client fire a full 33% faster than the weapon's real fire rate.
    if (now - lastTime < weapon.fireRate * 0.9) return;
    if (!player.useAmmo()) return; // false when the magazine is empty

    this.lastShootTime.set(playerId, now);
    // Shooting gives up your spawn shield (never an attack shield).
    this.clearSpawnProtection(playerId);
    
    // Set shooting state for sound effects. The game loop clears this flag
    // after ~100ms (see update()), so no per-shot timer is needed here.
    player.isShooting = true;
    
    // Broadcast updated magazine state
    this.broadcast({
      type: 'playerUpdated',
      playerId,
      state: player.getState(),
    });

    // Broadcast shot event to all other players for tracers, flash and sound
    this.broadcastExcept(playerId, {
      type: 'playerShot',
      playerId,
      origin,
      direction,
      weapon: player.equipment,
    });

    // Raycast to find terrain hit distance (extended battlefield bullet range)
    const hit = this.world.raycast(origin, direction, 350);
    const maxDist = hit ? hit.distance : 350;
    const vehicleHit = this.hitJeep(origin, direction, maxDist, player.team);
    const structureHit = this.hitEmplacement(origin, direction, maxDist, player.team);

    // Suppression awareness: enemies within ~2m of the bullet's path were
    // nearly hit — bot victims react by seeking/digging cover ("pinned down").
    if (player.team !== undefined) {
      const rayLen = maxDist;
      for (const [tid, tgt] of this.players) {
        if (tid === playerId || tgt.isDead || tgt.team === player.team) continue;
        if (!(tgt instanceof ServerBot)) continue;
        const tx = tgt.position.x - origin.x;
        const ty = tgt.position.y + 1.0 - origin.y;
        const tz = tgt.position.z - origin.z;
        const dot = tx * direction.x + ty * direction.y + tz * direction.z;
        if (dot <= 0 || dot > rayLen) continue;
        const px = origin.x + direction.x * dot - tgt.position.x;
        const py = origin.y + direction.y * dot - (tgt.position.y + 1.0);
        const pz = origin.z + direction.z * dot - tgt.position.z;
        if (Math.hypot(px, py, pz) < 2.0) {
          tgt.noteIncoming(this.world.serverTime);
        }
      }
    }

    let confirmedTarget: { id: string; player: ServerPlayer; isHeadshot: boolean; distance: number } | null = null;

    // 1. First priority: validate client-reported hit candidate if enemy was hit on shooter's screen
    if (clientTargetId && this.players.has(clientTargetId)) {
      const target = this.players.get(clientTargetId)!;
      if (!target.isDead && target.team !== player.team) {
        const dx = target.position.x - origin.x;
        // Aim at torso height (+1.0), matching the client's hit model, so the
        // server LoS ray uses the same endpoint the client actually shot at.
        const dy = target.position.y + 1.0 - origin.y;
        const dz = target.position.z - origin.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 1e-6 && dist <= 350) {
          // Line of sight check — normalize by the TRUE distance to the
          // torso point (previously divided by foot-level distance while
          // adding +1.0 to y, producing a skewed unit vector that could
          // fail LoS against terrain for legitimately-hit targets).
          const toTargetDir = { x: dx / dist, y: dy / dist, z: dz / dist };
          const terrainHit = this.world.raycast(origin, toTargetDir, dist);
          if (!terrainHit || terrainHit.distance >= dist - 1.2) {
            confirmedTarget = {
              id: clientTargetId,
              player: target,
              isHeadshot: !!clientIsHeadshot,
              distance: dist,
            };
          }
        }
      }
    }

    // 2. Second priority / fallback: 3D raycast against all enemy players
    if (!confirmedTarget) {
      let closestDist = maxDist;

      for (const [targetId, target] of this.players) {
        if (targetId === playerId || target.isDead) continue;
        if (target.team === player.team) continue; // No friendly fire

        const toTarget = {
          x: target.position.x - origin.x,
          y: target.position.y - origin.y,
          z: target.position.z - origin.z,
        };

        const dot = toTarget.x * direction.x + toTarget.y * direction.y + toTarget.z * direction.z;
        if (dot > 0 && dot < closestDist) {
          const pointOnRay = {
            x: origin.x + direction.x * dot,
            y: origin.y + direction.y * dot,
            z: origin.z + direction.z * dot,
          };
          const horizDist = Math.hypot(pointOnRay.x - target.position.x, pointOnRay.z - target.position.z);
          const vertDist = pointOnRay.y - target.position.y;

          if (horizDist < 0.85 && vertDist >= -0.3 && vertDist <= 2.3) {
            const isHeadshot = vertDist >= 1.45;
            confirmedTarget = {
              id: targetId,
              player: target,
              isHeadshot,
              distance: Math.hypot(toTarget.x, toTarget.y, toTarget.z),
            };
            closestDist = dot;
          }
        }
      }
    }

    if (vehicleHit && (!confirmedTarget || vehicleHit.distance < confirmedTarget.distance)) {
      this.damageJeep(vehicleHit.jeep, weaponDamage(weapon, false, vehicleHit.distance));
      return;
    }

    if (structureHit && (!confirmedTarget || structureHit.distance < confirmedTarget.distance)) {
      this.damageEmplacement(structureHit.emplacement.id, weaponDamage(weapon, false, structureHit.distance));
      return;
    }

    if (confirmedTarget) {
      const damage = weaponDamage(weapon, confirmedTarget.isHeadshot, confirmedTarget.distance);
      const target = confirmedTarget.player;
      const targetId = confirmedTarget.id;

      // Spawn shield: the round lands on nothing. Returning here also skips the
      // hit marker and every death/score path, so the shield cannot leak kills.
      if (this.isSpawnProtected(targetId)) return;

      target.takeDamage(damage);
      this.noteDamaged(targetId);

      // Threat memory: bot victims hunt back toward whoever shot them
      if (target instanceof ServerBot) {
        target.noteHitBy(playerId, this.world.serverTime);
      }

      // Notify attacker of confirmed hit
      this.sendToPlayer(playerId, {
        type: 'hitConfirmed',
        targetId,
        damage,
        isHeadshot: confirmedTarget.isHeadshot,
      });

      // Notify victim and everyone of damage
      this.broadcast({
        type: 'playerDamaged',
        playerId: targetId,
        damage,
        attackerId: playerId,
      });

      // Broadcast updated target state (HP sync)
      this.broadcast({
        type: 'playerUpdated',
        playerId: targetId,
        state: target.getState(),
      });

      if (target.isDead) {
        // Handle flag drop
        this.handlePlayerDeath(targetId);

        if (player.team === 'red') {
          this.addTeamScore('red');
        } else {
          this.addTeamScore('blue');
        }
        this.getStats(playerId).kills++;
        this.broadcastStats();
        this.broadcast({
          type: 'playerDied',
          playerId: targetId,
          killerId: playerId,
          weapon: player.equipment,
          isHeadshot: confirmedTarget.isHeadshot,
        });

        // Respawn after 4s via the game loop tick (no setTimeout: survives
        // connection churn and dead players can't ghost-update meanwhile)
        this.respawnTimers.set(targetId, 4.0);
      }

      return;
    }

    // Hit voxel (if bullet hit block and didn't hit player first)
    if (hit && hit.voxelPos) {
      const { x, y, z } = hit.voxelPos;
      const destroyed = this.world.damageVoxel(x, y, z, 1);
      
      if (destroyed) {
        const voxel = this.world.getVoxel(x, y, z);
        this.broadcast({
          type: 'voxelChanged',
          change: {
            x,
            y,
            z,
            type: voxel ? voxel.type : VOXEL_AIR,
            durability: voxel ? voxel.durability : 0,
          },
        });
        
        // Check for collapse
        const collapsed = this.world.collapseDisconnected(x, y, z);
        for (const change of collapsed) {
          this.broadcast({
            type: 'voxelChanged',
            change,
          });
        }
      } else {
        const voxel = this.world.getVoxel(x, y, z);
        if (voxel) {
          this.broadcast({
            type: 'voxelChanged',
            change: {
              x,
              y,
              z,
              type: voxel.type,
              durability: voxel.durability,
            },
          });
        }
      }
    }
  }

  private handleUseTool(playerId: string, tool: 'pickaxe' | 'spade', target: Position): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.driverJeep(playerId)) return;

    if ((tool !== 'pickaxe' && tool !== 'spade') || player.equipment !== tool) return;
    const { x, y, z } = target;
    if (![x, y, z].every(Number.isInteger) || isWorkshopProtectedCell(x, z)) return;
    const eye = { x: player.position.x, y: player.position.y + 1.45, z: player.position.z };
    const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > 6 || distance < 0.01) return;
    const hit = this.world.raycast(eye, { x: dx / distance, y: dy / distance, z: dz / distance }, distance + 0.9);
    if (!hit || hit.voxelPos.x !== x || hit.voxelPos.y !== y || hit.voxelPos.z !== z) return;
    const original = this.world.getVoxel(x, y, z);
    if (!original) return;

    const now = Date.now() / 1000;
    const toolData = TOOLS[tool];
    
    const lastTime = this.lastToolTime.get(playerId) || 0;
    if (now - lastTime < toolData.cooldown * 0.75) return;
    
    this.lastToolTime.set(playerId, now);

    const destroyed = this.world.damageVoxel(x, y, z, toolData.damage);
    
    if (destroyed) {
      if (toolData.harvests) {
        if (original.type === VOXEL_BUILT) {
          const inventory = (this.inventories.get(playerId) ?? 0) + 1;
          this.inventories.set(playerId, inventory);
          this.sendToPlayer(playerId, { type: 'inventoryUpdated', inventory });
        } else {
          const depositable = (this.depositableBlocks.get(playerId) ?? 0) + 1;
          this.depositableBlocks.set(playerId, depositable);
          this.sendToPlayer(playerId, { type: 'resourcesUpdated', depositable });
        }
      }
      
      const voxel = this.world.getVoxel(x, y, z);
      this.broadcast({
        type: 'voxelChanged',
        change: {
          x,
          y,
          z,
          type: voxel ? voxel.type : VOXEL_AIR,
          durability: voxel ? voxel.durability : 0,
        },
      });
      
      // Check for collapse
      const collapsed = this.world.collapseDisconnected(x, y, z);
      for (const change of collapsed) {
        this.broadcast({
          type: 'voxelChanged',
          change,
        });
      }
    } else {
      const voxel = this.world.getVoxel(x, y, z);
      if (voxel) {
        this.broadcast({
          type: 'voxelChanged',
          change: {
            x,
            y,
            z,
            type: voxel.type,
            durability: voxel.durability,
          },
        });
      }
    }
  }

  private canBuildAt(x: number, y: number, z: number): boolean {
    if (!this.world.canBuild(x, y, z)) return false;
    if ([...this.jeeps.values()].some(jeep => {
      const spec = vehicleSpec(jeep.kind);
      return Math.abs(y - jeep.position.y) < spec.height + 0.5 &&
        Math.hypot(x - jeep.position.x, z - jeep.position.z) < Math.hypot(spec.halfWidth, spec.halfLength) + 0.71;
    })) return false;
    
    // Check if block intersects any connected player
    for (const player of this.players.values()) {
      if (player.isDead) continue;
      const pr = 0.45;
      const ph = 1.9;
      if (
        player.position.x + pr > x && player.position.x - pr < x + 1 &&
        player.position.y + ph > y && player.position.y < y + 1 &&
        player.position.z + pr > z && player.position.z - pr < z + 1
      ) {
        return false;
      }
    }
    return true;
  }

  private handleBuild(playerId: string, position: Position): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.driverJeep(playerId)) return;

    const inventory = this.inventories.get(playerId) ?? 0;
    const depositable = this.depositableBlocks.get(playerId) ?? 0;
    if (inventory + depositable <= 0) return;

    const { x, y, z } = position;

    // Reach check: the placement coordinate is client-supplied, so without this
    // a modified client could build anywhere on the map (e.g. sealing a flag
    // stand or a spawn from a distance).
    const reach = Math.hypot(
      x + 0.5 - player.position.x,
      y + 0.5 - (player.position.y + 1.0),
      z + 0.5 - player.position.z,
    );
    if (reach > this.BUILD_REACH) return;

    if (this.canBuildAt(x, y, z)) {
      this.world.setVoxel(x, y, z, 4, 3); // VOXEL_BUILT
      if (inventory > 0) {
        this.inventories.set(playerId, inventory - 1);
        this.sendToPlayer(playerId, { type: 'inventoryUpdated', inventory: inventory - 1 });
      } else {
        this.depositableBlocks.set(playerId, depositable - 1);
        this.sendToPlayer(playerId, { type: 'resourcesUpdated', depositable: depositable - 1 });
      }
      
      this.broadcast({
        type: 'voxelChanged',
        change: {
          x,
          y,
          z,
          type: 4,
          durability: 3,
        },
      });
    }
  }

  private handleFlagPickup(playerId: string): void {
    if (this.roundPhase !== 'live') return; // no objective play between rounds
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.driverJeep(playerId)) return;

    // Check if player is already carrying a flag
    if (this.blueFlagCarrier === playerId || this.redFlagCarrier === playerId) {
      return;
    }

    // Check if player is near enemy flag at base
    const enemyFlagPos = player.team === 'blue' ? this.RED_FLAG_POS : this.BLUE_FLAG_POS;
    const dx = player.position.x - enemyFlagPos.x;
    const dz = player.position.z - enemyFlagPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance < this.CAPTURE_DISTANCE) {
      // Check if flag is at base
      if (player.team === 'blue' && this.redFlagAtBase) {
        this.redFlagAtBase = false;
        this.redFlagCarrier = playerId;
        player.carryingFlag = true;
        this.flagTouches.blue++;
        log.info(`RED flag picked up by ${playerId}`);
        
        this.broadcast({
          type: 'flagPickedUp',
          playerId: playerId,
          flagTeam: 'red',
        });
      } else if (player.team === 'red' && this.blueFlagAtBase) {
        this.blueFlagAtBase = false;
        this.blueFlagCarrier = playerId;
        player.carryingFlag = true;
        this.flagTouches.red++;
        log.info(`BLUE flag picked up by ${playerId}`);
        
        this.broadcast({
          type: 'flagPickedUp',
          playerId: playerId,
          flagTeam: 'blue',
        });
      }
    }

    // A base pickup ends this call. Without the early return the dropped-flag
    // loop below could consume a second flag entry in the same tick (silently
    // deleting it from every client's view) and overwrite the carrier id.
    if (player.carryingFlag) return;

    // Check if player is near dropped flags
    const enemyFlagTeam = player.team === 'blue' ? 'red' : 'blue';
    for (let i = this.droppedFlags.length - 1; i >= 0; i--) {
      const droppedFlag = this.droppedFlags[i];
      const dx = player.position.x - droppedFlag.position.x;
      const dz = player.position.z - droppedFlag.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance < this.CAPTURE_DISTANCE) {
        if (droppedFlag.team === enemyFlagTeam) {
          // Pick up dropped enemy flag. A recovered enemy flag is still a steal:
          // it counts toward the touch tiebreak even though it was not at base.
          this.droppedFlags.splice(i, 1);
          this.flagTouches[player.team]++;
          
          if (enemyFlagTeam === 'red') {
            this.redFlagCarrier = playerId;
          } else {
            this.blueFlagCarrier = playerId;
          }
          player.carryingFlag = true;
          
          this.broadcast({
            type: 'flagPickedUp',
            playerId: playerId,
            flagTeam: enemyFlagTeam,
          });
        } else if (droppedFlag.team === player.team) {
          // Return friendly dropped flag to base: a defensive recovery that
          // breaks a touch tie when neither side converted a steal.
          this.droppedFlags.splice(i, 1);
          this.flagReturns[player.team]++;
          if (player.team === 'blue') {
            this.blueFlagAtBase = true;
          } else {
            this.redFlagAtBase = true;
          }
          this.broadcast({
            type: 'flagReturned',
            flagTeam: player.team,
          });
        }
      }
    }
  }

  private handleFlagCapture(playerId: string): void {
    if (this.roundPhase !== 'live') return; // clock already stopped this round
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating || this.driverJeep(playerId)) return;

    // Validation: only a LIVE player who is actually carrying the enemy flag
    // AND standing at their home base may score. This blocks malicious or
    // buggy clients from sending fake 'captureFlag' messages for instant wins.
    const carryingEnemyFlag = player.team === 'blue'
      ? this.redFlagCarrier === playerId
      : this.blueFlagCarrier === playerId;
    if (!carryingEnemyFlag) return;

    const homeBase = player.team === 'blue' ? this.BLUE_FLAG_POS : this.RED_FLAG_POS;
    const distance = Math.hypot(player.position.x - homeBase.x, player.position.z - homeBase.z);
    if (distance > this.CAPTURE_SCORE_RADIUS) return; // matches the client radius

    this.awardCapture(playerId, player);
  }

  /**
   * The single place a capture is scored.
   *
   * Both entry points — the automatic proximity check in `checkFlagCaptures`
   * and the client's optimistic `captureFlag` message — go through here, so the
   * score, flag state, respawn timer and the per-player `captures` tally can
   * never diverge again (the automatic path used to skip the tally entirely,
   * which is why bot captures never appeared on the scoreboard).
   */
  private awardCapture(playerId: string, player: ServerPlayer): void {
    if (player.team === 'blue') {
      this.captures.blue++;
      this.redFlagAtBase = false; // captured flag disappears while respawning
      this.redFlagCarrier = null;
      this.redFlagRespawnTimer = 8.0;
    } else {
      this.captures.red++;
      this.blueFlagAtBase = false;
      this.blueFlagCarrier = null;
      this.blueFlagRespawnTimer = 8.0;
    }
    player.carryingFlag = false;
    this.getStats(playerId).captures++;
    this.broadcastStats();
    log.info(`FLAG CAPTURED by ${playerId} (${player.team}) — score blue:${this.captures.blue} red:${this.captures.red}`);

    this.broadcast({
      type: 'flagCaptured',
      team: player.team,
      // The captured flag is the ENEMY flag (blue scores by carrying red home)
      flagTeam: player.team === 'blue' ? 'red' : 'blue',
      playerId,
      captures: this.captures,
    });
  }

  /**
   * Drop any flag this player is carrying onto the ground at their feet.
   *
   * Every path that takes a carrier out of play (death, disconnect, entering
   * spectator, teleport-respawn) MUST call this while the player still exists
   * in `players`. Otherwise the carrier id keeps pointing at a player who is
   * gone or frozen, no dropped-flag entry is created, and the flag can never be
   * picked up, returned or captured again — the CTF round deadlocks.
   */
  private dropCarriedFlag(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.carryingFlag) return;

    player.carryingFlag = false;

    // Snap the dropped flag to solid ground so clients (and late joiners
    // reading the init snapshot) never render it floating in mid-air.
    const dropY = this.world.getGroundHeight(player.position.x, player.position.z);
    const position = { x: player.position.x, y: dropY + 0.5, z: player.position.z };

    if (this.blueFlagCarrier === playerId) {
      this.blueFlagCarrier = null;
      this.droppedFlags.push({ position, team: 'blue', respawnTimer: 60 });
      this.broadcast({ type: 'flagDropped', position, flagTeam: 'blue', playerId });
    } else if (this.redFlagCarrier === playerId) {
      this.redFlagCarrier = null;
      this.droppedFlags.push({ position, team: 'red', respawnTimer: 60 });
      this.broadcast({ type: 'flagDropped', position, flagTeam: 'red', playerId });
    }
  }

  private handlePlayerDeath(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Scoreboard bookkeeping: count the death (handlePlayerDeath is the single
    // choke point every kill path funnels through, so deaths can't be missed).
    this.getStats(playerId).deaths++;
    this.broadcastStats();

    this.clearSpawnProtection(playerId);
    this.dropCarriedFlag(playerId);
    this.exitJeep(playerId, true);
    this.dismountEmplacement(playerId, true);
  }

  update(dt: number): void {
    // Advance authoritative server clock (used for footstep throttling etc.)
    this.world.updateTime(dt);

    // Round clock + phase transitions (live -> intermission -> next round)
    this.updateRound(dt);
    this.updateJeeps(dt);
    this.updateShells(dt);
    // A manned nest turns with its gunner; 10Hz is enough to read as smooth and
    // keeps aim updates off the per-message broadcast path.
    if (this.emplacements.size > 0) {
      this.emplacementSync += dt;
      if (this.emplacementSync >= 0.1) {
        this.emplacementSync = 0;
        if ([...this.emplacements.values()].some(e => e.gunnerId)) this.broadcastEmplacements();
      }
    }
    // Spotting posts are HUD hints: four reports a second are enough to track
    // a running enemy, and cheap enough to send only to the owning team.
    this.spotSync += dt;
    if (this.spotSync >= 0.25) {
      this.spotSync = 0;
      this.broadcastSpotReports();
    }

    // Clear stale shooting flags once the 100ms window has elapsed.
    // Done in the game loop instead of per-shot setTimeout so state stays
    // consistent even if a socket closes mid-timeout. (lastShootTime is in seconds)
    const nowSec = Date.now() / 1000;
    for (const player of this.players.values()) {
      if (player instanceof ServerBot) continue; // bots manage their own shoot flag via botUpdate
      if (player.isShooting && nowSec - (this.lastShootTime.get(player.id) || 0) > 0.1) {
        player.isShooting = false;
      }
    }

    // Process scheduled respawns for dead networked players
    if (this.respawnTimers.size > 0) {
      for (const [playerId, timer] of this.respawnTimers) {
        const remaining = timer - dt;
        if (remaining <= 0) {
          this.respawnTimers.delete(playerId);
          const player = this.players.get(playerId);
          if (player && player.isDead) {
            const spawnPos = this.getSpawnPosition(player.team);
            player.respawn(spawnPos);
            this.grantSpawnProtection(playerId);
            // Restore build inventory on respawn (matches join-time value)
            this.inventories.set(playerId, 20);
            this.resetResources(playerId);
            if (player instanceof ServerBot) {
              player.refillBlocks();
            }
            this.broadcast({
              type: 'playerRespawned',
              playerId,
              position: spawnPos,
            });
            this.sendToPlayer(playerId, {
              type: 'inventoryUpdated',
              inventory: 20,
            });
          }
        } else {
          this.respawnTimers.set(playerId, remaining);
        }
      }
    }

    // Update all players (humans use client-authoritative input; bots run AI)
    const botCtx = this.getBotContext();
    for (const player of this.players.values()) {
      if (player instanceof ServerBot) continue; // handled below via botUpdate
      player.update(dt, this.world);
      if (this.driverJeep(player.id)) continue;
      
      // Check and broadcast footstep sounds
      const footstepData = player.getFootstepData(this.world);
      if (footstepData) {
        this.broadcastExcept(player.id, {
          type: 'footstep',
          playerId: player.id,
          volume: footstepData.volume,
          pitch: footstepData.pitch,
        });
      }
    }

    // Run bot AI (movement, aiming, flanking, camping, building)
    this.updateBots(botCtx);
    
    // Update dropped flag timers
    this.updateDroppedFlags(dt);

    // Update captured flags respawn timers (flags disappear during this period)
    if (this.blueFlagRespawnTimer > 0) {
      this.blueFlagRespawnTimer -= dt;
      if (this.blueFlagRespawnTimer <= 0) {
        this.blueFlagRespawnTimer = 0;
        this.blueFlagAtBase = true;
        this.broadcast({
          type: 'flagReturned',
          flagTeam: 'blue',
        });
      }
    }
    if (this.redFlagRespawnTimer > 0) {
      this.redFlagRespawnTimer -= dt;
      if (this.redFlagRespawnTimer <= 0) {
        this.redFlagRespawnTimer = 0;
        this.redFlagAtBase = true;
        this.broadcast({
          type: 'flagReturned',
          flagTeam: 'red',
        });
      }
    }
    
    // Check for flag captures — only while a round is live, so the intermission
    // is a genuine pause in scoring even though the world keeps simulating.
    if (this.roundPhase === 'live') {
      this.checkFlagCaptures();
    }

    // Spawn shields + out-of-combat regeneration
    this.updateHealth(dt);
  }
  
  private updateDroppedFlags(dt: number): void {
    for (let i = this.droppedFlags.length - 1; i >= 0; i--) {
      const droppedFlag = this.droppedFlags[i];
      droppedFlag.respawnTimer -= dt;
      
      if (droppedFlag.respawnTimer <= 0) {
        // Return flag to base
        this.droppedFlags.splice(i, 1);
        
        if (droppedFlag.team === 'blue') {
          this.blueFlagAtBase = true;
        } else {
          this.redFlagAtBase = true;
        }
        
        this.broadcast({
          type: 'flagReturned',
          flagTeam: droppedFlag.team,
        });
      }
    }
  }
  
  private checkFlagCaptures(): void {
    for (const [playerId, player] of this.players) {
      if (player.isDead || player.isSpectating || this.driverJeep(playerId)) continue;

      if (!player.carryingFlag) {
        // Auto-check flag pickup
        this.handleFlagPickup(playerId);
      } else {
        // Carrying flag: check if reached home base to score
        const homeBase = player.team === 'blue' ? this.BLUE_FLAG_POS : this.RED_FLAG_POS;
        const dx = player.position.x - homeBase.x;
        const dz = player.position.z - homeBase.z;
        const distance = Math.hypot(dx, dz);

        if (distance < this.CAPTURE_SCORE_RADIUS) {
          this.awardCapture(playerId, player);
        }
      }

      // Check if player walks over friendly dropped flag to return it
      const friendlyTeam = player.team;
      for (let i = this.droppedFlags.length - 1; i >= 0; i--) {
        const droppedFlag = this.droppedFlags[i];
        if (droppedFlag.team === friendlyTeam) {
          const dx = player.position.x - droppedFlag.position.x;
          const dz = player.position.z - droppedFlag.position.z;
          if (Math.hypot(dx, dz) < 3.5) {
            this.droppedFlags.splice(i, 1);
            if (friendlyTeam === 'blue') this.blueFlagAtBase = true;
            else this.redFlagAtBase = true;

            this.broadcast({
              type: 'flagReturned',
              flagTeam: friendlyTeam,
            });
          }
        }
      }
    }
  }

  broadcastState(): void {
    // Send individual player updates instead of full state
    for (const [playerId, player] of this.players) {
      this.broadcastExcept(playerId, {
        type: 'playerUpdated',
        playerId,
        state: player.getState(),
      });
    }
  }

  private getSpawnPosition(team: 'red' | 'blue'): Position {
    const zMin = team === 'blue' ? BLUE_SPAWN_Z_MIN : RED_SPAWN_Z_MIN;
    const zMax = team === 'blue' ? BLUE_SPAWN_Z_MAX : RED_SPAWN_Z_MAX;
    let bestX = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
    let bestZ = zMin + Math.random() * (zMax - zMin);
    let bestY = this.world.getGroundHeight(bestX, bestZ);

    for (let attempt = 0; attempt < 20; attempt++) {
      const x = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
      const z = zMin + Math.random() * (zMax - zMin);
      const y = this.world.getGroundHeight(x, z);
      const vx = Math.round(x);
      const vz = Math.round(z);
      if (!this.world.isSolid(vx, Math.round(y + 0.8), vz) && !this.world.isSolid(vx, Math.round(y + 1.6), vz)) {
        bestX = x;
        bestZ = z;
        bestY = y;
        break;
      }
    }
    return { x: bestX, y: bestY, z: bestZ };
  }

  private isConnOpen(conn: WebSocket | GameConnection): boolean {
    if ('isOpen' in conn && typeof conn.isOpen === 'function') {
      return conn.isOpen();
    }
    return (conn as WebSocket).readyState === WebSocket.OPEN;
  }

  private sendToPlayer(playerId: string, message: ServerMessage): void {
    const conn = this.connections.get(playerId);
    if (conn && this.isConnOpen(conn)) {
      conn.send(JSON.stringify(message));
    }
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const conn of this.connections.values()) {
      if (this.isConnOpen(conn)) {
        conn.send(data);
      }
    }
  }

  private broadcastExcept(exceptPlayerId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const [playerId, conn] of this.connections) {
      if (playerId !== exceptPlayerId && this.isConnOpen(conn)) {
        conn.send(data);
      }
    }
  }
}
