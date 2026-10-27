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
  | { type: 'join'; team: 'red' | 'blue'; position?: Position; name?: string }
  | { type: 'playerInput'; input: PlayerInput }
  | { type: 'shoot'; origin: Position; direction: Position; targetId?: string; isHeadshot?: boolean }
  | { type: 'useTool'; tool: 'pickaxe' | 'spade'; target: Position }
  | { type: 'build'; position: Position }
  | { type: 'reload' }
  | { type: 'pickupFlag' }
  | { type: 'captureFlag'; team: 'red' | 'blue' }
  | { type: 'toggleSpectator' }
  | { type: 'footstep'; volume: number; pitch: number }
  | { type: 'requestRespawn' }
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

export type ServerMessage =
  | { type: 'init'; playerId: string; state: PlayerState; players: Array<{ id: string; state: PlayerState }>; scores: { red: number; blue: number }; captures: { red: number; blue: number }; stats?: Record<string, PlayerStats>; inventory?: number; voxelChanges?: VoxelChange[]; flags?: { blue: FlagSnapshot; red: FlagSnapshot } }
  | { type: 'gameState'; state: GameState }
  | { type: 'playerJoined'; playerId: string; state: PlayerState }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'playerUpdated'; playerId: string; state: PlayerState }
  | { type: 'playerShot'; playerId: string; origin: Position; direction: Position; weapon: string }
  | { type: 'voxelChanged'; change: VoxelChange }
  | { type: 'chunkUpdated'; chunk: ChunkData }
  | { type: 'playerDamaged'; playerId: string; damage: number; attackerId?: string }
  | { type: 'playerDied'; playerId: string; killerId?: string }
  | { type: 'scoreUpdate'; scores: { red: number; blue: number } }
  | { type: 'statsUpdate'; stats: Record<string, PlayerStats> }
  | { type: 'playerRespawned'; playerId: string; position: Position }
  | { type: 'hitConfirmed'; targetId: string; damage: number; isHeadshot: boolean }
  | { type: 'inventoryUpdated'; inventory: number }
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

export const PLAYER_SPEED = 5;
export const SPRINT_MULTIPLIER = 1.6;
export const CROUCH_MULTIPLIER = 0.5;
export const JUMP_FORCE = 8;
export const GRAVITY = 20;
export const PLAYER_HEIGHT = 1.7;
export const CROUCH_HEIGHT = 1.2;
export const PLAYER_RADIUS = 0.3;

export type WeaponId = 'rifle' | 'smg';

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
