// Shared types for client-server communication

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  yaw: number;
  pitch: number;
}

export interface PlayerState {
  id: string;
  position: Position;
  rotation: Rotation;
  velocity: Position;
  hp: number;
  team: 'red' | 'blue';
  isDead: boolean;
  equipment: 'rifle' | 'smg' | 'pickaxe' | 'spade';
  isAiming: boolean;
  isCrouching: boolean;
  isSprinting: boolean;
  isShooting?: boolean;
  currentAmmo?: number;
  magazineSize?: number;
  isReloading?: boolean;
  aimTransition?: number; // 0-1 for smooth aiming animation
  carryingFlag?: boolean; // Is player carrying enemy flag?
  spawnProtected?: boolean; // spawn invulnerability is still active (HUD shield)
  isBot?: boolean; // Server-authoritative: true for AI combatants (scoreboard)
  name?: string;   // Display name shown on the Tab scoreboard / nametags
}

/** Per-combatant scoreboard tallies (kills/deaths/flag captures). Broadcast
 *  to all clients via `statsUpdate` so the Tab scoreboard can rank players. */
export interface PlayerStats {
  kills: number;
  deaths: number;
  captures: number;
}

export interface VoxelChange {
  x: number;
  y: number;
  z: number;
  type: number;
  durability: number;
}

export interface ChunkData {
  chunkX: number;
  chunkZ: number;
  voxels: VoxelChange[];
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'placeEmplacement'; kind: EmplacementKind; position: Position; yaw: number; slot: number }
  | { type: 'previewEmplacement'; kind: EmplacementKind; position: Position; yaw: number; slot: number }
  | { type: 'craftBlueprint'; kind: EmplacementKind; slot: number }
  | { type: 'mountEmplacement'; emplacementId: string }
  | { type: 'dismountEmplacement' }
  | { type: 'fireEmplacement' }
  | { type: 'useSupplyCrate'; emplacementId: string; action: 'deposit' | 'draw' }
  | { type: 'join'; team: 'red' | 'blue'; position?: Position; name?: string }
  | { type: 'playerInput'; input: PlayerInput }
  | { type: 'shoot'; origin: Position; direction: Position; targetId?: string; isHeadshot?: boolean }
  | { type: 'useTool'; tool: 'pickaxe' | 'spade'; target: Position }
  | { type: 'build'; position: Position }
  | { type: 'depositWorkshop'; team: 'red' | 'blue' }
  | { type: 'buildJeep' }
  | { type: 'enterJeep'; vehicleId: string }
  | { type: 'exitJeep' }
  | { type: 'driveJeep'; throttle: number; steering: number; brake: boolean }
  | { type: 'reload' }
  | { type: 'pickupFlag' }
  | { type: 'captureFlag'; team: 'red' | 'blue' }
  | { type: 'toggleSpectator' }
  | { type: 'footstep'; volume: number; pitch: number }
  | { type: 'requestRespawn' }
  // Round-trip probe: the server echoes `t` straight back so the client can
  // measure latency without relying on WebSocket protocol pings.
  | { type: 'ping'; t: number }
  | { type: 'disconnect' };

export interface PlayerInput {
  moveX: number;
  moveZ: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  yaw: number;
  pitch: number;
  position?: Position;
  equipment?: 'rifle' | 'smg' | 'pickaxe' | 'spade';
  isAiming?: boolean;
}

// Server -> Client messages
export interface FlagSnapshot {
  atBase: boolean;
  carrierId: string | null;
  respawnTimer: number;
  droppedPosition: Position | null;
}

export type RoundPhase = 'live' | 'intermission';

/** Authoritative round state, mirrored to every client (and included in `init`
 *  so a late joiner immediately sees the current round and clock). */
export interface RoundSnapshot {
  /** 1-based round number for this server session. */
  round: number;
  phase: RoundPhase;
  /** Seconds left in the live round (0 during an intermission). */
  timeLeft: number;
  /** Seconds left of the intermission (0 while the round is live). */
  intermission: number;
  captures: { red: number; blue: number };
  /** Rounds won per team this session. */
  wins: { red: number; blue: number };
  /** Configured round length in seconds, so the HUD can draw a clock/bar. */
  duration: number;
}

export type RoundWinner = 'red' | 'blue' | 'draw';

