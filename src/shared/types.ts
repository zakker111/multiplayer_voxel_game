// Game Constants
export const WORLD_SIZE = 320;
export const CHUNK_SIZE = 16;
export const GROUND_LEVEL = 8;
export const MAX_BUILD_UP = 16;
export const MAX_DIG_DOWN = 4;
export const PLAYER_HEIGHT = 1.7;
export const CROUCH_HEIGHT = 0.9;
export const PLAYER_RADIUS = 0.4;
export const PLAYER_SPEED = 5.0;
export const SPRINT_MULTIPLIER = 1.6;
export const CROUCH_MULTIPLIER = 0.5;
export const JUMP_FORCE = 8.5;
export const GRAVITY = 20.0;

// Spawn zones
export const BLUE_SPAWN_Z_MIN = -145;
export const BLUE_SPAWN_Z_MAX = -120;
export const RED_SPAWN_Z_MIN = 120;
export const RED_SPAWN_Z_MAX = 145;
export const SPAWN_X_RANGE = 25;

// Flag positions
export const BLUE_FLAG_POS = { x: 0, y: 8, z: -95 };
export const RED_FLAG_POS = { x: 0, y: 8, z: 95 };

// Voxel types
export const VOXEL_AIR = 0;
export const VOXEL_DIRT = 1;
export const VOXEL_STONE = 2;
export const VOXEL_GRASS = 3;
export const VOXEL_BUILT = 4;
export const VOXEL_WOOD = 5;
export const VOXEL_LEAVES = 6;

// Weapons
export const WEAPONS = {
  rifle: { name: 'M1 Garand', damage: 25, range: 100, fireRate: 0.8, ammo: 8 },
  smg: { name: 'Thompson', damage: 15, range: 50, fireRate: 0.15, ammo: 30 },
  spade: { name: 'Spade', damage: 50, range: 3, fireRate: 0.6, ammo: Infinity },
  pickaxe: { name: 'Pickaxe', damage: 30, range: 4, fireRate: 0.5, ammo: Infinity }
};

// Tools
export const TOOLS = {
  spade: { name: 'Spade', digSpeed: 1.0, cooldown: 0.6, harvests: [VOXEL_DIRT, VOXEL_GRASS] },
  pickaxe: { name: 'Pickaxe', digSpeed: 0.5, cooldown: 0.5, harvests: [VOXEL_STONE] }
};

// Interfaces
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
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  team: 'red' | 'blue' | 'spectator';
  health: number;
  hp: number; // Legacy alias
  weapon: string;
  hasFlag: boolean;
  ammo: number;
  isAlive: boolean;
  isDead: boolean; // Computed property
  isSpectator: boolean;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  name?: string;
  velocity?: { x: number; y: number; z: number };
  equipment?: number | string;
}

export interface PlayerInput {
  forward: number;
  right: number;
  moveX?: number; // Legacy alias for right
  moveY?: number; // Legacy alias for forward  
  moveZ?: number; // Legacy alias (unused)
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  shoot: boolean;
  yaw: number;
  pitch: number;
  equipment?: string;
  isAiming?: boolean;
  position?: { x: number; y: number; z: number };
}

export interface PlayerData {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  team: 'red' | 'blue' | 'spectator';
  health: number;
  weapon: string;
  hasFlag: boolean;
}

export interface GameState {
  players: PlayerData[];
  flags: {
    red: { x: number; y: number; z: number; captured: boolean };
    blue: { x: number; y: number; z: number; captured: boolean };
  };
  scores: { red: number; blue: number };
  timeRemaining: number;
}

export interface BlockData {
  x: number;
  y: number;
  z: number;
  type: number;
}

export interface VoxelChange {
  x: number;
  y: number;
  z: number;
  oldValue: number;
  newValue: number;
  type?: number;
  durability?: number;
}

export interface WorldChunk {
  x: number;
  z: number;
  blocks: BlockData[];
}

export type ClientMessage = 
  | { type: 'join'; name: string; team: 'red' | 'blue'; position?: { x: number; y: number; z: number } }
  | { type: 'playerInput'; input: PlayerInput }
  | { type: 'shoot'; x: number; y: number; z: number; dx: number; dy: number; dz: number; origin?: { x: number; y: number; z: number }; direction?: { x: number; y: number; z: number }; targetId?: string; isHeadshot?: boolean }
  | { type: 'useTool'; action: 'destroy' | 'build'; x: number; y: number; z: number; blockType?: number; tool?: string; target?: string }
  | { type: 'build'; x: number; y: number; z: number; blockType: number; position?: { x: number; y: number; z: number } }
  | { type: 'reload' }
  | { type: 'toggleSpectator' }
  | { type: 'captureFlag'; team: 'red' | 'blue' }
  | { type: 'pickupFlag'; team: 'red' | 'blue' }
  | { type: 'heartbeat' }
  | { type: 'footstep'; volume: number }
  | { type: 'disconnect' };

export type ServerMessage =
  | { type: 'gameState'; state: GameState }
  | { type: 'worldChunk'; chunk: WorldChunk }
  | { type: 'playerJoined'; player: PlayerState; playerId?: string; state?: Partial<PlayerState> }
  | { type: 'playerUpdated'; playerId: string; state: Partial<PlayerState> }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'blockDestroyed'; x: number; y: number; z: number }
  | { type: 'blockPlaced'; block: BlockData }
  | { type: 'flagCaptured'; team: 'red' | 'blue'; scorer: string; playerId?: string; captures?: { blue: number; red: number } }
  | { type: 'flagPickedUp'; team: 'red' | 'blue'; playerId: string; flagTeam?: 'red' | 'blue' }
  | { type: 'flagReturned'; team: 'red' | 'blue'; playerId?: string; flagTeam?: 'red' | 'blue' }
  | { type: 'flagDropped'; team: 'red' | 'blue'; playerId: string; position?: { x: number; y: number; z: number }; flagTeam?: 'red' | 'blue' }
  | { type: 'playerHit'; playerId: string; damage: number }
  | { type: 'playerKilled'; playerId: string; killerId: string }
  | { type: 'playerDied'; playerId: string; killerId?: string }
  | { type: 'playerRespawned'; playerId: string; position?: { x: number; y: number; z: number } }
  | { type: 'inventoryUpdated'; inventory: number }
  | { type: 'voxelChanged'; x: number; y: number; z: number; voxelType: number; change?: { x: number; y: number; z: number; type: number; durability?: number } }
  | { type: 'ammoUpdate'; ammo: number }
  | { type: 'init'; playerId: string; captures?: { blue: number; red: number }; scores?: { blue: number; red: number }; players?: Array<{ id: string; state: PlayerState }>; inventory?: number; voxelChanges?: Array<{ x: number; y: number; z: number; type: number; durability: number }> }
  | { type: 'spectatorToggled'; playerId: string; isSpectator: boolean; isSpectating?: boolean }
  | { type: 'footstep'; playerId: string; volume: number; pitch?: number }
  | { type: 'playerShot'; playerId: string; targetId?: string; origin?: { x: number; y: number; z: number }; direction?: { x: number; y: number; z: number }; weapon?: string }
  | { type: 'hitConfirmed'; playerId: string; damage: number; targetId?: string; isHeadshot?: boolean }
  | { type: 'playerDamaged'; playerId: string; damage: number; attackerId?: string }
  | { type: 'error'; message: string };

// Legacy aliases for backward compatibility
export type ClientToServerMessage = ClientMessage;
export type ServerToClientMessage = ServerMessage;
