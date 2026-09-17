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

export interface WorldChunk {
  x: number;
  z: number;
  blocks: BlockData[];
}

export type ClientToServerMessage =
  | { type: 'join'; name: string; team: 'red' | 'blue' }
  | { type: 'move'; x: number; y: number; z: number; yaw: number; pitch: number }
  | { type: 'shoot'; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  | { type: 'destroyBlock'; x: number; y: number; z: number }
  | { type: 'placeBlock'; x: number; y: number; z: number; blockType: number }
  | { type: 'captureFlag'; team: 'red' | 'blue' }
  | { type: 'heartbeat' };

export type ServerToClientMessage =
  | { type: 'gameState'; state: GameState }
  | { type: 'worldChunk'; chunk: WorldChunk }
  | { type: 'playerJoined'; player: PlayerData }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'blockDestroyed'; x: number; y: number; z: number }
  | { type: 'blockPlaced'; block: BlockData }
  | { type: 'flagCaptured'; team: 'red' | 'blue'; scorer: string }
  | { type: 'error'; message: string };