export interface WorkshopSnapshot {
  position: Position;
  stock: number;
  capacity: number;
}

export type Workshops = Record<'red' | 'blue', WorkshopSnapshot>;

export interface JeepSnapshot {
  id: string;
  /** Which VEHICLES record drives this vehicle's stats and footprint. */
  kind: VehicleKind;
  team: 'red' | 'blue';
  position: Position;
  yaw: number;
  speed: number;
  hp: number;
  driverId: string | null;
  wreck: boolean;
}

export type ServerMessage =
  | { type: 'init'; playerId: string; sessionToken?: string; state: PlayerState; players: Array<{ id: string; state: PlayerState }>; scores: { red: number; blue: number }; captures: { red: number; blue: number }; stats?: Record<string, PlayerStats>; inventory?: number; depositable?: number; workshops?: Workshops;   jeeps?: JeepSnapshot[]; emplacements?: EmplacementSnapshot[]; voxelChanges?: VoxelChange[]; flags?: { blue: FlagSnapshot; red: FlagSnapshot }; round?: RoundSnapshot; blueprints?: BlueprintSlots }
  | { type: 'roundUpdate'; round: RoundSnapshot }
  | { type: 'roundEnded'; round: number; winner: RoundWinner; captures: { red: number; blue: number }; wins: { red: number; blue: number } }
  | { type: 'gameState'; state: GameState }
  | { type: 'joined'; state: PlayerState }
  | { type: 'playerJoined'; playerId: string; state: PlayerState }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'playerUpdated'; playerId: string; state: PlayerState }
  | { type: 'playerShot'; playerId: string; origin: Position; direction: Position; weapon: string }
  | { type: 'voxelChanged'; change: VoxelChange }
  | { type: 'chunkUpdated'; chunk: ChunkData }
  | { type: 'playerDamaged'; playerId: string; damage: number; attackerId?: string }
  | { type: 'playerDied'; playerId: string; killerId?: string; weapon?: string; isHeadshot?: boolean }
  | { type: 'pong'; t: number }
  | { type: 'scoreUpdate'; scores: { red: number; blue: number } }
  | { type: 'statsUpdate'; stats: Record<string, PlayerStats> }
  | { type: 'playerRespawned'; playerId: string; position: Position }
  | { type: 'hitConfirmed'; targetId: string; damage: number; isHeadshot: boolean }
  | { type: 'inventoryUpdated'; inventory: number }
  | { type: 'resourcesUpdated'; depositable: number }
  | { type: 'workshopsUpdated'; workshops: Workshops }
  | { type: 'jeepsUpdated'; jeeps: JeepSnapshot[] }
  | { type: 'emplacementsUpdated'; emplacements: EmplacementSnapshot[] }
  | { type: 'emplacementPreview'; ok: boolean; reason?: string; position?: Position; yaw?: number }
  | { type: 'emplacementMessage'; message: string }
  | { type: 'emplacementMounted'; emplacementId: string; position: Position; yaw: number }
  | { type: 'shellFired'; id: string; kind: EmplacementKind; position: Position; velocity: Position }
  | { type: 'shellImpact'; id: string; kind: EmplacementKind; position: Position; radius: number }
  | { type: 'emplacementExited'; position: Position }
  | { type: 'blueprintsUpdated'; blueprints: BlueprintSlots }
  | { type: 'jeepExited'; position: Position }
  | { type: 'jeepMessage'; message: string }
  | { type: 'flagCaptured'; team: 'red' | 'blue'; flagTeam?: 'red' | 'blue'; playerId: string; captures: { red: number; blue: number } }
  | { type: 'flagPickedUp'; playerId: string; flagTeam: 'red' | 'blue' }
  | { type: 'flagDropped'; position: Position; flagTeam: 'red' | 'blue'; playerId?: string }
  | { type: 'flagReturned'; flagTeam: 'red' | 'blue' }
  | { type: 'spectatorToggled'; playerId: string; isSpectating: boolean }
  | { type: 'footstep'; playerId: string; volume: number; pitch: number }
  | { type: 'kicked'; reason: string; banned: boolean };

export interface GameState {
  players: Map<string, PlayerState>;
  scores: { red: number; blue: number };
  serverTime: number;
}

// Constants (shared between client and server)
// NOTE: single source of truth for map size. The client voxel world
// (src/game/world.ts) imports this value — do not re-declare it there.
export const WORLD_SIZE = 448; // 28 chunks of CHUNK_SIZE(16); keeps half=224 aligned to chunk grid
export const CHUNK_SIZE = 16;

/** Half-extent of the playable map. Derived from WORLD_SIZE so that resizing
 *  the map can never again leave the spawn zones outside the "fell out of the
 *  world" bounds (a hardcoded 124 here made every spawn self-eliminate). */
export const WORLD_HALF = WORLD_SIZE / 2;

/** Below this Y a player has fallen out of the world. */
export const VOID_KILL_Y = -8;

/** True when a position is outside the playable map or below the void floor. */
export function isOutOfWorld(pos: { x: number; y: number; z: number }): boolean {
  return (
    pos.y < VOID_KILL_Y ||
    Math.abs(pos.x) > WORLD_HALF ||
    Math.abs(pos.z) > WORLD_HALF
  );
}
export const GROUND_LEVEL = 8;
export const MAX_BUILD_UP = 20;
export const MAX_DIG_DOWN = 20;
export const VOXEL_SIZE = 1;

export const VOXEL_AIR = 0;
export const VOXEL_DIRT = 1;
export const VOXEL_STONE = 2;
export const VOXEL_GRASS = 3;
export const VOXEL_BUILT = 4;

// The garage is a protected visual structure, not a destructible voxel entity.
// A fixed footprint keeps its floor and future vehicle pad clear of edits.
export const WORKSHOP_CENTERS = {
  blue: { x: 45, z: -185 },
  red: { x: 45, z: 185 },
} as const;
export const WORKSHOP_START_STOCK = 50;
export const WORKSHOP_CAPACITY = 200;
export const WORKSHOP_REACH = 8;
/** The blueprint bench sits inside the workshop's protected cells (clear of the
 *  jeep pad at x+11), so a bench can never be dug out or built over. */
export const BENCH_OFFSET = { x: -3, z: 5 } as const;
export const BENCH_REACH = 6;

export function benchPosition(workshop: Position): Position {
  return { x: workshop.x + BENCH_OFFSET.x, y: workshop.y, z: workshop.z + BENCH_OFFSET.z };
}
/** Vehicles are data, not code: one record per kind carries the workshop cost,
 *  durability, per-team limit and physical footprint, so the build/enter/drive/
 *  damage path is shared instead of copied for every new vehicle. */
export type VehicleKind = 'jeep';

/** Physical shape shared by anything solid the server places in the world:
 *  oriented box half-extents, the same rectangle collision and bullets use. */
export interface Footprint {
  halfWidth: number;
  halfLength: number;
  height: number;
}

export interface VehicleSpec extends Footprint {
  kind: VehicleKind;
  /** Team workshop blocks spent to build one. */
  cost: number;
  maxHp: number;
  /** Live vehicles a team may field at once. */
  teamLimit: number;
  /** How close a player must stand to board. */
  enterReach: number;
  // Arcade handling. A tank and a jeep differ here far more than in their HP.
  /** Forward speed cap in metres per second. */
  topSpeed: number;
  /** Reverse speed cap (a positive number; applied backwards). */
  reverseSpeed: number;
  /** How fast speed may change, m/s². */
  acceleration: number;
  /** Steering rate in radians per second at full authority. */
  turnRate: number;
  /** Speed at which steering reaches full authority. */
  fullTurnSpeed: number;
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  jeep: {
    kind: 'jeep', cost: 40, maxHp: 250, teamLimit: 2,
    halfWidth: 1.3, halfLength: 2, height: 2, enterReach: 4,
    topSpeed: 12, reverseSpeed: 5, acceleration: 10, turnRate: 1.4, fullTurnSpeed: 4,
  },
};

export function vehicleSpec(kind: VehicleKind): VehicleSpec {
  return VEHICLES[kind];
}

export type EmplacementKind = 'mgNest' | 'cannon' | 'mortar' | 'supplyCrate' | 'spottingPost';

/** The three blueprint slots a player carries. A crafted slot holds one kind and
 *  is emptied when that blueprint is placed. */
export type BlueprintSlots = [EmplacementKind | null, EmplacementKind | null, EmplacementKind | null];

/** Static hardware a player places from a blueprint. `arc`, `ammo` and the
 *  range pair describe the weapon case; support builds leave them at zero. */
export interface EmplacementSpec extends Footprint {
  kind: EmplacementKind;
  /** Team workshop blocks spent to place one. */
  cost: number;
  maxHp: number;
  /** How many of this kind a team may have standing at once. */
  teamLimit: number;
  /** Firing arc in radians, centred on the placement yaw. 0 = unarmed. */
  arc: number;
  /** Seconds between rounds once manned. 0 = unarmed. */
  fireInterval: number;
  /** Rounds carried when placed. 0 = unarmed. */
  ammo: number;
  /** Closest useful target; indirect fire needs this so it cannot hit its base. */
  minRange: number;
  maxRange: number;
}

export const EMPLACEMENTS: Record<EmplacementKind, EmplacementSpec> = {
  mgNest: { kind: 'mgNest', cost: 70, maxHp: 300, teamLimit: 2, halfWidth: 1.1, halfLength: 1.1, height: 1.6, arc: Math.PI, fireInterval: 0.09, ammo: 200, minRange: 0, maxRange: 90 },
  cannon: { kind: 'cannon', cost: 90, maxHp: 350, teamLimit: 1, halfWidth: 1.2, halfLength: 1.6, height: 1.5, arc: Math.PI / 3, fireInterval: 2.5, ammo: 10, minRange: 8, maxRange: 120 },
  mortar: { kind: 'mortar', cost: 80, maxHp: 250, teamLimit: 1, halfWidth: 0.9, halfLength: 0.9, height: 1.2, arc: Math.PI, fireInterval: 3, ammo: 6, minRange: 25, maxRange: 120 },
  supplyCrate: { kind: 'supplyCrate', cost: 20, maxHp: 150, teamLimit: 3, halfWidth: 0.9, halfLength: 0.9, height: 1.1, arc: 0, fireInterval: 0, ammo: 0, minRange: 0, maxRange: 0 },
  spottingPost: { kind: 'spottingPost', cost: 40, maxHp: 200, teamLimit: 1, halfWidth: 0.9, halfLength: 0.9, height: 4, arc: 0, fireInterval: 0, ammo: 0, minRange: 0, maxRange: 0 },
};

/** Unknown kinds come straight from the wire, so this is a lookup, not a cast. */
export function emplacementSpec(kind: string): EmplacementSpec | undefined {
  return Object.prototype.hasOwnProperty.call(EMPLACEMENTS, kind)
    ? EMPLACEMENTS[kind as EmplacementKind]
    : undefined;
}

export interface EmplacementSnapshot {
  id: string;
  kind: EmplacementKind;
  team: 'red' | 'blue';
  position: Position;
  /** Current facing. Tracked from the gunner's aim while the nest is manned. */
  yaw: number;
  /** Facing chosen when it was placed; the gunner swings within `arc / 2`. */
  baseYaw: number;
  hp: number;
  ammo: number;
  /** Mined blocks held by a supply crate; 0 for every other build. */
  stock: number;
  /** Player manning it, or null. Only MANNED_EMPLACEMENTS can be manned. */
  gunnerId: string | null;
}

/** Kinds a player can man with F: the three armed builds. */
export const MANNED_EMPLACEMENTS: EmplacementKind[] = ['mgNest', 'cannon', 'mortar'];
/** How close a player must stand to climb into a nest. */
export const EMPLACEMENT_MOUNT_REACH = 3.5;
/** How close a team must stand to fill or draw from a supply crate. */
export const EMPLACEMENT_USE_REACH = 4;
/** Mined blocks a forward supply crate can hold before it is full. */
export const SUPPLY_CRATE_CAPACITY = 60;
/** Blocks one draw hands to a teammate's build inventory. */
export const SUPPLY_CRATE_DRAW = 5;
/** Seconds between MG nest rounds: an emplaced nest outguns a rifle. */
export const EMPLACEMENT_FIRE_INTERVAL = 0.09;
/** Gravity pulling cannon and mortar shells, shared so the client can draw the
 *  same arc the server simulates. */
export const EMPLACEMENT_SHELL_GRAVITY = 18;
/** Splash radius and the damage at the centre of a cannon round. */
export const CANNON_BLAST_RADIUS = 4;
export const CANNON_BLAST_DAMAGE = 70;
/** Slower, heavier, wider: the mortar's trade for its arc and range. */
export const MORTAR_BLAST_RADIUS = 6;
export const MORTAR_BLAST_DAMAGE = 90;
/** Damage one MG nest round does to a body. */
export const EMPLACEMENT_ROUND_DAMAGE = 30;
/** How far up or down the gunner may tilt the nest, in radians. */
export const EMPLACEMENT_MAX_PITCH = 0.6;

// Named aliases keep existing call sites readable; VEHICLES is the only source.
export const JEEP_COST = VEHICLES.jeep.cost;
export const JEEP_TEAM_LIMIT = VEHICLES.jeep.teamLimit;
export const JEEP_MAX_HP = VEHICLES.jeep.maxHp;
export const JEEP_ENTER_REACH = VEHICLES.jeep.enterReach;


export function isWorkshopProtectedCell(x: number, z: number): boolean {
  return Object.values(WORKSHOP_CENTERS).some(
    center => x >= center.x - 5 && x <= center.x + 17 && Math.abs(z - center.z) <= 7,
  );
}

/** Round length in minutes. Both teams are already 320m apart at the start of a
 *  round and a flag run crosses the whole arena, so rounds are long by design;
 *  override with ROUND_MINUTES (the round clock is never shorter than 30 min). */
export const DEFAULT_ROUND_MINUTES = 30;

/** Pause between rounds: flags return to their stands, everyone respawns. */
export const INTERMISSION_SECONDS = 20;

/** Spawn invulnerability. Given on join, respawn and round start; a player's
 *  own shot cancels it early so it can never be used as an attack shield. */
export const SPAWN_PROTECTION_SECONDS = 2.5;

/** Health regenerates only after this long without taking damage (long enough
 *  that a firefight is still decided by aim, short enough that a survivor can
 *  push again instead of limping around at 12 HP forever). */
export const REGEN_DELAY_SECONDS = 6;

/** Health per second once regeneration starts. */
export const REGEN_RATE = 6;

/** Screen-space bearing of a target from an observer, in degrees: 0 is dead
 *  ahead, +90 is to the right, +/-180 is directly behind. Used by the HUD's
 *  damage-direction indicator, so it lives here (shared, pure, testable)
 *  instead of inside the 5k-line game class. */
export function relativeBearingDegrees(
  origin: { x: number; z: number },
  forward: { x: number; z: number },
  target: { x: number; z: number },
): number {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dist = Math.hypot(dx, dz);
  if (!Number.isFinite(dist) || dist < 1e-4) return 0;

  const fLen = Math.hypot(forward.x, forward.z) || 1;
  const fx = forward.x / fLen;
  const fz = forward.z / fLen;
  // Right-hand side of the view direction (y-up), i.e. forward rotated -90deg.
  const rx = -fz;
  const rz = fx;

  const ahead = (dx * fx + dz * fz) / dist;
  const right = (dx * rx + dz * rz) / dist;
  return (Math.atan2(right, ahead) * 180) / Math.PI;
}

export const PLAYER_SPEED = 5;
export const SPRINT_MULTIPLIER = 1.6;
export const CROUCH_MULTIPLIER = 0.5;
export const JUMP_FORCE = 8;
export const GRAVITY = 20;
export const PLAYER_HEIGHT = 1.7;
export const CROUCH_HEIGHT = 1.2;
export const PLAYER_RADIUS = 0.3;

/**
 * Hard ceiling on how far a client-reported position may travel per second.
 * The client runs its own physics and then tells the server where it is, so
 * without a budget a modified client can simply teleport (e.g. straight onto
 * the enemy flag). Sprint is 5 * 1.6 = 8 u/s, so 12 u/s keeps 50% headroom for
 * jitter, slope stepping and dropped packets while staying far below any
 * teleport a cheat might attempt.
 */
export const PLAYER_MAX_SPEED = PLAYER_SPEED * SPRINT_MULTIPLIER * 1.5;
/** Seconds of movement a stalled client may bank before it is throttled. */
export const PLAYER_MOVE_BURST_SECONDS = 0.4;
/** Fastest a falling player can legitimately descend, in units per second. */
export const PLAYER_MAX_FALL_SPEED = 50;

export type WeaponId = 'rifle' | 'smg';

/** Everything a player can hold. Equipment ids arrive from the network, so the
 *  server validates them with `isEquipment()` before they reach game state —
 *  an unknown string used to sit in `equipment`, break HUD lookups and leave
 *  the player unable to shoot. */
export type EquipmentId = WeaponId | 'pickaxe' | 'spade';

export const EQUIPMENT_IDS: readonly EquipmentId[] = ['rifle', 'smg', 'pickaxe', 'spade'];

export function isEquipment(value: unknown): value is EquipmentId {
  return typeof value === 'string' && (EQUIPMENT_IDS as readonly string[]).includes(value);
}

/** Authoritative weapon stats.
 *
 *  THIS IS THE ONLY DEFINITION. The client (`src/game/game.ts`), the server
 *  (`serverGame` / `serverPlayer`) and the bots all read this table. The
 *  client used to keep its own copy, which silently drifted to 34/100 damage
 *  for the SMG while the server dealt 20/34 — the same gun, two different
 *  numbers. Never re-declare a damage, fire-rate or magazine value anywhere
 *  else; add it here. */
export interface WeaponStats {
  name: string;
  /** Seconds between shots (semi-auto weapons are also click-gated). */
  fireRate: number;
  damage: { head: number; body: number };
  /** Hip-fire cone in radians; 0 would be pinpoint. */
  spread: number;
  magazineSize: number;
  reloadTime: number;
  /** Full damage applies inside this many metres. */
  fullRange: number;
  /** Damage scales linearly from 1x at `fullRange` down to `minMultiplier`
   *  at this range, then stays there. */
  falloffRange: number;
  minMultiplier: number;
}

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  // Marksman: slow cadence, pinpoint, two body shots (one headshot) to kill at
  // any range. Beaten by the SMG inside ~18m, dominant past ~40m.
  rifle: {
    name: 'Rifle',
    fireRate: 0.7,
    damage: { head: 100, body: 65 },
    spread: 0.0006,
    magazineSize: 10,
    reloadTime: 2.0,
    fullRange: 140,
    falloffRange: 260,
    minMultiplier: 0.8,
  },
  // Close quarters: highest raw DPS in the game, but the damage collapses past
  // 18m and it is a 10 shot/s spray with a 30-round magazine.
  smg: {
    name: 'SMG',
    fireRate: 0.1,
    damage: { head: 34, body: 20 },
    spread: 0.012,
    magazineSize: 30,
    reloadTime: 1.5,
    fullRange: 18,
    falloffRange: 50,
    minMultiplier: 0.35,
  },
};

/** Range damage multiplier for a weapon (1 inside `fullRange`). */
export function rangeMultiplier(weapon: WeaponStats, distance: number): number {
  if (!Number.isFinite(distance) || distance <= weapon.fullRange) return 1;
  if (distance >= weapon.falloffRange) return weapon.minMultiplier;
  const t = (distance - weapon.fullRange) / (weapon.falloffRange - weapon.fullRange);
  return 1 + (weapon.minMultiplier - 1) * t;
}

/** Authoritative damage for a single hit, including range falloff.
 *  Server hits, bot hits and the offline bot match must all use this so a
 *  weapon hits for identical numbers in every mode. */
export function weaponDamage(weapon: WeaponStats, isHeadshot: boolean, distance: number): number {
  const base = isHeadshot ? weapon.damage.head : weapon.damage.body;
  return Math.max(1, Math.round(base * rangeMultiplier(weapon, distance)));
}

export const TOOLS = {
  pickaxe: { damage: 3, cooldown: 0.5, harvests: true },
  spade: { damage: 3, cooldown: 0.3, harvests: false, affectsMultiple: true },
};

// Flag bases moved deeper into the halves (-160 / +160) so the two bases are
// 320m apart on the enlarged map.
export const BLUE_FLAG_POS = { x: 0, z: -160 };
export const RED_FLAG_POS = { x: 0, z: 160 };

// Spawns are placed far behind the base flag (40m - 60m behind flag), so each
// team must cross ~200m of contested ground to reach the enemy flag.
export const BLUE_SPAWN_Z_MIN = -220;
export const BLUE_SPAWN_Z_MAX = -200;
export const RED_SPAWN_Z_MIN = 200;
export const RED_SPAWN_Z_MAX = 220;
export const SPAWN_X_RANGE = 32;
