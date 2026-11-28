import * as THREE from 'three';
import { VoxelWorld, VOXEL_BUILT, VOXEL_SIZE, WORLD_SIZE, CHUNK_SIZE } from './world';
import { Player } from './player';
import { vehicleClear, vehicleExitSpot, vehicleGround, vehicleRectsOverlap, type ClearanceBodies } from '../shared/vehiclePhysics';
import { SoundManager } from './sounds';
import { NetworkClient } from './networkClient';
import { spotPostCoverage, type SpotPostCoverage } from '../shared/spotting';
import { PlayerState, Position, PlayerStats, Workshops, JeepSnapshot, WorkshopSnapshot } from '../shared/types';
// Local copies previously drifted from the server (shared/types) values;
// now sourced from the shared module so client and server agree on spawns/flags.
import {
  BLUE_SPAWN_Z_MIN,
  BLUE_SPAWN_Z_MAX,
  RED_SPAWN_Z_MIN,
  RED_SPAWN_Z_MAX,
  SPAWN_X_RANGE,
  BLUE_FLAG_POS,
  RED_FLAG_POS,
  WEAPONS,
  weaponDamage,
  gunStats,
  DEFAULT_ROUND_MINUTES,
  INTERMISSION_SECONDS,
  relativeBearingDegrees,
  WORKSHOP_REACH, JEEP_ENTER_REACH, BENCH_REACH, benchPosition,
  WORKSHOP_CENTERS, WORKSHOP_CAPACITY, WORLD_HALF, vehicleSpec, WRECK_LIFETIME_SECONDS,
  VOXEL_AIR, VOXEL_DIRT, VOXEL_GRASS, GROUND_LEVEL,
  VOXEL_MAX_DURABILITY, VOXEL_SHOT_DAMAGE,
  emplacementSpec, emplacementDismantleRefund, EMPLACEMENTS, type EmplacementKind, type BlueprintSlots, type EmplacementSnapshot,
  MANNED_EMPLACEMENTS, EMPLACEMENT_MOUNT_REACH, EMPLACEMENT_SHELL_GRAVITY,
  EMPLACEMENT_USE_REACH, EMPLACEMENT_MAX_PITCH, EMPLACEMENT_ROUND_DAMAGE, emplacedShotDirection,
  CANNON_BLAST_RADIUS, MORTAR_BLAST_RADIUS, CANNON_BLAST_DAMAGE, MORTAR_BLAST_DAMAGE,
  SUPPLY_CRATE_CAPACITY, SUPPLY_CRATE_DRAW, SPOTTING_POST_RADIUS,
  type EmplacementSpec, type Footprint, type SpotContact,
  isWorkshopProtectedCell,
  type WeaponStats,
  type RoundPhase,
  type RoundSnapshot,
  type RoundWinner,
} from '../shared/types';
import {
  CANNON_SHELL_SPEED, MORTAR_SHELL_SPEED, ballisticVelocity, blastVoxelHits, shellArc, mortarImpactPoint,
  shellStopsAt, type ShellObstacle,
} from '../shared/ballistics';
import { SHELL_STEP, stepOfflineShells } from './localShells';

/** A walking bot's footprint for vehicle avoidance: its 0.4m movement cylinder. */
const BOT_VEHICLE_FOOTPRINT: Footprint = { halfWidth: 0.4, halfLength: 0.4, height: 1.9 };

/**
 * Draw a seat's stand-in figure only for someone else's body, never your own
 * (the first-person camera is in that seat) and never on a wreck.
 */
function showSeatFigure(id: string | null | undefined, localId: string, wreck: boolean): boolean {
  return !!id && !wreck && id !== localId;
}
import { WreckSmoke } from './wreckSmoke';

/** How long a killfeed row stays on screen. */
const KILLFEED_SECONDS = 8;
/** Paint burned off a destroyed vehicle or build. Dark enough to read as
 *  charcoal, light enough that the facets still catch the light. */
const WRECK_CHAR_COLOR = 0x57514a;
/** How long a damage-direction arc lingers after you are hit. */
const DAMAGE_INDICATOR_SECONDS = 2;
/** Latency probe interval (ms, measured every N seconds). */
const PING_INTERVAL_SECONDS = 2;

/** One round's landing: a flash, a ground/wall ring and a few debris chips. */
interface ImpactBurst {
  flash: THREE.Mesh;
  dust: THREE.Mesh;
  ring: THREE.Mesh;
  chips: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3 }>;
  life: number;
  maxLife: number;
}

/** Offline Beta judges build spots with the server's own layout rules
 *  (serverGame.ts), so a ghost that reads green places exactly the same way. */
const LOCAL_EMPLACEMENT_ENEMY_BASE_RING = 40;
const LOCAL_EMPLACEMENT_OWN_FLAG_CLEARANCE = 10;
const LOCAL_EMPLACEMENT_WORKSHOP_CLEARANCE = 8;
const LOCAL_EMPLACEMENT_SEPARATION = 0.5;
const LOCAL_EMPLACEMENT_PREVIEW_INTERVAL = 120;

/** Separating-axis test for two oriented footprints on the XZ plane, the same
 *  rectangle test the server uses, so different build sizes compare correctly. */
function localRectsOverlap(
  ax: number, az: number, ayaw: number, aSpec: Footprint,
  bx: number, bz: number, byaw: number, bSpec: Footprint,
): boolean {
  const rect = (yaw: number) => ({
    f: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
    s: { x: Math.cos(yaw), z: -Math.sin(yaw) },
  });
  const a = rect(ayaw), b = rect(byaw);
  for (const axis of [a.f, a.s, b.f, b.s]) {
    const pa = ax * axis.x + az * axis.z;
    const pb = bx * axis.x + bz * axis.z;
    const ha = aSpec.halfLength * Math.abs(a.f.x * axis.x + a.f.z * axis.z) +
      aSpec.halfWidth * Math.abs(a.s.x * axis.x + a.s.z * axis.z);
    const hb = bSpec.halfLength * Math.abs(b.f.x * axis.x + b.f.z * axis.z) +
      bSpec.halfWidth * Math.abs(b.s.x * axis.x + b.s.z * axis.z);
    if (Math.abs(pa - pb) >= ha + hb) return false;
  }
  return true;
}

/** Offline Beta runs one bot jeep errand per team at a time, like the server. */
const BOT_JEEP_MAX_DRIVERS_PER_TEAM = 1;
const BOT_JEEP_COOLDOWN_SECONDS = 30;
/** A jeep errand ends once it is this close to the enemy flag stand. */
const BOT_JEEP_ARRIVE_RADIUS = 75;
/** Give up walking to the workshop / driving if the errand stalls this long. */
const BOT_JEEP_APPROACH_SECONDS = 35;
// The jeep collides with infantry exactly as it does on the server, so a
// crowded midfield costs a wait or a wide route. The window allows for that
// without letting a genuinely stuck errand run forever.
const BOT_JEEP_DRIVE_SECONDS = 75;
/** Errand routing works on this many metres per cell, which is more than the
 *  jeep's own body, so a fortification between the pad and the flag is a run of
 *  blocked cells the route can go around. */
const JEEP_ROUTE_STEP = 4;
/** Route cells A* may expand before an errand falls back to steering straight. */
const JEEP_ROUTE_BUDGET = 2500;
/** Extra route cost per metre inside this many metres of the centre line: the
 *  fight lives there, so a jeep swings wide around it when the detour is short
 *  enough, which is what keeps an errand alive to reach the far flag. */
const JEEP_ROUTE_DANGER = 80;

/** Squared distance to a plain snapshot position, so the per-frame reach checks
 *  allocate nothing. */
function distanceSquared(from: { x: number; y: number; z: number }, to: Position): number {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const dz = from.z - to.z;
  return dx * dx + dy * dy + dz * dz;
}

/** One row of the killfeed. Names are resolved on the client because the server
 *  only sends ids (it never needs to know display names). */
export interface KillfeedEntry {
  id: number;
  killerId: string | null;
  victimId: string;
  killerName: string;
  killerTeam: Team | null;
  victimName: string;
  victimTeam: Team | null;
  weapon: string;
  isHeadshot: boolean;
  /** Wall-clock ms, used only to expire the row. */
  at: number;
}

/* ---------- Tab-held scoreboard data model ---------- */

export interface ScoreboardRow {
  id: string;
  name: string;
  isBot: boolean;
  kills: number;
  deaths: number;
  captures: number;
  kd: number;
  isLocalPlayer: boolean;
  isTopCapturer: boolean;
}

export interface ScoreboardTeamPanel {
  team: 'blue' | 'red';
  points: number;      // flag captures = points
  killPoints: number;  // total team kills (secondary score)
  rows: ScoreboardRow[];
}

export interface ScoreboardData {
  teams: ScoreboardTeamPanel[];   // own team first
  leadingTeam: 'blue' | 'red' | null; // which side is on top
  topCapturerName: string | null;
}

// Game Constants

export type EquipmentType = 'rifle' | 'smg' | 'spade' | 'pickaxe';
type Team = 'red' | 'blue';
type GameMode = 'multiplayer' | 'singleplayer' | 'online' | 'beta';

export interface RadioMessage {
  id: string;
  sender: string;
  text: string;
  team: Team;
  time: number;
}

/** One enemy the HUD marks because a friendly spotting post can see them. */
export interface SpotMarker {
  id: string;
  team: Team;
  /** Screen position in percent of the viewport. */
  xPct: number;
  yPct: number;
  /** Ground distance from the player, in metres. */
  distance: number;
}

export interface GameState {
  hp: number;
  maxHp: number;
  equipment: EquipmentType;
  inventory: number;
  depositable: number;
  workshopStock: number;
  workshopCapacity: number;
  workshopDistance: number | null;
  /** Distance to this team's blueprint bench; null before the workshop state
   *  arrives or outside online play. */
  benchDistance: number | null;
  /** The bench panel is open. Opening it frees the cursor, so it is UI state
   *  owned by the game loop rather than by React. */
  benchOpen: boolean;
  /** Blueprints crafted into the bench slots, in slot order (5/6/7). */
  blueprints: BlueprintSlots;
  /** What each slot builds, so the HUD can name an empty one. */
  blueprintCatalogue: EmplacementKind[];
  /** The bench menu overlay is up; the cursor is free and the game keys idle. */
  benchMenuOpen: boolean;
  /** Latest craft answer from the server, shown inside the bench menu because
   *  the menu overlay covers the normal HUD message line. */
  benchFeedback: string;
  /** True while manning an emplacement; the HUD swaps to its gun hints. */
  manningEmplacement: boolean;
  /** Which gun is manned, for the HUD line. */
  manningKind: EmplacementKind | null;
  /** Rounds left in the manned nest, or null when not manning one. */
  manningAmmo: number | null;
  /** Aimed landing point of a manned mortar (the ring centre), or null. */
  manningAim: { x: number; z: number; range: number } | null;
  /** A mannable nest of your own team is within reach. */
  emplacementNearby: boolean;
  /** A supply crate of your own team is within use reach. */
  crateNearby: boolean;
  /** Blocks held by that crate, for the HUD prompt. */
  crateStock: number | null;
  /** What the dismantle key would tear down from here, or null. */
  dismantleTarget: 'build' | 'jeep' | null;
  /** Shell packs carried for the next cannon or mortar resupply. */
  shellPacks: number;
  /** A friendly cannon or mortar is in reach (or manned) for an R reload. */
  shellGunNearby: boolean;
  jeepNearby: boolean;
  jeepDriving: boolean;
  jeepRiding: boolean;
  jeepHp: number;
  jeepSpeed: number;
  isDead: boolean;
  respawnTimer: number;
  hitMarker: boolean;
  targetInfo: string;
  message: string;
  messageTimer: number;
  buildMode: boolean;
  buildValid: boolean;
  blueKills: number;
  redKills: number;
  blueCaptures: number;
  redCaptures: number;
  isAiming: boolean;
  currentAmmo: number;
  magazineSize: number;
  /** Rounds in the pouch besides the magazine (online); mirrored from the
   *  server so the HUD counts down as reloads spend it. */
  ammoReserve: number;
  /** Blocks one magazine of the equipped gun costs at the bench, or null for
   *  a tool that cannot buy ammo. */
  ammoCost: number | null;
  isReloading: boolean;
  playerCarryingFlag: boolean;
  flagCarrierName: string;
  isSpectating: boolean;
  spectatorMode?: 'action' | 'free';
  spectatorTrackedName?: string;
  isOnline?: boolean;
  connectedPlayersCount?: number;
  isNetworkConnected?: boolean;
  transportName?: string;
  localPlayerId?: string | null;
  // Round HUD (online play only; `roundIsServerDriven` gates the display)
  roundIsServerDriven: boolean;
  roundNumber: number;
  roundPhase: RoundPhase;
  roundTimeLeft: number;
  roundIntermission: number;
  roundDuration: number;
  roundWins: { red: number; blue: number };
  roundWinner: RoundWinner | null;
  blueFlagStatus?: 'at_base' | 'carried' | 'dropped' | 'captured';
  redFlagStatus?: 'at_base' | 'carried' | 'dropped' | 'captured';
  blueFlagTimer?: number;
  redFlagTimer?: number;
  radioLog?: RadioMessage[];
  scoreboard?: ScoreboardData;
  showScoreboard?: boolean;
  // Feedback layer (Phase A): killfeed, damage direction, latency, spawn shield
  killfeed: KillfeedEntry[];
  /** Bearings of recent damage sources in degrees (0 = ahead, +90 = right). */
  damageIndicators: number[];
  /** Enemies currently inside a friendly spotting post's radius. */
  spotContacts: SpotMarker[];
  /** This team's live spotting post, or null when it has none. */
  spotPost: SpotPostCoverage | null;
  /** Round-trip latency in ms; 0 when offline or not measured yet. */
  pingMs: number;
  /** Spawn invulnerability is active right now. */
  spawnProtected: boolean;
  /** Master audio muted (M key or the HUD audio control). */
  audioMuted: boolean;
  /** Master audio volume, 0..1. */
  audioVolume: number;
}

interface Bot {
  mesh: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  hp: number;
  maxHp: number;
  isDead: boolean;
  respawnTimer: number;
  targetPos: THREE.Vector3;
  moveTimer: number;
  shootTimer: number;
  burstRemaining: number;
  burstTimer: number;
  headY: number;
  grounded: boolean;
  team: Team;
  name: string;
  role: 'attacker' | 'defender' | 'flanker' | 'support';
  laneOffset: number;
  nameTag: THREE.Sprite;
  isCrouching: boolean;
  crouchTimer: number;
  behaviorState: string;
  behaviorTimer: number;
  strafeDirection: number;
  stuckTimer: number;
  lastPos: THREE.Vector3;
  jumpCooldown: number;
  skill: number;
  aggression: number;
  lastDamageTime: number;
  dodgeTimer: number;
  coverTimer: number;
  weapon: 'rifle' | 'smg';
  weaponMesh: THREE.Group | null;
  ammo: number;
  maxAmmo: number;
  isReloading: boolean;
  reloadTimer: number;
  aimPitch: number;
  bodyParts?: {
    head: THREE.Mesh;
    helmet: THREE.Mesh;
    leftArm: THREE.Mesh;
    rightArm: THREE.Mesh;
    leftLeg: THREE.Mesh;
    rightLeg: THREE.Mesh;
    weaponGroup: THREE.Group;
    spadeGroup: THREE.Group;
    blockGroup: THREE.Group;
  };
  isAiming: boolean;
  aimTransition: number;
  carryingFlag: boolean;
  flagMesh: THREE.Group | null;
  lookAroundTimer: number;
  lookAroundTarget: number;
  walkCycle: number;
  // Human-like behavior properties
  hasSpade: boolean;
  isDigging: boolean;
  digTimer: number;
  digTarget: { x: number; y: number; z: number } | null;
  trenchDepth: number;
  isInTrench: boolean;
  panicLevel: number;
  confidence: number;
  suppressionTimer: number;
  lastSeenEnemy: THREE.Vector3 | null;
  memoryPosition: THREE.Vector3 | null;
  memoryTimer: number;
  flankRoute: Array<{ x: number; z: number }> | null;
  flankProgress: number;
  squadId: number;
  isLeading: boolean;
  // Building behavior properties
  hasBlocks: boolean;
  inventoryBlocks: number;
  /** MG nest this bot is manning, or null. */
  nestId: string | null;
  /** Seconds seated without a target before it steps back out. */
  nestIdleTimer: number;
  /** Seconds before this bot looks for another MG post. */
  nestCooldown: number;
  isBuilding: boolean;
  buildTimer: number;
  buildTarget: { x: number; y: number; z: number } | null;
  // Dynamic tactical state & overhead badge system
  tacticalState: 'shooting' | 'building' | 'capturing' | 'returning' | 'digging' | 'defending' | 'flanking';
  tacticalStateTimer: number;
  buildCooldown: number;
  digCooldown: number;
  tacticalBlocksQueued: Array<{ x: number; y: number; z: number }>;
  nameTagCanvas?: HTMLCanvasElement;
  nameTagTexture?: THREE.CanvasTexture;
  lastDrawnState?: string;
  // Bot archetype, voice radio & breaching capabilities
  archetype: 'assault' | 'marksman' | 'breacher' | 'engineer';
  speechText?: string;
  speechTimer: number;
  combatJumpCooldown: number;
  flinchTimer: number;
  isBreaching: boolean;
  breachTimer: number;
  breachTarget: { x: number; y: number; z: number } | null;
  lastRadioCallTime: number;
  // Human combat & aiming characteristics
  reactionDelay: number;
  currentTargetKey: string | null;
  consecutiveShots: number;
}

interface Flag {
  team: Team;
  basePos: { x: number; z: number };
  currentPos: THREE.Vector3;
  carrier: { isPlayer: boolean; bot?: Bot; name: string } | null;
  isDropped: boolean;
  dropTimer: number;
  isCaptured: boolean;
  capturedTimer: number;
  mesh: THREE.Group;
  clothMesh: THREE.Mesh;
  light: THREE.PointLight;
}

interface Weapon extends WeaponStats {
  lastFired: number;
  currentAmmo: number;
  isReloading: boolean;
  reloadStartTime: number;
}

/** Per-instance runtime state around the shared authoritative stats. */
function makeWeapon(stats: WeaponStats): Weapon {
  return {
    ...stats,
    damage: { ...stats.damage },
    currentAmmo: stats.magazineSize,
    lastFired: 0,
    isReloading: false,
    reloadStartTime: 0,
  };
}

/** How a moving body travels relative to where it faces. A carrier keeps its
 *  chest on the chaser while its feet run the escape lane, so its legs must not
 *  swing as if it were sprinting forwards or it reads as running backwards. */
type Gait = 'forward' | 'strafe' | 'backpedal';

function gaitFor(travelX: number, travelZ: number, yaw: number): Gait {
  const len = Math.hypot(travelX, travelZ);
  if (len < 1e-4) return 'forward';
  // The model's front is -Z, so its forward vector is (-sin yaw, -cos yaw).
  const forwardness = (travelX * -Math.sin(yaw) + travelZ * -Math.cos(yaw)) / len;
  if (forwardness < -0.35) return 'backpedal';
  if (forwardness < 0.35) return 'strafe';
  return 'forward';
}

const TEAM_COLORS: Record<Team, { body: number; accent: number; legs: number; label: string }> = {
  red: { body: 0xcc2222, accent: 0xff4444, legs: 0x661111, label: 'RED' },
  blue: { body: 0x2244cc, accent: 0x4488ff, legs: 0x112266, label: 'BLUE' },
};

/** One offline bot's vehicle errand: walk to the workshop, build or collect a
 *  jeep, drive it at the enemy base, then hand the field back to the AI. */
interface BotJeepMission {
  phase: 'workshop' | 'board' | 'drive';
  jeepId: string | null;
  startedAt: number;
  lastProgressAt: number;
  lastPos: { x: number; z: number };
  recoveries: number;
  reverseUntil: number;
  /** Route waypoints still to drive, next first; empty asks for a fresh plan. */
  route: { x: number; z: number }[];
  nextRouteAt: number;
  /** Cells a stall proved impassable, keyed like a grid cell (jeepRouteKey). */
  walls: Set<string>;
  /** Look-ahead drive plan, refreshed a few times a second. */
  plannedSteering: number;
  plannedThrottle: number;
  nextPlanAt: number;
}

export class Game {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  world: VoxelWorld;
  player: Player;
  bots: Bot[] = [];
  /** The render loop, stoppable on destroy so a retry cannot leave the old
   *  match running behind the new one. */
  private running = false;
  private animationFrame: number | null = null;
  equipment: EquipmentType = 'rifle';
  inventory: number = 0;
  depositable: number = 0;
  workshops: Workshops | null = null;
  private workshopMeshes: THREE.Group[] = [];
  private jeeps = new Map<string, {
    state: JeepSnapshot; mesh: THREE.Group;
    seats: { driver: THREE.Object3D; passenger: THREE.Object3D };
    charred: boolean;
  }>();
  private drivingJeepId: string | null = null;
  /** The jeep whose second seat this player is riding in, online or offline. */
  private ridingJeepId: string | null = null;
  /** Client-owned vehicles for a local match. A connected server owns jeeps
   *  instead; offline Beta keeps the vehicle roadmap playable on the client with
   *  the same build/board/drive rules the server applies. */
  private localJeeps: JeepSnapshot[] = [];
  /** Local clock when each offline wreck should vanish, keyed `jeep:<id>` or
   *  `build:<id>`. Online wrecks are removed by the server. */
  private localWreckExpiry = new Map<string, number>();
  /** Rising smoke over every wreck currently on the map. */
  private wreckSmoke = new Map<string, WreckSmoke>();
  private localJeepSeq = 0;
  private localJeepSync = 0;
  /** Offline Beta builds and their shells, owned by the client like the jeeps. */
  private localEmplacements: EmplacementSnapshot[] = [];
  private localEmplacementSeq = 0;
  private localEmplacementFireAt = new Map<string, number>();
  private localShells: Array<{
    id: string; kind: 'cannon' | 'mortar'; team: Team; mesh: THREE.Mesh;
    position: THREE.Vector3; velocity: THREE.Vector3; firedAt: number;
  }> = [];
  private localShellSeq = 0;
  /** Bot jeep errands, keyed by bot name, plus a per-team cooldown between them. */
  private botJeepMissions = new Map<string, BotJeepMission>();
  private botJeepTeamReadyAt = new Map<Team, number>();
  /** Seconds of local match time; the only clock the offline errands need. */
  private localTime = 0;

  // ---- Blueprint placement (Phase 4 prototype) ----
  /** What the bench can build into each slot (slot 1..3 = index 0..2). */
  private readonly blueprintCatalogue: EmplacementKind[] = ['mgNest', 'supplyCrate', 'spottingPost'];
  /** Server-owned crafted blueprints. A slot must be filled at the bench before
   *  its ghost can go green; placing consumes it. */
  private craftedSlots: BlueprintSlots = [null, null, null];
  private benchOpen = false;
  private benchMenuOpen = false;
  /** Last craft success/refusal, mirrored into the menu overlay. */
  private benchFeedback = '';
  /** Online pouch rounds, mirrored from the server's own PlayerState. */
  private ammoReserve = 0;
  /** Shell packs carried, mirrored from the server's PlayerState. */
  private shellPacks = 0;
  /** Emplacements the server has broadcast, and the meshes drawn for them. */
  private emplacedSnapshots = new Map<string, EmplacementSnapshot>();
  private emplacementMeshes = new Map<string, THREE.Group>();
  /** World-space health-bar bar+background for each emplacement, hidden when full. */
  private emplacementHealthBars = new Map<string, { bar: THREE.Mesh; bg: THREE.Mesh; material: THREE.MeshBasicMaterial }>();
  /** Brief white flash applied to a build right after it takes a hit. */
  private emplacementFlashes = new Map<string, { until: number; color: THREE.Color }>();
  private mountedEmplacementId: string | null = null;
  /** Gunner zoom while manning a cannon/mortar (right-click). */
  private manningZoom = false;
  private lastEmplacementFire = 0;
  /** Predicted shell path and landing ring for the manned cannon/mortar. */
  private shellPreviewLine: THREE.Line | null = null;
  private shellPreviewMarker: THREE.Mesh | null = null;
  private shellPreviewRadius = 0;
  /** Shells in flight, drawn from the same spawn/velocity/gravity the server
   *  uses so the round you see is the round that lands. */
  private shells = new Map<string, { mesh: THREE.Mesh; spawn: THREE.Vector3; velocity: THREE.Vector3; spawnedAt: number }>();
  private shellBlasts: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; until: number }> = [];
  /** The slot whose crafted blueprint is being placed (5/6/7). */
  private blueprintIndex: number | null = null;
  private ghost: THREE.Group | null = null;
  private ghostMaterial: THREE.MeshStandardMaterial | null = null;
  private ghostPosition: { x: number; y: number; z: number } | null = null;
  private ghostYaw = 0;
  private ghostValid = false;
  private ghostRequestedAt = 0;
  private lastDriveInput = 0;
  private jeepBrake = false;
  lastActionTime: number = 0;
  isMouseDown: boolean = false;
  // Separate per-button state so right-click (build/aim) never triggers the
  // left-click auto-fire loop, and vice versa.
  isLeftDown: boolean = false;
  isRightDown: boolean = false;
  highlightMesh: THREE.Mesh;
  buildPreviewMesh: THREE.Mesh;
  muzzleFlash: THREE.PointLight;
  muzzleTimer: number = 0;
  hitMarkerTimer: number = 0;
  // Feedback layer
  killfeed: KillfeedEntry[] = [];
  private killfeedSeq: number = 0;
  /** Recent damage sources, kept in world space so the HUD arc tracks as you turn. */
  private damageSources: Array<{ x: number; z: number; until: number }> = [];
  /** Latest server spot report (online play) and when it arrived. */
  private spottedContacts: SpotContact[] = [];
  private spotReportAt = 0;
  private pingMs: number = 0;
  private pingTimer: number = 0;
  private spawnProtected: boolean = false;
  message: string = '';
  messageTimer: number = 0;
  blueKills: number = 0;
  redKills: number = 0;
  blueCaptures: number = 0;
  redCaptures: number = 0;
  isSpectating: boolean = false;
  spectatorPos: THREE.Vector3 = new THREE.Vector3(0, 22, -40);
  spectatorTarget: THREE.Vector3 = new THREE.Vector3(0, 5, 0);
  spectatorMode: 'action' | 'free' = 'action';
  spectatorTrackedName: string = 'Midfield Cam';
  spectatorAngle: number = 0;
  spectatorPitch: number = -0.3;
  spectatorSpeed: number = 28;
  spectatorFlyUp: boolean = false;
  spectatorFlyDown: boolean = false;
  spectatorMoveForward: boolean = false;
  spectatorMoveBackward: boolean = false;
  spectatorMoveLeft: boolean = false;
  spectatorMoveRight: boolean = false;
  spectatorTurnLeft: boolean = false;
  spectatorTurnRight: boolean = false;
  spectatorPitchUp: boolean = false;
  spectatorPitchDown: boolean = false;
  spectatorSprint: boolean = false;
  lastManualControlTime: number = 0;
  buildMode: boolean = false;
  clock: THREE.Clock;
  onStateChange: ((state: GameState) => void) | null = null;
  canvas: HTMLCanvasElement;
  playerTeam: Team = 'blue';
  sounds: SoundManager;

  weaponModels: Map<EquipmentType, THREE.Group> = new Map();
  currentWeaponModel: THREE.Group | null = null;
  weaponContainer: THREE.Group;
  localPlayerMesh: THREE.Group | null = null;
  isAiming: boolean = false;
  aimTransition: number = 0;

  hipPosition: THREE.Vector3 = new THREE.Vector3(0.28, -0.28, -0.55);
  adsPosition: THREE.Vector3 = new THREE.Vector3(0, -0.165, -0.42);

  pickaxeAnimationTime: number = 0;
  isPickaxeAnimating: boolean = false;
  pickaxeAnimationDuration: number = 0.3;

  deathAnimations: Map<string, { mesh: THREE.Group; timer: number; startPos: THREE.Vector3 }> = new Map();

  bulletTracers: Array<{
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    life: number;
    maxLife: number;
    hasWhizzed: boolean;
    hasImpacted: boolean;
    targetDistance?: number;
    startPos?: THREE.Vector3;
  }> = [];

  /** Landing bursts, stepped in one pass so a spraying nest cannot spawn a
   *  requestAnimationFrame loop per round. */
  private impactBursts: ImpactBurst[] = [];
  private readonly impactFlashGeometry = new THREE.SphereGeometry(0.26, 6, 4);
  private readonly impactChipGeometry = new THREE.BoxGeometry(0.18, 0.18, 0.18);
  private readonly impactRingGeometry = new THREE.RingGeometry(0.22, 0.5, 14);

  collapseAnimations: Array<{
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    angularVelocity: THREE.Vector3;
    life: number;
    maxLife: number;
  }> = [];

  reloadAnimationTime: number = 0;
  isReloadAnimating: boolean = false;
  reloadAnimationDuration: number = 1.5;

  bulletShells: Array<{
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    rotationSpeed: THREE.Vector3;
    life: number;
    maxLife: number;
    groundBounces?: number;
  }> = [];

  muzzleFlashes: Array<{
    light: THREE.PointLight;
    group: THREE.Group;
    sparks?: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3 }>;
    life: number;
    maxLife: number;
  }> = [];

  captureFireworks: Array<{
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    life: number;
    maxLife: number;
    color: number;
  }> = [];

  radioLog: RadioMessage[] = [];

  blueFlag!: Flag;
  redFlag!: Flag;
  // Server-authoritative flag status (online mode) for rendering sync
  serverBlueFlagAtBase: boolean = true;
  serverRedFlagAtBase: boolean = true;
  serverBlueFlagCarrierId: string | null = null;
  serverRedFlagCarrierId: string | null = null;
  // Which flag team the LOCAL player is currently carrying (online mode).
  // Needed to clear the correct carrier id when we die or score a capture —
  // without it, the stale carrier id keeps the flag "hidden at post" while the
  // server simultaneously marks it dropped/at-base, producing ghost duplicates.
  serverCarriedFlagTeam: 'blue' | 'red' | null = null;
  // True while the LOCAL player carries the enemy flag (online mode). The
  // server does not echo a flagPickedUp event back to the picker, so we set
  // this optimistically on pickup and clear it on capture/death. It is purely
  // for HUD display — all scoring logic stays server-authoritative.
  serverCarryingEnemyFlag: boolean = false;
  captureZoneSize: number = 4;

  gameMode: GameMode = 'multiplayer';
  /** True when launched from Beta Development Mode: rides the same
   *  authoritative server simulation as online mode (workshops, jeeps,
   *  logistics bots) but keeps a distinct label for the HUD. */
  betaLabel: boolean = false;

  networkClient: NetworkClient | null = null;
  private onlineJoinConfirmed = false;
  serverUrl?: string;
  playerName?: string;
  /** Timestamp (ms) of the last client-initiated respawn request — used by the
   *  online safety net so a dropped/raced playerRespawned event can never leave
   *  the player permanently stuck dead at spawn. */
  private lastRespawnRequestTime = 0;
  remotePlayers: Map<string, { mesh: THREE.Group; state: PlayerState; targetPosition: THREE.Vector3; targetRotation: THREE.Euler; lastShootingTime: number; flagMesh?: THREE.Group; damageFlashTimer: number }> = new Map();

  // ---- Tab-held scoreboard state ----
  /** Authoritative (online) or locally tallied (singleplayer) K/D/captures. */
  statsById: Map<string, PlayerStats> = new Map();
  tabHeld = false;
  private lastScoreboardJson = '';
  private cachedScoreboard: ScoreboardData | undefined = undefined;
  private boundBlur: () => void;
  private boundContextMenu: (e: Event) => void;
  localPlayerId: string | null = null;
  /** The seat id local play uses before (or without) a server assignment. */
  private get localPlayerKey(): string {
    return this.localPlayerId ?? 'local-player';
  }
  lastInputSendTime: number = 0;
  inputSendRate: number = 50;

  // ---- Round state (online: the server owns this clock) ----
  /** Set once the server reports rounds, so offline modes keep the old HUD. */
  roundIsServerDriven: boolean = false;
  roundNumber: number = 1;
  roundPhase: RoundPhase = 'live';
  roundTimeLeft: number = DEFAULT_ROUND_MINUTES * 60;
  roundIntermission: number = 0;
  roundDuration: number = DEFAULT_ROUND_MINUTES * 60;
  roundWins: { red: number; blue: number } = { red: 0, blue: 0 };
  roundWinner: RoundWinner | null = null;
  roundWinnerTimer: number = 0;

  private boundResize: () => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  weapons: Record<string, Weapon> = {
    // Gun stats come from the shared table (single source of truth with the
    // server); only the mutable per-instance state is added here.
    rifle: makeWeapon(WEAPONS.rifle),
    smg: makeWeapon(WEAPONS.smg),
    // Tools are not fireable weapons (voxel damage comes from TOOLS); these
    // entries exist only for the ammo/reload UI, so the range fields are
    // neutral.
    spade: {
      fireRate: 0.5, lastFired: 0, damage: { head: 40, body: 25 }, spread: 0,
      name: 'Spade', magazineSize: 0, currentAmmo: 0, reloadTime: 0,
      ammoCost: 0, reserveMagazines: 0,
      fullRange: 0, falloffRange: 0, minMultiplier: 1,
      isReloading: false, reloadStartTime: 0
    },
    pickaxe: {
      fireRate: 0.5, lastFired: 0, damage: { head: 40, body: 25 }, spread: 0,
      name: 'Pickaxe', magazineSize: 0, currentAmmo: 0, reloadTime: 0,
      ammoCost: 0, reserveMagazines: 0,
      fullRange: 0, falloffRange: 0, minMultiplier: 1,
      isReloading: false, reloadStartTime: 0
    },
  };

  constructor(canvas: HTMLCanvasElement, mode: GameMode = 'multiplayer', team: Team = 'blue', serverUrl?: string, playerName?: string) {
    try {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.sounds = new SoundManager();
    // Keep the HUD audio control in sync with the M-key shortcut.
    this.sounds.onSettingsChange(() => this.emitState());
    this.gameMode = mode;
    this.betaLabel = mode === 'beta';
    // Beta rides the server-authoritative path only when a server was named
    // explicitly (`&server=`); otherwise it plays its own bot match. There is
    // no always-on Beta server, so waiting for one just left the page looping.
    if (mode === 'beta') {
      this.gameMode = serverUrl && serverUrl.trim() ? 'online' : 'multiplayer';
    }
    this.playerTeam = team;
    this.serverUrl = serverUrl;
    this.playerName = playerName;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87CEEB);
    // Fog tuned for the enlarged map: distant flag bases stay visible across
    // the longer battlefield (was 60/150, which hid everything past midfield).
    this.scene.fog = new THREE.Fog(0x87CEEB, 120, 400);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    this.scene.add(sun);

    this.world = new VoxelWorld();
    this.scene.add(this.world.mesh);

    this.addTeamZoneMarkers();

    this.player = new Player(this.world);
    this.player.team = team;
    const spawnPos = this.getSafeSpawnPos(team);
    this.player.position.copy(spawnPos);
    this.player.yaw = team === 'blue' ? Math.PI : 0;
    this.player.updateCamera();
    this.player.onRespawn = () => this.handlePlayerRespawn();
    // Online mode: the server owns death & respawn timing. Without this flag
    // the client's local countdown fires onRespawn() right after the server's
    // playerRespawned message, respawning twice ("die immediately" bug).
    this.player.serverAuthoritativeRespawn = this.gameMode === 'online';

    const hlGeo = new THREE.BoxGeometry(VOXEL_SIZE + 0.02, VOXEL_SIZE + 0.02, VOXEL_SIZE + 0.02);
    const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.6 });
    this.highlightMesh = new THREE.Mesh(hlGeo, hlMat);
    this.highlightMesh.visible = false;
    this.scene.add(this.highlightMesh);

    const bpGeo = new THREE.BoxGeometry(VOXEL_SIZE * 0.95, VOXEL_SIZE * 0.95, VOXEL_SIZE * 0.95);
    const bpMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.4 });
    this.buildPreviewMesh = new THREE.Mesh(bpGeo, bpMat);
    this.buildPreviewMesh.visible = false;
    this.scene.add(this.buildPreviewMesh);

    this.muzzleFlash = new THREE.PointLight(0xffaa00, 0, 5);
    this.scene.add(this.muzzleFlash);

    this.weaponContainer = new THREE.Group();
    this.player.camera.add(this.weaponContainer);
    this.scene.add(this.player.camera);

    this.createWeaponModels();
    this.switchWeaponModel('rifle');

    // Create 3D player mesh for third-person rendering when in spectator mode
    const { group: pMesh } = this.createBotMesh(team);
    const pTag = this.createNameTag(team, 'YOU');
    pTag.position.y = 2.6;
    pMesh.add(pTag);
    this.localPlayerMesh = pMesh;
    this.localPlayerMesh.visible = false;
    this.scene.add(this.localPlayerMesh);

    this.createFlags();
    this.createCaptureZones();

    if (this.gameMode === 'multiplayer') this.startLocalMatch();

    if (this.gameMode === 'online') {
      // Server spawns authoritative AI bots in online mode; spawning client-side
      // bots here would create duplicates/ghosts alongside the server ones.
      this.initializeNetwork();
    }
    
    this.boundResize = this.onResize.bind(this);
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundWheel = this.onWheel.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundKeyUp = this.onKeyUp.bind(this);
    // If the window loses focus while Tab is held, keyup never arrives —
    // clear the flag so the scoreboard can't get stuck open.
    this.boundBlur = () => { this.tabHeld = false; if (this.drivingJeepId) { this.player.clearKeys(); this.jeepBrake = false; } };
    this.boundMouseMove = this.onMouseMove.bind(this);
    // Stored (not an inline arrow) so destroy() can remove it; the inline version
    // leaked one listener per game instance.
    this.boundContextMenu = (e) => e.preventDefault();

    window.addEventListener('resize', this.boundResize);
    canvas.addEventListener('mousedown', this.boundMouseDown);
    canvas.addEventListener('mouseup', this.boundMouseUp);
    canvas.addEventListener('wheel', this.boundWheel);
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('blur', this.boundBlur);
    document.addEventListener('mousemove', this.boundMouseMove);
    canvas.addEventListener('contextmenu', this.boundContextMenu);
    } catch (error) {
      console.error('Error in game constructor:', error);
      throw error;
    }
  }

  private addTeamZoneMarkers(): void {
    const blueMarkerGeo = new THREE.PlaneGeometry(100, 60);
    const blueMarkerMat = new THREE.MeshBasicMaterial({ color: 0x2244cc, transparent: true, opacity: 0.05, side: THREE.DoubleSide });
    const blueMarker = new THREE.Mesh(blueMarkerGeo, blueMarkerMat);
    blueMarker.rotation.x = -Math.PI / 2;
    blueMarker.position.set(0, this.world.getOriginalGroundLevel() + 0.02, BLUE_FLAG_POS.z);
    this.scene.add(blueMarker);

    const redMarkerGeo = new THREE.PlaneGeometry(100, 60);
    const redMarkerMat = new THREE.MeshBasicMaterial({ color: 0xcc2222, transparent: true, opacity: 0.05, side: THREE.DoubleSide });
    const redMarker = new THREE.Mesh(redMarkerGeo, redMarkerMat);
    redMarker.rotation.x = -Math.PI / 2;
    redMarker.position.set(0, this.world.getOriginalGroundLevel() + 0.02, RED_FLAG_POS.z);
    this.scene.add(redMarker);

  }


  private renderWorkshops(workshops: Workshops): void {
    for (const group of this.workshopMeshes) {
      this.scene.remove(group);
      group.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => material.dispose());
        }
      });
    }
    this.workshopMeshes = [];
    for (const team of ['blue', 'red'] as const) {
      const { position } = workshops[team];
      const group = new THREE.Group();
      group.position.set(position.x, position.y, position.z);
      const box = (width: number, height: number, depth: number, x: number, y: number, z: number, color: number) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
        mesh.position.set(x, y, z);
        group.add(mesh);
      };
      const color = team === 'blue' ? 0x2859bc : 0xb62e2e;
      box(8, 0.35, 8, 0, 0, 0, 0x555b63);
      box(8, 3.4, 0.7, 0, 1.8, -3.7, color);
      box(0.7, 3.4, 8, -3.7, 1.8, 0, color);
      box(0.7, 3.4, 8, 3.7, 1.8, 0, color);
      box(8, 0.55, 8, 0, 3.7, 0, 0x333c49);
      box(5, 0.8, 0.3, 0, 3, 3.7, 0xf0ca48);
      box(8, 0.18, 8, 11, 0, 0, 0x777c80);
      box(2.3, 1.1, 1.3, 0, 0.7, 0, 0xa27140);
      this.scene.add(group);
      this.workshopMeshes.push(group);
    }
  }

  private applyJeeps(states: JeepSnapshot[]): void {
    const ids = new Set(states.map(state => state.id));
    const localId = this.localPlayerKey;
    for (const [id, jeep] of this.jeeps) {
      if (!ids.has(id)) {
        this.syncWreckSmoke(`jeep:${id}`, null);
        this.scene.remove(jeep.mesh);
        jeep.mesh.traverse(object => {
          if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(material => material.dispose());
          }
        });
        this.jeeps.delete(id);
      }
    }
    for (const state of states) {
      let jeep = this.jeeps.get(state.id);
      if (!jeep) {
        const mesh = new THREE.Group();
        const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) => {
          const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
          part.position.set(x, y, z); mesh.add(part);
        };
        const color = state.team === 'blue' ? 0x335ec4 : 0xb83535;
        box(2, 0.65, 3.4, 0, 0.9, 0, color);
        box(1.8, 0.45, 1.15, 0, 1.42, -1, color);
        box(1.8, 0.4, 0.7, 0, 1.45, 1, color);
        box(1.65, 0.65, 0.12, 0, 1.8, -0.35, 0xaad8ee);
        for (const x of [-1.15, 1.15]) for (const z of [-1.1, 1.1]) box(0.65, 0.85, 0.85, x, 0.5, z, 0x252930);
        box(0.45, 0.25, 0.12, -0.65, 1, -1.76, 0xffdf77);
        box(0.45, 0.25, 0.12, 0.65, 1, -1.76, 0xffdf77);
        // Seated crew: a jeep reads as crewed even though the occupant's own
        // body is hidden inside the vehicle. Team colours, helmet on top.
        const seatFigure = (x: number, z: number) => {
          const seat = new THREE.Group();
          // Raised so the shoulders clear the tub and the rear deck: a crew
          // reads as two bodies, not two helmets behind the bodywork.
          const torso = new THREE.Mesh(
            new THREE.BoxGeometry(0.62, 0.8, 0.42),
            // Lighter than the body paint so a seated crew reads against it.
            new THREE.MeshStandardMaterial({ color: state.team === 'blue' ? 0x5b8ae8 : 0xd9635f, roughness: 0.85 }),
          );
          torso.position.y = 1.8;
          const head = new THREE.Mesh(
            new THREE.BoxGeometry(0.34, 0.34, 0.34),
            new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.9 }),
          );
          head.position.y = 2.36;
          const helmet = new THREE.Mesh(
            new THREE.BoxGeometry(0.4, 0.16, 0.4),
            new THREE.MeshStandardMaterial({ color: state.team === 'blue' ? 0x1d3f86 : 0x7d2424, roughness: 0.75 }),
          );
          helmet.position.y = 2.56;
          seat.add(torso, head, helmet);
          seat.position.set(x, 0, z);
          seat.visible = false;
          mesh.add(seat);
          return seat;
        };
        // Side by side inside the cockpit: behind the windshield (z = -0.35)
        // and in front of the rear deck (z = 0.65), not out on the hood.
        const seats = { driver: seatFigure(-0.45, 0.15), passenger: seatFigure(0.45, 0.15) };
        mesh.position.set(state.position.x, state.position.y, state.position.z);
        mesh.rotation.y = state.yaw;
        this.scene.add(mesh);
        jeep = { state, mesh, seats, charred: false }; this.jeeps.set(state.id, jeep);
      }
      jeep.state = state;
      jeep.seats.driver.visible = showSeatFigure(state.driverId, localId, state.wreck);
      jeep.seats.passenger.visible = showSeatFigure(state.passengerId, localId, state.wreck);
      if (state.wreck) {
        this.syncWreckSmoke(`jeep:${state.id}`, state.position);
        if (!jeep.charred) { jeep.charred = true; this.charMesh(jeep.mesh); }
      }
    }
    const occupied = new Set([...states.map(state => state.driverId), ...states.map(state => state.passengerId)]
      .filter((id): id is string => !!id));
    for (const [id, remote] of this.remotePlayers) remote.mesh.visible = !remote.state.isDead && !occupied.has(id);
    const driving = states.find(state => state.driverId === localId && !state.wreck);
    if (driving && this.drivingJeepId !== driving.id) {
      this.drivingJeepId = driving.id;
      this.player.clearKeys(); this.jeepBrake = false;
      this.isLeftDown = false; this.isRightDown = false;
      this.weaponContainer.visible = false;
    }
    if (!driving && this.drivingJeepId) {
      this.drivingJeepId = null;
      this.player.clearKeys();
      this.weaponContainer.visible = !this.isSpectating;
    }
    const riding = states.find(state => state.passengerId === localId && !state.wreck);
    if (riding && this.ridingJeepId !== riding.id) {
      this.ridingJeepId = riding.id;
      this.player.clearKeys(); this.jeepBrake = false;
      this.isLeftDown = false; this.isRightDown = false;
      // The passenger keeps their weapon: only the driver's hands are on the wheel.
      this.weaponContainer.visible = !this.isSpectating;
    }
    if (!riding && this.ridingJeepId) this.ridingJeepId = null;
  }

  /** Charcoal every painted part of a wreck once, when it is first seen. */
  private charMesh(root: THREE.Object3D): void {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        object.material.color.setHex(WRECK_CHAR_COLOR);
      }
    });
  }

  /** Keep one smoke column per wreck, built at its death position, and drop it
   *  when the server removes the vehicle or build. */
  private syncWreckSmoke(key: string, position: Position | null): void {
    if (position) {
      if (!this.wreckSmoke.has(key)) this.wreckSmoke.set(key, new WreckSmoke(this.scene, position));
      return;
    }
    const existing = this.wreckSmoke.get(key);
    if (!existing) return;
    existing.dispose();
    this.wreckSmoke.delete(key);
  }

  private nearestJeep(): JeepSnapshot | null {
    let closest: JeepSnapshot | null = null;
    let distance = JEEP_ENTER_REACH;
    const localId = this.localPlayerKey;
    for (const { state } of this.jeeps.values()) {
      if (state.team !== this.playerTeam || state.wreck) continue;
      // A driven jeep offers its free second seat; a full one offers nothing.
      if (state.driverId && state.passengerId) continue;
      if (state.driverId === localId || state.passengerId === localId) continue;
      const d = this.player.position.distanceTo(new THREE.Vector3(state.position.x, state.position.y, state.position.z));
      if (d < distance) { distance = d; closest = state; }
    }
    return closest;
  }

  /**
   * Local matches have no server to send a workshop, so Beta builds both sites
   * and the garage pads itself. The terrain under them is levelled exactly like
   * ServerWorld.levelWorkshopSites(), otherwise the pad jeeps spawn on would be
   * a slope and every build would be refused as "blocked".
   */
  private startLocalWorkshops(): void {
    for (const center of Object.values(WORKSHOP_CENTERS)) {
      for (let x = center.x - 5; x <= center.x + 17; x++) {
        for (let z = center.z - 7; z <= center.z + 7; z++) {
          for (let y = GROUND_LEVEL - 1; y <= GROUND_LEVEL + 2; y++) {
            const desired = y < GROUND_LEVEL ? VOXEL_DIRT : y === GROUND_LEVEL ? VOXEL_GRASS : VOXEL_AIR;
            if ((this.world.getVoxel(x, y, z)?.type ?? VOXEL_AIR) === desired) continue;
            this.world.setVoxel(x, y, z, desired, desired === VOXEL_AIR ? 0 : 3);
          }
        }
      }
      // One wide apron exactly one voxel below the pad, rather than a staircase
      // of one-metre terraces: the shared vehicle rule samples a 2m ring, so a
      // single step is drivable in both directions while a second terrace would
      // read as a wall and pen the jeep in. The pad itself is above the apron
      // already, so the height test covers it.
      const apron = 3;
      const apronTop = GROUND_LEVEL - 1;
      for (let x = center.x - 5 - apron; x <= center.x + 17 + apron; x++) {
        for (let z = center.z - 7 - apron; z <= center.z + 7 + apron; z++) {
          const ground = this.world.getGroundHeight(x, z);
          if (ground - 0.5 >= apronTop) continue;
          for (let y = Math.floor(ground) + 1; y <= apronTop; y++) {
            this.world.setVoxel(x, y, z, y === apronTop ? VOXEL_GRASS : VOXEL_DIRT, VOXEL_MAX_DURABILITY);
          }
        }
      }
    }
    const snapshot = (team: Team): WorkshopSnapshot => {
      const center = WORKSHOP_CENTERS[team];
      return {
        position: { x: center.x, y: GROUND_LEVEL + 0.5, z: center.z },
        stock: WORKSHOP_CAPACITY,
        capacity: WORKSHOP_CAPACITY,
      };
    };
    this.workshops = { blue: snapshot('blue'), red: snapshot('red') };
    this.renderWorkshops(this.workshops);
  }

  /** G at the workshop: spend team stock on a jeep on the garage pad. */
  private buildLocalJeep(): void {
    if (!this.workshops || this.player.isDead || this.drivingJeepId) return;
    const workshop = this.workshops[this.playerTeam];
    const spec = vehicleSpec('jeep');
    if (workshop.stock < spec.cost) { this.showMessage('🚙 Not enough workshop blocks'); return; }
    if (this.localJeeps.filter(jeep => jeep.team === this.playerTeam && !jeep.wreck).length >= spec.teamLimit) {
      this.showMessage(`🚙 Team jeep limit reached (${spec.teamLimit})`); return;
    }
    const jeep = this.spawnLocalJeep(this.playerTeam);
    if (!jeep) { this.showMessage('🚙 Garage pad is blocked'); return; }
    this.showMessage(`🚙 Jeep built · -${spec.cost} blocks · press F to board`);
  }

  /** Put a jeep on a team's garage pad, paying from that team's stock. Shared by
   *  the player's G key and the bots' errands so both obey the same rules. */
  private spawnLocalJeep(team: Team): JeepSnapshot | null {
    if (!this.workshops) return null;
    const workshop = this.workshops[team];
    const spec = vehicleSpec('jeep');
    if (workshop.stock < spec.cost) return null;
    if (this.localJeeps.filter(jeep => jeep.team === team && !jeep.wreck).length >= spec.teamLimit) return null;
    const x = workshop.position.x + 11;
    const z = workshop.position.z;
    const yaw = team === 'blue' ? Math.PI : 0;
    const y = this.localJeepGround({ x, y: workshop.position.y, z }, yaw, spec);
    if (y === null || !this.localJeepClear({ x, y, z }, yaw, spec, null)) return null;
    workshop.stock -= spec.cost;
    const jeep: JeepSnapshot = {
      id: `local_jeep_${++this.localJeepSeq}`,
      kind: 'jeep', team, position: { x, y, z }, yaw, speed: 0, hp: spec.maxHp, driverId: null, passengerId: null, wreck: false,
    };
    this.localJeeps.push(jeep);
    this.applyJeeps(this.localJeeps);
    return jeep;
  }

  /** Bodies the shared vehicle rules should account for in local play: every
   *  local jeep, the player's own capsule and each bot's body. */
  private localVehicleBodies(ignoreVehicleId: string | null = null, ignorePlayerId: string | null = null, ignorePlayerIds: string[] = []): ClearanceBodies {
    const ignored = new Set<string>(ignorePlayerIds);
    if (ignorePlayerId) ignored.add(ignorePlayerId);
    const players = [
      { id: this.localPlayerKey, position: this.player.position, isDead: this.player.isDead, isSpectating: this.isSpectating },
      ...this.bots.map(bot => ({ id: bot.name, position: bot.position, isDead: bot.isDead })),
    ].filter(p => !ignored.has(p.id));
    return { vehicles: this.localJeeps, structures: this.localEmplacements, players, ignoreVehicleId, ignorePlayerId: null };
  }

  /** Ground and footprint tests come from the shared vehicle rules, so the
   *  offline jeep is held to exactly what the server enforces online. */
  private localJeepGround(position: Position, yaw: number, spec: Footprint): number | null {
    return vehicleGround(this.world, position, yaw, spec);
  }

  private localJeepClear(position: Position, yaw: number, spec: Footprint, ignoreId: string | null, ignorePlayerId: string | null = null, ignorePlayerIds: string[] = []): boolean {
    return vehicleClear(this.world, position, yaw, spec, this.localVehicleBodies(ignoreId, ignorePlayerId, ignorePlayerIds));
  }

  /** Which seat, if any, the local player holds in a Beta jeep. */
  private localSeat(): { jeep: JeepSnapshot; seat: 'driver' | 'passenger' } | null {
    const id = this.localPlayerKey;
    for (const jeep of this.localJeeps) {
      if (jeep.wreck) continue;
      if (jeep.driverId === id) return { jeep, seat: 'driver' };
      if (jeep.passengerId === id) return { jeep, seat: 'passenger' };
    }
    return null;
  }

  /** The same clearance test without infantry: voxels and other vehicles only,
   *  so a stall can tell a wall it must back away from from a bot that will
   *  simply walk on. */
  private localJeepRockClear(position: Position, yaw: number, spec: Footprint, ignoreId: string | null): boolean {
    return vehicleClear(this.world, position, yaw, spec, {
      vehicles: this.localJeeps, structures: this.localEmplacements, ignoreVehicleId: ignoreId,
    });
  }

  private enterLocalJeep(jeep: JeepSnapshot): void {
    const spec = vehicleSpec(jeep.kind);
    if (jeep.wreck || jeep.team !== this.playerTeam) return;
    if (jeep.driverId && jeep.passengerId) return;
    if (this.localSeat()) return;
    if (this.player.carryingFlag) { this.showMessage('Drop the flag before boarding a jeep'); return; }
    if (Math.hypot(
      this.player.position.x - jeep.position.x,
      this.player.position.y - jeep.position.y,
      this.player.position.z - jeep.position.z,
    ) > spec.enterReach) return;
    const playerId = this.localPlayerKey;
    if (!jeep.driverId) {
      jeep.driverId = playerId;
      jeep.speed = 0;
    } else jeep.passengerId = playerId;
    this.player.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
    this.player.velocity.set(0, 0, 0);
    this.applyJeeps(this.localJeeps);
  }

  /** First safe spot to step out, from the same exit ring the server sweeps. */
  private localJeepExitSpot(jeep: JeepSnapshot, driverId: string | null = jeep.driverId): Position | null {
    return vehicleExitSpot(this.world, jeep, this.localVehicleBodies(jeep.id, driverId));
  }

  private exitLocalJeep(): void {
    const found = this.localSeat();
    if (!found) return;
    const { jeep, seat } = found;
    const spot = this.localJeepExitSpot(jeep);
    if (seat === 'driver') {
      jeep.driverId = null;
      jeep.speed = 0;
      // The bot riding along gets out too: nobody is left in a driverless jeep.
      const passenger = jeep.passengerId ? this.bots.find(bot => bot.name === jeep.passengerId) : undefined;
      jeep.passengerId = null;
      if (passenger) {
        const passengerSpot = this.localJeepExitSpot(jeep, passenger.name);
        passenger.mesh.visible = true;
        if (passengerSpot) passenger.position.set(passengerSpot.x, passengerSpot.y, passengerSpot.z);
        passenger.mesh.position.copy(passenger.position);
      }
    } else jeep.passengerId = null;
    this.drivingJeepId = null;
    this.ridingJeepId = null;
    this.player.clearKeys();
    this.weaponContainer.visible = !this.isSpectating;
    if (spot) this.player.position.set(spot.x, spot.y, spot.z);
    this.player.velocity.set(0, 0, 0);
    this.applyJeeps(this.localJeeps);
  }

  /** One physics step for a local jeep, shared by the player and the bots so
   *  both handle with the server's numbers. */
  private stepLocalJeep(jeep: JeepSnapshot, dt: number, throttle: number, steering: number, brake: boolean): boolean {
    const step = Math.min(dt, 0.05);
    const spec = vehicleSpec(jeep.kind);
    const targetSpeed = brake ? 0 : throttle * (throttle < 0 ? spec.reverseSpeed : spec.topSpeed);
    jeep.speed += Math.max(-spec.acceleration * step, Math.min(spec.acceleration * step, targetSpeed - jeep.speed));
    const turn = steering * Math.min(Math.abs(jeep.speed) / spec.fullTurnSpeed, 1) * (jeep.speed < 0 ? -1 : 1) * spec.turnRate * step;
    const yaw = jeep.yaw + turn;
    const x = jeep.position.x - Math.sin(yaw) * jeep.speed * step;
    const z = jeep.position.z - Math.cos(yaw) * jeep.speed * step;
    const y = this.localJeepGround({ x, y: jeep.position.y, z }, yaw, spec);
    if (y === null || !this.localJeepClear({ x, y, z }, yaw, spec, jeep.id, jeep.driverId, jeep.passengerId ? [jeep.passengerId] : [])) {
      // A wall or a drop stops the jeep instead of letting it slide through.
      // The yaw is only kept with a move that happened, as on the server: turning
      // a blocked jeep swings its long body into whatever is beside it, and that
      // is how a jeep wedged itself against a single block and could never move.
      jeep.speed = 0;
      return false;
    }
    jeep.yaw = yaw;
    jeep.position = { x, y, z };
    return true;
  }

  /** Everything the offline vehicles need each frame: the player's jeep, the
   *  bots' errands, and the mesh sync. */
  private updateLocalVehicles(dt: number): void {
    this.localTime += dt;
    let wreckRemoved = false;
    for (const jeep of [...this.localJeeps]) {
      if (!jeep.wreck) continue;
      const key = `jeep:${jeep.id}`;
      if (this.localTime < (this.localWreckExpiry.get(key) ?? Infinity)) continue;
      this.localJeeps = this.localJeeps.filter(v => v.id !== jeep.id);
      this.localWreckExpiry.delete(key);
      wreckRemoved = true;
    }
    if (wreckRemoved) this.applyJeeps(this.localJeeps);
    const seat = this.localSeat();
    if (seat && seat.seat === 'driver') {
      const jeep = seat.jeep;
      if (this.player.isDead || this.isSpectating) {
        // Dying or spectating at the wheel leaves the jeep parked instead of
        // pinning the respawned player back into it, like the server's exit.
        jeep.driverId = null;
        jeep.speed = 0;
        this.player.clearKeys();
      } else {
        const throttle = (this.player.hasKey('KeyW') ? 1 : 0) - (this.player.hasKey('KeyS') ? 1 : 0);
        const steering = (this.player.hasKey('KeyA') ? 1 : 0) - (this.player.hasKey('KeyD') ? 1 : 0);
        this.stepLocalJeep(jeep, dt, throttle, steering, this.jeepBrake);
        this.player.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
        this.player.velocity.set(0, 0, 0);
      }
    } else if (seat && seat.seat === 'passenger') {
      const jeep = seat.jeep;
      if (this.player.isDead || this.isSpectating) jeep.passengerId = null;
      else {
        this.player.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
        this.player.velocity.set(0, 0, 0);
      }
    }
    this.updateLocalBotPassengers();
    this.localJeepSync += dt;
    if (this.localJeepSync >= 0.1) {
      this.localJeepSync = 0;
      this.assignBotJeepMissions();
      this.applyJeeps(this.localJeeps);
    }
  }

  /** A passing team jeep with a free second seat picks up foot bots, and while
   *  they ride their bodies are pinned to it like the server's passengers. */
  private updateLocalBotPassengers(): void {
    for (const jeep of this.localJeeps) {
      if (jeep.passengerId && !jeep.driverId) { this.releaseLocalBotPassenger(jeep); continue; }
      const passenger = jeep.passengerId ? this.bots.find(bot => bot.name === jeep.passengerId) : undefined;
      if (passenger) {
        if (passenger.isDead || jeep.wreck) { jeep.passengerId = null; passenger.mesh.visible = true; continue; }
        passenger.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
        passenger.mesh.position.copy(passenger.position);
      }
      if (jeep.wreck || !jeep.driverId || jeep.passengerId) continue;
      const spec = vehicleSpec(jeep.kind);
      const rider = this.bots.find(bot => bot.team === jeep.team && !bot.isDead && !bot.carryingFlag &&
        bot.name !== jeep.driverId && !this.localJeeps.some(v => v.passengerId === bot.name || v.driverId === bot.name) &&
        Math.hypot(bot.position.x - jeep.position.x, bot.position.y - jeep.position.y, bot.position.z - jeep.position.z) <= spec.enterReach - 0.4);
      if (rider) {
        jeep.passengerId = rider.name;
        rider.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
        rider.mesh.position.copy(rider.position);
        rider.mesh.visible = false;
      }
    }
  }

  // ---------------- Offline Beta emplacements --------------
  // Online, the bench, the ghost verdict and every build rule live on the
  // server. Beta runs the same loop here: craft at the bench, place the ghost,
  // man the build, fire it, and resupply from a crate.

  /** Per-frame work for offline builds: swing the manned gun with the look
   *  direction inside its arc, and step every shell in the air. */
  private updateLocalEmplacements(dt: number): void {
    let wreckRemoved = false;
    for (const emplacement of [...this.localEmplacements]) {
      if (!emplacement.wreck) continue;
      const key = `build:${emplacement.id}`;
      if (this.localTime < (this.localWreckExpiry.get(key) ?? Infinity)) continue;
      // Its gunner was put out when the build was wrecked; only the husk is left.
      this.localEmplacements = this.localEmplacements.filter(e => e.id !== emplacement.id);
      this.localEmplacementFireAt.delete(emplacement.id);
      this.localWreckExpiry.delete(key);
      wreckRemoved = true;
    }
    if (wreckRemoved) this.applyEmplacements(this.localEmplacements);
    // A seat lasts only as long as the gunner holds it. A bot that dies or is
    // pulled away elsewhere can leave its name on a nest, and because an
    // occupied seat refuses every mount, that nest would stay unmannable for
    // the rest of the round. The player's own seat belongs to the mount block
    // below, not to this sweep.
    for (const emplacement of this.localEmplacements) {
      const gunner = emplacement.gunnerId;
      if (emplacement.wreck || !gunner || gunner === this.localPlayerId) continue;
      const bot = this.bots.find(candidate => candidate.name === gunner);
      if (!bot || bot.isDead || bot.nestId !== emplacement.id) this.clearNestSeat(emplacement);
    }
    if (this.mountedEmplacementId) {
      const nest = this.localEmplacements.find(e => e.id === this.mountedEmplacementId);
      const spec = nest ? emplacementSpec(nest.kind) : undefined;
      if (this.player.isDead || this.isSpectating || !nest || !spec || nest.wreck) {
        this.dismountLocalEmplacement(true);
      } else {
        const half = spec.arc / 2;
        const offset = Math.atan2(Math.sin(this.player.yaw - nest.baseYaw), Math.cos(this.player.yaw - nest.baseYaw));
        const yaw = Math.abs(offset) > half ? nest.baseYaw + Math.sign(offset) * half : this.player.yaw;
        if (Math.abs(yaw - nest.yaw) > 0.01) {
          nest.yaw = yaw;
          this.applyEmplacements(this.localEmplacements);
        }
      }
    }
    this.updateLocalShells(dt);
  }

  /** Place a build offline, judged by the server's rules. The slot's crafted
   *  blueprint is the deployment right; it is spent only on a clean placement. */
  private placeLocalEmplacement(kind: EmplacementKind, position: Position, yaw: number, slot: number): void {
    if (this.player.isDead || this.drivingJeepId) return;
    if (this.craftedSlots[slot] !== kind) { this.showBenchMessage('No blueprint in that slot'); return; }
    const verdict = this.localEmplacementSpot(kind, position, yaw);
    if (!verdict.ok) { this.showBenchMessage(verdict.reason); return; }
    this.craftedSlots[slot] = null;
    const snapshot: EmplacementSnapshot = {
      id: `local_emp_${++this.localEmplacementSeq}`,
      kind,
      team: this.playerTeam,
      position: verdict.spot,
      yaw: verdict.rotation,
      baseYaw: verdict.rotation,
      hp: verdict.spec.maxHp,
      ammo: verdict.spec.ammo,
      stock: 0,
      gunnerId: null,
      wreck: false,
    };
    this.localEmplacements.push(snapshot);
    this.applyEmplacements(this.localEmplacements);
    this.cancelBlueprint();
    this.showMessage(`🏗️ ${kind} placed · slot ${slot + 1} spent`);
  }

  /** Put blocks back into a team's local workshop, capped like the server's
   *  refund so a full stockpile never overflows. Returns what actually fit. */
  private refundLocalWorkshop(team: Team, amount: number): number {
    if (!this.workshops) return 0;
    const workshop = this.workshops[team];
    const refund = Math.min(amount, Math.max(0, workshop.capacity - workshop.stock));
    if (refund <= 0) return 0;
    workshop.stock += refund;
    return refund;
  }

  /** X offline: the server's dismantle, run here. Every rule — own team, in
   *  reach, not a wreck — is already applied by `dismantleCandidate`, the same
   *  test the HUD hint uses, so this only has to pay out and remove. The refund
   *  is the shared one, less the rounds a gun has fired and anything a crate
   *  still holds. */
  private dismantleLocalEmplacement(id: string): void {
    const emplacement = this.localEmplacements.find(e => e.id === id);
    if (!emplacement) return;

    // A crewed build comes down too: the gunner steps out the way a wrecked
    // nest puts them out, so a bot parked on it cannot make it permanent. A
    // bot's body is pinned to the seat while it mans the gun, so it has to be
    // moved beside the build before the build goes, or the crew would be left
    // standing inside thin air where the nest used to be.
    const botGunner = emplacement.gunnerId ? this.bots.find(b => b.name === emplacement.gunnerId) : undefined;
    if (botGunner) this.releaseBotNest(botGunner, true);

    const refund = this.refundLocalWorkshop(
      emplacement.team,
      emplacementDismantleRefund(EMPLACEMENTS[emplacement.kind], emplacement.ammo, emplacement.stock, emplacement.hp),
    );
    this.localEmplacements = this.localEmplacements.filter(e => e.id !== id);
    this.localEmplacementFireAt.delete(id);
    this.applyEmplacements(this.localEmplacements);
    const label = emplacement.kind === 'mgNest' ? 'MG nest' : emplacement.kind;
    this.showMessage(refund > 0 ? `Dismantled ${label} (+${refund} blocks)` : `Dismantled ${label} (workshop full)`);
  }

  /** X offline: the server's scuttle, run here. `dismantleCandidate` has already
   *  applied the rules, so the hull just leaves the map and its full cost goes
   *  back to the workshop, capped like a dismantled build. A bot crew is put out
   *  through the same safe exit a wreck uses, so a bot-driven jeep cannot make
   *  it permanent. */
  private scuttleLocalJeep(id: string): void {
    const jeep = this.localJeeps.find(vehicle => vehicle.id === id);
    if (!jeep) return;
    const refund = this.refundLocalWorkshop(jeep.team, vehicleSpec(jeep.kind).cost);
    // The driver's release puts the passenger out too, and ends the errand so
    // the bot walks back to the fight instead of driving a ghost.
    this.releaseLocalJeepCrew(jeep);
    this.localJeeps = this.localJeeps.filter(vehicle => vehicle.id !== id);
    this.applyJeeps(this.localJeeps);
    this.showMessage(refund > 0 ? `Scuttled jeep (+${refund} blocks)` : 'Scuttled jeep (workshop full)');
  }

  /** The server's spot rules, mirrored: map bounds, base and pad clearance,
   *  solid flat ground, separation from other builds, and the team limit. */
  private localEmplacementSpot(
    kind: EmplacementKind, position: Position, yaw: number, team: Team = this.playerTeam,
  ): { ok: true; spec: EmplacementSpec; spot: Position; rotation: number } | { ok: false; reason: string } {
    const spec = emplacementSpec(kind);
    if (!spec) return { ok: false, reason: 'Unknown blueprint' };
    const extent = Math.hypot(spec.halfWidth, spec.halfLength);
    if (Math.abs(position.x) > WORLD_HALF - extent - 1 || Math.abs(position.z) > WORLD_HALF - extent - 1) {
      return { ok: false, reason: 'Outside the map' };
    }
    const ownFlag = team === 'blue' ? BLUE_FLAG_POS : RED_FLAG_POS;
    const enemyFlag = team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    if (Math.hypot(position.x - enemyFlag.x, position.z - enemyFlag.z) < LOCAL_EMPLACEMENT_ENEMY_BASE_RING) {
      return { ok: false, reason: 'Too close to the enemy base' };
    }
    if (Math.hypot(position.x - ownFlag.x, position.z - ownFlag.z) < LOCAL_EMPLACEMENT_OWN_FLAG_CLEARANCE) {
      return { ok: false, reason: 'Too close to your flag stand' };
    }
    const workshop = this.workshops?.[team].position;
    if (workshop && Math.hypot(position.x - workshop.x, position.z - workshop.z) < LOCAL_EMPLACEMENT_WORKSHOP_CLEARANCE) {
      return { ok: false, reason: 'Keep the workshop pad clear' };
    }

    const rotation = Number.isFinite(yaw) ? yaw : 0;
    const ground = this.world.getGroundHeight(position.x, position.z);
    const spot = { x: position.x, y: ground, z: position.z };
    if (!this.localFootprintClear(spot.x, ground, spot.z, rotation, spec)) return { ok: false, reason: 'Needs flat, clear ground' };

    const padded = { ...spec, halfWidth: spec.halfWidth + LOCAL_EMPLACEMENT_SEPARATION, halfLength: spec.halfLength + LOCAL_EMPLACEMENT_SEPARATION };
    for (const other of this.localEmplacements) {
      if (other.wreck) continue;
      const otherSpec = emplacementSpec(other.kind) ?? spec;
      if (Math.abs(other.position.y - ground) >= (spec.height + otherSpec.height) / 2) continue;
      if (localRectsOverlap(spot.x, spot.z, rotation, padded, other.position.x, other.position.z, other.baseYaw, otherSpec)) {
        return { ok: false, reason: 'Too close to another emplacement' };
      }
    }

    const built = this.localEmplacements.filter(e => !e.wreck && e.team === team && e.kind === kind).length;
    if (built >= spec.teamLimit) return { ok: false, reason: 'Team limit for that build reached' };
    return { ok: true, spec, spot, rotation };
  }

  /** Every corner of the footprint needs level ground and clear air up to the
   *  build's full height, and no jeep may be parked inside it. */
  private localFootprintClear(x: number, y: number, z: number, yaw: number, spec: EmplacementSpec): boolean {
    const forwardX = -Math.sin(yaw), forwardZ = -Math.cos(yaw);
    const rightX = -forwardZ, rightZ = forwardX;
    const samples: Array<[number, number]> = [
      [0, 0], [spec.halfLength, 0], [-spec.halfLength, 0], [0, spec.halfWidth], [0, -spec.halfWidth],
      [spec.halfLength, spec.halfWidth], [spec.halfLength, -spec.halfWidth],
      [-spec.halfLength, spec.halfWidth], [-spec.halfLength, -spec.halfWidth],
    ];
    for (const [forward, side] of samples) {
      const px = x + forwardX * forward + rightX * side;
      const pz = z + forwardZ * forward + rightZ * side;
      if (Math.abs(px) > WORLD_HALF - 1 || Math.abs(pz) > WORLD_HALF - 1) return false;
      const ground = this.world.getGroundHeight(px, pz);
      if (Math.abs(ground - y) > 1) return false;
      for (let up = 0.5; up < spec.height + 0.5; up += 0.5) {
        if (this.world.isSolid(Math.round(px), Math.round(ground + up), Math.round(pz))) return false;
      }
    }
    const radius = Math.hypot(spec.halfWidth, spec.halfLength) + Math.hypot(1.3, 2);
    return !this.localJeeps.some(jeep => !jeep.wreck &&
      Math.abs(jeep.position.y - y) < 2 && Math.hypot(jeep.position.x - x, jeep.position.z - z) < radius);
  }

  /** Craft one blueprint from the bench menu, paying the workshop stock. */
  private craftLocalBlueprint(kind: EmplacementKind, slot: number): void {
    if (this.player.isDead || this.drivingJeepId) { this.showBenchMessage('Cannot craft right now'); return; }
    const spec = emplacementSpec(kind);
    if (!spec) { this.showBenchMessage('That is not a real blueprint'); return; }
    const bench = this.workshops ? benchPosition(this.workshops[this.playerTeam].position) : null;
    if (!bench || this.player.position.distanceTo(new THREE.Vector3(bench.x, bench.y, bench.z)) > BENCH_REACH) {
      this.showBenchMessage('Stand at your blueprint bench to craft');
      return;
    }
    if (this.craftedSlots[slot] !== null) { this.showBenchMessage('That slot already has a blueprint in it'); return; }
    const workshop = this.workshops![this.playerTeam];
    if (workshop.stock < spec.cost) { this.showBenchMessage('Not enough workshop blocks for that build'); return; }
    workshop.stock -= spec.cost;
    this.craftedSlots[slot] = kind;
    this.showBenchMessage(`🔧 Crafted ${kind} into slot ${slot + 1} · -${spec.cost} blocks`);
  }

  /** Climb into one of your own nests offline: reach, team, occupancy and the
   *  flag rule are all checked here, exactly as the server checks them. */
  private mountLocalEmplacement(emplacement: EmplacementSnapshot): void {
    if (emplacement.wreck) return;
    if (!MANNED_EMPLACEMENTS.includes(emplacement.kind)) { this.showMessage('That build cannot be manned'); return; }
    if (emplacement.team !== this.playerTeam) { this.showMessage('That nest belongs to the other team'); return; }
    if (emplacement.gunnerId) { this.showMessage('That nest is already manned'); return; }
    if (this.drivingJeepId) return;
    if (this.player.carryingFlag) { this.showMessage('Drop the flag before manning a nest'); return; }
    if (this.player.position.distanceTo(new THREE.Vector3(emplacement.position.x, emplacement.position.y, emplacement.position.z)) > EMPLACEMENT_MOUNT_REACH) {
      this.showMessage('Walk up to the nest to man it');
      return;
    }
    emplacement.gunnerId = this.localPlayerId;
    emplacement.yaw = emplacement.baseYaw;
    this.player.position.set(emplacement.position.x, emplacement.position.y, emplacement.position.z);
    this.player.velocity.set(0, 0, 0);
    this.player.updateCamera();
    this.mountedEmplacementId = emplacement.id;
    this.cancelBlueprint();
    this.weaponContainer.visible = false;
    this.applyEmplacements(this.localEmplacements);
    const label = emplacement.kind === 'mgNest' ? 'MG nest' : emplacement.kind;
    this.showMessage(`🔫 Manning the ${label} · hold click to fire · F to step out`);
  }

  /** Step out of the nest; a forced exit falls back to the seat itself. */
  private dismountLocalEmplacement(forced = false): void {
    const emplacement = this.localEmplacements.find(e => e.id === this.mountedEmplacementId);
    this.mountedEmplacementId = null;
    this.isLeftDown = false;
    this.weaponContainer.visible = !this.isSpectating;
    if (!emplacement) return;
    emplacement.gunnerId = null;
    emplacement.yaw = emplacement.baseYaw;
    this.localEmplacementFireAt.delete(emplacement.id);
    if (!this.player.isDead) {
      const spot = this.localEmplacementExitSpot(emplacement);
      if (!spot && !forced) { this.showMessage('No clear way out of the nest'); }
      if (spot) {
        this.player.position.set(spot.x, spot.y, spot.z);
        this.player.velocity.set(0, 0, 0);
        this.player.updateCamera();
      }
    }
    this.applyEmplacements(this.localEmplacements);
  }

  /** First ring spot a body fits in, like the server's safeEmplacementExit. */
  private localEmplacementExitSpot(emplacement: EmplacementSnapshot): Position | null {
    const spec = emplacementSpec(emplacement.kind);
    if (!spec) return null;
    const base = Math.hypot(spec.halfWidth, spec.halfLength);
    for (const radius of [base + 1.2, base + 2.2, base + 3.4]) {
      for (let i = 0; i < 8; i++) {
        const angle = emplacement.baseYaw + i * Math.PI / 4;
        const x = emplacement.position.x + Math.cos(angle) * radius;
        const z = emplacement.position.z + Math.sin(angle) * radius;
        if (Math.abs(x) >= WORLD_HALF - 1 || Math.abs(z) >= WORLD_HALF - 1) continue;
        const y = this.world.getGroundHeight(x, z);
        if (Math.abs(y - emplacement.position.y) > 1) continue;
        let clear = true;
        for (const dx of [-0.45, 0.45]) for (const dz of [-0.45, 0.45]) for (const dy of [0.3, 1, 1.8]) {
          if (this.world.isSolid(Math.round(x + dx), Math.round(y + dy), Math.round(z + dz))) clear = false;
        }
        if (!clear) continue;
        if (this.localEmplacements.some(e => e.id !== emplacement.id &&
          Math.abs(e.position.y - y) < 2 && Math.hypot(e.position.x - x, e.position.z - z) < 2)) continue;
        return { x, y, z };
      }
    }
    return null;
  }

  /** The nest a bot is sitting in, if it still exists and the bot still holds it. */
  private botNest(bot: Bot): EmplacementSnapshot | null {
    if (!bot.nestId) return null;
    const nest = this.localEmplacements.find(e => e.id === bot.nestId);
    if (!nest || nest.team !== bot.team || nest.gunnerId !== bot.name) {
      bot.nestId = null;
      return null;
    }
    return nest;
  }

  /** Seat a bot in one of its team's nests: pinned, weapon out, no foot AI. */
  private mountBotNest(bot: Bot, nest: EmplacementSnapshot): void {
    if (nest.gunnerId) return;
    nest.gunnerId = bot.name;
    nest.yaw = nest.baseYaw;
    bot.nestId = nest.id;
    bot.nestIdleTimer = 0;
    bot.position.set(nest.position.x, nest.position.y, nest.position.z);
    bot.lastPos.copy(bot.position);
    bot.velocity.set(0, 0, 0);
    bot.mesh.position.copy(bot.position);
    bot.mesh.rotation.y = nest.yaw;
    bot.targetPos.copy(bot.position);
    if (bot.bodyParts) {
      bot.bodyParts.weaponGroup.visible = true;
      bot.bodyParts.spadeGroup.visible = false;
      bot.bodyParts.blockGroup.visible = false;
    }
    this.updateBotNameTag(bot, '🔫 MANNING MG NEST', '#ffd166');
  }

  /** Free a build's gunner seat, whoever the name on it is. An occupied seat
   *  refuses every mount, so a name that no longer has a body behind it has to
   *  be cleared rather than trusted. */
  private clearNestSeat(nest: EmplacementSnapshot): void {
    nest.gunnerId = null;
    nest.yaw = nest.baseYaw;
    this.localEmplacementFireAt.delete(nest.id);
    const pivot = this.emplacementMeshes.get(nest.id)?.getObjectByName('gunPivot');
    if (pivot) pivot.rotation.y = 0;
  }

  /** Give up a nest seat; a living bot steps out beside the nest. */
  private releaseBotNest(bot: Bot, stepOut: boolean): void {
    const nest = this.localEmplacements.find(e => e.id === bot.nestId && e.gunnerId === bot.name);
    if (nest) {
      this.clearNestSeat(nest);
      if (stepOut && !bot.isDead) {
        const exit = this.localEmplacementExitSpot(nest);
        if (exit) {
          bot.position.set(exit.x, exit.y, exit.z);
          bot.lastPos.copy(bot.position);
          bot.mesh.position.copy(bot.position);
        }
      }
    }
    bot.nestId = null;
    bot.nestIdleTimer = 0;
    bot.nestCooldown = 12;
  }

  /** Nearest enemy a nest can actually shoot: any facing, but inside its arc,
   *  range and with clear line of sight. A turret scans; it does not share the
   *  infantry's narrow field of view. */
  private findNestTarget(nest: EmplacementSnapshot, team: Team): { x: number; y: number; z: number } | null {
    const spec = emplacementSpec(nest.kind);
    if (!spec) return null;
    const origin = new THREE.Vector3(nest.position.x, nest.position.y + 1.15, nest.position.z);
    const candidates: Array<{ x: number; y: number; z: number; distance: number }> = [];
    const consider = (x: number, y: number, z: number) => {
      const dx = x - origin.x, dy = y + 1.0 - origin.y, dz = z - origin.z;
      const flat = Math.hypot(dx, dz);
      if (flat < 1 || flat > spec.maxRange) return;
      const yaw = Math.atan2(-dx, -dz);
      const offset = Math.atan2(Math.sin(yaw - nest.baseYaw), Math.cos(yaw - nest.baseYaw));
      if (Math.abs(offset) > spec.arc / 2) return;
      const len = Math.hypot(dx, dy, dz);
      const hit = this.world.raycast(origin, new THREE.Vector3(dx / len, dy / len, dz / len), len + 0.5);
      if (hit && hit.hit && hit.distance < len - 0.6) return;
      candidates.push({ x, y, z, distance: flat });
    };
    for (const other of this.bots) {
      if (other.isDead || other.team === team) continue;
      consider(other.position.x, other.position.y, other.position.z);
    }
    if (this.playerTeam !== team && !this.player.isDead && !this.isSpectating) {
      consider(this.player.position.x, this.player.position.y, this.player.position.z);
    }
    return candidates.length > 0
      ? candidates.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest)
      : null;
  }

  /** MG post duty for one bot. Returns true when the frame belonged to a nest,
   *  so the infantry AI does not also walk or shoot the body out of the seat. */
  private updateBotNest(bot: Bot, dt: number): boolean {
    bot.nestCooldown = Math.max(0, bot.nestCooldown - dt);
    const nest = this.botNest(bot);
    if (nest) {
      const spec = emplacementSpec(nest.kind);
      if (!spec || nest.ammo <= 0) { this.releaseBotNest(bot, true); return false; }
      // The seat pins the body: no walking, no cover, no voxel building.
      bot.position.set(nest.position.x, nest.position.y, nest.position.z);
      bot.lastPos.copy(bot.position);
      bot.velocity.set(0, 0, 0);
      bot.mesh.position.copy(bot.position);
      bot.isBuilding = false;
      bot.isDigging = false;
      bot.isCrouching = false;

      const enemy = this.findNestTarget(nest, bot.team);
      if (enemy) {
        const dist = Math.hypot(enemy.x - nest.position.x, enemy.z - nest.position.z);
        const yawTo = Math.atan2(-(enemy.x - nest.position.x), -(enemy.z - nest.position.z));
        bot.nestIdleTimer = 0;
        nest.yaw = yawTo;
        bot.mesh.rotation.y = yawTo;
        const pivot = this.emplacementMeshes.get(nest.id)?.getObjectByName('gunPivot');
        if (pivot) pivot.rotation.y = nest.yaw - nest.baseYaw;
        const pitch = Math.max(-EMPLACEMENT_MAX_PITCH, Math.min(EMPLACEMENT_MAX_PITCH,
          Math.atan2(enemy.y + 1.0 - (nest.position.y + 1.15), Math.max(0.1, dist))));
        const last = this.localEmplacementFireAt.get(nest.id);
        if (last === undefined || this.localTime - last >= spec.fireInterval) {
          this.localEmplacementFireAt.set(nest.id, this.localTime);
          nest.ammo -= 1;
          this.fireNestRound(nest, pitch);
          this.applyEmplacements(this.localEmplacements);
        }
      } else {
        // Nothing in the arc: hold the seat a while, then go back to the fight.
        bot.nestIdleTimer += dt;
        if (bot.nestIdleTimer > 20) { this.releaseBotNest(bot, true); return false; }
      }
      return true;
    }

    if (bot.isDead || bot.carryingFlag || bot.nestCooldown > 0) return false;

    // A free friendly nest within a few strides is worth climbing into.
    const free = this.localEmplacements.find(e => !e.wreck && e.kind === 'mgNest' && e.team === bot.team && !e.gunnerId && e.ammo > 0
      && Math.abs(e.position.y - bot.position.y) < 2
      && Math.hypot(e.position.x - bot.position.x, e.position.z - bot.position.z) < 10);
    if (free) { this.mountBotNest(bot, free); return true; }

    // Otherwise a forward bot sets one up on quiet ground. One nest per lane:
    // the team limit and the "nest already near" check keep the map readable.
    if (!this.workshops) return false;
    const enemy = this.findNearestEnemy(bot);
    if (enemy && Math.hypot(enemy.pos.x - bot.position.x, enemy.pos.z - bot.position.z) < 35) return false;
    const ownFlag = bot.team === 'blue' ? BLUE_FLAG_POS : RED_FLAG_POS;
    const enemyFlag = bot.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    // Only on the enemy side of the midpoint: a nest behind your own spawn
    // never sees a fight.
    if (Math.hypot(bot.position.x - enemyFlag.x, bot.position.z - enemyFlag.z)
      > Math.hypot(bot.position.x - ownFlag.x, bot.position.z - ownFlag.z) - 40) return false;
    if (this.localEmplacements.some(e => !e.wreck && e.kind === 'mgNest' && e.team === bot.team
      && Math.hypot(e.position.x - bot.position.x, e.position.z - bot.position.z) < 60)) return false;
    const spec = emplacementSpec('mgNest');
    const workshop = this.workshops[bot.team];
    if (!spec || workshop.stock < spec.cost) { bot.buildCooldown = 8; return false; }
    const yaw = Math.atan2(-(enemyFlag.x - bot.position.x), -(enemyFlag.z - bot.position.z));
    const x = Math.round(bot.position.x), z = Math.round(bot.position.z);
    const verdict = this.localEmplacementSpot('mgNest', { x, y: this.world.getGroundHeight(x, z), z }, yaw, bot.team);
    if (!verdict.ok) { bot.buildCooldown = 4; return false; }
    workshop.stock -= spec.cost;
    const built: EmplacementSnapshot = {
      id: `local_emp_${++this.localEmplacementSeq}`,
      kind: 'mgNest',
      team: bot.team,
      position: verdict.spot,
      yaw: verdict.rotation,
      baseYaw: verdict.rotation,
      hp: spec.maxHp,
      ammo: spec.ammo,
      stock: 0,
      gunnerId: null,
      wreck: false,
    };
    this.localEmplacements.push(built);
    this.applyEmplacements(this.localEmplacements);
    this.mountBotNest(bot, built);
    this.updateBotNameTag(bot, '🏗️ SETTING UP MG NEST', '#ffd166');
    return true;
  }

  /** One round from the manned build. The nest aims itself: yaw comes from the
   *  clamped gun, pitch from the gunner's look, never from a client ray. */
  private fireLocalEmplacement(): void {
    const emplacement = this.localEmplacements.find(e => e.id === this.mountedEmplacementId);
    if (!emplacement || emplacement.wreck || this.player.isDead || this.isSpectating) return;
    const spec = emplacementSpec(emplacement.kind);
    if (!spec || !spec.fireInterval) return;
    if (emplacement.ammo <= 0) { this.showMessage('The nest is out of rounds'); return; }
    const last = this.localEmplacementFireAt.get(emplacement.id);
    if (last !== undefined && this.localTime - last < spec.fireInterval) return;

    const pitch = Math.max(-EMPLACEMENT_MAX_PITCH, Math.min(EMPLACEMENT_MAX_PITCH, this.player.pitch));
    if (emplacement.kind === 'cannon' || emplacement.kind === 'mortar') {
      const aim = emplacement.kind === 'mortar' ? this.shellAimPoint(spec, emplacement.position, emplacement.yaw) : null;
      if (emplacement.kind === 'mortar' && !aim) { this.showMessage('Aim the mortar at the ground ahead'); return; }
      // Offline rounds scatter like the server's: inside the ring, not on its
      // centre tile every shot.
      const impact = aim
        ? mortarImpactPoint(aim, emplacement.position, spec, (x, z) => this.world.getGroundHeight(x, z))
        : null;
      this.localEmplacementFireAt.set(emplacement.id, this.localTime);
      emplacement.ammo -= 1;
      this.fireLocalShell(emplacement, pitch, impact);
      this.applyEmplacements(this.localEmplacements);
      return;
    }

    this.localEmplacementFireAt.set(emplacement.id, this.localTime);
    emplacement.ammo -= 1;
    this.fireNestRound(emplacement, pitch);
    this.applyEmplacements(this.localEmplacements);
  }

  /** One round from a manned MG nest, whoever mans it. The cone, muzzle,
   *  terrain and target rules are shared, so a bot-run nest is the same
   *  weapon balance the player's is. */
  private fireNestRound(emplacement: EmplacementSnapshot, pitch: number): void {
    const spec = emplacementSpec(emplacement.kind);
    if (!spec) return;
    const gunnerIsPlayer = emplacement.gunnerId === this.localPlayerId;
    if (gunnerIsPlayer) {
      this.sounds.rifleShot();
    } else {
      const dist = Math.hypot(emplacement.position.x - this.player.position.x, emplacement.position.z - this.player.position.z);
      const pan = Math.sin(Math.atan2(emplacement.position.x - this.player.position.x, emplacement.position.z - this.player.position.z) - this.player.yaw);
      this.sounds.playDistantShot('rifle', dist, pan);
    }

    // A belt-fed nest hoses an area: every round walks off the aim line, so a
    // burst reads as a spray of tracers and impacts instead of one laser.
    const direction = emplacedShotDirection(emplacement.yaw, pitch);
    const origin = {
      x: emplacement.position.x + direction.x * 0.9,
      y: emplacement.position.y + 1.2,
      z: emplacement.position.z + direction.z * 0.9,
    };
    const muzzle = new THREE.Vector3(origin.x, origin.y, origin.z);
    // Hang the flash on the barrel the player can see, not on the nest centre.
    const gunMesh = this.emplacementMeshes.get(emplacement.id);
    const muzzleMarker = gunMesh?.getObjectByName('emplacementMuzzle');
    if (gunMesh && muzzleMarker) {
      gunMesh.updateMatrixWorld(true);
      muzzleMarker.getWorldPosition(muzzle);
    }
    const rayDir = new THREE.Vector3(direction.x, direction.y, direction.z);
    const terrainHit = this.world.raycast(muzzle, rayDir, spec.maxRange);
    const maxDist = terrainHit ? terrainHit.distance : spec.maxRange;

    type NestTarget =
      | { kind: 'bot'; bot: Bot; distance: number; headshot: boolean }
      | { kind: 'player'; distance: number; headshot: boolean };
    const candidates: NestTarget[] = [];
    const consider = (x: number, y: number, z: number, kind: 'bot' | 'player', bot?: Bot) => {
      for (const [height, headshot] of [[1.55, true], [1.0, false]] as const) {
        const to = { x: x - origin.x, y: y + height - origin.y, z: z - origin.z };
        const along = to.x * direction.x + to.y * direction.y + to.z * direction.z;
        if (along <= 0 || along > maxDist) continue;
        const perp = Math.hypot(to.x - direction.x * along, to.y - direction.y * along, to.z - direction.z * along);
        if (perp > (headshot ? 0.35 : 0.6)) continue;
        candidates.push(kind === 'bot'
          ? { kind, bot: bot as Bot, distance: along, headshot }
          : { kind, distance: along, headshot });
      }
    };
    for (const bot of this.bots) {
      if (bot.isDead || bot.team === emplacement.team) continue;
      consider(bot.position.x, bot.position.y, bot.position.z, 'bot', bot);
    }
    if (this.playerTeam !== emplacement.team && !this.player.isDead && !this.isSpectating) {
      consider(this.player.position.x, this.player.position.y, this.player.position.z, 'player');
    }
    const best = candidates.length > 0
      ? candidates.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest)
      : null;

    // Vehicle bodywork stops a burst, exactly as it does on the server: a nest
    // can wreck a jeep, and the jeep shields whoever is behind it.
    let jeepHit: { jeep: JeepSnapshot; distance: number } | null = null;
    for (const jeep of this.localJeeps) {
      if (jeep.wreck || jeep.team === emplacement.team) continue;
      const to = { x: jeep.position.x - origin.x, y: jeep.position.y + 1 - origin.y, z: jeep.position.z - origin.z };
      const along = to.x * direction.x + to.y * direction.y + to.z * direction.z;
      if (along <= 0 || along > maxDist) continue;
      const perp = Math.hypot(
        to.x - direction.x * along,
        to.y - direction.y * along,
        to.z - direction.z * along,
      );
      if (perp > 1.6) continue;
      if (!jeepHit || along < jeepHit.distance) jeepHit = { jeep, distance: along };
    }
    if (jeepHit && (!best || jeepHit.distance <= best.distance)) {
      this.createMuzzleFlash(muzzle, rayDir);
      this.createBulletTracer(muzzle, rayDir, jeepHit.distance, 300);
      this.damageLocalJeep(jeepHit.jeep, EMPLACEMENT_ROUND_DAMAGE);
      return;
    }

    // Slight terrain damage, mirroring the server: a round that reaches the
    // ground chips the voxel it hit.
    if (!best && terrainHit) {
      const { x, y, z } = terrainHit.voxelPos;
      this.world.damageVoxel(x, y, z, VOXEL_SHOT_DAMAGE);
    }

    const tracerDist = best ? best.distance : maxDist;
    this.createMuzzleFlash(muzzle, rayDir);
    this.createBulletTracer(muzzle, rayDir, tracerDist, 300);
    if (!best) return;
    const impact = muzzle.clone().add(rayDir.clone().multiplyScalar(best.distance));
    this.createImpactSparks(impact);
    const damage = EMPLACEMENT_ROUND_DAMAGE * (best.headshot ? 1.5 : 1);
    if (best.kind === 'bot') {
      this.damageLocalBot(best.bot, damage, best.headshot, { team: emplacement.team, announce: gunnerIsPlayer });
    } else {
      this.damageLocalPlayerFromNest(emplacement, damage, best.headshot);
    }
  }

  /** Cannon rounds fly flat and fast; mortar rounds are solved onto `aim` so
   *  they drop exactly where the landing marker was drawn. */
  private fireLocalShell(emplacement: EmplacementSnapshot, pitch: number, aim: Position | null = null): void {
    const isMortar = emplacement.kind === 'mortar';
    if (isMortar && aim) {
      // Face the shot: a mortar always points at what it is firing at.
      emplacement.yaw = Math.atan2(-(aim.x - emplacement.position.x), -(aim.z - emplacement.position.z));
    }
    const forward = { x: -Math.sin(emplacement.yaw), z: -Math.cos(emplacement.yaw) };
    const speed = isMortar ? MORTAR_SHELL_SPEED : CANNON_SHELL_SPEED;
    const launchPitch = isMortar ? Math.max(pitch, Math.PI / 4) : pitch;
    const cosPitch = Math.cos(launchPitch);
    // Leave from the barrel the player can see. The marker sits on the aiming
    // pivot, so it already carries the build's yaw; the fixed offset is only
    // the fallback for a build whose model is already gone.
    const gunMesh = this.emplacementMeshes.get(emplacement.id);
    const muzzleMarker = gunMesh?.getObjectByName('emplacementMuzzle');
    let position: THREE.Vector3;
    if (gunMesh && muzzleMarker) {
      gunMesh.updateMatrixWorld(true);
      position = muzzleMarker.getWorldPosition(new THREE.Vector3());
    } else {
      const fallback = isMortar ? 1.0 : 1.6;
      position = new THREE.Vector3(
        emplacement.position.x + forward.x * fallback,
        emplacement.position.y + 1.2,
        emplacement.position.z + forward.z * fallback,
      );
    }
    const solved = isMortar && aim
      ? ballisticVelocity(position, aim, MORTAR_SHELL_SPEED, EMPLACEMENT_SHELL_GRAVITY, 'high')
      : null;
    const velocity = solved
      ? new THREE.Vector3(solved.x, solved.y, solved.z)
      : new THREE.Vector3(
        forward.x * speed * cosPitch,
        Math.sin(launchPitch) * speed,
        forward.z * speed * cosPitch,
      );
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(isMortar ? 0.28 : 0.2, 8, 6),
      new THREE.MeshBasicMaterial({ color: isMortar ? 0x2b2b2b : 0x3a3a3a }),
    );
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.localShells.push({
      id: `local_shell_${++this.localShellSeq}`,
      kind: isMortar ? 'mortar' : 'cannon',
      team: emplacement.team,
      mesh,
      position,
      velocity,
      firedAt: this.localTime,
    });
    this.sounds.collapse();
    this.createMuzzleFlash(position, velocity.clone().normalize());
  }

  /** Step the offline shells; damage is resolved in one pass by the module. */
  private updateLocalShells(dt: number): void {
    if (this.localShells.length === 0) return;
    stepOfflineShells(
      this.localShells,
      dt,
      this.world,
      this.shellObstacles(),
      this.localTime,
      { bots: this.bots, jeeps: this.localJeeps, builds: this.localEmplacements },
      {
        damageBot: (bot, damage) => this.damageLocalBot(bot, damage, false),
        damageJeep: (jeep, damage) => this.damageLocalJeep(jeep, damage),
        damageBuild: (build, damage) => this.damageLocalEmplacement(build.id, damage),
        onExplode: (shell, impact, radius) => {
          this.explodeLocalShell(shell, impact, radius);
          this.scene.remove(shell.mesh);
          shell.mesh.geometry.dispose();
          (shell.mesh.material as THREE.Material).dispose();
        },
      },
    );
    // The module owns flight physics, so carry each live round's mesh along
    // with its position for this frame.
    for (const shell of this.localShells) {
      shell.mesh.position.set(shell.position.x, shell.position.y, shell.position.z);
    }
  }

  /** Blast visuals and the terrain crater. Victim damage was already resolved
   *  by `stepOfflineShells`; this path must never damage a body as well. */
  private explodeLocalShell(shell: { kind: 'cannon' | 'mortar'; velocity: Position }, impact: Position, radius: number): void {
    const material = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.6, 12, 8), material);
    mesh.position.set(impact.x, impact.y, impact.z);
    this.scene.add(mesh);
    this.shellBlasts.push({ mesh, material, until: performance.now() / 1000 + 0.35 });
    this.sounds.collapse();
    // The same distance-driven crater the server carves, so an offline round
    // digs the hole the online one would and future explosives only have to
    // call the shared helper.
    const power = shell.kind === 'mortar' ? MORTAR_BLAST_DAMAGE : CANNON_BLAST_DAMAGE;
    for (const { x, y, z, damage } of blastVoxelHits(impact, radius, power, (vx, vy, vz) => this.world.isSolid(vx, vy, vz), shell.velocity)) {
      this.world.damageVoxel(x, y, z, damage);
    }
  }

  /** Start a wreck's three-minute clock at the moment it is destroyed, not when
   *  the next vehicle tick first notices it. */
  private markLocalJeepWreck(jeep: JeepSnapshot): void {
    this.localWreckExpiry.set(`jeep:${jeep.id}`, this.localTime + WRECK_LIFETIME_SECONDS);
  }

  /** Put a bot crew back on its feet and end its errand. The local player's seat
   *  is the caller's business: it owns the camera and weapon visibility. */
  private releaseLocalJeepCrew(jeep: JeepSnapshot): void {
    const driver = jeep.driverId ? this.bots.find(bot => bot.name === jeep.driverId) : undefined;
    if (driver) this.abandonBotJeepMission(driver);
    this.releaseLocalBotPassenger(jeep);
  }

  /** Damage a client-owned jeep. At zero HP it wrecks and puts its crew out. */
  private damageLocalJeep(jeep: JeepSnapshot, damage: number): void {
    if (jeep.wreck || !(damage > 0)) return;
    // Vehicles keep whole HP, so a fractional hit is rounded once here.
    jeep.hp = Math.max(0, jeep.hp - Math.max(1, Math.round(damage)));
    if (jeep.hp > 0) { this.applyJeeps(this.localJeeps); return; }

    jeep.wreck = true;
    jeep.speed = 0;
    this.markLocalJeepWreck(jeep);
    // Before the seats are cleared: a riding bot is hidden, so releasing it is
    // the only way its body comes back and its errand ends.
    this.releaseLocalJeepCrew(jeep);
    if (this.drivingJeepId === jeep.id) {
      this.drivingJeepId = null;
      this.player.clearKeys();
      this.weaponContainer.visible = !this.isSpectating;
    }
    if (this.ridingJeepId === jeep.id) {
      this.ridingJeepId = null;
      this.weaponContainer.visible = !this.isSpectating;
    }
    jeep.driverId = null;
    jeep.passengerId = null;
    this.showMessage(`💥 ${jeep.team === 'blue' ? 'Blue' : 'Red'} jeep destroyed!`);
    this.sounds.collapse();
    this.applyJeeps(this.localJeeps);
  }

  /** Damage a build offline; a wrecked one takes its gunner down with it. */
  private damageLocalEmplacement(id: string, damage: number): void {
    const emplacement = this.localEmplacements.find(e => e.id === id);
    if (!emplacement || emplacement.wreck) return;
    const spec = emplacementSpec(emplacement.kind);
    if (!spec || !(damage > 0)) return;
    // Builds keep whole HP, so a fractional hit is rounded once here.
    emplacement.hp = Math.max(0, emplacement.hp - Math.max(1, Math.round(damage)));
    const snapshot = this.emplacedSnapshots.get(id);
    if (snapshot) snapshot.hp = emplacement.hp;
    this.updateHealthBarVisibility(id, emplacement.hp, spec.maxHp);
    this.emplacementFlashes.set(id, { until: performance.now() + 180, color: new THREE.Color(0xffffff) });
    if (emplacement.hp > 0) return;
    if (this.mountedEmplacementId === id) this.dismountLocalEmplacement(true);
    const botGunner = emplacement.gunnerId ? this.bots.find(b => b.name === emplacement.gunnerId) : undefined;
    if (botGunner) { botGunner.nestId = null; botGunner.nestIdleTimer = 0; botGunner.nestCooldown = 8; }
    emplacement.wreck = true;
    emplacement.gunnerId = null;
    emplacement.ammo = 0;
    emplacement.stock = 0;
    this.localEmplacementFireAt.delete(id);
    this.localWreckExpiry.set(`build:${id}`, this.localTime + WRECK_LIFETIME_SECONDS);
    this.applyEmplacements(this.localEmplacements);
    this.showMessage(`💥 Your ${emplacement.kind} was destroyed — it is smoking out`);
  }

  /** Shots from a build land like player shots: hp, flinch, hit marker, and the
   *  scoring team's kill counter plus the flag drop when the target goes down.
   *  A bot-manned nest passes its own team and silences the player's HUD cue. */
  private damageLocalBot(
    bot: Bot, damage: number, headshot: boolean,
    credit: { team: Team; announce: boolean } = { team: this.playerTeam, announce: true },
  ): void {
    if (bot.isDead) return;
    bot.hp -= damage;
    bot.lastDamageTime = Date.now();
    bot.flinchTimer = 0.22;
    if (credit.announce) {
      this.hitMarkerTimer = 0.25;
      this.sounds.hitMarker();
      if (headshot) this.sounds.headshot();
    }
    if (bot.hp > 0) {
      this.updateBotNameTag(bot, bot.hp < 30 ? '🏃 TACTICAL RETREAT' : '⚡ UNDER HOSTILE ATTACK!', '#ff4444');
      return;
    }
    bot.isDead = true;
    if (bot.nestId) this.releaseBotNest(bot, false);
    bot.mesh.visible = false;
    bot.respawnTimer = 4;
    if (bot.carryingFlag) {
      const carried = bot.team === 'blue' ? this.redFlag : this.blueFlag;
      if (carried) {
        carried.carrier = null;
        carried.isDropped = true;
        carried.dropTimer = 30;
        const dropY = this.world.getGroundHeight(bot.position.x, bot.position.z);
        carried.currentPos.set(bot.position.x, dropY, bot.position.z);
        carried.mesh.position.copy(carried.currentPos);
        carried.mesh.visible = true;
        this.showMessage(`🚩 ${carried.team.toUpperCase()} flag was dropped by ${bot.name}!`);
      }
      bot.carryingFlag = false;
    }
    if (credit.team === 'blue') this.blueKills++; else this.redKills++;
    if (credit.announce) {
      this.sounds.killSound();
      this.showMessage(`🎯 Your emplacement killed ${bot.name}${headshot ? ' (HEADSHOT!)' : ''}`);
    }
  }

  /** A nest round that found the local player. Same damage, shake and death
   *  bookkeeping a bot's rifle uses, credited to the nest's team. */
  private damageLocalPlayerFromNest(nest: EmplacementSnapshot, damage: number, headshot: boolean): void {
    this.player.takeDamage(damage);
    this.player.addCameraShake(headshot ? 0.32 : 0.18);
    this.sounds.hurt();
    if (!this.player.isDead) {
      if (headshot) this.showMessage('💥 MG nest headshot!');
      return;
    }
    if (this.player.carryingFlag) {
      const enemyF = this.playerTeam === 'blue' ? this.redFlag : this.blueFlag;
      if (enemyF) {
        enemyF.carrier = null;
        enemyF.isDropped = true;
        enemyF.dropTimer = 30;
        const dropY = this.world.getGroundHeight(this.player.position.x, this.player.position.z);
        enemyF.currentPos.set(this.player.position.x, dropY, this.player.position.z);
        enemyF.mesh.position.copy(enemyF.currentPos);
        enemyF.mesh.visible = true;
        this.showMessage(`🚩 ${enemyF.team.toUpperCase()} flag was dropped!`);
      }
      this.player.carryingFlag = false;
    }
    if (nest.team === 'blue') this.blueKills++; else this.redKills++;
    this.sounds.killSound();
    this.showMessage(`☠️ A ${nest.team} MG nest eliminated you!`);
  }

  /** G/E at a forward crate offline: blocks in so a squad can resupply away
   *  from the pad, or back out into the player's build inventory. */
  private useLocalSupplyCrate(crate: EmplacementSnapshot, action: 'deposit' | 'draw'): void {
    if (this.player.isDead) return;
    if (this.player.position.distanceTo(new THREE.Vector3(crate.position.x, crate.position.y, crate.position.z)) > EMPLACEMENT_USE_REACH) {
      this.showMessage('Walk up to the crate to use it');
      return;
    }
    if (action === 'deposit') {
      const amount = Math.min(this.inventory, SUPPLY_CRATE_CAPACITY - crate.stock);
      if (amount <= 0) { this.showMessage(crate.stock >= SUPPLY_CRATE_CAPACITY ? 'The crate is full' : 'Mine blocks to fill the crate'); return; }
      crate.stock += amount;
      this.inventory -= amount;
      this.showMessage(`📦 Stored ${amount} blocks · crate ${crate.stock}/${SUPPLY_CRATE_CAPACITY}`);
    } else {
      if (crate.stock <= 0) { this.showMessage('The crate is empty'); return; }
      const amount = Math.min(SUPPLY_CRATE_DRAW, crate.stock);
      crate.stock -= amount;
      this.inventory += amount;
      this.showMessage(`📦 Drew ${amount} blocks · carrying ${this.inventory}`);
    }
    this.applyEmplacements(this.localEmplacements);
  }

  /** Pick one bot per team to run a jeep errand. It is a demo of the vehicle
   *  roadmap, so the errands repeat on a cooldown rather than once. */
  private assignBotJeepMissions(): void {
    if (!this.betaLabel || !this.workshops) return;
    for (const team of ['blue', 'red'] as const) {
      const drivers = [...this.botJeepMissions.keys()].filter(name => this.bots.find(bot => bot.name === name)?.team === team).length;
      if (drivers >= BOT_JEEP_MAX_DRIVERS_PER_TEAM) continue;
      if (this.localTime < (this.botJeepTeamReadyAt.get(team) ?? 0)) continue;
      const workshop = this.workshops[team].position;
      // A driverless jeep near the shop is fair game, unless the player is
      // standing at it: their build should not be taken out from under them.
      const waiting = this.localJeeps.find(jeep => jeep.team === team && !jeep.wreck && !jeep.driverId &&
        Math.hypot(jeep.position.x - workshop.x, jeep.position.z - workshop.z) <= 30 &&
        Math.hypot(jeep.position.x - this.player.position.x, jeep.position.z - this.player.position.z) > 12);
      const spec = vehicleSpec('jeep');
      const live = this.localJeeps.filter(jeep => jeep.team === team && !jeep.wreck).length;
      if (!waiting && (this.workshops[team].stock < spec.cost || live >= spec.teamLimit)) continue;
      const candidates = this.bots.filter(bot => bot.team === team && !bot.isDead && !bot.carryingFlag &&
        !this.botJeepMissions.has(bot.name) && Math.hypot(bot.position.x - workshop.x, bot.position.z - workshop.z) < 140);
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => Math.hypot(a.position.x - workshop.x, a.position.z - workshop.z) -
        Math.hypot(b.position.x - workshop.x, b.position.z - workshop.z));
      const bot = candidates[0];
      this.botJeepMissions.set(bot.name, {
        phase: waiting ? 'board' : 'workshop',
        jeepId: waiting ? waiting.id : null,
        startedAt: this.localTime, lastProgressAt: this.localTime,
        lastPos: { x: bot.position.x, z: bot.position.z }, recoveries: 0, reverseUntil: 0,
        route: [], nextRouteAt: 0, walls: new Set(),
        plannedSteering: 0, plannedThrottle: 1, nextPlanAt: 0,
      });
      this.updateBotNameTag(bot, '🚙 JEEP DETAIL', '#fbbf24');
    }
  }

  /** March a bot toward a point, stepping over one voxel and sliding around a
   *  wall. Returns false when both the direct and the slide line are blocked. */
  private walkBotToward(bot: Bot, tx: number, tz: number, speed: number, dt: number): boolean {
    const dx = tx - bot.position.x, dz = tz - bot.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.05) return true;
    const step = Math.min(distance, speed * dt);
    let nx = bot.position.x + (dx / distance) * step;
    let nz = bot.position.z + (dz / distance) * step;
    let ground = this.world.getGroundHeight(nx, nz);
    if (ground - bot.position.y > 1.2) {
      const side = Math.sin(this.localTime + bot.laneOffset) > 0 ? 1 : -1;
      nx = bot.position.x + (-dz / distance) * step * side;
      nz = bot.position.z + (dx / distance) * step * side;
      ground = this.world.getGroundHeight(nx, nz);
      if (ground - bot.position.y > 1.2) return false;
    }
    bot.position.set(nx, ground, nz);
    bot.mesh.position.copy(bot.position);
    bot.mesh.rotation.y = Math.atan2(-dx, -dz);
    return true;
  }

  /** Walk to the workshop, build, board, then drive at the enemy flag stand. */
  private updateBotJeepMission(bot: Bot, mission: BotJeepMission, dt: number): void {
    const spec = vehicleSpec('jeep');
    const workshop = this.workshops?.[bot.team].position;
    if (!workshop) { this.abandonBotJeepMission(bot); return; }

    if (mission.phase !== 'drive') {
      if (this.localTime - mission.startedAt > BOT_JEEP_APPROACH_SECONDS) { this.abandonBotJeepMission(bot); return; }
      let jeep = mission.jeepId ? this.localJeeps.find(vehicle => vehicle.id === mission.jeepId) : undefined;
      if (mission.phase === 'workshop') {
        if (Math.hypot(bot.position.x - workshop.x, bot.position.z - workshop.z) > WORKSHOP_REACH - 1.5) {
          this.walkBotToward(bot, workshop.x, workshop.z, 6.2, dt);
          return;
        }
        jeep = this.spawnLocalJeep(bot.team) ?? undefined;
        if (!jeep) { this.abandonBotJeepMission(bot); return; }
        mission.jeepId = jeep.id;
        mission.phase = 'board';
      }
      if (!jeep || jeep.wreck || jeep.driverId) { this.abandonBotJeepMission(bot); return; }
      if (Math.hypot(bot.position.x - jeep.position.x, bot.position.z - jeep.position.z) > spec.enterReach - 0.4) {
        this.walkBotToward(bot, jeep.position.x, jeep.position.z, 6.2, dt);
        return;
      }
      // Board: the bot rides in the jeep, so its body mesh goes with it.
      jeep.driverId = bot.name;
      jeep.speed = 0;
      bot.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
      bot.mesh.position.copy(bot.position);
      bot.mesh.visible = false;
      mission.phase = 'drive';
      mission.lastPos = { x: jeep.position.x, z: jeep.position.z };
      mission.lastProgressAt = this.localTime;
      this.applyJeeps(this.localJeeps);
      return;
    }

    const jeep = mission.jeepId ? this.localJeeps.find(vehicle => vehicle.id === mission.jeepId) : undefined;
    if (!jeep || jeep.wreck || jeep.driverId !== bot.name) { this.abandonBotJeepMission(bot); return; }
    const enemyFlag = bot.team === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    // Aim at a lane beside the flag, not the flag itself: head-on opposing
    // errands used to meet on the centre line, block each other, and both give
    // up half way across the map.
    const lane = bot.team === 'blue' ? 35 : -35;
    const destination = { x: enemyFlag.x + lane, z: enemyFlag.z };
    const flagDistance = Math.hypot(jeep.position.x - enemyFlag.x, jeep.position.z - enemyFlag.z);
    if (flagDistance <= BOT_JEEP_ARRIVE_RADIUS || this.localTime - mission.startedAt > BOT_JEEP_DRIVE_SECONDS) {
      this.exitBotJeep(bot, jeep);
      return;
    }
    // A straight line at the flag runs into whatever the bots have built, so
    // the jeep follows a route through cells it fits in. A stall marks the cell
    // ahead as walled off and the next plan routes around it.
    if (!mission.route.length && this.localTime >= mission.nextRouteAt) {
      mission.nextRouteAt = this.localTime + 4;
      const route = this.planJeepRoute(jeep.position, destination, mission.walls);
      if (route) mission.route = route;
    }
    while (mission.route.length > 0 &&
      Math.hypot(mission.route[0].x - jeep.position.x, mission.route[0].z - jeep.position.z) < JEEP_ROUTE_STEP) {
      mission.route.shift();
    }
    // Steer a little way down the route: a waypoint 4m away gives the arc
    // planner no gradient to choose between arcs.
    let target: { x: number; z: number } = destination;
    for (const point of mission.route) {
      if (Math.hypot(point.x - jeep.position.x, point.z - jeep.position.z) > 14) break;
      target = point;
    }
    // No progress for two seconds means a wall, a trench or another jeep: back
    // off and route again, and hand the jeep back after a few failed tries.
    if (this.localTime >= mission.reverseUntil && this.localTime - mission.lastProgressAt >= 2) {
      const moved = Math.hypot(jeep.position.x - mission.lastPos.x, jeep.position.z - mission.lastPos.z);
      mission.lastPos = { x: jeep.position.x, z: jeep.position.z };
      mission.lastProgressAt = this.localTime;
      if (moved < 1.5) {
        // A pedestrian in the way is temporary: reversing for one turns a
        // two-second wait into an eight-second recovery, and the field is full
        // of walking bots. Only a wall, a trench or another vehicle counts as
        // a stall worth backing out of.
        const stepX = jeep.position.x - Math.sin(jeep.yaw) * 1.6;
        const stepZ = jeep.position.z - Math.cos(jeep.yaw) * 1.6;
        const stepGround = this.localJeepGround({ x: stepX, y: jeep.position.y, z: stepZ }, jeep.yaw, spec);
        const blockedByRock = stepGround === null ||
          !this.localJeepRockClear({ x: stepX, y: stepGround, z: stepZ }, jeep.yaw, spec, jeep.id);
        const stalledOnCrowd = !blockedByRock && this.bots.some(other => !other.isDead && other.name !== bot.name &&
          Math.hypot(other.position.x - jeep.position.x, other.position.z - jeep.position.z) < 3.5);
        if (!stalledOnCrowd) {
          mission.recoveries++;
          if (mission.recoveries > 6) { this.exitBotJeep(bot, jeep); return; }
          // Remember the cell as walled off for this errand, back off, and plan
          // a fresh route from wherever the jeep ends up.
          mission.walls.add(this.jeepRouteKey(stepX, stepZ));
          mission.route.length = 0;
          mission.nextRouteAt = 0;
          mission.reverseUntil = this.localTime + 1.4;
        }
      }
    }
    if (this.localTime < mission.reverseUntil) {
      this.stepLocalJeep(jeep, dt, -1, mission.recoveries % 2 ? 1 : -1, false);
    } else {
      if (this.localTime >= mission.nextPlanAt) {
        const plan = this.planBotJeepDrive(jeep, target);
        mission.plannedSteering = plan.steering;
        mission.plannedThrottle = plan.throttle;
        mission.nextPlanAt = this.localTime + 0.25;
      }
      this.stepLocalJeep(jeep, dt, mission.plannedThrottle, mission.plannedSteering, false);
    }
    bot.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
  }

  /** Cell key for the errand route grid. */
  private jeepRouteKey(x: number, z: number): string {
    return `${Math.round(x / JEEP_ROUTE_STEP)},${Math.round(z / JEEP_ROUTE_STEP)}`;
  }

  /** Whether a jeep fits in a route cell. The tested square covers the cell edge
   *  to edge, so a thin wall between two cell centres cannot slip through a gap
   *  between cells that both look clear. */
  private jeepRouteCellOpen(x: number, z: number): boolean {
    const half = JEEP_ROUTE_STEP / 2;
    const square = { halfWidth: half, halfLength: half, height: vehicleSpec('jeep').height };
    const at = { x, y: this.world.getGroundHeight(x, z), z };
    const y = this.localJeepGround(at, 0, square);
    if (y === null) return false;
    return vehicleClear(this.world, { x, y, z }, 0, square);
  }

  /** Shortest chain of route cells from a jeep to a point: A* on an 8-way grid
   *  where a cell counts only if the jeep fits in it. Cells this errand was
   *  already stopped by count as walls, so a second try goes around the
   *  fortification instead of into it. Null when there is no way through, and
   *  the caller steers straight at the target as a fallback. */
  private planJeepRoute(
    from: Position, to: { x: number; z: number }, walls: Set<string>,
  ): { x: number; z: number }[] | null {
    const step = JEEP_ROUTE_STEP;
    const key = (x: number, z: number): string => `${x},${z}`;
    const startX = Math.round(from.x / step), startZ = Math.round(from.z / step);
    const startKey = key(startX, startZ);
    const cells = new Map<string, boolean>();
    const open = (x: number, z: number): boolean => {
      if (walls.has(key(x, z))) return false;
      if (Math.abs(x * step) >= WORLD_HALF - step || Math.abs(z * step) >= WORLD_HALF - step) return false;
      let known = cells.get(key(x, z));
      if (known === undefined) {
        known = this.jeepRouteCellOpen(x * step, z * step);
        cells.set(key(x, z), known);
      }
      return known;
    };
    // The lane point can itself be built over; end the route at the nearest cell
    // the jeep fits in instead.
    const goalX = Math.round(to.x / step), goalZ = Math.round(to.z / step);
    let goal: [number, number] | null = null;
    for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      if (open(goalX + ox, goalZ + oz)) { goal = [goalX + ox, goalZ + oz]; break; }
    }
    if (!goal) return null;
    const [endX, endZ] = goal;
    const estimate = (x: number, z: number): number => {
      const dx = Math.abs(x - endX), dz = Math.abs(z - endZ);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    };
    /** Per-metre cost of driving where the two teams meet. */
    const danger = (x: number): number => Math.max(0, JEEP_ROUTE_DANGER - Math.abs(x)) * 0.06;
    const cameFrom = new Map<string, string>();
    const cost = new Map<string, number>([[startKey, 0]]);
    const frontier: Array<{ x: number; z: number; f: number }> = [{ x: startX, z: startZ, f: estimate(startX, startZ) }];
    let reached = false;
    for (let expanded = 0; expanded < JEEP_ROUTE_BUDGET && frontier.length > 0; expanded++) {
      // A linear scan of a short frontier is cheaper to read than a heap.
      let bestIndex = 0;
      for (let i = 1; i < frontier.length; i++) if (frontier[i].f < frontier[bestIndex].f) bestIndex = i;
      const node = frontier.splice(bestIndex, 1)[0];
      const nodeKey = key(node.x, node.z);
      if (nodeKey === key(endX, endZ)) { reached = true; break; }
      const spent = cost.get(nodeKey) ?? 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = node.x + dx, nz = node.z + dz;
        const nextKey = key(nx, nz);
        if (nextKey !== startKey && !open(nx, nz)) continue;
        const nextCost = spent + (dx !== 0 && dz !== 0 ? 1.414 : 1) + danger(nx * step);
        const known = cost.get(nextKey);
        if (known !== undefined && known <= nextCost) continue;
        cost.set(nextKey, nextCost);
        cameFrom.set(nextKey, nodeKey);
        frontier.push({ x: nx, z: nz, f: nextCost + estimate(nx, nz) });
      }
    }
    if (!reached) return null;
    const route: { x: number; z: number }[] = [];
    let at: string | undefined = key(endX, endZ);
    while (at && at !== startKey) {
      const [x, z] = at.split(',').map(Number);
      route.push({ x: x * step, z: z * step });
      at = cameFrom.get(at);
    }
    return route.reverse();
  }

  /** Look ahead along a few steering arcs using the same clearance rules the jeep
   *  drives with, and take the arc that ends up furthest toward the target. This
   *  is what gets a bot around a trench, a wall or a parked jeep instead of
   *  grinding into it until the errand is abandoned. */
  private planBotJeepDrive(jeep: JeepSnapshot, target: { x: number; z: number }): { steering: number; throttle: number } {
    const spec = vehicleSpec(jeep.kind);
    const step = 0.05;
    const initial = Math.hypot(target.x - jeep.position.x, target.z - jeep.position.z);
    let bestScore = -Infinity;
    let best = { steering: 0, throttle: 1 };
    for (const steering of [0, -0.5, 0.5, -1, 1]) {
      for (const throttle of [1, 0.45]) {
        let x = jeep.position.x, y = jeep.position.y, z = jeep.position.z, yaw = jeep.yaw, speed = jeep.speed;
        let travelled = 0, blocked = false;
        for (let i = 0; i < 40; i++) {
          const targetSpeed = throttle * spec.topSpeed;
          speed += Math.max(-spec.acceleration * step, Math.min(spec.acceleration * step, targetSpeed - speed));
          yaw += steering * Math.min(Math.abs(speed) / spec.fullTurnSpeed, 1) * spec.turnRate * step;
          const nx = x - Math.sin(yaw) * speed * step;
          const nz = z - Math.cos(yaw) * speed * step;
          const ny = this.localJeepGround({ x: nx, y, z: nz }, yaw, spec);
          if (ny === null || !this.localJeepClear({ x: nx, y: ny, z: nz }, yaw, spec, jeep.id, jeep.driverId, jeep.passengerId ? [jeep.passengerId] : [])) { blocked = true; break; }
          travelled += Math.hypot(nx - x, nz - z);
          x = nx; y = ny; z = nz;
        }
        const progress = initial - Math.hypot(target.x - x, target.z - z);
        const score = progress + travelled * 0.1 - (blocked ? 8 : 0) - Math.abs(steering) * 0.2;
        if (score > bestScore) { bestScore = score; best = { steering, throttle }; }
      }
    }
    return best;
  }

  /** Put a bot passenger back on its feet beside the jeep. */
  private releaseLocalBotPassenger(jeep: JeepSnapshot): void {
    const id = jeep.passengerId;
    if (!id) return;
    jeep.passengerId = null;
    const passenger = this.bots.find(bot => bot.name === id);
    if (!passenger) return;
    passenger.mesh.visible = true;
    if (passenger.isDead) return;
    const spot = this.localJeepExitSpot(jeep, id);
    if (spot) passenger.position.set(spot.x, spot.y, spot.z);
    else passenger.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
    passenger.mesh.position.copy(passenger.position);
  }

  /** Finished at the enemy base: drop the bot beside the jeep and release it. */
  private exitBotJeep(bot: Bot, jeep: JeepSnapshot): void {
    const spot = this.localJeepExitSpot(jeep);
    if (!spot) return; // no room this frame; the errand ends next frame instead
    jeep.driverId = null;
    jeep.speed = 0;
    this.releaseLocalBotPassenger(jeep);
    bot.mesh.visible = true;
    bot.position.set(spot.x, spot.y, spot.z);
    bot.mesh.position.copy(bot.position);
    this.botJeepMissions.delete(bot.name);
    this.botJeepTeamReadyAt.set(bot.team, this.localTime + BOT_JEEP_COOLDOWN_SECONDS);
    this.updateBotNameTag(bot, bot.role === 'defender' ? '🛡️ DEFENDING' : '🎯 PATROLLING', bot.team === 'blue' ? '#60a5fa' : '#f87171');
    this.applyJeeps(this.localJeeps);
  }

  /** The errand failed (dead, stuck, jeep gone): park the jeep and let the AI
   *  have the bot back, after a cooldown so it does not retry immediately. */
  private abandonBotJeepMission(bot: Bot): void {
    const mission = this.botJeepMissions.get(bot.name);
    const jeep = mission?.jeepId ? this.localJeeps.find(vehicle => vehicle.id === mission.jeepId) : undefined;
    if (jeep && jeep.driverId === bot.name) {
      jeep.driverId = null;
      jeep.speed = 0;
      this.releaseLocalBotPassenger(jeep);
      // A live driver was hidden while riding; put it back beside its jeep so
      // the AI does not run an invisible bot for the rest of the round.
      if (!bot.isDead) {
        const spot = this.localJeepExitSpot(jeep, bot.name);
        if (spot) bot.position.set(spot.x, spot.y, spot.z);
        else bot.position.set(jeep.position.x, jeep.position.y, jeep.position.z);
        bot.mesh.position.copy(bot.position);
        bot.mesh.visible = true;
      }
      this.applyJeeps(this.localJeeps);
    }
    this.botJeepMissions.delete(bot.name);
    this.botJeepTeamReadyAt.set(bot.team, this.localTime + BOT_JEEP_COOLDOWN_SECONDS);
  }

  /** Incoming fire hits the vehicle while a bot is at the wheel, the same way
   *  server jeeps soak damage for their driver. Returns the damage left over
   *  for the bot itself (nothing while it is riding). */
  private absorbJeepDamage(bot: Bot, damage: number): number {
    const jeep = this.localJeeps.find(vehicle => !vehicle.wreck && (vehicle.driverId === bot.name || vehicle.passengerId === bot.name));
    if (!jeep) return damage;
    // Small arms glance off the bodywork of a moving jeep. Without this an
    // errand crossing the whole enemy team died about 200m short every time,
    // so the vehicle roadmap never reached a flag; a jeep is still lost to
    // focused fire, it just has to be focused.
    jeep.hp = Math.max(0, jeep.hp - Math.max(1, Math.round(damage / 2)));
    if (jeep.hp <= 0) {
      jeep.wreck = true;
      jeep.speed = 0;
      this.markLocalJeepWreck(jeep);
      this.showMessage(`💥 ${bot.team === 'blue' ? 'Blue' : 'Red'} jeep destroyed by enemy fire!`);
      this.releaseLocalJeepCrew(jeep);
    }
    this.applyJeeps(this.localJeeps);
    return 0;
  }

  /** E at the workshop offline: carry mined blocks into team stock, as online. */
  private depositToLocalWorkshop(): void {
    if (!this.workshops) return;
    const workshop = this.workshops[this.playerTeam];
    const moved = Math.min(this.inventory, Math.max(0, workshop.capacity - workshop.stock));
    if (moved <= 0) { this.showMessage('🏭 Workshop is full'); return; }
    this.inventory -= moved;
    workshop.stock += moved;
    this.showMessage(`🏭 Deposited ${moved} blocks · team stock ${workshop.stock}/${workshop.capacity}`);
  }

  private getSafeSpawnPos(team: Team): THREE.Vector3 {
    const zMin = team === 'blue' ? BLUE_SPAWN_Z_MIN : RED_SPAWN_Z_MIN;
    const zMax = team === 'blue' ? BLUE_SPAWN_Z_MAX : RED_SPAWN_Z_MAX;
    let bestX = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
    let bestZ = zMin + Math.random() * (zMax - zMin);
    let bestY = this.world.getGroundHeight(bestX, bestZ);

    for (let attempt = 0; attempt < 25; attempt++) {
      const testX = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
      const testZ = zMin + Math.random() * (zMax - zMin);
      const testY = this.world.getGroundHeight(testX, testZ);
      const vx = Math.round(testX);
      const vz = Math.round(testZ);
      const torsoY = Math.round(testY + 1.0);
      const headY = Math.round(testY + 1.8);
      if (!this.world.isSolid(vx, torsoY, vz) && !this.world.isSolid(vx, headY, vz)) {
        bestX = testX;
        bestZ = testZ;
        bestY = testY;
        break;
      }
    }
    return new THREE.Vector3(bestX, bestY, bestZ);
  }

  private createWeaponModels(): void {
    // Rifle - WW2 style with visible colors
    const rifle = new THREE.Group();
    const rifleBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x5a5a5a, metalness: 0.7, roughness: 0.3 })
    );
    rifleBody.position.set(0, 0, -0.15);
    rifle.add(rifleBody);

    // Rifle receiver ejection port locator (right side of receiver)
    const rifleEjection = new THREE.Object3D();
    rifleEjection.name = 'ejectionPort';
    rifleEjection.position.set(0.046, 0.025, -0.15);
    rifle.add(rifleEjection);

    // Visible ejection port recess
    const riflePortDetail = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.028, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.9, roughness: 0.2 })
    );
    riflePortDetail.position.set(0.041, 0.025, -0.15);
    rifle.add(riflePortDetail);
    
    const rifleBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.8, roughness: 0.2 })
    );
    rifleBarrel.rotation.x = Math.PI / 2;
    rifleBarrel.position.set(0, 0.01, -0.65);
    rifle.add(rifleBarrel);

    // Rifle barrel muzzle locator (right at the physical tip of the barrel)
    const rifleMuzzle = new THREE.Object3D();
    rifleMuzzle.name = 'barrelMuzzle';
    rifleMuzzle.position.set(0, 0.01, -0.96);
    rifle.add(rifleMuzzle);

    // Front iron sight post for precision ADS alignment
    const rifleSight = new THREE.Mesh(
      new THREE.BoxGeometry(0.008, 0.032, 0.015),
      new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.1 })
    );
    rifleSight.position.set(0, 0.042, -0.9);
    rifle.add(rifleSight);
    
    const rifleStock = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.12, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x8B4513, metalness: 0.1, roughness: 0.8 })
    );
    rifleStock.position.set(0, -0.02, 0.25);
    rifle.add(rifleStock);
    
    rifle.position.copy(this.hipPosition);
    this.weaponModels.set('rifle', rifle);

    // SMG - Thompson style with visible colors
    const smg = new THREE.Group();
    const smgBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x5a5a5a, metalness: 0.7, roughness: 0.3 })
    );
    smgBody.position.set(0, 0, -0.1);
    smg.add(smgBody);

    // SMG receiver ejection port locator (right side of receiver)
    const smgEjection = new THREE.Object3D();
    smgEjection.name = 'ejectionPort';
    smgEjection.position.set(0.05, 0.025, -0.1);
    smg.add(smgEjection);

    // Visible ejection port recess
    const smgPortDetail = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.026, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.9, roughness: 0.2 })
    );
    smgPortDetail.position.set(0.046, 0.025, -0.1);
    smg.add(smgPortDetail);
    
    const smgBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.35, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.8, roughness: 0.2 })
    );
    smgBarrel.rotation.x = Math.PI / 2;
    smgBarrel.position.set(0, 0.01, -0.4);
    smg.add(smgBarrel);

    // SMG barrel muzzle locator (right at the physical tip of the barrel)
    const smgMuzzle = new THREE.Object3D();
    smgMuzzle.name = 'barrelMuzzle';
    smgMuzzle.position.set(0, 0.01, -0.58);
    smg.add(smgMuzzle);

    // Front sight post for SMG
    const smgSight = new THREE.Mesh(
      new THREE.BoxGeometry(0.008, 0.028, 0.015),
      new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.1 })
    );
    smgSight.position.set(0, 0.038, -0.55);
    smg.add(smgSight);
    
    const smgStock = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.1, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x8B4513, metalness: 0.1, roughness: 0.8 })
    );
    smgStock.position.set(0, -0.01, 0.18);
    smg.add(smgStock);
    
    smg.position.copy(this.hipPosition);
    this.weaponModels.set('smg', smg);

    // Spade
    const spade = new THREE.Group();
    const spadeHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0x6b4423 }));
    spadeHandle.position.set(0, 0, -0.2);
    spade.add(spadeHandle);
    const spadeBlade = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 0.2), new THREE.MeshLambertMaterial({ color: 0x888888 }));
    spadeBlade.position.set(0, -0.25, -0.45);
    spade.add(spadeBlade);
    spade.position.copy(this.hipPosition);
    this.weaponModels.set('spade', spade);

    // Pickaxe
    const pickaxe = new THREE.Group();
    const pickHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0x6b4423 }));
    pickHandle.position.set(0, 0, -0.2);
    pickaxe.add(pickHandle);
    const pickHead = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.04, 0.04), new THREE.MeshLambertMaterial({ color: 0x888888 }));
    pickHead.position.set(0, 0.25, -0.45);
    pickaxe.add(pickHead);
    pickaxe.position.copy(this.hipPosition);
    this.weaponModels.set('pickaxe', pickaxe);
  }

  private switchWeaponModel(type: EquipmentType): void {
    this.isReloadAnimating = false;
    this.reloadAnimationTime = 0;
    for (const key of Object.keys(this.weapons)) {
      this.weapons[key].isReloading = false;
    }
    if (this.currentWeaponModel) {
      this.weaponContainer.remove(this.currentWeaponModel);
    }
    const newWeapon = this.weaponModels.get(type);
    if (newWeapon) {
      this.weaponContainer.add(newWeapon);
      this.currentWeaponModel = newWeapon;
      newWeapon.position.copy(this.hipPosition);
      newWeapon.rotation.set(0, 0, 0);
    }
  }

  private createFlags(): void {
    this.blueFlag = this.createFlagObject('blue', BLUE_FLAG_POS);
    this.redFlag = this.createFlagObject('red', RED_FLAG_POS);
  }

  private createFlagObject(team: Team, pos: { x: number; z: number }): Flag {
    const gY = this.world.getGroundHeight(pos.x, pos.z);

    // Base pedestal remains permanently at the base zone to mark the capture point
    const pedestalGeo = new THREE.CylinderGeometry(0.8, 1.0, 0.3, 16);
    const pedestalMat = new THREE.MeshStandardMaterial({
      color: team === 'blue' ? 0x113377 : 0x771122,
      roughness: 0.4,
      metalness: 0.5,
    });
    const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.set(pos.x, gY + 0.15, pos.z);
    this.scene.add(pedestal);

    // Base ring indicator
    const ringGeo = new THREE.RingGeometry(1.2, 1.45, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: team === 'blue' ? 0x4488ff : 0xff4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, gY + 0.05, pos.z);
    this.scene.add(ring);

    // Flag group (the flag object itself that disappears when carried)
    const group = new THREE.Group();
    group.position.set(pos.x, gY, pos.z);

    // Flagpole
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 4, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.3, metalness: 0.7 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 2;
    group.add(pole);

    // Flag banner cloth
    const flagColor = team === 'blue' ? 0x2277ff : 0xff2233;
    const clothGeo = new THREE.BoxGeometry(1.6, 0.9, 0.06);
    const clothMat = new THREE.MeshLambertMaterial({ color: flagColor });
    const cloth = new THREE.Mesh(clothGeo, clothMat);
    cloth.position.set(0.85, 3.3, 0);
    group.add(cloth);

    // Glowing sphere beacon on top
    const sphereGeo = new THREE.SphereGeometry(0.2, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({ color: team === 'blue' ? 0x66aaff : 0xff6666 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.y = 4.0;
    group.add(sphere);

    // Beacon point light for visibility across the battlefield
    const lightColor = team === 'blue' ? 0x4488ff : 0xff4444;
    const light = new THREE.PointLight(lightColor, 3, 22);
    light.position.y = 4.0;
    group.add(light);

    // Label sprite
    const labelSprite = this.createNameTag(team, team === 'blue' ? 'BLUE FLAG' : 'RED FLAG');
    labelSprite.position.set(0, 4.6, 0);
    labelSprite.scale.set(2.4, 0.6, 1);
    group.add(labelSprite);

    this.scene.add(group);

    return {
      team,
      basePos: { ...pos },
      currentPos: new THREE.Vector3(pos.x, gY, pos.z),
      carrier: null,
      isDropped: false,
      dropTimer: 0,
      isCaptured: false,
      capturedTimer: 0,
      mesh: group,
      clothMesh: cloth,
      light
    };
  }

  private resetFlagToBase(flag: Flag): void {
    const gY = this.world.getGroundHeight(flag.basePos.x, flag.basePos.z);
    flag.currentPos.set(flag.basePos.x, gY, flag.basePos.z);
    flag.mesh.position.copy(flag.currentPos);
    flag.carrier = null;
    flag.isDropped = false;
    flag.dropTimer = 0;
    flag.isCaptured = false;
    flag.capturedTimer = 0;
    flag.mesh.visible = true; // Flag reappears once returned to base!
    flag.light.intensity = 3;

    // In online mode the server owns flag state — mirror the return in our
    // authoritative tracking so the renderer doesn't fight the event state.
    if (flag.team === 'blue') this.serverBlueFlagAtBase = true;
    else this.serverRedFlagAtBase = true;

    // A flag can only exist in ONE place at a time: on its post, dropped on
    // the ground, or worn by exactly one carrier. When it returns to base,
    // clear every backpack-carried copy of it (local player + all bots + all
    // remote players) so no ghost duplicates linger on anyone's back.
    this.clearFlagCarriers(flag.team);
  }

  /**
   * Remove every visual/state copy of the given flag from carriers. Called
   * whenever a flag leaves play (returned to base, captured, respawned).
   */
  private clearFlagCarriers(flagTeam: 'blue' | 'red'): void {
    // The carried flag is the ENEMY team's flag: blue carriers wear red flags.
    const carrierTeam: 'blue' | 'red' = flagTeam === 'blue' ? 'red' : 'blue';

    if (this.gameMode !== 'online' && this.player.carryingFlag && this.playerTeam === carrierTeam) {
      this.player.carryingFlag = false;
    }
    if (this.serverCarryingEnemyFlag && this.playerTeam === carrierTeam) {
      this.serverCarryingEnemyFlag = false;
      this.serverCarriedFlagTeam = null;
    }

    for (const b of this.bots) {
      if (b.carryingFlag && b.team === carrierTeam) {
        b.carryingFlag = false;
        if (b.flagMesh) b.flagMesh.visible = false;
      }
    }

    for (const [, remote] of this.remotePlayers) {
      if (remote.state.carryingFlag && remote.state.team === carrierTeam) {
        remote.state.carryingFlag = false;
        if (remote.flagMesh) remote.flagMesh.visible = false;
      }
    }
  }

  /**
   * Online-mode flag rendering: the server owns ALL flag logic (pickup,
   * drop, return, capture) and broadcasts events. Here we only sync visuals:
   * hide taken flags, pulse dropped ones, and reposition them from events.
   */
  private updateFlagsVisualsOnline(): void {
    // Consistency guard: a flag is EITHER at its post, carried by exactly one
    // player, or dropped on the ground — never two of those at once. If an
    // event ordering slip leaves a stale carrier id while the server says the
    // flag is back at base (or vice versa), drop the stale state so we don't
    // render ghost duplicates (e.g. two flags on one flag post).
    if (this.serverBlueFlagAtBase) this.serverBlueFlagCarrierId = null;
    if (this.serverRedFlagAtBase) this.serverRedFlagCarrierId = null;

    const applyState = (flag: Flag, atBase: boolean, carrierId: string | null) => {
      if (atBase) {
        if (!flag.mesh.visible || flag.isDropped || flag.isCaptured || flag.carrier) {
          this.resetFlagToBase(flag);
        }
        flag.light.intensity = 3;
        flag.clothMesh.rotation.y = Math.sin(performance.now() * 0.003) * 0.3;
        return;
      }
      if (carrierId) {
        // Carried: invisible at its post (the carrier wears a backpack flag)
        flag.mesh.visible = false;
        flag.light.intensity = 0;
        return;
      }
      // Dropped somewhere on the battlefield (position set by flagDropped event)
      flag.mesh.visible = true;
      flag.mesh.position.copy(flag.currentPos);
      flag.light.intensity = 2 + Math.sin(performance.now() * 0.01) * 1.5;
    };

    applyState(this.blueFlag, this.serverBlueFlagAtBase, this.serverBlueFlagCarrierId);
    applyState(this.redFlag, this.serverRedFlagAtBase, this.serverRedFlagCarrierId);

    // Server-authoritative backpack flags: show the flag ONLY on the back of
    // the current carrier (players AND server bots — their state carries an
    // isBot flag). Everyone else's copy is hidden, so a taken flag can never
    // appear twice (e.g. one ghost on a back + one at the post).
    const blueCarried = !this.serverBlueFlagAtBase && !!this.serverBlueFlagCarrierId;
    const redCarried = !this.serverRedFlagAtBase && !!this.serverRedFlagCarrierId;
    for (const [id, remote] of this.remotePlayers) {
      // Bind backpack-flag visibility to the AUTHORITATIVE server carrier id,
      // not just the per-player `carryingFlag` hint: a flag can exist on at
      // most one back. If a client-reported flag desyncs from the server's
      // carrier list, the server wins and the ghost copy is hidden — this is
      // what prevents "two flags" (one carried + one still on the post).
      const heldByThisRemote =
        (remote.state.team === 'blue' && redCarried && this.serverRedFlagCarrierId === id) ||
        (remote.state.team === 'red' && blueCarried && this.serverBlueFlagCarrierId === id);
      if (!remote.flagMesh) {
        if (!heldByThisRemote) continue;
        const backpackFlagGroup = new THREE.Group();
        const poleGeo = new THREE.CylinderGeometry(0.014, 0.014, 1.0, 6);
        const poleMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
        const flagPole = new THREE.Mesh(poleGeo, poleMat);
        flagPole.position.set(0, 0.5, 0);
        backpackFlagGroup.add(flagPole);
        const flagClothColor = remote.state.team === 'blue' ? 0xee2222 : 0x2266ee;
        const clothGeo = new THREE.BoxGeometry(0.02, 0.35, 0.45);
        const clothMat = new THREE.MeshLambertMaterial({ color: flagClothColor });
        const flagCloth = new THREE.Mesh(clothGeo, clothMat);
        flagCloth.position.set(0, 0.75, 0.23);
        backpackFlagGroup.add(flagCloth);
        backpackFlagGroup.position.set(0, 1.1, 0.22);
        remote.mesh.add(backpackFlagGroup);
        remote.flagMesh = backpackFlagGroup;
      }
      remote.flagMesh.visible = heldByThisRemote;
    }
  }

  private updateFlags(dt: number): void {
    // In online mode the server owns all flag state (pickup / drop / return /
    // capture are broadcast as events). The client only renders those events,
    // so running local pickup/capture logic here would double-score and desync.
    if (this.gameMode === 'online') {
      this.updateFlagsVisualsOnline();
      return;
    }

    const flags = [this.blueFlag, this.redFlag];

    for (const flag of flags) {
      // If flag is captured, it completely disappears until respawn timer expires!
      if (flag.isCaptured) {
        flag.mesh.visible = false;
        flag.light.intensity = 0;
        flag.capturedTimer -= dt;
        if (flag.capturedTimer <= 0) {
          this.resetFlagToBase(flag);
          this.sounds.respawn();
          this.showMessage(`🚩 ${flag.team.toUpperCase()} FLAG HAS RESPAWNED AT BASE!`);
        }
        continue;
      }

      if (flag.carrier) {
        // Flag is currently carried: it disappears until returned!
        flag.mesh.visible = false;

        const carrier = flag.carrier;
        let carrierPos: THREE.Vector3 | null = null;
        let carrierDead = false;
        let carrierTeam: Team;

        if (carrier.isPlayer) {
          carrierDead = this.player.isDead;
          carrierPos = this.player.position;
          carrierTeam = this.playerTeam;
        } else if (carrier.bot) {
          carrierDead = carrier.bot.isDead;
          carrierPos = carrier.bot.position;
          carrierTeam = carrier.bot.team;
          if (carrier.bot.flagMesh) {
            carrier.bot.flagMesh.visible = true;
          }
        }

        if (carrierDead || !carrierPos) {
          // Carrier died: drop flag at death location where it reappears
          flag.carrier = null;
          flag.isDropped = true;
          flag.dropTimer = 30; // 30 seconds before auto-return
          const dropY = this.world.getGroundHeightBelow(flag.currentPos.x, flag.currentPos.y + 2, flag.currentPos.z);
          flag.currentPos.y = dropY;
          flag.mesh.position.copy(flag.currentPos);
          flag.mesh.visible = true; // Dropped flag appears on ground to be retrieved/returned
          if (carrier.isPlayer) this.player.carryingFlag = false;
          if (carrier.bot) {
            carrier.bot.carryingFlag = false;
            if (carrier.bot.flagMesh) carrier.bot.flagMesh.visible = false;
          }
          this.showMessage(`🚩 ${flag.team.toUpperCase()} flag was dropped!`);
        } else {
          // Carrier is alive: flag is taken and invisible until returned
          flag.mesh.visible = false;
          flag.currentPos.set(carrierPos.x, carrierPos.y, carrierPos.z);
          if (carrier.isPlayer) this.player.carryingFlag = true;
          if (carrier.bot) {
            carrier.bot.carryingFlag = true;
            if (carrier.bot.flagMesh) carrier.bot.flagMesh.visible = true;
          }

          // Check if carrier reached their home base!
          const homeBase = carrierTeam! === 'blue' ? BLUE_FLAG_POS : RED_FLAG_POS;
          const distToHome = Math.hypot(carrierPos.x - homeBase.x, carrierPos.z - homeBase.z);
          const baseGroundY = this.world.getGroundHeight(homeBase.x, homeBase.z);

          if (distToHome < 7.0 && Math.abs(carrierPos.y - baseGroundY) < 6.5) {
            // CAPTURE OCCURRED!
            if (carrierTeam! === 'blue') {
              this.blueCaptures++;
              this.showMessage(`🎉 BLUE TEAM (${carrier.name}) CAPTURED THE RED FLAG! Flag respawns in 8s...`);
            } else {
              this.redCaptures++;
              this.showMessage(`🚩 RED TEAM (${carrier.name}) CAPTURED THE BLUE FLAG! Flag respawns in 8s...`);
            }

            this.sounds.capture();
            this.sounds.captureFirework();
            this.createCaptureFireworks(new THREE.Vector3(homeBase.x, baseGroundY + 1.5, homeBase.z), carrierTeam!);
            this.addRadioMessage(carrier.name, `🚩 Enemy flag secured and scored at base! Respawning in 8s.`, carrierTeam!);

            if (this.networkClient && this.networkClient.isConnected()) {
              this.networkClient.send({
                type: 'captureFlag',
                team: carrierTeam!,
              });
            }

            if (carrier.isPlayer) this.player.carryingFlag = false;
            if (carrier.bot) {
              carrier.bot.carryingFlag = false;
              if (carrier.bot.flagMesh) carrier.bot.flagMesh.visible = false;
              carrier.bot.tacticalState = 'capturing';
              carrier.bot.tacticalStateTimer = 8;
            }

            // When captured, THE FLAG DISAPPEARS!
            flag.carrier = null;
            flag.isDropped = false;
            flag.isCaptured = true;
            flag.capturedTimer = 8.0; // Flag disappears for 8 seconds
            flag.mesh.visible = false;
            flag.light.intensity = 0;
          }
        }
      } else {
        // Flag is at base or dropped: visible in the world!
        flag.mesh.visible = true;
        flag.mesh.position.copy(flag.currentPos);
        flag.clothMesh.rotation.y = Math.sin(performance.now() * 0.003) * 0.3;

        if (flag.isDropped) {
          flag.dropTimer -= dt;
          flag.light.intensity = 2 + Math.sin(performance.now() * 0.01) * 1.5; // pulsing glow
          if (flag.dropTimer <= 0) {
            this.resetFlagToBase(flag);
            this.showMessage(`🏳️ ${flag.team.toUpperCase()} flag returned to base`);
          }
        } else {
          flag.light.intensity = 3;
        }

        // Check if local player picks it up
        if (!this.player.isDead) {
          const distToPlayer = Math.hypot(this.player.position.x - flag.currentPos.x, this.player.position.z - flag.currentPos.z);
          if (distToPlayer < 5.2 && Math.abs(this.player.position.y - flag.currentPos.y) < 5.5) {
            if (this.playerTeam !== flag.team) {
              // Enemy flag - pick it up! Flag disappears until returned
              flag.carrier = { isPlayer: true, name: 'You' };
              flag.isDropped = false;
              flag.mesh.visible = false;
              this.player.carryingFlag = true;
              this.sounds.capture();
              this.showMessage(`🚩 YOU TOOK THE ${flag.team.toUpperCase()} FLAG! Bring it to base!`);
            } else if (flag.isDropped) {
              // Friendly dropped flag - return it to base!
              this.resetFlagToBase(flag);
              this.sounds.respawn();
              this.showMessage(`🛡️ YOU RETURNED THE ${flag.team.toUpperCase()} FLAG TO BASE!`);
            }
          }
        }

        // Check if a bot picks it up
        if (!flag.carrier) {
          for (const bot of this.bots) {
            if (bot.isDead || bot.carryingFlag) continue;
            const distToBot = Math.hypot(bot.position.x - flag.currentPos.x, bot.position.z - flag.currentPos.z);
            const vertDist = Math.abs(bot.position.y - flag.currentPos.y);
            if (distToBot < 5.2 && vertDist < 5.5) {
              if (bot.team !== flag.team) {
                // Enemy bot picks up flag! Flag disappears until returned
                flag.carrier = { isPlayer: false, bot, name: bot.name };
                flag.isDropped = false;
                flag.mesh.visible = false;
                bot.carryingFlag = true;
                if (bot.flagMesh) bot.flagMesh.visible = true;
                bot.tacticalState = 'returning';
                bot.tacticalStateTimer = 999;
                this.sounds.weaponSwitch();
                this.showMessage(`🚩 ${bot.name} (${bot.team.toUpperCase()}) took the ${flag.team.toUpperCase()} flag!`);
                break;
              } else if (flag.isDropped) {
                // Friendly bot returns dropped flag!
                this.resetFlagToBase(flag);
                this.sounds.respawn();
                this.showMessage(`🛡️ ${bot.name} returned the ${flag.team.toUpperCase()} flag!`);
                break;
              }
            }
          }
        }
      }
    }
  }

  private createCaptureZones(): void {
    // Capture zones handled in updateFlags
  }

  private spawnTeamBots(team: Team, count: number): void {
    for (let i = 0; i < count; i++) {
      const pos = this.getSafeSpawnPos(team);

      // Aggressive CTF roles: 75% attackers pushing for the flag, 15% flankers, 10% base defender
      let role: 'attacker' | 'defender' | 'flanker' | 'support';
      let archetype: Bot['archetype'];

      if (i === 0) {
        role = 'defender';
        archetype = 'engineer'; // Base fortifier
      } else if (i === 1) {
        role = 'flanker';
        archetype = 'marksman'; // Long-distance cover fire
      } else if (i === 2) {
        role = 'attacker';
        archetype = 'breacher'; // Barricade demolisher & trench spade
      } else {
        role = 'attacker';
        archetype = (i % 2 === 0) ? 'assault' : 'breacher';
      }

      // Weapons tailored to archetype
      let weapon: 'rifle' | 'smg';
      if (archetype === 'marksman') {
        weapon = 'rifle';
      } else if (archetype === 'assault') {
        weapon = 'smg';
      } else if (archetype === 'engineer') {
        weapon = 'rifle';
      } else {
        weapon = Math.random() < 0.5 ? 'rifle' : 'smg';
      }

      const { group: botMesh, parts } = this.createBotMesh(team, weapon);
      botMesh.position.copy(pos);
      this.scene.add(botMesh);

      // Backpack flag: visible only when carrying the enemy flag
      const backpackFlagGroup = new THREE.Group();
      const poleGeo = new THREE.CylinderGeometry(0.014, 0.014, 1.0, 6);
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
      const flagPole = new THREE.Mesh(poleGeo, poleMat);
      flagPole.position.set(0, 0.5, 0);
      backpackFlagGroup.add(flagPole);

      // Enemy flag color on backpack
      const flagClothColor = team === 'blue' ? 0xee2222 : 0x2266ee;
      const clothGeo = new THREE.BoxGeometry(0.02, 0.35, 0.45);
      const clothMat = new THREE.MeshLambertMaterial({ color: flagClothColor });
      const flagCloth = new THREE.Mesh(clothGeo, clothMat);
      flagCloth.position.set(0, 0.75, 0.23);
      backpackFlagGroup.add(flagCloth);

      backpackFlagGroup.position.set(0, 1.1, 0.22);
      backpackFlagGroup.visible = false;
      botMesh.add(backpackFlagGroup);

      const botName = `${team === 'blue' ? 'Blue' : 'Red'} Bot ${i + 1}`;
      const { sprite: nameTag, canvas: nameTagCanvas, texture: nameTagTexture } = this.createBotNameTag();
      nameTag.position.y = 2.65;
      botMesh.add(nameTag);

      const laneOffset = ((i % 3) - 1) * 8 + (Math.random() - 0.5) * 4;
      const maxAmmo = weapon === 'rifle' ? 10 : 30;
      const initialTacticalState: Bot['tacticalState'] = role === 'attacker' ? 'capturing' : (role === 'defender' ? 'defending' : 'shooting');

      const bot: Bot = {
        mesh: botMesh,
        position: pos.clone(),
        velocity: new THREE.Vector3(),
        hp: 100, maxHp: 100,
        isDead: false, respawnTimer: 0,
        targetPos: pos.clone(),
        moveTimer: 1 + Math.random() * 2,
        shootTimer: 0.8 + Math.random() * 1.5,
        burstRemaining: 0,
        burstTimer: 0,
        headY: 1.8, grounded: false,
        team, name: botName, role, laneOffset,
        nameTag,
        isCrouching: false, crouchTimer: 0,
        behaviorState: role === 'attacker' ? 'rushFlag' : (role === 'flanker' ? 'flanking' : 'defend'),
        behaviorTimer: 2 + Math.random() * 3,
        strafeDirection: Math.random() > 0.5 ? 1 : -1,
        stuckTimer: 0, lastPos: pos.clone(),
        jumpCooldown: 0, skill: archetype === 'marksman' ? 0.9 : (0.65 + Math.random() * 0.3),
        aggression: archetype === 'assault' ? 0.95 : (0.6 + Math.random() * 0.4),
        lastDamageTime: 0, dodgeTimer: 1.5 + Math.random(), coverTimer: 0,
        weapon,
        weaponMesh: parts.weaponGroup,
        ammo: maxAmmo,
        maxAmmo,
        isReloading: false,
        reloadTimer: 0,
        aimPitch: 0,
        bodyParts: parts,
        isAiming: false, aimTransition: 0,
        carryingFlag: false, flagMesh: backpackFlagGroup,
        lookAroundTimer: 0, lookAroundTarget: 0,
        walkCycle: Math.random() * Math.PI * 2,
        // Equipment loadout
        hasSpade: true, // All combatants carry entrenching tools
        hasBlocks: true, // All combatants have building resources
        inventoryBlocks: archetype === 'engineer' ? 26 : (archetype === 'breacher' ? 20 : 14),
        isDigging: false,
        digTimer: 0,
        digTarget: null,
        trenchDepth: 0,
        isInTrench: false,
        isBuilding: false,
        nestId: null,
        nestIdleTimer: 0,
        nestCooldown: 0,
        buildTimer: 0,
        buildTarget: null,
        panicLevel: 0,
        confidence: 0.8 + Math.random() * 0.2,
        suppressionTimer: 0,
        lastSeenEnemy: null,
        memoryPosition: null,
        memoryTimer: 0,
        flankRoute: null,
        flankProgress: 0,
        squadId: Math.floor(i / 3),
        isLeading: i % 3 === 0,
        tacticalState: initialTacticalState,
        tacticalStateTimer: 3 + Math.random() * 3,
        buildCooldown: 1.5 + Math.random() * 2,
        digCooldown: 2 + Math.random() * 3,
        tacticalBlocksQueued: [],
        nameTagCanvas,
        nameTagTexture,
        lastDrawnState: '',
        archetype,
        speechText: undefined,
        speechTimer: 0,
        combatJumpCooldown: 1.0 + Math.random() * 2,
        flinchTimer: 0,
        isBreaching: false,
        breachTimer: 0,
        breachTarget: null,
        lastRadioCallTime: 0,
        reactionDelay: 0,
        currentTargetKey: null,
        consecutiveShots: 0,
      };

      this.updateBotNameTag(bot, initialTacticalState === 'capturing' ? '🚩 RUSHING FLAG' : (initialTacticalState === 'defending' ? '🛡️ DEFENDING' : '🎯 PATROLLING'), '#55aaff');
      this.bots.push(bot);
    }
  }

  private createBotMesh(team: Team, weaponType: 'rifle' | 'smg' = 'rifle'): {
    group: THREE.Group;
    parts: NonNullable<Bot['bodyParts']>;
  } {
    const colors = TEAM_COLORS[team];
    const group = new THREE.Group();

    // Body (torso)
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.8, 0.4),
      new THREE.MeshLambertMaterial({ color: colors.body })
    );
    body.position.y = 1.1;
    group.add(body);

    // Head
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshLambertMaterial({ color: 0xffdbac })
    );
    head.position.y = 1.8;
    group.add(head);

    // Tactical Eyes / Goggles facing forward along -Z
    const eyeGeo = new THREE.BoxGeometry(0.08, 0.05, 0.03);
    const eyeMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.09, 0.03, -0.205);
    head.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.09, 0.03, -0.205);
    head.add(rightEye);

    // Helmet with forward visor brim extending along -Z
    const helmet = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.2, 0.46),
      new THREE.MeshLambertMaterial({ color: colors.accent })
    );
    helmet.position.y = 2.05;
    group.add(helmet);

    const brim = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.04, 0.1),
      new THREE.MeshLambertMaterial({ color: colors.accent })
    );
    brim.position.set(0, -0.07, -0.26);
    helmet.add(brim);

    // Left arm
    const leftArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.6, 0.2),
      new THREE.MeshLambertMaterial({ color: colors.body })
    );
    leftArm.position.set(-0.4, 1.1, 0);
    group.add(leftArm);

    // Right arm
    const rightArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.6, 0.2),
      new THREE.MeshLambertMaterial({ color: colors.body })
    );
    rightArm.position.set(0.4, 1.1, 0);
    group.add(rightArm);

    // Left leg
    const leftLeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.6, 0.25),
      new THREE.MeshLambertMaterial({ color: colors.legs })
    );
    leftLeg.position.set(-0.15, 0.3, 0);
    group.add(leftLeg);

    // Right leg
    const rightLeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.6, 0.25),
      new THREE.MeshLambertMaterial({ color: colors.legs })
    );
    rightLeg.position.set(0.15, 0.3, 0);
    group.add(rightLeg);

    // Weapon group (Rifle or SMG)
    const weaponGroup = new THREE.Group();
    if (weaponType === 'rifle') {
      // Long wooden rifle stock
      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.12, 0.38),
        new THREE.MeshLambertMaterial({ color: 0x7a4b28 })
      );
      stock.position.set(0, 0, 0.12);
      weaponGroup.add(stock);

      // Dark metal receiver
      const receiver = new THREE.Mesh(
        new THREE.BoxGeometry(0.075, 0.08, 0.26),
        new THREE.MeshLambertMaterial({ color: 0x2e2e2e })
      );
      receiver.position.set(0, 0.02, -0.15);
      weaponGroup.add(receiver);

      // Long cylindrical rifle barrel
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.52, 8),
        new THREE.MeshLambertMaterial({ color: 0x161616 })
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.03, -0.45);
      weaponGroup.add(barrel);

      // Front iron sight
      const sight = new THREE.Mesh(
        new THREE.BoxGeometry(0.015, 0.03, 0.02),
        new THREE.MeshLambertMaterial({ color: 0x111111 })
      );
      sight.position.set(0, 0.06, -0.65);
      weaponGroup.add(sight);

      // Bot rifle barrel muzzle locator
      const botMuzzle = new THREE.Object3D();
      botMuzzle.name = 'barrelMuzzle';
      botMuzzle.position.set(0, 0.03, -0.72);
      weaponGroup.add(botMuzzle);

      // Bot rifle receiver ejection port locator
      const botEjection = new THREE.Object3D();
      botEjection.name = 'ejectionPort';
      botEjection.position.set(0.045, 0.03, -0.15);
      weaponGroup.add(botEjection);
    } else {
      // SMG: Compact receiver
      const bodySmg = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.1, 0.32),
        new THREE.MeshLambertMaterial({ color: 0x252525 })
      );
      bodySmg.position.set(0, 0, -0.08);
      weaponGroup.add(bodySmg);

      // Distinctive drum magazine
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.08, 12),
        new THREE.MeshLambertMaterial({ color: 0x141414 })
      );
      drum.position.set(0, -0.09, -0.06);
      weaponGroup.add(drum);

      // Tactical front foregrip
      const grip = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.11, 0.035),
        new THREE.MeshLambertMaterial({ color: 0x181818 })
      );
      grip.position.set(0, -0.08, -0.22);
      weaponGroup.add(grip);

      // Short barrel shroud
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.028, 0.22, 8),
        new THREE.MeshLambertMaterial({ color: 0x111111 })
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, -0.32);
      weaponGroup.add(barrel);

      // Bot SMG barrel muzzle locator
      const botMuzzle = new THREE.Object3D();
      botMuzzle.name = 'barrelMuzzle';
      botMuzzle.position.set(0, 0.02, -0.44);
      weaponGroup.add(botMuzzle);

      // Bot SMG receiver ejection port locator
      const botEjection = new THREE.Object3D();
      botEjection.name = 'ejectionPort';
      botEjection.position.set(0.048, 0.02, -0.08);
      weaponGroup.add(botEjection);
    }

    weaponGroup.position.set(0.38, 1.1, -0.25);
    group.add(weaponGroup);

    // Spade tool (shown during trench digging)
    const spadeGroup = new THREE.Group();
    const spadeHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.65, 8),
      new THREE.MeshLambertMaterial({ color: 0x8b5a2b })
    );
    spadeHandle.rotation.x = Math.PI / 3;
    spadeGroup.add(spadeHandle);

    const spadeBlade = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.02, 0.22),
      new THREE.MeshLambertMaterial({ color: 0x888888 })
    );
    spadeBlade.position.set(0, -0.25, -0.22);
    spadeGroup.add(spadeBlade);
    spadeGroup.position.set(0.4, 1.1, -0.1);
    spadeGroup.visible = false;
    group.add(spadeGroup);

    // Block mesh (shown during cover building)
    const blockGroup = new THREE.Group();
    const miniBlock = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.24, 0.24),
      new THREE.MeshLambertMaterial({ color: 0x4a7c59 })
    );
    miniBlock.position.set(0, 0, -0.2);
    blockGroup.add(miniBlock);
    blockGroup.position.set(0.4, 1.1, -0.1);
    blockGroup.visible = false;
    group.add(blockGroup);

    const parts = {
      head,
      helmet,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      weaponGroup,
      spadeGroup,
      blockGroup,
    };

    return { group, parts };
  }

  private createNameTag(team: Team, name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = team === 'blue' ? '#4488ff' : '#ff4444';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(name, 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2, 0.5, 1);
    return sprite;
  }

  private createCaptureFireworks(pos: THREE.Vector3, team: Team): void {
    const colors = team === 'blue' ? [0x4488ff, 0x00e5ff, 0xffffff, 0xffd700] : [0xff4444, 0xff9100, 0xffffff, 0xffd700];
    for (let i = 0; i < 32; i++) {
      const color = colors[i % colors.length];
      const geo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      this.scene.add(mesh);

      const angle = (i / 32) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed = 5 + Math.random() * 7;
      const vy = 9 + Math.random() * 7;
      const velocity = new THREE.Vector3(Math.cos(angle) * speed, vy, Math.sin(angle) * speed);

      this.captureFireworks.push({
        mesh,
        velocity,
        life: 0,
        maxLife: 1.8 + Math.random() * 0.5,
        color,
      });
    }
  }

  addRadioMessage(sender: string, text: string, team: Team, bot?: Bot): void {
    const msg: RadioMessage = {
      id: Math.random().toString(36).substring(2, 9),
      sender,
      text,
      team,
      time: performance.now(),
    };
    this.radioLog.push(msg);
    if (this.radioLog.length > 8) {
      this.radioLog.shift();
    }
    this.sounds.radioBeep();
    if (bot) {
      bot.speechText = text;
      bot.speechTimer = 3.5;
      this.updateBotNameTag(bot, bot.tacticalState, bot.team === 'blue' ? '#60a5fa' : '#f87171');
    }
  }

  private createBotNameTag(): { sprite: THREE.Sprite; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.6, 1.3, 1);
    return { sprite, canvas, texture };
  }

  private updateBotNameTag(bot: Bot, actionText: string, actionColor: string): void {
    if (!bot.nameTagCanvas || !bot.nameTagTexture) return;
    const stateKey = `${actionText}_${Math.round(bot.hp)}_${bot.speechText || ''}`;
    if (bot.lastDrawnState === stateKey) return;
    bot.lastDrawnState = stateKey;

    const ctx = bot.nameTagCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 256, 128);

    // 1. Speech balloon if bot has an active radio speech callout
    if (bot.speechText) {
      ctx.font = 'bold 12px Arial, sans-serif';
      const textMetrics = ctx.measureText(bot.speechText);
      const speechWidth = Math.min(244, Math.max(120, textMetrics.width + 18));
      const speechX = 128 - speechWidth / 2;
      ctx.fillStyle = 'rgba(10, 15, 26, 0.94)';
      ctx.beginPath();
      if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(speechX, 4, speechWidth, 22, 6);
      } else {
        ctx.rect(speechX, 4, speechWidth, 22);
      }
      ctx.fill();
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(bot.speechText, 128, 19);
    }

    // 2. Bot name + archetype tag
    const archetypeLabel = bot.archetype ? `[${bot.archetype.toUpperCase()}]` : '';
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = bot.team === 'blue' ? '#60a5fa' : '#f87171';
    ctx.fillText(`${bot.name} ${archetypeLabel}`, 128, bot.speechText ? 52 : 36);

    // 3. Dynamic Health Bar (140px wide)
    ctx.shadowBlur = 0;
    const barY = bot.speechText ? 60 : 44;
    const barWidth = 140;
    const barHeight = 8;
    const barX = 128 - barWidth / 2;

    // Bar background
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    if (typeof (ctx as any).roundRect === 'function') {
      (ctx as any).roundRect(barX, barY, barWidth, barHeight, 4);
    } else {
      ctx.rect(barX, barY, barWidth, barHeight);
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Bar fill
    const hpRatio = Math.max(0, Math.min(1, bot.hp / bot.maxHp));
    if (hpRatio > 0) {
      const fillWidth = Math.max(4, barWidth * hpRatio);
      ctx.fillStyle = hpRatio > 0.6 ? '#10b981' : (hpRatio > 0.3 ? '#f59e0b' : '#ef4444');
      ctx.beginPath();
      if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(barX, barY, fillWidth, barHeight, 4);
      } else {
        ctx.rect(barX, barY, fillWidth, barHeight);
      }
      ctx.fill();
    }

    // 4. Status action pill
    const badgeY = bot.speechText ? 76 : 60;
    const badgeHeight = 28;
    ctx.font = 'bold 14px Arial, sans-serif';
    const textWidth = ctx.measureText(actionText).width;
    const badgeWidth = Math.min(240, Math.max(120, textWidth + 24));
    const badgeX = 128 - badgeWidth / 2;

    // Dark rounded rect pill
    ctx.fillStyle = 'rgba(12, 18, 34, 0.92)';
    ctx.beginPath();
    if (typeof (ctx as any).roundRect === 'function') {
      (ctx as any).roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 6);
    } else {
      ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
    }
    ctx.fill();

    // Border with action color
    ctx.strokeStyle = actionColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Action text in action color
    ctx.fillStyle = actionColor;
    ctx.textAlign = 'center';
    ctx.fillText(actionText, 128, badgeY + 19);

    bot.nameTagTexture.needsUpdate = true;
  }

  private initializeNetwork(): void {
    // The transport owns the join: it asserts this identity once per session,
    // from the only place that knows the token a (re)connect just issued. It
    // never carries the stale menu-time position — the server picks the spawn.
    this.networkClient = new NetworkClient(this.serverUrl, this.playerTeam, this.playerName);

    this.networkClient.onConnect(() => {
      this.showMessage(`Connected to game server as ${this.playerTeam.toUpperCase()}!`);
      this.onlineJoinConfirmed = false;
    });

    this.networkClient.onDisconnect(() => {
      this.onlineJoinConfirmed = false;
      this.showMessage('Disconnected from server. Reconnecting...');
    });

    // Handle full init message
    this.networkClient.onMessage('init', (msg: any) => {
      this.localPlayerId = msg.playerId;
      // Fresh session: drop any feedback left over from a previous server.
      this.killfeed = [];
      this.damageSources = [];
      this.pingMs = 0;
      // Round HUD: adopt the server clock immediately, otherwise a late joiner
      // would show round 1 with a full 30:00 clock until the next 1Hz sync.
      if (msg.round) this.applyRoundSnapshot(msg.round as RoundSnapshot);
      // Bench blueprints survive reconnects: the server sends this player's
      // crafted slots with the rest of the init snapshot.
      this.craftedSlots = Array.isArray(msg.blueprints) ? (msg.blueprints as BlueprintSlots) : [null, null, null];
      // Scoreboard: adopt the server's authoritative K/D/capture tallies.
      // Clear stale singleplayer tallies first so they don't linger in online play.
      this.statsById.clear();
      if (msg.stats && typeof msg.stats === 'object') {
        for (const [id, s] of Object.entries(msg.stats as Record<string, PlayerStats>)) {
          this.statsById.set(id, { kills: s.kills || 0, deaths: s.deaths || 0, captures: s.captures || 0 });
        }
      }
      // Snap the local player to the server-authoritative state. Previously
      // the client kept its old menu-time position and pushed it back to the
      // server on the next input frame, which could teleport the server-side
      // player into danger (instant-elimination-on-join bug).
      if (msg.state) {
        const st = msg.state as PlayerState;
        if (st.position) {
          this.player.position.set(st.position.x, st.position.y, st.position.z);
        }
        this.player.velocity.set(0, 0, 0);
        // Force alive on join: never let a stale/dead server snapshot leave the
        // client in an eliminated state at spawn. The server's requestRespawn
        // handler guarantees a fresh full-HP spawn; if any event races or drops,
        // this ensures the local player starts alive and can move/shoot.
        this.player.isDead = false;
        this.player.respawnTimer = 0;
        this.player.hp = typeof st.hp === 'number' ? Math.max(st.hp, 1) : 100;
        this.spawnProtected = !!st.spawnProtected;
        // init is sent before the server processes our team selection.
        // Keep the selected team until the authoritative join update arrives.
        this.player.updateCamera();
      }
      if (msg.captures) {
        this.blueCaptures = msg.captures.blue || 0;
        this.redCaptures = msg.captures.red || 0;
      }
      if (msg.scores) {
        this.blueKills = msg.scores.blue || 0;
        this.redKills = msg.scores.red || 0;
      }
      // Add existing players
      if (msg.players && Array.isArray(msg.players)) {
        for (const p of msg.players) {
          if (p.id !== this.localPlayerId) {
            this.addRemotePlayer(p.id, p.state);
          }
        }
      }
      if (typeof msg.inventory === 'number') {
        this.inventory = msg.inventory;
      }
      this.depositable = typeof msg.depositable === 'number' ? msg.depositable : 0;
      if (msg.workshops) {
        this.workshops = msg.workshops as Workshops;
        this.renderWorkshops(this.workshops);
      }
      this.applyJeeps(Array.isArray(msg.jeeps) ? msg.jeeps : []);
      // Apply authoritative flag snapshot (late-joiner sync)
      if (msg.flags) {
        const applyFlagSnapshot = (team: 'blue' | 'red') => {
          const f = msg.flags[team];
          if (!f) return;
          const flag = team === 'blue' ? this.blueFlag : this.redFlag;
          if (team === 'blue') {
            this.serverBlueFlagAtBase = !!f.atBase;
            this.serverBlueFlagCarrierId = f.carrierId ?? null;
            if (!f.atBase && !f.carrierId && f.droppedPosition) {
              this.blueFlag.currentPos.set(f.droppedPosition.x, f.droppedPosition.y, f.droppedPosition.z);
              this.blueFlag.mesh.position.copy(this.blueFlag.currentPos);
              this.blueFlag.isDropped = true;
              this.blueFlag.isCaptured = false;
              this.blueFlag.carrier = null;
              this.blueFlag.mesh.visible = true;
            }
          } else {
            this.serverRedFlagAtBase = !!f.atBase;
            this.serverRedFlagCarrierId = f.carrierId ?? null;
            if (!f.atBase && !f.carrierId && f.droppedPosition) {
              this.redFlag.currentPos.set(f.droppedPosition.x, f.droppedPosition.y, f.droppedPosition.z);
              this.redFlag.mesh.position.copy(this.redFlag.currentPos);
              this.redFlag.isDropped = true;
              this.redFlag.isCaptured = false;
              this.redFlag.carrier = null;
              this.redFlag.mesh.visible = true;
            }
          }
          if (f.atBase) {
            this.resetFlagToBase(flag);
          } else if (f.droppedPosition) {
            flag.currentPos.set(f.droppedPosition.x, f.droppedPosition.y + 0.5, f.droppedPosition.z);
            flag.mesh.position.copy(flag.currentPos);
            flag.carrier = null;
            flag.isDropped = true;
            flag.isCaptured = false;
            flag.mesh.visible = true;
          } else if (f.respawnTimer > 0) {
            // Captured and respawning: hidden until server returns it
            flag.carrier = null;
            flag.isDropped = false;
            flag.isCaptured = true;
            flag.capturedTimer = f.respawnTimer;
            flag.mesh.visible = false;
            flag.light.intensity = 0;
          } else {
            // Carried by someone (or just taken): hidden at post
            flag.carrier = null;
            flag.isDropped = false;
            flag.isCaptured = false;
            flag.mesh.visible = false;
            flag.light.intensity = 0;
          }
        };
        applyFlagSnapshot('blue');
        applyFlagSnapshot('red');
      }
      if (msg.voxelChanges && Array.isArray(msg.voxelChanges) && msg.voxelChanges.length > 0) {
        for (const change of msg.voxelChanges) {
          this.world.setVoxel(change.x, change.y, change.z, change.type, change.durability);
        }
        this.world.update(true);
      }
      this.showMessage(`🟢 Online Match Ready! (${this.playerTeam.toUpperCase()} Team)`);
    });

    this.networkClient.onMessage('joined', (msg: any) => {
      const state = msg.state as PlayerState;
      if (!state?.position || (state.team !== 'red' && state.team !== 'blue')) return;
      this.playerTeam = state.team;
      this.player.team = state.team;
      this.player.position.set(state.position.x, state.position.y, state.position.z);
      this.player.velocity.set(0, 0, 0);
      this.player.yaw = state.team === 'blue' ? Math.PI : 0;
      this.player.updateCamera();
      this.onlineJoinConfirmed = true;
      if (typeof state.reserveAmmo === 'number') this.ammoReserve = state.reserveAmmo;
      if (typeof state.shellPacks === 'number') this.shellPacks = state.shellPacks;
    });

    // Handle player joined
    this.networkClient.onMessage('playerJoined', (msg: any) => {
      if (msg.playerId === this.localPlayerId) return;
      this.addRemotePlayer(msg.playerId, msg.state);
    });

    // Handle player left
    this.networkClient.onMessage('playerLeft', (msg: any) => {
      this.removeRemotePlayer(msg.playerId);
    });

    // Handle player updated
    this.networkClient.onMessage('playerUpdated', (msg: any) => {
      if (msg.playerId === this.localPlayerId) {
        if (msg.state) {
          // The server is authoritative over HP in both directions: damage
          // takes it down and out-of-combat regen brings it back up. Only the
          // downward direction makes a hurt sound.
          if (typeof msg.state.hp === 'number' && msg.state.hp < this.player.hp) {
            this.sounds.hurt();
          }
          if (typeof msg.state.hp === 'number') this.player.hp = msg.state.hp;
          if (typeof msg.state.reserveAmmo === 'number') this.ammoReserve = msg.state.reserveAmmo;
          if (typeof msg.state.shellPacks === 'number') this.shellPacks = msg.state.shellPacks;
          this.spawnProtected = !!msg.state.spawnProtected;
        }
        return;
      }
      let remote = this.remotePlayers.get(msg.playerId);
      if (!remote) {
        this.addRemotePlayer(msg.playerId, msg.state);
        remote = this.remotePlayers.get(msg.playerId);
      }
      if (remote) {
        // If team changed, rebuild mesh and nametag with the correct team colors!
        if (remote.state.team !== msg.state.team) {
          this.scene.remove(remote.mesh);
          const { group: mesh } = this.createBotMesh(msg.state.team as Team);
          const nameTag = this.createNameTag(msg.state.team as Team, `Player ${msg.playerId.slice(-4)}`);
          nameTag.position.y = 2.6;
          mesh.add(nameTag);
          this.scene.add(mesh);
          remote.mesh = mesh;
        }
        remote.state = msg.state;
        remote.mesh.visible = !msg.state.isDead && ![...this.jeeps.values()].some(jeep =>
          jeep.state.driverId === msg.playerId || jeep.state.passengerId === msg.playerId);
        remote.targetPosition.set(msg.state.position.x, msg.state.position.y, msg.state.position.z);
        remote.targetRotation.set(0, msg.state.rotation.yaw, 0, 'YXZ');
      }
    });

    // Handle remote player shot (muzzle flash, tracer, 3D sound)
    this.networkClient.onMessage('playerShot', (msg: any) => {
      if (msg.playerId === this.localPlayerId) return;
      this.renderRemotePlayerShot(msg.playerId, msg.origin, msg.direction, msg.weapon);
    });

    // Handle hit confirmed on enemy
    this.networkClient.onMessage('hitConfirmed', (msg: any) => {
      this.hitMarkerTimer = 0.25;
      this.sounds.hitMarker();
      if (msg.isHeadshot) {
        this.sounds.headshot();
      }
    });

    // Handle player damaged. The server is authoritative and broadcasts a
    // full-state sync (playerUpdated) right after damage, so applying the
    // delta locally too would double every hit (two shots killing from full
    // HP). This event is used ONLY for feedback (sound/flash); never mutate
    // local or remote HP here — trust the authoritative state sync instead.
    this.networkClient.onMessage('playerDamaged', (msg: any) => {
      if (msg.playerId === this.localPlayerId) {
        if (!this.player.isDead) {
          this.sounds.hurt();
        }
        // Record WHERE it came from (world space) so the HUD arc keeps
        // pointing at the shooter even after the player turns.
        const attackerPos =
          msg.attackerId && msg.attackerId !== this.localPlayerId
            ? this.remotePlayers.get(msg.attackerId)?.state.position
            : undefined;
        if (attackerPos && Number.isFinite(attackerPos.x) && Number.isFinite(attackerPos.z)) {
          const nowSec = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
          this.damageSources.push({
            x: attackerPos.x,
            z: attackerPos.z,
            until: nowSec + DAMAGE_INDICATOR_SECONDS,
          });
          if (this.damageSources.length > 6) this.damageSources.shift();
        }
      } else {
        const remote = this.remotePlayers.get(msg.playerId);
        if (remote && !remote.state.isDead) {
          // Feedback only: brief red damage flash tint on the remote mesh.
          remote.damageFlashTimer = 0.2;
        }
      }
    });

    // Handle player died
    this.networkClient.onMessage('playerDied', (msg: any) => {
      this.pushKillfeed(msg.killerId, msg.playerId, msg.weapon, !!msg.isHeadshot);
      if (msg.playerId === this.localPlayerId) {
        // Guard against re-applying death (double respawn timers / sounds)
        if (!this.player.isDead) {
          this.player.die();
          // Clear flag-carry state immediately; the server also broadcasts a
          // flagDropped event which repositions the flag on the ground.
          this.player.carryingFlag = false;
          this.serverCarryingEnemyFlag = false;
          // Clear OUR carrier id on the flag we were holding — otherwise the
          // post stays "hidden, carried by <us>" until the flagDropped event
          // lands, and any desync in between can render ghost duplicates.
          if (this.serverCarriedFlagTeam === 'blue') this.serverBlueFlagCarrierId = null;
          if (this.serverCarriedFlagTeam === 'red') this.serverRedFlagCarrierId = null;
          this.serverCarriedFlagTeam = null;
          this.player.respawnTimer = 4;
          this.sounds.deathSound();
          this.showMessage('☠️ You were eliminated! Respawning in 4s...');
        }
      } else {
        const remote = this.remotePlayers.get(msg.playerId);
        if (remote) {
          remote.mesh.visible = false;
          remote.state.isDead = true;
          remote.state.hp = 0;
        }
        if (msg.killerId === this.localPlayerId) {
          // Optimistic local increment only when not networked (singleplayer /
          // bot kills handled locally). In multiplayer the server broadcasts
          // authoritative totals via `scoreUpdate`, so incrementing here too
          // would double-count.
          if (!this.networkClient?.isConnected()) {
            if (this.playerTeam === 'blue') this.blueKills++; else this.redKills++;
          }
          this.sounds.killSound();
          this.showMessage(`🎯 You eliminated Player ${msg.playerId.slice(-4)}!`);
        }
      }
    });

    // Handle authoritative team score sync from the server
    this.networkClient.onMessage('scoreUpdate', (msg: any) => {
      if (msg.scores) {
        this.blueKills = msg.scores.blue || 0;
        this.redKills = msg.scores.red || 0;
      }
    });

    // Handle live per-player K/D/capture stats so the Tab scoreboard stays in
    // sync for everyone (previously only refreshed on join via `init`).
    this.networkClient.onMessage('statsUpdate', (msg: any) => {
      if (!msg.stats) return;
      for (const [id, s] of Object.entries(msg.stats)) {
        const st = s as any;
        this.statsById.set(id, {
          kills: st.kills ?? 0,
          deaths: st.deaths ?? 0,
          captures: st.captures ?? 0,
        });
      }
    });

    // Handle player respawned
    this.networkClient.onMessage('playerRespawned', (msg: any) => {
      if (msg.playerId === this.localPlayerId) {
        this.handlePlayerRespawn(new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z));
      } else {
        const remote = this.remotePlayers.get(msg.playerId);
        if (remote) {
          remote.state.isDead = false;
          remote.state.hp = 100;
          remote.mesh.visible = true;
          remote.mesh.position.set(msg.position.x, msg.position.y, msg.position.z);
          remote.targetPosition.set(msg.position.x, msg.position.y, msg.position.z);
        }
      }
    });

    // Handle voxel changes from server
    this.networkClient.onMessage('voxelChanged', (msg: any) => {
      const { x, y, z, type, durability } = msg.change;
      const prevVoxel = this.world.getVoxel(x, y, z);
      this.world.setVoxel(x, y, z, type, durability);
      
      // If solid voxel with partial durability, update color immediately
      if (type !== 0 && durability < VOXEL_MAX_DURABILITY) {
        this.world.updateVoxelColor(x, y, z, type, durability);
      }

      // Audio feedback if within hearing range of the player
      const dist = this.player.camera.position.distanceTo(new THREE.Vector3(x, y, z));
      if (dist < 30) {
        if (type === 0 && prevVoxel && prevVoxel.type !== 0) {
          this.sounds.spadeHit();
        } else if (type === 4 && (!prevVoxel || prevVoxel.type === 0)) {
          this.sounds.buildPlace();
        }
      }
    });

    // Handle inventory updates from server
    this.networkClient.onMessage('inventoryUpdated', (msg: any) => {
      if (typeof msg.inventory === 'number') {
        this.inventory = msg.inventory;
      }
    });

    this.networkClient.onMessage('resourcesUpdated', (msg: any) => {
      this.depositable = msg.depositable;
    });
    this.networkClient.onMessage('workshopsUpdated', (msg: any) => {
      this.workshops = msg.workshops as Workshops;
    });
    this.networkClient.onMessage('blueprintsUpdated', (msg: any) => {
      if (!Array.isArray(msg.blueprints)) return;
      const previous = this.craftedSlots;
      this.craftedSlots = msg.blueprints as BlueprintSlots;
      // Say what the bench just built; the slot update alone is invisible in a
      // busy HUD. Only a slot that went from empty to filled counts as a craft.
      const craftedAt = this.craftedSlots.findIndex((kind, i) => kind !== null && previous[i] === null);
      if (craftedAt >= 0) {
        const spec = emplacementSpec(this.craftedSlots[craftedAt]!);
        if (spec) this.showBenchMessage(`🔧 Crafted ${spec.kind} into slot ${craftedAt + 1} · -${spec.cost} blocks`);
      }
      // Placing a blueprint empties its slot, so the ghost must go away rather
      // than linger as a ghost the server would refuse.
      if (this.blueprintIndex !== null && !this.craftedSlots[this.blueprintIndex]) this.cancelBlueprint();
    });

    this.networkClient.onMessage('jeepsUpdated', (msg: any) => {
      if (Array.isArray(msg.jeeps)) this.applyJeeps(msg.jeeps as JeepSnapshot[]);
    });
    this.networkClient.onMessage('emplacementPreview', (msg: any) => {
      if (!this.ghost) return;
      this.ghostValid = msg.ok === true;
      if (this.ghostValid && msg.position) {
        // Adopt the server's snapped position so what you see is where it lands.
        this.ghostPosition = { x: msg.position.x, y: msg.position.y, z: msg.position.z };
        this.ghost.position.set(msg.position.x, msg.position.y, msg.position.z);
      }
      this.tintGhost(this.ghostValid);
    });
    this.networkClient.onMessage('emplacementsUpdated', (msg: any) => {
      if (Array.isArray(msg.emplacements)) this.applyEmplacements(msg.emplacements as EmplacementSnapshot[]);
    });
    this.networkClient.onMessage('spotReport', (msg: any) => {
      if (!Array.isArray(msg.contacts)) return;
      this.spottedContacts = (msg.contacts as SpotContact[]).filter((contact) => contact
        && typeof contact.id === 'string'
        && (contact.team === 'red' || contact.team === 'blue')
        && Number.isFinite(contact.position?.x)
        && Number.isFinite(contact.position?.y)
        && Number.isFinite(contact.position?.z));
      this.spotReportAt = performance.now();
    });
    this.networkClient.onMessage('emplacementDamaged', (msg: any) => {
      const m = msg as { emplacementId?: string; damage?: number; hp?: number; maxHp?: number };
      const id = typeof m.emplacementId === 'string' ? m.emplacementId : null;
      const hp = typeof m.hp === 'number' ? m.hp : null;
      const maxHp = typeof m.maxHp === 'number' ? m.maxHp : null;
      const damage = typeof m.damage === 'number' ? m.damage : 0;
      if (!id || maxHp == null) return;
      const snapshot = this.emplacedSnapshots.get(id);
      if (snapshot && hp !== null) snapshot.hp = hp;
      // Flash the build for a short beat so a far-away shot has visible
      // feedback even before the health bar reads out.
      if (damage > 0) {
        const intensity = Math.min(1, damage / maxHp);
        const teamColor = snapshot?.team === 'blue' ? 0x6aa0ff : 0xff7a5c;
        this.emplacementFlashes.set(id, {
          until: performance.now() + 180,
          color: new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), intensity),
        });
      }
    });
    this.networkClient.onMessage('emplacementMounted', (msg: any) => {
      this.mountedEmplacementId = typeof msg.emplacementId === 'string' ? msg.emplacementId : null;
      this.cancelBlueprint();
      this.weaponContainer.visible = false;
      if (msg.position) {
        this.player.position.set(msg.position.x, msg.position.y, msg.position.z);
        this.player.velocity.set(0, 0, 0);
        this.player.updateCamera();
      }
      const label = typeof msg.kind === 'string' ? (msg.kind === 'mgNest' ? 'MG nest' : msg.kind) : 'gun';
      this.showMessage(`🔫 Manning the ${label} · hold click to fire · F to step out`);
    });
    this.networkClient.onMessage('emplacementExited', (msg: any) => {
      this.mountedEmplacementId = null;
      this.isLeftDown = false;
      this.weaponContainer.visible = !this.isSpectating;
      if (msg.position) {
        this.player.position.set(msg.position.x, msg.position.y, msg.position.z);
        this.player.velocity.set(0, 0, 0);
        this.player.updateCamera();
      }
    });
    this.networkClient.onMessage('shellFired', (msg: any) => {
      if (!msg.position || !msg.velocity) return;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(msg.kind === 'mortar' ? 0.28 : 0.2, 8, 6),
        new THREE.MeshBasicMaterial({ color: msg.kind === 'mortar' ? 0x2b2b2b : 0x3a3a3a }),
      );
      this.scene.add(mesh);
      this.shells.set(msg.id, {
        mesh,
        spawn: new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z),
        velocity: new THREE.Vector3(msg.velocity.x, msg.velocity.y, msg.velocity.z),
        spawnedAt: performance.now() / 1000,
      });
    });
    this.networkClient.onMessage('shellImpact', (msg: any) => {
      const shell = this.shells.get(msg.id);
      if (shell) {
        this.scene.remove(shell.mesh);
        shell.mesh.geometry.dispose();
        (shell.mesh.material as THREE.Material).dispose();
        this.shells.delete(msg.id);
      }
      if (!msg.position) return;
      const radius = typeof msg.radius === 'number' && msg.radius > 0 ? msg.radius : 2;
      const material = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.6, 12, 8), material);
      mesh.position.set(msg.position.x, msg.position.y, msg.position.z);
      this.scene.add(mesh);
      this.shellBlasts.push({ mesh, material, until: performance.now() / 1000 + 0.35 });
    });
    this.networkClient.onMessage('emplacementMessage', (msg: any) => {
      if (typeof msg.message === 'string') this.showBenchMessage(msg.message);
    });
    // Ammo purchases answer on their own channel, but land on the same bench
    // feedback line (which also updates the HUD banner).
    this.networkClient.onMessage('ammoMessage', (msg: any) => {
      if (typeof msg.message === 'string') this.showBenchMessage(msg.message);
    });
    this.networkClient.onMessage('jeepExited', (msg: any) => {
      this.drivingJeepId = null;
      this.ridingJeepId = null;
      this.player.clearKeys();
      this.weaponContainer.visible = !this.isSpectating;
      if (msg.position) {
        this.player.position.set(msg.position.x, msg.position.y, msg.position.z);
        this.player.velocity.set(0, 0, 0);
        this.player.updateCamera();
      }
    });
    this.networkClient.onMessage('jeepMessage', (msg: any) => {
      if (typeof msg.message === 'string') this.showMessage(msg.message);
    });

    // Handle flag pickup
    this.networkClient.onMessage('flagPickedUp', (msg: any) => {
      const isLocal = msg.playerId === this.localPlayerId;
      const flag = msg.flagTeam === 'blue' ? this.blueFlag : this.redFlag;
      // Track server-authoritative carrier for online rendering
      if (msg.flagTeam === 'blue') {
        this.serverBlueFlagAtBase = false;
        this.serverBlueFlagCarrierId = msg.playerId;
      } else {
        this.serverRedFlagAtBase = false;
        this.serverRedFlagCarrierId = msg.playerId;
      }
      if (flag) {
        flag.isDropped = false;
        flag.isCaptured = false; // leaving the respawn-shadow state: it's carried now
        flag.capturedTimer = 0;
        flag.carrier = null;
        flag.mesh.visible = false; // Flag disappears when taken until returned
        flag.light.intensity = 0;
        if (isLocal) {
          this.player.carryingFlag = true;
          this.serverCarryingEnemyFlag = true;
          this.serverCarriedFlagTeam = msg.flagTeam === 'blue' ? 'blue' : 'red';
          this.sounds.flagPickup();
          this.showMessage(`🚩 YOU TOOK THE ${msg.flagTeam.toUpperCase()} FLAG! RUN TO BASE!`);
        } else {
          this.sounds.flagAlarm();
          this.showMessage(`⚠️ ${msg.flagTeam.toUpperCase()} FLAG TAKEN by Player ${msg.playerId.slice(-4)}!`);
        }
      }
    });

    // Handle flag dropped
    this.networkClient.onMessage('flagDropped', (msg: any) => {
      const flag = msg.flagTeam === 'blue' ? this.blueFlag : this.redFlag;
      // Server says the flag is no longer carried, it's on the ground now
      if (msg.flagTeam === 'blue') this.serverBlueFlagCarrierId = null;
      else this.serverRedFlagCarrierId = null;
      // If we were carrying that flag (server dropped it because we died),
      // clear our local carry state so the HUD stops telling us to run home
      if (msg.playerId === this.localPlayerId || flag?.carrier?.isPlayer) {
        this.player.carryingFlag = false;
        this.serverCarryingEnemyFlag = false;
        this.serverCarriedFlagTeam = null;
        if (flag) flag.carrier = null;
      }
      if (flag) {
        // Snap to solid ground beneath the reported death position so a flag
        // dropped mid-jump/on a slope never hangs in mid-air.
        const groundY = this.world.getGroundHeightBelow(
          msg.position.x, msg.position.y + 3, msg.position.z);
        flag.currentPos.set(msg.position.x, groundY + 0.5, msg.position.z);
        flag.mesh.position.copy(flag.currentPos);
        flag.carrier = null;
        flag.isDropped = true;
        flag.mesh.visible = true; // Dropped flag appears on battlefield!
        this.showMessage(`🚩 ${msg.flagTeam.toUpperCase()} FLAG DROPPED on the battlefield!`);
      }
    });

    // Handle flag returned
    this.networkClient.onMessage('flagReturned', (msg: any) => {
      const flag = msg.flagTeam === 'blue' ? this.blueFlag : this.redFlag;
      if (msg.flagTeam === 'blue') {
        this.serverBlueFlagAtBase = true;
        this.serverBlueFlagCarrierId = null;
      } else {
        this.serverRedFlagAtBase = true;
        this.serverRedFlagCarrierId = null;
      }
      if (flag) {
        this.resetFlagToBase(flag);
        this.showMessage(`🛡️ ${msg.flagTeam.toUpperCase()} FLAG RETURNED TO BASE!`);
      }
    });

    // Handle flag captured
    this.networkClient.onMessage('flagCaptured', (msg: any) => {
      this.blueCaptures = msg.captures.blue;
      this.redCaptures = msg.captures.red;
      // The server tells us WHICH FLAG was taken (the enemy flag). Prefer the
      // explicit flagTeam field; fall back to deriving it from the scoring
      // team for older servers. Blue scores by carrying the RED flag home.
      const capturedTeam: 'blue' | 'red' =
        msg.flagTeam === 'blue' || msg.flagTeam === 'red'
          ? msg.flagTeam
          : (msg.team === 'blue' ? 'red' : 'blue');
      const capturedFlag = capturedTeam === 'blue' ? this.blueFlag : this.redFlag;
      // Captured flag disappears and respawns after the server timer; clear
      // our authoritative tracking so visuals don't fight the event state
      if (capturedTeam === 'blue') {
        this.serverBlueFlagAtBase = false;
        this.serverBlueFlagCarrierId = null;
      } else {
        this.serverRedFlagAtBase = false;
        this.serverRedFlagCarrierId = null;
      }
      if (capturedFlag) {
        // Disappear upon capture!
        capturedFlag.carrier = null;
        capturedFlag.isDropped = false;
        capturedFlag.isCaptured = true;
        capturedFlag.capturedTimer = 8.0;
        capturedFlag.mesh.visible = false;
        capturedFlag.light.intensity = 0;
      }
      // The scored flag left play: wipe every backpack copy of it (including a
      // stale one on the scorer or any desynced carrier) so no ghost duplicate
      // lingers while the flag is in its respawn shadow.
      this.clearFlagCarriers(capturedTeam);
      this.sounds.flagCapture();
      if (msg.playerId === this.localPlayerId) {
        this.player.carryingFlag = false;
        this.serverCarryingEnemyFlag = false;
        this.serverCarriedFlagTeam = null;
        this.showMessage(`🏆 YOU CAPTURED THE ENEMY FLAG! (+1 SCORE) Flag respawns in 8s...`);
      } else {
        this.showMessage(`🏆 ${msg.team.toUpperCase()} TEAM SCORED A FLAG CAPTURE! Flag respawns in 8s...`);
      }
    });

    // Handle spectator toggled from other players
    this.networkClient.onMessage('roundUpdate', (msg: any) => {
      if (msg && msg.round) this.applyRoundSnapshot(msg.round as RoundSnapshot);
    });

    this.networkClient.onMessage('roundEnded', (msg: any) => {
      this.roundIsServerDriven = true;
      if (msg.captures) {
        this.blueCaptures = msg.captures.blue || 0;
        this.redCaptures = msg.captures.red || 0;
      }
      if (msg.wins) this.roundWins = { red: msg.wins.red || 0, blue: msg.wins.blue || 0 };
      this.roundWinner = (msg.winner || 'draw') as RoundWinner;
      this.roundWinnerTimer = 5;
      const label = this.roundWinner === 'draw'
        ? 'ROUND DRAWN'
        : `${String(this.roundWinner).toUpperCase()} TAKES ROUND ${msg.round}`;
      this.showMessage(
        `🏁 ${label} — ${this.blueCaptures}:${this.redCaptures} · next round in ${INTERMISSION_SECONDS}s`,
      );
    });

    this.networkClient.onMessage('pong', (msg: any) => {
      if (typeof msg?.t === 'number') {
        this.pingMs = Math.max(0, Math.round(Date.now() - msg.t));
      }
    });

    this.networkClient.onMessage('footstep', (msg: any) => {
      // Play footstep sound for other players using SoundManager
      const pan = Math.sin(Math.atan2(msg.position?.x || 0, msg.position?.z || 0) - this.player.yaw);
      this.sounds.playFootstepRemote(msg.volume, msg.pitch, pan);
    });

    // Server kicked/banned this client — show a clear message and stop reconnecting.
    this.networkClient.onMessage('kicked', (msg: any) => {
      const reason = msg.reason || 'no reason given';
      console.warn(`Kicked from server: ${reason} (banned=${msg.banned})`);
      this.showMessage(msg.banned ? `⛔ You have been BANNED: ${reason}` : `👢 You have been kicked: ${reason}`);
      try {
        this.networkClient?.disconnect();
      } catch {
        /* ignore */
      }
    });

    // The boot path owns "nobody answered": it waits for a real connection and
    // shows the loading screen's error card if none arrives, so an unreachable
    // server never turns into a silent local match that looks online.
    void this.networkClient.connect();
  }

  /** Client-side bots and local voxel edits: a normal offline bot match. An
   *  online session that cannot reach a server reports it on the loading screen
   *  instead of quietly turning into this. */
  private startLocalMatch(): void {
    this.gameMode = 'multiplayer';
    this.player.serverAuthoritativeRespawn = false;
    // Beta is the workshop/vehicle test bed, so an offline match owns both: the
    // client builds the sites the server would describe and drives its own jeeps.
    this.localPlayerId = this.localPlayerId ?? 'local-player';
    if (this.betaLabel) this.startLocalWorkshops();
    this.spawnTeamBots('blue', 6);
    this.spawnTeamBots('red', 7);
    if (this.betaLabel) {
      this.showMessage('🧪 Beta offline — bot match. Build a jeep at your workshop with G, board with F.');
    }
  }

  private addRemotePlayer(id: string, state: PlayerState): void {
    if (this.remotePlayers.has(id)) return;
    const { group: mesh } = this.createBotMesh(state.team as Team);
    mesh.position.set(state.position.x, state.position.y, state.position.z);

    const nameTag = this.createNameTag(state.team as Team, `Player ${id.slice(-4)}`);
    nameTag.position.y = 2.6;
    mesh.add(nameTag);

    this.scene.add(mesh);
    this.remotePlayers.set(id, {
      mesh,
      state,
      targetPosition: new THREE.Vector3(state.position.x, state.position.y, state.position.z),
      targetRotation: new THREE.Euler(0, state.rotation.yaw, 0, 'YXZ'),
      lastShootingTime: 0,
      damageFlashTimer: 0,
    });
    this.showMessage(`🎮 Player ${id.slice(-4)} (${state.team.toUpperCase()}) joined!`);
  }

  private removeRemotePlayer(id: string): void {
    const remote = this.remotePlayers.get(id);
    if (remote) {
      this.scene.remove(remote.mesh);
      this.remotePlayers.delete(id);
      this.showMessage(`Player ${id.slice(-4)} left the game.`);
    }
  }

  /* ---------- Tab-held scoreboard helpers ---------- */

  /** Get (creating if needed) the tally record for a combatant id. */
  private statFor(id: string): PlayerStats {
    let s = this.statsById.get(id);
    if (!s) {
      s = { kills: 0, deaths: 0, captures: 0 };
      this.statsById.set(id, s);
    }
    return s;
  }

  /** Build the full scoreboard payload: both teams, all players and bots,
   *  per-team flag-capture points, K/D tallies, top capturer and leader. */
  private buildScoreboard(): ScoreboardData {
    const online = this.gameMode === 'online';
    interface Entry extends ScoreboardRow { team: 'blue' | 'red' }
    const entries: Entry[] = [];

    if (online) {
      // Server-authoritative rows: every connected player + server bot.
      for (const [id, remote] of this.remotePlayers) {
        const st = this.statFor(id);
        entries.push({
          id,
          name: remote.state.name || `Player ${id.slice(-4)}`,
          isBot: !!remote.state.isBot,
          kills: st.kills, deaths: st.deaths, captures: st.captures,
          kd: st.deaths > 0 ? Math.round((st.kills / st.deaths) * 100) / 100 : st.kills,
          isLocalPlayer: false,
          isTopCapturer: false,
          team: remote.state.team === 'red' ? 'red' : 'blue',
        });
      }
      const meSt = this.statFor(this.localPlayerId || 'me');
      entries.push({
        id: this.localPlayerId || 'me',
        name: this.playerName || 'You',
        isBot: false,
        kills: meSt.kills, deaths: meSt.deaths, captures: meSt.captures,
        kd: meSt.deaths > 0 ? Math.round((meSt.kills / meSt.deaths) * 100) / 100 : meSt.kills,
        isLocalPlayer: true,
        isTopCapturer: false,
        team: this.playerTeam,
      });
    } else {
      // Local match: AI bots + the human player.
      for (const bot of this.bots) {
        const st = this.statFor(bot.name);
        entries.push({
          id: bot.name,
          name: bot.name,
          isBot: true,
          kills: st.kills, deaths: st.deaths, captures: st.captures,
          kd: st.deaths > 0 ? Math.round((st.kills / st.deaths) * 100) / 100 : st.kills,
          isLocalPlayer: false,
          isTopCapturer: false,
          team: bot.team,
        });
      }
      const meSt = this.statFor('you');
      entries.push({
        id: 'you',
        name: this.playerName || 'You',
        isBot: false,
        kills: meSt.kills, deaths: meSt.deaths, captures: meSt.captures,
        kd: meSt.deaths > 0 ? Math.round((meSt.kills / meSt.deaths) * 100) / 100 : meSt.kills,
        isLocalPlayer: true,
        isTopCapturer: false,
        team: this.playerTeam,
      });
    }

    // Top flag capturer across the whole match (🏅 badge).
    let top: Entry | null = null;
    for (const e of entries) {
      if (e.captures > 0 && (!top || e.captures > top.captures)) top = e;
    }
    if (top) top.isTopCapturer = true;

    const mkPanel = (team: 'blue' | 'red'): ScoreboardTeamPanel => ({
      team,
      points: team === 'blue' ? this.blueCaptures : this.redCaptures,
      killPoints: team === 'blue' ? this.blueKills : this.redKills,
      rows: entries
        .filter(e => e.team === team)
        .sort((a, b) => b.kills - a.kills || b.captures - a.captures || a.name.localeCompare(b.name)),
    });

    // Which side is on top: capture points first, kills as tiebreak.
    let leadingTeam: 'blue' | 'red' | null = null;
    if (this.blueCaptures !== this.redCaptures) {
      leadingTeam = this.blueCaptures > this.redCaptures ? 'blue' : 'red';
    } else if (this.blueKills !== this.redKills) {
      leadingTeam = this.blueKills > this.redKills ? 'blue' : 'red';
    }

    const own = mkPanel(this.playerTeam);
    const enemy = mkPanel(this.playerTeam === 'blue' ? 'red' : 'blue');
    return { teams: [own, enemy], leadingTeam, topCapturerName: top ? top.name : null };
  }

  private renderRemotePlayerShot(playerId: string, origin: Position, direction: Position, weaponType: string): void {
    const o = new THREE.Vector3(origin.x, origin.y, origin.z);
    const d = new THREE.Vector3(direction.x, direction.y, direction.z);
    const speed = weaponType === 'rifle' ? 300 : 230;
    const terrainHit = this.world.raycast(o, d, 350);
    const maxDist = terrainHit ? terrainHit.distance : 350;

    const remote = this.remotePlayers.get(playerId);
    let muzzlePos = o;
    let receiverPos = o;
    if (weaponType === 'mgNest' || weaponType === 'cannon' || weaponType === 'mortar') {
      // The gun is the build, not the gunner's rifle: fire the flash out of the
      // barrel marker of the emplacement standing at the reported origin.
      const build = [...this.emplacedSnapshots.values()].find((candidate) => !candidate.wreck
        && candidate.kind === weaponType
        && Math.hypot(candidate.position.x - origin.x, candidate.position.z - origin.z) < 3.5
        && Math.abs(candidate.position.y - origin.y) < 3.5);
      const buildMesh = build ? this.emplacementMeshes.get(build.id) : undefined;
      if (buildMesh) buildMesh.updateMatrixWorld(true);
      const marker = buildMesh?.getObjectByName('emplacementMuzzle');
      muzzlePos = marker ? marker.getWorldPosition(new THREE.Vector3()) : o.clone().addScaledVector(d, 1.0);
    } else if (remote) {
      remote.mesh.updateMatrixWorld(true);
      const muzzleObj = remote.mesh.getObjectByName('barrelMuzzle');
      const ejectionObj = remote.mesh.getObjectByName('ejectionPort');
      if (muzzleObj) {
        muzzlePos = new THREE.Vector3();
        muzzleObj.getWorldPosition(muzzlePos);
      }
      if (ejectionObj) {
        receiverPos = new THREE.Vector3();
        ejectionObj.getWorldPosition(receiverPos);
      }
    }

    this.createMuzzleFlash(muzzlePos, d);
    // A shell's flight is drawn from where the server spawned it; only the
    // flash moves to the barrel.
    const tracerStart = weaponType === 'cannon' || weaponType === 'mortar' ? o : muzzlePos;
    this.createBulletTracer(tracerStart, d, maxDist, speed);
    // A belt-fed nest throws brass too, but its receiver is inside the model.
    if (weaponType !== 'mgNest') this.createBulletShell(receiverPos, d, true);
    if (weaponType === 'smg') {
      this.sounds.smgShot();
    } else {
      this.sounds.rifleShot();
    }
  }

  private onResize(): void {
    this.player.camera.aspect = window.innerWidth / window.innerHeight;
    this.player.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ---------------- Blueprint placement (Phase 4 prototype) --------------
  // Three slots on 5/6/7. The ghost is advisory only: every green/red tint comes
  // from the server's own placement rules, and a click just sends the intent.

  private toggleBlueprint(index: number): void {
    if (!this.benchEnabled || this.isSpectating || this.player.isDead || this.drivingJeepId) return;
    const kind = this.craftedSlots[index];
    if (!kind) {
      this.clearGhost();
      this.blueprintIndex = null;
      this.showMessage(`Slot ${index + 1} is empty — press B at the bench to craft it`);
      return;
    }
    if (this.blueprintIndex === index) { this.cancelBlueprint(); return; }
    this.clearGhost();
    const spec = emplacementSpec(kind);
    if (!spec) return;
    this.blueprintIndex = index;
    // Armed builds start facing the enemy so a mortar never has to be spun
    // around before it is useful; Q still nudges the facing.
    const enemyFlag = this.playerTeam === 'blue' ? RED_FLAG_POS : BLUE_FLAG_POS;
    this.ghostYaw = spec.arc > 0
      ? Math.atan2(-(enemyFlag.x - this.player.position.x), -(enemyFlag.z - this.player.position.z))
      : 0;
    this.ghostValid = false;
    this.ghostRequestedAt = 0;
    this.ghostMaterial = new THREE.MeshStandardMaterial({ color: 0xe04949, transparent: true, opacity: 0.45, depthWrite: false });
    this.ghost = this.createEmplacementMesh(kind, this.ghostMaterial);
    this.ghost.visible = false;
    this.ghost.rotation.y = this.ghostYaw;
    this.scene.add(this.ghost);
    this.showMessage(`🔧 ${spec.kind} blueprint in slot ${index + 1} · aimed at the enemy · Q adjust · click place · right-click cancel`);
  }

  /** B at the bench opens the build menu. Opening it frees the cursor so the
   *  pointer can reach the buttons, like the workshop pad does for E/G. */
  private toggleBenchMenu(): void {
    if (this.benchMenuOpen) { this.closeBenchMenu(); return; }
    if (!this.benchOpen || this.isSpectating || this.player.isDead || this.drivingJeepId) {
      this.showMessage('Stand at your blueprint bench to craft');
      return;
    }
    this.benchMenuOpen = true;
    this.benchFeedback = '';
    // A ghost left over from a previous pick would sit behind the panel.
    this.cancelBlueprint();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Close the bench menu and hand the mouse back to the game. */
  closeBenchMenu(): void {
    if (!this.benchMenuOpen) return;
    this.benchMenuOpen = false;
    // Re-locking needs a user gesture; closing from a click on the panel has
    // one, closing from a key press falls back to the canvas click path, so a
    // rejected request must not surface as an unhandled promise.
    if (!document.pointerLockElement) this.tryPointerLock();
  }

  /** Show craft feedback in the bench menu as well as the normal HUD line. The
   *  overlay covers the message banner, so a refusal would otherwise look like
   *  a dead click. */
  private showBenchMessage(msg: string): void {
    this.showMessage(msg);
    if (this.benchMenuOpen) this.benchFeedback = msg;
  }

  /** Craft one build into one slot from the menu. The server owns the cost, the
   *  reach check and the slot, so this only states the intent. */
  craftFromBench(kind: EmplacementKind, slot: number): void {
    if (!this.benchOpen) { this.showBenchMessage('Stand at your blueprint bench to craft'); return; }
    if (this.gameMode !== 'online') { this.craftLocalBlueprint(kind, slot); return; }
    this.networkClient?.send({ type: 'craftBlueprint', kind, slot });
  }

  /** Buy one magazine at the bench. The server validates reach, team stock and
   *  pouch space, and the Buy row only renders online. */
  buyAmmo(): void {
    if (!this.benchOpen) { this.showBenchMessage('Stand at your blueprint bench to buy ammo'); return; }
    this.networkClient?.send({ type: 'craftAmmo' });
  }

  /** Buy one carried shell pack at the bench; R loads it beside a gun. */
  buyShellPack(): void {
    if (!this.benchOpen) { this.showBenchMessage('Stand at your blueprint bench to buy a shell pack'); return; }
    this.networkClient?.send({ type: 'craftShellPack' });
  }

  /** The friendly cannon or mortar an R press would load: the manned one, or
   *  the nearest one inside use reach. */
  private shellPackCandidate(): EmplacementSnapshot | null {
    const isShellGun = (gun: EmplacementSnapshot) =>
      !gun.wreck && (gun.kind === 'cannon' || gun.kind === 'mortar') && gun.team === this.playerTeam;
    if (this.mountedEmplacementId) {
      const mounted = this.emplacedSnapshots.get(this.mountedEmplacementId);
      return mounted && isShellGun(mounted) ? mounted : null;
    }
    let best: EmplacementSnapshot | null = null;
    let bestDistanceSq = Infinity;
    const reachSq = EMPLACEMENT_USE_REACH * EMPLACEMENT_USE_REACH;
    for (const gun of this.emplacedSnapshots.values()) {
      if (!isShellGun(gun)) continue;
      const distanceSq = distanceSquared(this.player.position, gun.position);
      if (distanceSq > reachSq || distanceSq >= bestDistanceSq) continue;
      best = gun;
      bestDistanceSq = distanceSq;
    }
    return best;
  }

  /** Ask the server to load a shell pack into the gun in reach. */
  loadShellPack(): void {
    const gun = this.shellPackCandidate();
    if (gun) this.networkClient?.send({ type: 'loadShellPack', emplacementId: gun.id });
  }

  /** One-click bench path: craft into the first free slot. */
  craftFromBenchNext(kind: EmplacementKind): void {
    const slot = this.craftedSlots.findIndex((entry) => entry === null);
    if (slot === -1) { this.showBenchMessage('All three slots are full — place one first'); return; }
    this.craftFromBench(kind, slot);
  }

  /** The bench is Beta's (or an online server's) to show; offline Beta runs it
   *  here, and a plain local match leaves builds to the server-backed modes. */
  private get benchEnabled(): boolean {
    return this.betaLabel || this.gameMode === 'online';
  }

  private cancelBlueprint(): void {
    if (this.blueprintIndex === null) return;
    this.blueprintIndex = null;
    this.clearGhost();
  }

  private clearGhost(): void {
    if (!this.ghost) return;
    this.scene.remove(this.ghost);
    this.ghost.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    this.ghostMaterial?.dispose();
    this.ghost = null;
    this.ghostMaterial = null;
    this.ghostPosition = null;
    this.ghostValid = false;
  }

  /** Blocky models for every build. Each armed one carries its gun on a pivot
   *  named `gunPivot` so the barrel follows the nest's aim, plus a marker named
   *  `emplacementMuzzle` where the flash and tracer start. */
  private createEmplacementMesh(
    kind: EmplacementKind,
    material: THREE.Material,
    weaponMaterial: THREE.Material = material,
  ): THREE.Group {
    const group = new THREE.Group();
    const box = (
      parent: THREE.Object3D, w: number, h: number, d: number,
      x: number, y: number, z: number, mat: THREE.Material = material,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y + h / 2, z);
      // Remember the paint so a damage flash can restore it exactly.
      mesh.userData.baseColor = (mat as THREE.MeshStandardMaterial).color?.getHex?.() ?? 0xffffff;
      parent.add(mesh);
      return mesh;
    };
    // The gun swings inside the build's arc; the base it stands on does not.
    const pivot = new THREE.Group();
    pivot.name = 'gunPivot';
    group.add(pivot);
    const muzzle = (y: number, z: number) => {
      const marker = new THREE.Object3D();
      marker.name = 'emplacementMuzzle';
      marker.position.set(0, y, z);
      pivot.add(marker);
    };

    if (kind === 'mgNest') {
      // Low sandbag parapet with a pintle-mounted MG in the middle: receiver,
      // jacket and a long barrel have to read as a machine gun from 10 m out.
      box(group, 2.2, 0.3, 2.2, 0, 0, 0);
      box(group, 0.34, 0.75, 1.95, -0.93, 0.3, 0);
      box(group, 0.34, 0.75, 1.95, 0.93, 0.3, 0);
      box(group, 2.2, 0.75, 0.34, 0, 0.3, 0.93);
      box(group, 0.18, 0.9, 0.18, 0, 0.6, 0.1, weaponMaterial);
      box(pivot, 0.9, 0.55, 0.12, 0, 0.85, -0.72, weaponMaterial);
      box(pivot, 0.5, 0.42, 1.15, 0, 1.02, 0.05, weaponMaterial);
      box(pivot, 0.3, 0.3, 0.55, 0, 1.08, -0.72, weaponMaterial);
      box(pivot, 0.16, 0.16, 1.25, 0, 1.15, -1.45, weaponMaterial);
      box(pivot, 0.42, 0.34, 0.4, 0.42, 0.95, 0.18, weaponMaterial);
      muzzle(1.23, -2.08);
    } else if (kind === 'cannon') {
      box(group, 1.9, 0.3, 1.9, 0, 0, 0);
      box(group, 0.28, 0.85, 0.85, -1.0, 0.15, 0.35, weaponMaterial);
      box(group, 0.28, 0.85, 0.85, 1.0, 0.15, 0.35, weaponMaterial);
      box(pivot, 1.7, 0.9, 0.14, 0, 0.35, -0.75, weaponMaterial);
      box(pivot, 0.55, 0.55, 0.7, 0, 0.75, 0.05, weaponMaterial);
      box(pivot, 0.28, 0.28, 2.2, 0, 0.9, -1.25, weaponMaterial);
      muzzle(1.04, -2.35);
    } else if (kind === 'mortar') {
      box(group, 1.3, 0.18, 1.3, 0, 0, 0);
      box(group, 0.12, 0.85, 0.12, -0.45, 0.15, -0.25, weaponMaterial);
      box(group, 0.12, 0.85, 0.12, 0.45, 0.15, -0.25, weaponMaterial);
      const tube = box(pivot, 0.26, 1.9, 0.26, 0, 0.35, -0.2, weaponMaterial);
      tube.rotation.x = -0.55; // elevated toward -z, the mortar's lob
      muzzle(1.3 + Math.cos(0.55) * 0.95, -0.2 - Math.sin(0.55) * 0.95);
    } else if (kind === 'supplyCrate') {
      box(group, 1.4, 1.0, 1.4, 0, 0, 0);
      box(group, 1.5, 0.12, 1.5, 0, 1.0, 0);
      box(group, 1.46, 0.14, 0.16, 0, 0.3, 0.66, weaponMaterial);
      box(group, 1.46, 0.14, 0.16, 0, 0.7, 0.66, weaponMaterial);
    } else {
      box(group, 0.16, 3.6, 0.16, -0.5, 0, -0.5);
      box(group, 0.16, 3.6, 0.16, 0.5, 0, -0.5);
      box(group, 0.16, 3.6, 0.16, -0.5, 0, 0.5);
      box(group, 0.16, 3.6, 0.16, 0.5, 0, 0.5);
      box(group, 1.5, 0.16, 1.5, 0, 3.6, 0);
      box(group, 1.5, 0.12, 0.12, 0, 4.2, -0.69, weaponMaterial);
      box(group, 1.5, 0.12, 0.12, 0, 4.2, 0.69, weaponMaterial);
      box(group, 0.12, 0.12, 1.5, -0.69, 4.2, 0, weaponMaterial);
      box(group, 0.12, 0.12, 1.5, 0.69, 4.2, 0, weaponMaterial);
      box(group, 0.3, 0.4, 0.3, 0, 3.76, 0, weaponMaterial);
    }
    return group;
  }

  /** A mannable nest of your team within reach, or null. */
  private nearbyMannableEmplacement(): EmplacementSnapshot | null {
    if (!this.benchEnabled) return null;
    const reachSq = EMPLACEMENT_MOUNT_REACH * EMPLACEMENT_MOUNT_REACH;
    let best: EmplacementSnapshot | null = null;
    let bestDistanceSq = Infinity;
    for (const snapshot of this.emplacedSnapshots.values()) {
      if (snapshot.wreck || !MANNED_EMPLACEMENTS.includes(snapshot.kind)) continue;
      if (snapshot.team !== this.playerTeam || snapshot.gunnerId) continue;
      const distanceSq = distanceSquared(this.player.position, snapshot.position);
      if (distanceSq <= reachSq && distanceSq < bestDistanceSq) {
        best = snapshot;
        bestDistanceSq = distanceSq;
      }
    }
    return best;
  }

  /** The friendly build or jeep the dismantle key would tear down, or null. The
   *  key and the HUD hint share this so they always agree on the target.
   *
   *  A build in reach always wins over a jeep, even a nearer one. The key used
   *  to take whichever was closest, so a jeep parked beside a nest swallowed
   *  the press meant for the nest and the squad lost its gun instead. */
  private dismantleCandidate(): { type: 'build' | 'jeep'; id: string } | null {
    if (!this.benchEnabled || this.player.isDead || this.mountedEmplacementId || this.drivingJeepId || this.ridingJeepId) return null;
    const reachSq = EMPLACEMENT_USE_REACH * EMPLACEMENT_USE_REACH;
    let bestBuild: string | null = null;
    let bestBuildDistanceSq = reachSq;
    for (const snapshot of this.emplacedSnapshots.values()) {
      if (snapshot.team !== this.playerTeam || snapshot.wreck) continue;
      const distanceSq = distanceSquared(this.player.position, snapshot.position);
      if (distanceSq <= bestBuildDistanceSq) { bestBuild = snapshot.id; bestBuildDistanceSq = distanceSq; }
    }
    if (bestBuild) return { type: 'build', id: bestBuild };
    let bestJeep: string | null = null;
    let bestJeepDistanceSq = reachSq;
    for (const { state } of this.jeeps.values()) {
      if (state.team !== this.playerTeam || state.wreck) continue;
      const distanceSq = distanceSquared(this.player.position, state.position);
      if (distanceSq <= bestJeepDistanceSq) { bestJeep = state.id; bestJeepDistanceSq = distanceSq; }
    }
    return bestJeep ? { type: 'jeep', id: bestJeep } : null;
  }

  /** An own-team supply crate within reach, or null. */
  private nearbySupplyCrate(): EmplacementSnapshot | null {
    if (!this.benchEnabled) return null;
    const reachSq = EMPLACEMENT_USE_REACH * EMPLACEMENT_USE_REACH;
    let best: EmplacementSnapshot | null = null;
    let bestDistanceSq = Infinity;
    for (const snapshot of this.emplacedSnapshots.values()) {
      if (snapshot.wreck || snapshot.kind !== 'supplyCrate' || snapshot.team !== this.playerTeam) continue;
      const distanceSq = distanceSquared(this.player.position, snapshot.position);
      if (distanceSq <= reachSq && distanceSq < bestDistanceSq) {
        best = snapshot;
        bestDistanceSq = distanceSq;
      }
    }
    return best;
  }

  /** Place, move, turn and remove the meshes for the server's emplacements.
   *  They are static props, so each broadcast only touches what changed. */
  private applyEmplacements(list: EmplacementSnapshot[]): void {
    const seen = new Set<string>();
    for (const snapshot of list) {
      seen.add(snapshot.id);
      this.emplacedSnapshots.set(snapshot.id, snapshot);
      let mesh = this.emplacementMeshes.get(snapshot.id);
      if (!mesh) {
        const material = new THREE.MeshStandardMaterial({
          color: snapshot.team === 'blue' ? 0x4a6fa8 : 0xa8544a,
          roughness: 0.85,
        });
        // Guns are bare metal, not team paint: a sandbag nest should not hide
        // its barrel just because the base is blue or red.
        const weaponMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.55, roughness: 0.4 });
        mesh = this.createEmplacementMesh(snapshot.kind, material, weaponMaterial);
        this.scene.add(mesh);
        this.emplacementMeshes.set(snapshot.id, mesh);
        this.attachHealthBar(snapshot.id, snapshot.team, emplacementSpec(snapshot.kind)?.height ?? 1.6);
      }
      mesh.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      // The placement faces baseYaw; the gun tracks the gunner's aim on top.
      mesh.rotation.y = snapshot.baseYaw;
      const pivot = mesh.getObjectByName('gunPivot');
      if (pivot) pivot.rotation.y = snapshot.yaw - snapshot.baseYaw;
      // The server also sends an explicit exit, but never leave the camera
      // seated in a build that is now only a smoking husk.
      if (snapshot.wreck && snapshot.id === this.mountedEmplacementId) {
        this.mountedEmplacementId = null;
        this.weaponContainer.visible = !this.isSpectating;
      }
      if (snapshot.wreck && mesh.userData.charred !== true) {
        mesh.userData.charred = true;
        this.charMesh(mesh);
      }
      // A wreck has no health bar: it is already past zero and only smoking out.
      const maxHp = emplacementSpec(snapshot.kind)?.maxHp ?? 0;
      this.updateHealthBarVisibility(snapshot.id, snapshot.wreck ? maxHp : snapshot.hp, maxHp);
      if (snapshot.wreck) this.syncWreckSmoke(`build:${snapshot.id}`, snapshot.position);
    }

    for (const [id, mesh] of this.emplacementMeshes) {
      if (seen.has(id)) continue;
      this.syncWreckSmoke(`build:${id}`, null);
      // Destroyed or cleared with the round: the seat goes with it.
      if (id === this.mountedEmplacementId) {
        this.mountedEmplacementId = null;
        this.weaponContainer.visible = !this.isSpectating;
      }
      this.scene.remove(mesh);
      this.detachHealthBar(id);
      this.emplacementFlashes.delete(id);
      mesh.traverse((object) => {
        const part = object as THREE.Mesh;
        part.geometry?.dispose();
        const material = part.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      });
      this.emplacementMeshes.delete(id);
      this.emplacedSnapshots.delete(id);
    }
  }

  /** One trigger pull at the nest. The server rate-limits and aims it. */
  private fireMannedEmplacement(): void {
    const now = performance.now();
    if (now - this.lastEmplacementFire < 100) return;
    this.lastEmplacementFire = now;
    if (this.gameMode !== 'online') { this.fireLocalEmplacement(); return; }
    // The mortar is indirect fire: name the ground point under the crosshair so
    // the server lands the round inside the ring the trajectory marker shows.
        const mounted = this.mountedEmplacementId ? this.emplacedSnapshots.get(this.mountedEmplacementId) : null;
    if (mounted?.wreck) return;
    const spec = mounted ? emplacementSpec(mounted.kind) : undefined;
    if (mounted?.kind === 'mortar' && spec) {
      const target = this.shellAimPoint(spec, mounted.position, mounted.yaw);
      if (!target) { this.showMessage('Aim the mortar at the ground ahead'); return; }
      this.networkClient?.send({ type: 'fireEmplacement', target });
      return;
    }
    this.networkClient?.send({ type: 'fireEmplacement' });
  }

  /**
   * Ground point under the crosshair, clamped into a weapon's range band.
   *
   * This is the point a mortar is solved to hit: the client sends it with the
   * shot and draws the landing marker there, so no turret spinning is needed
   * and the round lands where the player is looking.
   */
  private shellAimPoint(spec: EmplacementSpec, from: Position, fallbackYaw: number): Position | null {
    const origin = this.player.camera.position.clone();
    const direction = this.player.getAimDirection();
    const hit = this.world.raycast(origin, direction, spec.maxRange);
    let dx: number;
    let dz: number;
    if (hit) {
      dx = hit.voxelPos.x + 0.5 - from.x;
      dz = hit.voxelPos.z + 0.5 - from.z;
    } else {
      // No terrain under the crosshair (looking at the sky, or down the map):
      // keep the shot on the battlefield at maximum range, using the horizontal
      // look direction and falling back to the gun's own facing when the player
      // is looking straight up or down.
      let dirX = direction.x;
      let dirZ = direction.z;
      const horizontal = Math.hypot(dirX, dirZ);
      if (horizontal < 0.2) {
        dirX = -Math.sin(fallbackYaw);
        dirZ = -Math.cos(fallbackYaw);
      } else {
        dirX /= horizontal;
        dirZ /= horizontal;
      }
      dx = dirX * spec.maxRange;
      dz = dirZ * spec.maxRange;
    }
    const flat = Math.hypot(dx, dz);
    if (!Number.isFinite(flat) || flat < 1e-3) return null;

    const capped = Math.min(Math.max(flat, spec.minRange), spec.maxRange);
    const x = from.x + (dx / flat) * capped;
    const z = from.z + (dz / flat) * capped;
    if (Math.abs(x) >= WORLD_HALF - 1 || Math.abs(z) >= WORLD_HALF - 1) return null;
    return { x, y: this.world.getGroundHeight(x, z), z };
  }

  /** The aimed landing point of the manned mortar, for the HUD coordinate
   *  readout. This is the ring centre, before the round's own scatter. */
  private mannedMortarAim(): { x: number; z: number; range: number } | null {
    const mounted = this.mountedEmplacementId ? this.emplacedSnapshots.get(this.mountedEmplacementId) : undefined;
    if (!mounted || mounted.wreck || mounted.kind !== 'mortar') return null;
    const aim = this.shellAimPoint(EMPLACEMENTS.mortar, mounted.position, mounted.yaw);
    if (!aim) return null;
    return {
      x: aim.x,
      z: aim.z,
      range: Math.hypot(aim.x - mounted.position.x, aim.z - mounted.position.z),
    };
  }

  /** Bodies and hardware a shell stops on, in the exact shape the shared
   *  `shellStopsAt` test expects. Both the preview ring and the offline
   *  projectile use this list, so a jeep in the way stops the round at the
   *  marker instead of a metre short of it (or a metre past). */
  private shellObstacles(): ShellObstacle[] {
    const obstacles: ShellObstacle[] = [];
    for (const { state } of this.jeeps.values()) {
      if (state.wreck) continue;
      obstacles.push({ kind: 'footprint', team: state.team, position: state.position, footprint: vehicleSpec(state.kind) });
    }
    for (const jeep of this.localJeeps) {
      if (jeep.wreck) continue;
      obstacles.push({ kind: 'footprint', team: jeep.team, position: jeep.position, footprint: vehicleSpec(jeep.kind) });
    }
    for (const bot of this.bots) {
      if (bot.isDead) continue;
      obstacles.push({ kind: 'body', team: bot.team, position: bot.position });
    }
    for (const remote of this.remotePlayers.values()) {
      if (remote.state.isDead) continue;
      obstacles.push({ kind: 'body', team: remote.state.team, position: remote.mesh.position });
    }
    for (const emplacement of this.emplacedSnapshots.values()) {
      if (emplacement.wreck) continue;
      const spec = emplacementSpec(emplacement.kind);
      if (!spec) continue;
      obstacles.push({ kind: 'footprint', team: emplacement.team, position: emplacement.position, footprint: spec });
    }
    return obstacles;
  }

  /** Draw (or refresh) the manned cannon/mortar arc and landing ring. */
  private updateShellPreview(): void {
    const mounted = this.mountedEmplacementId ? this.emplacedSnapshots.get(this.mountedEmplacementId) : null;
    const kind = mounted?.kind;
    const spec = mounted && !mounted.wreck && (kind === 'cannon' || kind === 'mortar') ? emplacementSpec(kind) : undefined;
    if (!mounted || !spec || !kind) { this.hideShellPreview(); return; }

    const isMortar = kind === 'mortar';
    const aim = isMortar ? this.shellAimPoint(spec, mounted.position, mounted.yaw) : null;
    if (isMortar && !aim) { this.hideShellPreview(); return; }

    const forward = { x: -Math.sin(mounted.yaw), z: -Math.cos(mounted.yaw) };
    const muzzleOffset = isMortar ? 1.0 : 1.6;
    const origin = {
      x: mounted.position.x + forward.x * muzzleOffset,
      y: mounted.position.y + 1.2,
      z: mounted.position.z + forward.z * muzzleOffset,
    };
    const pitch = Math.max(-EMPLACEMENT_MAX_PITCH, Math.min(EMPLACEMENT_MAX_PITCH, this.player.pitch));
    const cos = Math.cos(pitch);
    const velocity = isMortar && aim
      ? ballisticVelocity(origin, aim, MORTAR_SHELL_SPEED, EMPLACEMENT_SHELL_GRAVITY, 'high')
      : {
        x: forward.x * CANNON_SHELL_SPEED * cos,
        y: Math.sin(pitch) * CANNON_SHELL_SPEED,
        z: forward.z * CANNON_SHELL_SPEED * cos,
      };
    if (!velocity) { this.hideShellPreview(); return; }

    // Same integration and gravity the server steps shells with, so this line
    // ends on the aimed point; a mortar burst may scatter inside the ring.
    const obstacles = this.shellObstacles();
    const arc = shellArc(origin, velocity, {
      gravity: EMPLACEMENT_SHELL_GRAVITY,
      // Small steps so a shell cannot tunnel through a 2m-wide body between
      // samples: a cannon round covers 2.1m per step at 85 m/s.
      step: SHELL_STEP,
      maxTime: 10,
      groundAt: (x, z) => this.world.getGroundHeight(x, z),
      solidAt: (point) => this.world.isSolid(Math.round(point.x), Math.round(point.y), Math.round(point.z)),
      stopAt: (point) => shellStopsAt(point, mounted.team, obstacles),
    });

    if (!this.shellPreviewLine) {
      const geometry = new THREE.BufferGeometry();
      this.shellPreviewLine = new THREE.Line(
        geometry,
        // Amber reads against both the grass and the pale sky; the old sky
        // blue disappeared into the horizon at the exact range it was aimed at.
        new THREE.LineBasicMaterial({ color: 0xffc247, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      this.shellPreviewLine.frustumCulled = false;
      this.scene.add(this.shellPreviewLine);
    }
    const positions: number[] = [];
    for (const point of arc.points) positions.push(point.x, point.y, point.z);
    const lineGeometry = this.shellPreviewLine.geometry as THREE.BufferGeometry;
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    lineGeometry.computeBoundingSphere();
    // A mortar hides the line on dismount; the next cannon must bring it back.
    this.shellPreviewLine.visible = true;

    const radius = isMortar ? MORTAR_BLAST_RADIUS : CANNON_BLAST_RADIUS;
    if (!this.shellPreviewMarker || this.shellPreviewRadius !== radius) {
      if (this.shellPreviewMarker) {
        this.scene.remove(this.shellPreviewMarker);
        this.shellPreviewMarker.geometry.dispose();
        (this.shellPreviewMarker.material as THREE.Material).dispose();
      }
      const material = new THREE.MeshBasicMaterial({ color: 0xffc247, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      this.shellPreviewMarker = new THREE.Mesh(new THREE.RingGeometry(radius * 0.25, radius, 32), material);
      this.shellPreviewMarker.rotation.x = -Math.PI / 2;
      this.scene.add(this.shellPreviewMarker);
      this.shellPreviewRadius = radius;
    }
    // Lift the ring clear of the turf: at ground height it z-fought the grass
    // and read as no marker at all from the gunner's seat.
    this.shellPreviewMarker.position.set(arc.impact.x, arc.impact.y + 0.22, arc.impact.z);
    this.shellPreviewMarker.visible = true;
  }

  private hideShellPreview(): void {
    if (this.shellPreviewLine) this.shellPreviewLine.visible = false;
    if (this.shellPreviewMarker) this.shellPreviewMarker.visible = false;
  }

  /** A small bar hovering just above the build: full = hidden, empty = fully red. */
  private attachHealthBar(id: string, team: 'red' | 'blue', height: number): void {
    const color = team === 'blue' ? 0x4a6fa8 : 0xa8544a;
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 0.2),
      new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    bg.position.set(0, height + 0.6, 0);
    bg.rotation.x = -0.35;
    const barMat = new THREE.MeshBasicMaterial({ color, depthWrite: false });
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(2.24, 0.13), barMat);
    bar.position.set(0, height + 0.6, 0.001);
    bar.rotation.x = -0.35;
    // Keep the bar glued to the build: parent it to the emplacement group so it
    // moves/rotates with the mesh, but keep its scale in local space.
    const mesh = this.emplacementMeshes.get(id);
    if (mesh) mesh.add(bg);
    if (mesh) mesh.add(bar);
    this.emplacementHealthBars.set(id, { bar, bg, material: barMat });
  }

  private detachHealthBar(id: string): void {
    const entry = this.emplacementHealthBars.get(id);
    if (!entry) return;
    entry.bar.geometry.dispose();
    entry.bg.geometry.dispose();
    entry.material.dispose();
    entry.bar.removeFromParent();
    entry.bg.removeFromParent();
    this.emplacementHealthBars.delete(id);
  }

  private updateHealthBarVisibility(id: string, hp: number, maxHp: number): void {
    const entry = this.emplacementHealthBars.get(id);
    if (!entry) return;
    const fraction = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
    const visible = fraction < 1;
    entry.bar.visible = visible;
    entry.bg.visible = visible;
    if (visible) {
      entry.bar.scale.x = fraction;
      entry.bar.position.x = -1.12 * (1 - fraction);
    }
  }

  /** Per-frame decay of hit flashes; resets the material tint when done. */
  private updateEmplacementFlashes(now: number): void {
    for (const [id, flash] of this.emplacementFlashes) {
      if (now >= flash.until) {
        this.emplacementFlashes.delete(id);
        const mesh = this.emplacementMeshes.get(id);
        if (!mesh) continue;
        // Reset each part to the paint it was built with (team base, bare gun),
        // or keep a destroyed build charred once its death flash fades.
        const wrecked = Boolean(this.emplacedSnapshots.get(id)?.wreck);
        mesh.traverse((object) => {
          const part = object as THREE.Mesh;
          if (!part.isMesh) return;
          const mats = Array.isArray(part.material) ? part.material : [part.material];
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial) {
              m.color.setHex(wrecked ? WRECK_CHAR_COLOR : (typeof part.userData.baseColor === 'number' ? part.userData.baseColor : 0x9a9a9a));
              m.emissive.setHex(0x000000);
            }
          }
        });
        continue;
      }
      // While flashing: tint each material toward the flash color.
      const mesh = this.emplacementMeshes.get(id);
      if (!mesh) continue;
      const t = 1 - (flash.until - now) / 180;
      mesh.traverse((object) => {
        const part = object as THREE.Mesh;
        if (!part.isMesh) return;
        const mats = Array.isArray(part.material) ? part.material : [part.material];
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial) {
            const baseColor = new THREE.Color(typeof part.userData.baseColor === 'number' ? part.userData.baseColor : 0x9a9a9a);
            m.color.copy(baseColor).lerp(flash.color, Math.max(0, 1 - t * 2));
            m.emissive.copy(flash.color).multiplyScalar(Math.max(0, 0.6 * (1 - t)));
          }
        }
      });
    }
  }

  private tintGhost(valid: boolean): void {
    this.ghostMaterial?.color.setHex(valid ? 0x49e06a : 0xe04949);
  }

  private updateGhost(): void {
    if (this.blueprintIndex === null || !this.ghost) return;
    const kind = this.craftedSlots[this.blueprintIndex];
    if (!kind) return;
    const hit = this.world.raycast(this.player.camera.position.clone(), this.player.getAimDirection(), 8);
    if (!hit) { this.ghost.visible = false; this.ghostValid = false; return; }
    const spot = { x: Math.round(hit.voxelPos.x), y: Math.round(hit.voxelPos.y) + 1, z: Math.round(hit.voxelPos.z) };
    this.ghostPosition = spot;
    this.ghost.position.set(spot.x, spot.y, spot.z);
    this.ghost.rotation.y = this.ghostYaw;
    this.ghost.visible = true;
    const now = performance.now();
    if (now - this.ghostRequestedAt >= LOCAL_EMPLACEMENT_PREVIEW_INTERVAL) {
      this.ghostRequestedAt = now;
      if (this.gameMode === 'online') {
        this.networkClient?.send({ type: 'previewEmplacement', kind, position: spot, yaw: this.ghostYaw, slot: this.blueprintIndex });
      } else {
        // Offline the ghost is judged by the same rules a placement uses, so a
        // green tint really means the click will build.
        const verdict = this.localEmplacementSpot(kind, spot, this.ghostYaw);
        this.ghostValid = verdict.ok;
        if (verdict.ok) {
          this.ghostPosition = verdict.spot;
          this.ghost.position.set(verdict.spot.x, verdict.spot.y, verdict.spot.z);
        }
        this.tintGhost(verdict.ok);
      }
    }
  }

  private placeBlueprint(): void {
    if (this.blueprintIndex === null || !this.ghostPosition || !this.ghostValid) return;
    const kind = this.craftedSlots[this.blueprintIndex];
    if (!kind) return;
    if (this.gameMode === 'online') {
      this.networkClient?.send({
        type: 'placeEmplacement',
        kind,
        position: this.ghostPosition,
        yaw: this.ghostYaw,
        slot: this.blueprintIndex,
      });
    } else {
      this.placeLocalEmplacement(kind, this.ghostPosition, this.ghostYaw, this.blueprintIndex);
    }
    this.ghostRequestedAt = 0; // ask again at once in case that spot is taken now
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.drivingJeepId) return;
    if (this.mountedEmplacementId) {
      // The nest owns the trigger: no weapon, no ghost, no voxel building.
      if (e.button === 0) {
        this.isMouseDown = true;
        this.isLeftDown = true;
        this.fireMannedEmplacement();
      } else if (e.button === 2) {
        // Right-click is the gunner's zoom, like iron sights on a rifle. The
        // mortar uses it too: its target is a point on the ground far away.
        const kind = this.emplacedSnapshots.get(this.mountedEmplacementId)?.kind;
        if (kind === 'cannon' || kind === 'mortar') {
          this.manningZoom = !this.manningZoom;
          this.showMessage(this.manningZoom ? '🔭 Zoomed in — right-click to zoom out' : '🔭 Zoom out');
        }
      }
      return;
    }
    if (this.blueprintIndex !== null) {
      // A ghost is up: clicks belong to the blueprint, never to the weapon.
      if (e.button === 0) this.placeBlueprint();
      else if (e.button === 2) this.cancelBlueprint();
      return;
    }
    if (this.isSpectating) {
      // In spectator mode, clicking/dragging steers the camera only —
      // spectators must never fire or build.
      if (e.button === 0 || e.button === 2) {
        this.isMouseDown = true;
      }
      return;
    }
    if (e.button === 0) {
      // Left click: shoot / mine (single action; SMG & tools auto-fire via loop)
      this.isMouseDown = true;
      this.isLeftDown = true;
      this.performAction();
    } else if (e.button === 2) {
      // Right click: ALWAYS builds voxels — it must never shoot or mine.
      // For guns, right-click toggles aim down sights instead of firing.
      const wasRightDown = this.isRightDown;
      this.isMouseDown = true;
      this.isRightDown = true;
      if (this.equipment === 'rifle' || this.equipment === 'smg') {
        this.isAiming = !this.isAiming;
        this.player.isAiming = this.isAiming;
      } else if (!wasRightDown) {
        // One click = one block. Guard against repeated mousedown events
        // while the button is held so holding never places multiple blocks.
        this.tryBuild();
      }
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.isLeftDown = false;
    if (e.button === 2) this.isRightDown = false;
    if (e.button === 0 || e.button === 2) this.isMouseDown = this.isLeftDown || this.isRightDown;
  }

  private onWheel(e: WheelEvent): void {
    if (this.isSpectating) {
      // Adjust drone flight speed (min lowered so the cam can crawl for slow
      // inspection instead of being clamped to a fast minimum)
      this.spectatorSpeed = Math.max(4, Math.min(90, this.spectatorSpeed - e.deltaY * 0.04));
      this.showMessage(`🚀 Spectator Flight Speed: ${Math.round(this.spectatorSpeed)} m/s (Scroll to adjust)`);
      return;
    }
    const items: EquipmentType[] = ['rifle', 'smg', 'spade', 'pickaxe'];
    const idx = items.indexOf(this.equipment);
    this.equipment = e.deltaY > 0 ? items[(idx + 1) % 4] : items[(idx - 1 + 4) % 4];
    this.switchWeaponModel(this.equipment);
    this.isAiming = false;
    this.player.isAiming = false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Tab (held) opens the scoreboard; preventDefault stops browser focus-switching.
    if (e.code === 'Tab') {
      e.preventDefault();
      this.tabHeld = true;
      return;
    }
    if (e.code === 'KeyP') {
      this.toggleSpectator();
      return;
    }
    // M mutes/unmutes all game audio; works in spectator mode too.
    if (e.code === 'KeyM' && !e.repeat) {
      this.sounds.toggleMuted();
      return;
    }

    // The bench menu owns the keyboard while it is up, so no game key leaks
    // through to a panel that already has the cursor.
    if (this.benchMenuOpen) {
      if (e.code === 'Escape' || (e.code === 'KeyB' && !e.repeat)) this.closeBenchMenu();
      e.preventDefault();
      return;
    }

    // Spectator mode controls: WASD/Arrows to fly & pan, Space/E to ascend, Q/Shift to descend, C to toggle modes
    if (this.isSpectating) {
      if (e.code === 'KeyC') {
        this.cycleSpectatorMode();
        return;
      }

      // Vertical flight
      if (e.code === 'Space' || e.code === 'KeyE') this.spectatorFlyUp = true;
      if (e.code === 'KeyQ') this.spectatorFlyDown = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.spectatorSprint = true;
        // If not holding horizontal movement, shift also descends
        if (!this.spectatorMoveForward && !this.spectatorMoveBackward && !this.spectatorMoveLeft && !this.spectatorMoveRight) {
          this.spectatorFlyDown = true;
        }
      }

      // Horizontal flight
      if (e.code === 'KeyW') this.spectatorMoveForward = true;
      if (e.code === 'KeyS') this.spectatorMoveBackward = true;
      if (e.code === 'KeyA') this.spectatorMoveLeft = true;
      if (e.code === 'KeyD') this.spectatorMoveRight = true;

      // Smooth keyboard steering / panning (essential for non-pointerlock previews & accessibility)
      if (e.code === 'ArrowLeft') this.spectatorTurnLeft = true;
      if (e.code === 'ArrowRight') this.spectatorTurnRight = true;
      if (e.code === 'ArrowUp') {
        // Up arrow flies forward or tilts up
        if (e.shiftKey) this.spectatorPitchUp = true;
        else this.spectatorMoveForward = true;
      }
      if (e.code === 'ArrowDown') {
        // Down arrow flies backward or tilts down
        if (e.shiftKey) this.spectatorPitchDown = true;
        else this.spectatorMoveBackward = true;
      }

      // If user inputs flight movement while in action mode, smoothly switch to free fly mode
      if (this.spectatorMode === 'action' && (
        this.spectatorFlyUp || this.spectatorFlyDown || this.spectatorMoveForward ||
        this.spectatorMoveBackward || this.spectatorMoveLeft || this.spectatorMoveRight ||
        this.spectatorTurnLeft || this.spectatorTurnRight
      )) {
        this.setSpectatorMode('free');
      }

      this.lastManualControlTime = Date.now();
      return; // Do NOT pass input to player
    }

    if (!this.player.isDead && !e.repeat && e.code === 'KeyF') {
      if (this.gameMode === 'online') {
        if (this.drivingJeepId || this.ridingJeepId) this.networkClient?.send({ type: 'exitJeep' });
        else if (this.mountedEmplacementId) this.networkClient?.send({ type: 'dismountEmplacement' });
        else {
          const nest = this.nearbyMannableEmplacement();
          if (nest) this.networkClient?.send({ type: 'mountEmplacement', emplacementId: nest.id });
          else {
            const jeep = this.nearestJeep();
            if (jeep) this.networkClient?.send({ type: 'enterJeep', vehicleId: jeep.id });
          }
        }
      } else if (this.drivingJeepId || this.ridingJeepId) {
        this.exitLocalJeep();
      } else if (this.mountedEmplacementId) {
        this.dismountLocalEmplacement();
      } else {
        const nest = this.nearbyMannableEmplacement();
        if (nest) this.mountLocalEmplacement(nest);
        else {
          const jeep = this.nearestJeep();
          if (jeep) this.enterLocalJeep(jeep);
        }
      }
      return;
    }
    // X tears down a friendly build in reach, or scuttles a friendly jeep.
    // Without it a misplaced nest or a wedged jeep sits in the squad's way
    // until an enemy removes it.
    if (!e.repeat && e.code === 'KeyX') {
      const target = this.dismantleCandidate();
      if (target?.type === 'build') {
        if (this.gameMode === 'online') this.networkClient?.send({ type: 'dismantleEmplacement', emplacementId: target.id });
        else this.dismantleLocalEmplacement(target.id);
      } else if (target?.type === 'jeep') {
        if (this.gameMode === 'online') this.networkClient?.send({ type: 'scuttleJeep', vehicleId: target.id });
        else this.scuttleLocalJeep(target.id);
      }
      return;
    }
    if (this.drivingJeepId) {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) { e.preventDefault(); if (e.code !== 'Space') this.player.handleKeyDown(e.code); else this.jeepBrake = true; }
      return;
    }
    if (this.ridingJeepId) {
      // The driver owns the controls; the passenger only looks around and fires.
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) e.preventDefault();
      return;
    }
    if (e.code === 'KeyG' && !e.repeat && !this.player.isDead && this.workshops) {
      const pos = this.workshops[this.playerTeam].position;
      const atWorkshop = this.player.position.distanceTo(new THREE.Vector3(pos.x, pos.y, pos.z)) <= WORKSHOP_REACH;
      if (this.gameMode === 'online') {
        if (atWorkshop) this.networkClient?.send({ type: 'buildJeep' });
        else {
          const crate = this.nearbySupplyCrate();
          if (crate) this.networkClient?.send({ type: 'useSupplyCrate', emplacementId: crate.id, action: 'draw' });
        }
      } else if (atWorkshop) {
        this.buildLocalJeep();
      } else {
        const crate = this.nearbySupplyCrate();
        if (crate) this.useLocalSupplyCrate(crate, 'draw');
      }
      return;
    }
    if (e.code === 'KeyE' && !e.repeat && !this.player.isDead && this.workshops) {
      const pos = this.workshops[this.playerTeam].position;
      const atWorkshop = this.player.position.distanceTo(new THREE.Vector3(pos.x, pos.y, pos.z)) <= WORKSHOP_REACH;
      if (this.gameMode === 'online') {
        if (atWorkshop) this.networkClient?.send({ type: 'depositWorkshop', team: this.playerTeam });
        else {
          const crate = this.nearbySupplyCrate();
          if (crate) this.networkClient?.send({ type: 'useSupplyCrate', emplacementId: crate.id, action: 'deposit' });
        }
      } else if (atWorkshop) {
        this.depositToLocalWorkshop();
      } else {
        const crate = this.nearbySupplyCrate();
        if (crate) this.useLocalSupplyCrate(crate, 'deposit');
      }
      return;
    }

    // Normal player mode controls:
    if (e.code === 'Digit1') { this.equipment = 'rifle'; this.switchWeaponModel('rifle'); this.isAiming = false; this.player.isAiming = false; }
    if (e.code === 'Digit2') { this.equipment = 'smg'; this.switchWeaponModel('smg'); this.isAiming = false; this.player.isAiming = false; }
    if (e.code === 'Digit3') { this.equipment = 'spade'; this.switchWeaponModel('spade'); this.isAiming = false; this.player.isAiming = false; }
    if (e.code === 'Digit4') { this.equipment = 'pickaxe'; this.switchWeaponModel('pickaxe'); this.isAiming = false; this.player.isAiming = false; }
    if (e.code === 'Digit5' || e.code === 'Digit6' || e.code === 'Digit7') {
      this.toggleBlueprint(Number(e.code.slice(-1)) - 5);
    }
    if (e.code === 'KeyQ' && this.blueprintIndex !== null && !e.repeat) {
      this.ghostYaw += Math.PI / 2;
      this.ghostRequestedAt = 0; // re-ask the server for this rotation
    }
    if (e.code === 'KeyB' && !e.repeat && this.benchEnabled) { this.toggleBenchMenu(); return; }
    if (e.code === 'KeyR') {
      // Beside or manning a cannon/mortar, R loads a shell pack instead of
      // reloading the rifle in hand.
      if (!e.repeat && this.networkClient && this.shellPackCandidate()) { this.loadShellPack(); return; }
      this.startReload();
      return;
    }
    this.player.handleKeyDown(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') this.jeepBrake = false;
    if (e.code === 'Tab') {
      this.tabHeld = false;
      return;
    }
    if (this.isSpectating) {
      if (e.code === 'Space' || e.code === 'KeyE') this.spectatorFlyUp = false;
      if (e.code === 'KeyQ') this.spectatorFlyDown = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.spectatorSprint = false;
        this.spectatorFlyDown = false;
      }
      if (e.code === 'KeyW' || (!e.shiftKey && e.code === 'ArrowUp')) this.spectatorMoveForward = false;
      if (e.code === 'KeyS' || (!e.shiftKey && e.code === 'ArrowDown')) this.spectatorMoveBackward = false;
      if (e.code === 'KeyA') this.spectatorMoveLeft = false;
      if (e.code === 'KeyD') this.spectatorMoveRight = false;
      if (e.code === 'ArrowLeft') this.spectatorTurnLeft = false;
      if (e.code === 'ArrowRight') this.spectatorTurnRight = false;
      if (e.code === 'ArrowUp') this.spectatorPitchUp = false;
      if (e.code === 'ArrowDown') this.spectatorPitchDown = false;
      return;
    }

    this.player.handleKeyUp(e.code);
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.isSpectating) {
      // Spectator mode: rotate camera with mouse (yaw and pitch)
      // Works both with pointer lock and by dragging with mouse
      if (document.pointerLockElement || this.isMouseDown) {
        if (this.spectatorMode === 'action') {
          this.setSpectatorMode('free');
        }
        this.spectatorAngle -= e.movementX * 0.0032;
        this.spectatorPitch -= e.movementY * 0.0032;
        this.spectatorPitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.spectatorPitch));
        this.lastManualControlTime = Date.now();
      }
      return;
    }
    if (this.drivingJeepId) return;
    if (document.pointerLockElement) {
      this.player.handleMouseMove(e.movementX, e.movementY);
    } else if (this.isMouseDown) {
      // Drag-to-look when pointer lock is not active (essential for AI preview / iframe)
      this.player.handleMouseMove(e.movementX * 1.5, e.movementY * 1.5);
    }
  }

  toggleSpectator(): void {
    this.isSpectating = !this.isSpectating;
    if (this.isSpectating) {
      this.spectatorFlyUp = false;
      this.spectatorFlyDown = false;
      this.spectatorMoveForward = false;
      this.spectatorMoveBackward = false;
      this.spectatorMoveLeft = false;
      this.spectatorMoveRight = false;
      this.spectatorTurnLeft = false;
      this.spectatorTurnRight = false;
      this.spectatorPitchUp = false;
      this.spectatorPitchDown = false;
      this.spectatorSprint = false;
      this.isMouseDown = false;
      this.isLeftDown = false;
      this.isRightDown = false;
      this.spectatorMode = 'action';
      this.isAiming = false;

      // Clear player keys so character doesn't keep running in spectator
      this.player.clearKeys();

      // Position spectator camera smoothly from current player position
      this.spectatorPos.copy(this.player.getEyePosition());
      const lookDir = new THREE.Vector3();
      this.player.camera.getWorldDirection(lookDir);
      this.spectatorAngle = Math.atan2(lookDir.x, lookDir.z);
      this.spectatorPitch = Math.asin(Math.max(-0.99, Math.min(0.99, lookDir.y)));

      // Hide first-person weapon and highlight meshes
      if (this.weaponContainer) this.weaponContainer.visible = false;
      if (this.highlightMesh) this.highlightMesh.visible = false;
      if (this.buildPreviewMesh) this.buildPreviewMesh.visible = false;
      if (this.localPlayerMesh) {
        this.localPlayerMesh.visible = !this.player.isDead;
        this.localPlayerMesh.position.copy(this.player.position);
        this.localPlayerMesh.rotation.y = this.player.yaw;
      }

      this.showMessage('🎥 Spectator Mode: Active (Action Cam • Press C for Free Fly)');
      
      if (this.networkClient && this.networkClient.isConnected()) {
        this.networkClient.sendToggleSpectator();
      }
    } else {
      this.spectatorFlyUp = false;
      this.spectatorFlyDown = false;
      this.spectatorMoveForward = false;
      this.spectatorMoveBackward = false;
      this.spectatorMoveLeft = false;
      this.spectatorMoveRight = false;
      this.spectatorTurnLeft = false;
      this.spectatorTurnRight = false;
      this.spectatorPitchUp = false;
      this.spectatorPitchDown = false;
      this.spectatorSprint = false;
      this.isMouseDown = false;
      this.isLeftDown = false;
      this.isRightDown = false;
      this.player.clearKeys();

      if (this.weaponContainer) this.weaponContainer.visible = true;
      if (this.localPlayerMesh) this.localPlayerMesh.visible = false;
      this.player.updateCamera();
      this.showMessage('🎯 Player First-Person: Active');
      
      if (this.networkClient && this.networkClient.isConnected()) {
        this.networkClient.sendToggleSpectator();
      }
    }
  }

  cycleSpectatorMode(): void {
    const nextMode = this.spectatorMode === 'action' ? 'free' : 'action';
    this.spectatorMode = nextMode;
    if (nextMode === 'free') {
      // Seamlessly take over current position & orientation
      this.spectatorPos.copy(this.player.camera.position);
      const lookDir = new THREE.Vector3();
      this.player.camera.getWorldDirection(lookDir);
      this.spectatorAngle = Math.atan2(lookDir.x, lookDir.z);
      this.spectatorPitch = Math.asin(Math.max(-0.99, Math.min(0.99, lookDir.y)));
    }
    this.lastManualControlTime = Date.now();
    this.showMessage(
      this.spectatorMode === 'action'
        ? '🎬 Spectator: Dynamic Action Cam (Tracking duels & flags)'
        : '🚀 Spectator: Free Fly Cam (WASD to fly, Space/Shift for altitude, Mouse to look)'
    );
  }

  setSpectatorMode(mode: 'action' | 'free'): void {
    if (this.spectatorMode !== mode && mode === 'free') {
      this.spectatorPos.copy(this.player.camera.position);
      const lookDir = new THREE.Vector3();
      this.player.camera.getWorldDirection(lookDir);
      this.spectatorAngle = Math.atan2(lookDir.x, lookDir.z);
      this.spectatorPitch = Math.asin(Math.max(-0.99, Math.min(0.99, lookDir.y)));
    }
    this.spectatorMode = mode;
    this.lastManualControlTime = Date.now();
  }

  requestPointerLock(canvas: HTMLCanvasElement): void {
    this.tryPointerLock(canvas);
  }

  /** Request pointer lock without leaking a rejected promise. Browsers reject
   *  when the request is not tied to a user gesture or the document is not
   *  focused; the canvas click path re-locks, so the failure stays silent. */
  private tryPointerLock(canvas: HTMLCanvasElement = this.canvas): void {
    try {
      const pending = canvas.requestPointerLock?.() as unknown;
      if (pending instanceof Promise) void pending.catch(() => { /* click path re-locks */ });
    } catch {
      /* older browsers may throw synchronously */
    }
  }

  private performAction(): void {
    if (this.player.isDead || this.benchMenuOpen) return;
    if (this.blueprintIndex !== null) return; // ghost up: no shooting or mining
    const now = performance.now() / 1000;
    if (this.equipment === 'rifle' || this.equipment === 'smg') {
      this.shoot(now);
    } else if (this.equipment === 'pickaxe') {
      this.usePickaxe(now);
    } else if (this.equipment === 'spade') {
      this.useSpade(now);
    }
  }

  private shoot(now: number): void {
    const weapon = this.weapons[this.equipment];
    if (!weapon || weapon.magazineSize === 0) return;
    if (weapon.isReloading) return;
    if (now - weapon.lastFired < weapon.fireRate) return;
    if (weapon.currentAmmo <= 0) {
      this.startReload();
      return;
    }
    weapon.lastFired = now;
    weapon.currentAmmo--;

    // High accuracy aiming direction (pinpoint when ADS, virtually zero rifle hip spread)
    let dir = this.player.getAimDirection();
    if (!this.isAiming) {
      // Pinpoint accurate rifle (near-zero spread), tighter and controlled SMG spread
      // Hip fire cone comes straight from the shared weapon table.
      const spreadAmount = weapon.spread;
      const spreadX = (Math.random() - 0.5) * spreadAmount;
      const spreadY = (Math.random() - 0.5) * spreadAmount;
      const right = this.player.getRight();
      const up = new THREE.Vector3(0, 1, 0);
      dir.addScaledVector(right, spreadX).addScaledVector(up, spreadY).normalize();
    } else if (this.equipment === 'smg') {
      // ADS tightens the SMG cone to ~1/6 of its hip fire; the rifle's ADS is
      // pinpoint. Derived from the shared value so tuning the SMG cone in one
      // place still tightens it here.
      const spreadAmount = weapon.spread * 0.17;
      const spreadX = (Math.random() - 0.5) * spreadAmount;
      const spreadY = (Math.random() - 0.5) * spreadAmount;
      const right = this.player.getRight();
      const up = new THREE.Vector3(0, 1, 0);
      dir.addScaledVector(right, spreadX).addScaledVector(up, spreadY).normalize();
    }

    const cameraPos = this.player.camera.position.clone();
    
    // Play appropriate sound based on weapon
    if (this.equipment === 'rifle') {
      this.sounds.rifleShot();
    } else if (this.equipment === 'smg') {
      this.sounds.smgShot();
    }

    // Extended 350m battlefield raycast starting directly from camera view
    const maxBulletDistance = 350;
    const hit = this.world.raycast(cameraPos, dir, maxBulletDistance);
    const voxelDist = hit ? hit.distance : maxBulletDistance;

    // Check hit on enemy remote players
    let hitRemoteId: string | null = null;
    let hitRemoteHeadshot = false;
    let closestTargetDist = voxelDist;
    let actualImpactPoint = hit ? hit.position.clone() : cameraPos.clone().add(dir.clone().multiplyScalar(maxBulletDistance));

    for (const [id, remote] of this.remotePlayers) {
      if (remote.state.isDead || remote.state.team === this.playerTeam) continue;
      const targetPos = remote.mesh.position;
      const dx = targetPos.x - cameraPos.x;
      const dz = targetPos.z - cameraPos.z;
      const horizDirSq = dir.x * dir.x + dir.z * dir.z;

      if (horizDirSq > 0.0001) {
        const t = (dx * dir.x + dz * dir.z) / horizDirSq;
        if (t > 0.3 && t < closestTargetDist) {
          const rayX = cameraPos.x + dir.x * t;
          const rayZ = cameraPos.z + dir.z * t;
          const rayY = cameraPos.y + dir.y * t;
          const horizontalDist = Math.hypot(rayX - targetPos.x, rayZ - targetPos.z);
          const verticalDist = rayY - targetPos.y;

          if (horizontalDist < 0.65 && verticalDist >= -0.1 && verticalDist <= 2.15) {
            hitRemoteId = id;
            hitRemoteHeadshot = verticalDist >= 1.45;
            closestTargetDist = t;
            actualImpactPoint = new THREE.Vector3(rayX, rayY, rayZ);
          }
        }
      }
    }

    if (hitRemoteId) {
      this.hitMarkerTimer = 0.25;
      this.sounds.hitMarker();
      if (hitRemoteHeadshot) this.sounds.headshot();
      this.createImpactSparks(actualImpactPoint);
    }

    // Send shoot event to network server with hit candidate
    if (this.networkClient && this.networkClient.isConnected()) {
      this.networkClient.sendShoot(
        { x: cameraPos.x, y: cameraPos.y, z: cameraPos.z },
        { x: dir.x, y: dir.y, z: dir.z },
        hitRemoteId ? { targetId: hitRemoteId, isHeadshot: hitRemoteHeadshot } : undefined
      );
    }

    // Check hit on enemy bots with precision 3D ray-cylinder intersection
    let hitBot: Bot | null = null;
    let hitBotHeadshot = false;

    for (const bot of this.bots) {
      if (bot.isDead || bot.team === this.playerTeam) continue;
      const dx = bot.position.x - cameraPos.x;
      const dz = bot.position.z - cameraPos.z;
      const horizDirSq = dir.x * dir.x + dir.z * dir.z;

      if (horizDirSq > 0.0001) {
        const t = (dx * dir.x + dz * dir.z) / horizDirSq;
        if (t > 0.3 && t < closestTargetDist) {
          const rayX = cameraPos.x + dir.x * t;
          const rayZ = cameraPos.z + dir.z * t;
          const rayY = cameraPos.y + dir.y * t;
          const horizontalDist = Math.hypot(rayX - bot.position.x, rayZ - bot.position.z);
          const verticalDist = rayY - bot.position.y;

          // Realistic bot hitbox: horizontal radius 0.65m, vertical height 0 to 2.15m
          if (horizontalDist < 0.65 && verticalDist >= -0.1 && verticalDist <= 2.15) {
            hitBot = bot;
            hitBotHeadshot = verticalDist >= 1.45;
            closestTargetDist = t;
            actualImpactPoint = new THREE.Vector3(rayX, rayY, rayZ);
          }
        }
      }
    }

    // An enemy workshop jeep takes the round too, crewed or not: every build
    // that comes out of the workshop is destructible in the offline Beta.
    let hitLocalJeep: JeepSnapshot | null = null;
    for (const jeep of this.localJeeps) {
      if (jeep.wreck || jeep.team === this.playerTeam) continue;
      const spec = vehicleSpec(jeep.kind);
      const horizDirSq = dir.x * dir.x + dir.z * dir.z;
      if (horizDirSq <= 0.0001) continue;
      const dx = jeep.position.x - cameraPos.x;
      const dz = jeep.position.z - cameraPos.z;
      const t = (dx * dir.x + dz * dir.z) / horizDirSq;
      if (t <= 0.3 || t >= closestTargetDist) continue;
      const rayX = cameraPos.x + dir.x * t;
      const rayY = cameraPos.y + dir.y * t;
      const rayZ = cameraPos.z + dir.z * t;
      if (Math.hypot(rayX - jeep.position.x, rayZ - jeep.position.z) > Math.hypot(spec.halfWidth, spec.halfLength)) continue;
      const vertical = rayY - jeep.position.y;
      if (vertical < -0.1 || vertical > spec.height + 0.2) continue;
      hitLocalJeep = jeep;
      closestTargetDist = t;
      actualImpactPoint = new THREE.Vector3(rayX, rayY, rayZ);
      hitBot = null; // the bodywork stopped the round before any body behind it
    }
    if (hitLocalJeep) {
      this.damageLocalJeep(hitLocalJeep, weaponDamage(weapon, false, closestTargetDist));
      this.hitMarkerTimer = 0.25;
      this.sounds.hitMarker();
      this.createImpactSparks(actualImpactPoint);
    }

    if (hitBot) {
      // Shared damage model + range falloff, so the offline bot match hits for
      // exactly what the server would deal for the same shot.
      const damage = this.absorbJeepDamage(hitBot, weaponDamage(weapon, hitBotHeadshot, closestTargetDist));
      hitBot.hp -= damage;
      hitBot.lastDamageTime = Date.now();
      hitBot.flinchTimer = 0.22;
      this.hitMarkerTimer = 0.25;
      this.sounds.hitMarker();
      if (hitBotHeadshot) this.sounds.headshot();
      this.createImpactSparks(actualImpactPoint);

      if (hitBot.hp > 0) {
        const hitCallout = hitBot.hp < 30 ? '🔥 HEAVY DAMAGE! FALLING BACK!' : '⚡ UNDER HOSTILE ATTACK!';
        this.addRadioMessage(hitBot.name, hitCallout, hitBot.team, hitBot);
        this.updateBotNameTag(hitBot, hitBot.hp < 30 ? '🏃 TACTICAL RETREAT' : '🎯 ENGAGING PLAYER', '#ff4444');
      }

      if (hitBot.hp <= 0) {
        hitBot.isDead = true;
        hitBot.mesh.visible = false;
        hitBot.respawnTimer = 4;

        // Drop flag if bot was carrying it so it reappears on the ground
        if (hitBot.carryingFlag) {
          const carriedFlag = hitBot.team === 'blue' ? this.redFlag : this.blueFlag;
          if (carriedFlag) {
            carriedFlag.carrier = null;
            carriedFlag.isDropped = true;
            carriedFlag.dropTimer = 30;
            const dropY = this.world.getGroundHeight(hitBot.position.x, hitBot.position.z);
            carriedFlag.currentPos.set(hitBot.position.x, dropY, hitBot.position.z);
            carriedFlag.mesh.position.copy(carriedFlag.currentPos);
            carriedFlag.mesh.visible = true; // Dropped flag appears on ground!
            this.showMessage(`🚩 ${carriedFlag.team.toUpperCase()} flag was dropped by ${hitBot.name}!`);
          }
          hitBot.carryingFlag = false;
        }

        if (this.playerTeam === 'blue') this.blueKills++; else this.redKills++;
        this.sounds.killSound();
        this.showMessage(`🎯 You killed ${hitBot.name} ${hitBotHeadshot ? '(HEADSHOT!)' : ''}`);
      }
    } else if (hit && closestTargetDist >= voxelDist - 0.2) {
      // Hit a voxel in the world
      const voxel = this.world.getVoxel(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z);
      if (voxel && this.gameMode !== 'online') {
        const result = this.world.damageVoxel(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z, VOXEL_SHOT_DAMAGE);
        if (result.destroyed) {
          this.sounds.pickaxeHit();
        }
      }
      this.createImpactSparks(actualImpactPoint, hit.normal);
    }

    // Update camera and weapon model world matrices to ensure pinpoint locator accuracy
    this.player.camera.updateMatrixWorld(true);
    if (this.currentWeaponModel) this.currentWeaponModel.updateMatrixWorld(true);

    let barrelMuzzlePos = new THREE.Vector3();
    let receiverPos = new THREE.Vector3();
    const muzzleObj = this.currentWeaponModel?.getObjectByName('barrelMuzzle');
    const ejectionObj = this.currentWeaponModel?.getObjectByName('ejectionPort');

    if (muzzleObj) {
      muzzleObj.getWorldPosition(barrelMuzzlePos);
    } else {
      barrelMuzzlePos.copy(cameraPos).addScaledVector(dir, 0.4);
    }

    if (ejectionObj) {
      ejectionObj.getWorldPosition(receiverPos);
    } else {
      const right = this.player.getRight();
      receiverPos.copy(this.player.camera.position).addScaledVector(right, 0.25).addScaledVector(dir, 0.15);
    }

    // Long-distance luminous tracer & muzzle visuals
    const bulletSpeed = this.equipment === 'rifle' ? 300 : 230;
    const tracerDir = actualImpactPoint.clone().sub(barrelMuzzlePos).normalize();
    const tracerDist = barrelMuzzlePos.distanceTo(actualImpactPoint);

    this.createMuzzleFlash(barrelMuzzlePos, dir.clone());
    this.createBulletTracer(barrelMuzzlePos, tracerDir, tracerDist, bulletSpeed);
    this.createBulletShell(receiverPos, dir.clone());
  }

  private usePickaxe(now: number): void {
    if (now - this.lastActionTime < 0.3) return;
    this.lastActionTime = now;
    
    const dir = this.player.getAimDirection();
    const origin = this.player.camera.position.clone();
    const hit = this.world.raycast(origin, dir, 5);
    
    if (hit) {
      if (this.gameMode === 'online') {
        this.networkClient?.sendUseTool('pickaxe', { x: hit.voxelPos.x, y: hit.voxelPos.y, z: hit.voxelPos.z });
      } else {
        const result = this.world.damageVoxel(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z, 3);
        if (result.destroyed) {
          this.inventory++;
          this.sounds.pickaxeHit();
        }
      }
    }
  }

  private useSpade(now: number): void {
    if (now - this.lastActionTime < 0.3) return;
    this.lastActionTime = now;
    
    const dir = this.player.getAimDirection();
    const origin = this.player.camera.position.clone();
    const hit = this.world.raycast(origin, dir, 5);
    
    if (hit) {
      // Dig trench: remove target voxel and the one below it (2 tiles)
      const vx = hit.voxelPos.x;
      const vy = hit.voxelPos.y;
      const vz = hit.voxelPos.z;
      
      if (this.gameMode === 'online') {
        this.networkClient?.sendUseTool('spade', { x: vx, y: vy, z: vz });
        return;
      }

      // Destroy target voxel
      const result1 = this.world.damageVoxel(vx, vy, vz, 3);
      if (result1.destroyed) {
        this.inventory++;
      }
      
      // Destroy voxel below for trench effect
      const result2 = this.world.damageVoxel(vx, vy - 1, vz, 3);
      if (result2.destroyed) {
        this.inventory++;
      }
      
      this.sounds.spadeHit();
    }
  }

  // Check if a 1x1x1 voxel bounding box intersects any living entity (player or bots)
  public doesVoxelIntersectAnyEntity(x: number, y: number, z: number, ignoreBot?: Bot): boolean {
    const vMinX = x - 0.5;
    const vMaxX = x + 0.5;
    const vMinY = y - 0.5;
    const vMaxY = y + 0.5;
    const vMinZ = z - 0.5;
    const vMaxZ = z + 0.5;

    // Check local player
    if (!this.player.isDead) {
      const pr = 0.45;
      const ph = this.player.currentHeight;
      const px = this.player.position.x;
      const py = this.player.position.y;
      const pz = this.player.position.z;

      if (
        px + pr > vMinX && px - pr < vMaxX &&
        py + ph > vMinY && py < vMaxY &&
        pz + pr > vMinZ && pz - pr < vMaxZ
      ) {
        return true;
      }
    }

    // Check all bots
    for (const b of this.bots) {
      if (b.hp <= 0 || b === ignoreBot) continue;
      const br = 0.48;
      const bh = 1.95;
      const bx = b.position.x;
      const by = b.position.y;
      const bz = b.position.z;

      if (
        bx + br > vMinX && bx - br < vMaxX &&
        by + bh > vMinY && by < vMaxY &&
        bz + br > vMinZ && bz - br < vMaxZ
      ) {
        return true;
      }
    }

    return false;
  }

  // Combined validity check: world support + non-solid + zero entity clipping
  public canPlaceBlock(x: number, y: number, z: number, ignoreBot?: Bot): boolean {
    if (!this.world.canBuild(x, y, z)) return false;
    if (this.doesVoxelIntersectAnyEntity(x, y, z, ignoreBot)) return false;
    return true;
  }

  // 3D Voxel Collision check for bot movement cylinder
  private checkBotVoxelCollision(x: number, y: number, z: number, botName?: string, radius = 0.38): boolean {
    const yChecks = [
      y + 0.45, // Shin/lower body - strictly above the floor voxel
      y + 1.05, // Torso
      y + 1.65  // Head/upper body
    ];

    const offsets = [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
      [radius * 0.707, radius * 0.707],
      [-radius * 0.707, radius * 0.707],
      [radius * 0.707, -radius * 0.707],
      [-radius * 0.707, -radius * 0.707],
    ];

    for (const cy of yChecks) {
      const vy = Math.round(cy);
      for (const [ox, oz] of offsets) {
        const vx = Math.round(x + ox);
        const vz = Math.round(z + oz);
        if (this.world.isSolid(vx, vy, vz)) {
          return true;
        }
      }
    }
    // Live vehicles are solid to a walking bot: probe the same cylinder against
    // each jeep footprint so the AI walks around the bodywork instead of
    // grinding into it (its own seat is excluded).
    for (const { state } of this.jeeps.values()) {
      if (botName && (state.driverId === botName || state.passengerId === botName)) continue;
      const spec = vehicleSpec(state.kind);
      if (Math.abs(state.position.y - y) >= spec.height) continue;
      if (vehicleRectsOverlap(x, z, 0, BOT_VEHICLE_FOOTPRINT,
        state.position.x, state.position.z, state.yaw, spec)) return true;
    }
    return false;
  }

  // Smooth unclip / de-penetration routine: ensures bots never remain embedded in solid voxels
  private resolveBotVoxelPenetration(bot: Bot): void {
    const radius = 0.38;
    const yLevels = [bot.position.y + 0.45, bot.position.y + 1.05, bot.position.y + 1.65];
    let adjusted = false;

    for (const cy of yLevels) {
      const vy = Math.round(cy);
      const centerVx = Math.round(bot.position.x);
      const centerVz = Math.round(bot.position.z);

      // If bot center is inside a solid block, push out to nearest border
      if (this.world.isSolid(centerVx, vy, centerVz)) {
        const voxelCenterX = centerVx;
        const voxelCenterZ = centerVz;
        let pushX = bot.position.x - voxelCenterX;
        let pushZ = bot.position.z - voxelCenterZ;
        if (Math.abs(pushX) < 0.001 && Math.abs(pushZ) < 0.001) {
          pushX = 0.5;
          pushZ = 0.5;
        }
        const pushLen = Math.hypot(pushX, pushZ) || 0.001;
        const targetDist = 0.5 + radius + 0.02;
        bot.position.x = voxelCenterX + (pushX / pushLen) * targetDist;
        bot.position.z = voxelCenterZ + (pushZ / pushLen) * targetDist;
        adjusted = true;
        break;
      }

      // Check all 8 neighboring voxels at this height level
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          const vx = centerVx + dx;
          const vz = centerVz + dz;
          if (this.world.isSolid(vx, vy, vz)) {
            // Find closest point on voxel AABB [vx - 0.5, vx + 0.5] x [vz - 0.5, vz + 0.5]
            const closestX = Math.max(vx - 0.5, Math.min(bot.position.x, vx + 0.5));
            const closestZ = Math.max(vz - 0.5, Math.min(bot.position.z, vz + 0.5));
            const distX = bot.position.x - closestX;
            const distZ = bot.position.z - closestZ;
            const dist = Math.hypot(distX, distZ);

            if (dist < radius) {
              const overlap = radius - dist + 0.01;
              if (dist > 0.001) {
                bot.position.x += (distX / dist) * overlap;
                bot.position.z += (distZ / dist) * overlap;
              } else {
                bot.position.x += dx * 0.12;
                bot.position.z += dz * 0.12;
              }
              adjusted = true;
            }
          }
        }
      }
    }

    if (adjusted && bot.grounded) {
      bot.position.y = this.world.getGroundHeightBelow(bot.position.x, bot.position.y, bot.position.z);
    }
  }

  private tryBuild(): void {
    if (this.inventory + (this.gameMode === 'online' ? this.depositable : 0) <= 0) return;
    
    const dir = this.player.getAimDirection();
    const origin = this.player.camera.position.clone();
    const hit = this.world.raycast(origin, dir, 6);
    
    if (hit) {
      const px = hit.voxelPos.x + Math.round(hit.normal.x);
      const py = hit.voxelPos.y + Math.round(hit.normal.y);
      const pz = hit.voxelPos.z + Math.round(hit.normal.z);
      
      if (this.gameMode === 'online') {
        if (!isWorkshopProtectedCell(px, pz) && !this.world.isSolid(px, py, pz) && this.canPlaceBlock(px, py, pz)) {
          this.networkClient?.sendBuild({ x: px, y: py, z: pz });
        }
        return;
      }
      if (!this.world.isSolid(px, py, pz) && this.canPlaceBlock(px, py, pz)) {
        this.world.setVoxel(px, py, pz, VOXEL_BUILT, VOXEL_MAX_DURABILITY);
        this.inventory--;
        this.sounds.buildPlace();
        
        // Add instant visual feedback - flash the placed block
        this.createBlockPlacementEffect(px, py, pz);
      }
    }
  }

  private createBlockPlacementEffect(x: number, y: number, z: number): void {
    // Create a quick flash effect at the placement location (voxels centered at x, y, z)
    const flashGeo = new THREE.BoxGeometry(VOXEL_SIZE * 1.05, VOXEL_SIZE * 1.05, VOXEL_SIZE * 1.05);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0x88ff88, transparent: true, opacity: 0.7 });
    const flashMesh = new THREE.Mesh(flashGeo, flashMat);
    flashMesh.position.set(x, y, z);
    this.scene.add(flashMesh);
    
    // Animate the flash fading out
    const fadeOut = () => {
      flashMat.opacity -= 0.15;
      if (flashMat.opacity > 0) {
        requestAnimationFrame(fadeOut);
      } else {
        this.scene.remove(flashMesh);
        flashGeo.dispose();
        flashMat.dispose();
      }
    };
    requestAnimationFrame(fadeOut);
  }

  /** Mark where a round landed: a bright flash, a ring on the surface and a few
   *  debris chips. Big enough to read a spraying nest at range. */
  private createImpactSparks(position: THREE.Vector3, normal?: THREE.Vector3): void {
    const surface = normal ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);

    const flash = new THREE.Mesh(
      this.impactFlashGeometry,
      new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    flash.position.copy(position).addScaledVector(surface, 0.06);
    this.scene.add(flash);

    // A dust puff makes a strike legible at 50-90 m, where a spark is a pixel.
    const dust = new THREE.Mesh(
      this.impactFlashGeometry,
      new THREE.MeshBasicMaterial({ color: 0xd8cdb4, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    dust.position.copy(flash.position);
    this.scene.add(dust);

    // RingGeometry lies in its local XY plane, so face it along the surface.
    const ring = new THREE.Mesh(
      this.impactRingGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffc44d, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.position.copy(flash.position);
    ring.lookAt(flash.position.clone().add(surface));
    this.scene.add(ring);

    const chips: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3 }> = [];
    for (let i = 0; i < 4; i++) {
      const chip = new THREE.Mesh(
        this.impactChipGeometry,
        new THREE.MeshBasicMaterial({ color: 0xffdd77, transparent: true, opacity: 0.95 }),
      );
      chip.position.copy(position);
      const velocity = surface.clone().multiplyScalar(1.5 + Math.random() * 2)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5));
      this.scene.add(chip);
      chips.push({ mesh: chip, velocity });
    }

    this.impactBursts.push({ flash, dust, ring, chips, life: 0, maxLife: 1.0 });
    // A long firefight must not grow the effect list without bound.
    if (this.impactBursts.length > 60) {
      const oldest = this.impactBursts.shift();
      if (oldest) this.removeImpactBurst(oldest);
    }
  }

  /** Drop one burst's meshes and per-burst materials; the geometries are shared. */
  private removeImpactBurst(burst: ImpactBurst): void {
    for (const mesh of [burst.flash, burst.dust, burst.ring, ...burst.chips.map((chip) => chip.mesh)]) {
      this.scene.remove(mesh);
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
  }

  private startReload(): void {
    const weapon = this.weapons[this.equipment];
    if (!weapon || weapon.magazineSize === 0 || weapon.isReloading || weapon.currentAmmo === weapon.magazineSize) return;
    // The pouch is empty: no reload is possible until magazines are bought at
    // the bench. Offline practice keeps unlimited ammo.
    if (this.gameMode === 'online' && this.ammoReserve <= 0) {
      this.showMessage('Out of ammo — buy magazines at your bench (B)');
      return;
    }
    weapon.isReloading = true;
    weapon.reloadStartTime = performance.now() / 1000;
    this.isReloadAnimating = true;
    this.reloadAnimationTime = 0;
    this.reloadAnimationDuration = weapon.reloadTime;
    this.sounds.reload();
    if (this.networkClient && this.networkClient.isConnected()) {
      this.networkClient.sendReload();
    }
  }

  private createMuzzleFlash(position: THREE.Vector3, direction: THREE.Vector3): void {
    const light = new THREE.PointLight(0xffb703, 5, 8);
    light.position.copy(position);
    this.scene.add(light);

    const flashGroup = new THREE.Group();
    flashGroup.position.copy(position);
    flashGroup.lookAt(position.clone().add(direction));

    // Hot bright white-yellow inner core spark
    const coreGeo = new THREE.SphereGeometry(0.045, 8, 8);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    coreMesh.position.set(0, 0, 0.04);
    flashGroup.add(coreMesh);

    // Forward flame burst cone projecting from the barrel
    const flameGeo = new THREE.ConeGeometry(0.09, 0.24, 6);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.85 });
    const flameMesh = new THREE.Mesh(flameGeo, flameMat);
    flameMesh.rotation.x = -Math.PI / 2;
    flameMesh.position.set(0, 0, 0.12);
    flashGroup.add(flameMesh);

    // Star-burst spark blades
    const starH = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.015, 0.015),
      new THREE.MeshBasicMaterial({ color: 0xffea00, transparent: true, opacity: 0.9 })
    );
    starH.position.set(0, 0, 0.06);
    flashGroup.add(starH);

    const starV = new THREE.Mesh(
      new THREE.BoxGeometry(0.015, 0.24, 0.015),
      new THREE.MeshBasicMaterial({ color: 0xffea00, transparent: true, opacity: 0.9 })
    );
    starV.position.set(0, 0, 0.06);
    flashGroup.add(starV);

    this.scene.add(flashGroup);

    // Flying incandescent sparks spraying from the barrel opening
    const sparks: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3 }> = [];
    const sparkCount = 4 + Math.floor(Math.random() * 3);
    for (let s = 0; s < sparkCount; s++) {
      const spGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      const spMat = new THREE.MeshBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.95 });
      const spMesh = new THREE.Mesh(spGeo, spMat);
      spMesh.position.copy(position);
      this.scene.add(spMesh);

      // Spray velocity forward and outwards
      const spVel = direction.clone().multiplyScalar(9 + Math.random() * 9).add(new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6
      ));
      sparks.push({ mesh: spMesh, velocity: spVel });
    }

    this.muzzleFlashes.push({
      light,
      group: flashGroup,
      sparks,
      life: 0,
      maxLife: 0.07,
    });
  }

  private createBulletTracer(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number = 350, speed: number = 280): void {
    // High-visibility luminous tracer projectile
    const tracerGeo = new THREE.BoxGeometry(0.04, 0.04, 1.4);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffea00, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(tracerGeo, tracerMat);
    mesh.position.copy(origin);
    mesh.lookAt(origin.clone().add(direction));
    this.scene.add(mesh);

    // The endpoint is where the round lands, so it must not be padded out to a
    // minimum: a wall two metres away would otherwise get its spark 8 m on.
    const clampedDist = Math.max(0.5, Math.min(350, maxDistance));
    const velocity = direction.clone().multiplyScalar(speed);
    const maxLife = clampedDist / speed;

    this.bulletTracers.push({
      mesh,
      velocity,
      life: 0,
      maxLife,
      hasWhizzed: false,
      hasImpacted: false,
      targetDistance: maxDistance,
      startPos: origin.clone()
    });
  }

  private createBulletShell(origin: THREE.Vector3, direction: THREE.Vector3, isBot: boolean = false, botRight?: THREE.Vector3): void {
    const shellGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.042, 8);
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xdfa020,
      metalness: 0.85,
      roughness: 0.18,
      transparent: true,
      opacity: 1.0,
    });
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.position.copy(origin);
    
    // Initial random tumble
    mesh.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI
    );
    this.scene.add(mesh);

    // Compute ejection vector: pops to the right (+X) and up (+Y) and slightly back (-Z) from receiver
    let right: THREE.Vector3;
    let up: THREE.Vector3;
    let forward: THREE.Vector3;

    if (isBot && botRight) {
      right = botRight.clone().normalize();
      up = new THREE.Vector3(0, 1, 0);
      forward = direction.clone().normalize();
    } else {
      right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.player.camera.quaternion);
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.player.camera.quaternion);
      forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.camera.quaternion);
    }

    // Dynamic ejection impulse: kick right, slight upward pop, slight rearward drift
    const velocity = right.clone().multiplyScalar(2.4 + Math.random() * 0.9)
      .addScaledVector(up, 1.4 + Math.random() * 0.7)
      .addScaledVector(forward, -0.3 + (Math.random() - 0.5) * 0.3);

    // Impart slight player momentum if moving
    if (!isBot && this.player) {
      velocity.addScaledVector(this.player.velocity, 0.35);
    }

    const rotationSpeed = new THREE.Vector3(
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 24
    );

    this.bulletShells.push({
      mesh,
      velocity,
      rotationSpeed,
      life: 0,
      maxLife: 2.2,
      groundBounces: 0,
    });
  }

  private showMessage(msg: string): void {
    this.message = msg;
    this.messageTimer = 2;
  }


  private handlePlayerRespawn(customPos?: THREE.Vector3): void {
    const spawnPos = customPos || this.getSafeSpawnPos(this.playerTeam);
    this.player.respawn(this.playerTeam, spawnPos);
    this.player.yaw = this.playerTeam === 'blue' ? Math.PI : 0;
    this.player.pitch = 0;
    this.player.updateCamera();

    // Reset weapon magazines & ammo
    for (const key of Object.keys(this.weapons)) {
      const w = this.weapons[key];
      if (w && w.magazineSize > 0) {
        w.currentAmmo = w.magazineSize;
        w.isReloading = false;
      }
    }
    // Restore build blocks on respawn (server also sends inventoryUpdated=20
    // in online mode; local games have no server so set it here too)
    if (this.gameMode !== 'online') this.inventory = Math.max(this.inventory, 20);
    this.player.carryingFlag = false;
    this.isReloadAnimating = false;
    this.reloadAnimationTime = 0;
    this.sounds.respawn();
    this.showMessage(`🎖️ Respawned at ${this.playerTeam.toUpperCase()} Base!`);

    if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected()) {
      this.networkClient.sendPlayerInput({
        moveX: 0,
        moveZ: 0,
        jump: false,
        crouch: false,
        sprint: false,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        position: { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z },
        equipment: this.equipment,
        isAiming: false,
      });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.animate();
  }

  private animate = (): void => {
    if (!this.running) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    // Online safety net: if the local player is stuck dead for >6s while
    // connected (e.g. a playerRespawned event was dropped or raced with join),
    // re-request a server-authoritative safe spawn so they can never remain
    // permanently eliminated at spawn ("join already dead" bug).
    if (
      this.networkClient?.isConnected() &&
      this.localPlayerId &&
      this.player.isDead &&
      Date.now() - this.lastRespawnRequestTime > 6000
    ) {
      this.lastRespawnRequestTime = Date.now();
      this.networkClient.sendRequestRespawn();
    }

    // Seated only while alive and not spectating — dying or switching to
    // spectator drops the player straight back to their own body and camera.
    // The camera itself is chosen once, at the end of the frame (see the camera
    // chain below), so nothing has to guard against a later overwrite here.
    const driving = this.drivingJeepId ? this.jeeps.get(this.drivingJeepId) : undefined;
    const riding = this.ridingJeepId ? this.jeeps.get(this.ridingJeepId) : undefined;
    const seatedJeep = driving && !this.isSpectating && !this.player.isDead ? driving : undefined;
    const seatedPassenger = riding && !this.isSpectating && !this.player.isDead ? riding : undefined;
    if (seatedJeep) {
      const state = seatedJeep.state;
      this.player.position.set(state.position.x, state.position.y, state.position.z);
      this.player.velocity.set(0, 0, 0);
      const now = performance.now();
      if (now - this.lastDriveInput > 80) {
        this.lastDriveInput = now;
        this.networkClient?.send({ type: 'driveJeep', throttle: (this.player.hasKey('KeyW') ? 1 : 0) - (this.player.hasKey('KeyS') ? 1 : 0), steering: (this.player.hasKey('KeyA') ? 1 : 0) - (this.player.hasKey('KeyD') ? 1 : 0), brake: this.jeepBrake });
      }
    } else if (seatedPassenger) {
      // Server jeeps pin the passenger to the vehicle too; follow the snapshot
      // so the camera rides with it between state broadcasts.
      const state = seatedPassenger.state;
      this.player.position.set(state.position.x, state.position.y, state.position.z);
      this.player.velocity.set(0, 0, 0);
    } else if (this.mountedEmplacementId) {
      // The server pins the gunner to the nest; mirror that locally so the
      // camera does not slide away from the gun while walking keys are held.
      const nest = this.emplacedSnapshots.get(this.mountedEmplacementId);
      if (nest) this.player.position.set(nest.position.x, nest.position.y, nest.position.z);
      this.player.velocity.set(0, 0, 0);
    } else this.player.update(dt);
    // Offline matches drive their own jeeps; a connected server stays the owner.
    if (this.gameMode !== 'online') {
      this.updateLocalVehicles(dt);
      this.updateLocalEmplacements(dt);
    }
    for (const { state, mesh } of this.jeeps.values()) {
      mesh.position.lerp(new THREE.Vector3(state.position.x, state.position.y, state.position.z), Math.min(dt * 14, 1));
      const delta = Math.atan2(Math.sin(state.yaw - mesh.rotation.y), Math.cos(state.yaw - mesh.rotation.y));
      mesh.rotation.y += delta * Math.min(dt * 14, 1);
    }

    if (this.benchMenuOpen && (!this.benchOpen || this.isSpectating || this.player.isDead || this.drivingJeepId)) {
      this.benchMenuOpen = false;
    }
    if (this.blueprintIndex !== null) {
      // Dying, spectating or boarding a vehicle puts the ghost away.
      if (this.isSpectating || this.player.isDead || this.drivingJeepId) this.cancelBlueprint();
      else this.updateGhost();
    }
    // A manned cannon/mortar draws its arc and landing ring every frame, so the
    // marker follows the crosshair while the gunner aims.
    this.updateShellPreview();
    // Your own build is drawn from inside its barrel (the mortar's tube sits
    // right against the seat camera), so hide it in first person and let the
    // arc and landing ring stay in view.
    for (const [id, mesh] of this.emplacementMeshes) mesh.visible = id !== this.mountedEmplacementId;
    this.world.update();
    for (const smoke of this.wreckSmoke.values()) smoke.update(dt);

    // Continuous fire for SMG and tools while holding the LEFT mouse button.
    // Rifle fires exactly once per click (no burst). Right-click never fires —
    // it is reserved for building voxels.
    // Shells follow the server's parabola; blasts pop and fade.
    if (this.shells.size > 0 || this.shellBlasts.length > 0) {
      const nowSeconds = performance.now() / 1000;
      for (const shell of this.shells.values()) {
        const t = nowSeconds - shell.spawnedAt;
        shell.mesh.position.set(
          shell.spawn.x + shell.velocity.x * t,
          shell.spawn.y + shell.velocity.y * t - 0.5 * EMPLACEMENT_SHELL_GRAVITY * t * t,
          shell.spawn.z + shell.velocity.z * t,
        );
      }
      for (let i = this.shellBlasts.length - 1; i >= 0; i--) {
        const blast = this.shellBlasts[i];
        const left = blast.until - nowSeconds;
        if (left <= 0) {
          this.scene.remove(blast.mesh);
          blast.mesh.geometry.dispose();
          blast.material.dispose();
          this.shellBlasts.splice(i, 1);
          continue;
        }
        blast.material.opacity = Math.min(0.85, left * 2.5);
        blast.mesh.scale.multiplyScalar(1.06);
      }
    }

    if (this.mountedEmplacementId && this.isLeftDown && !this.player.isDead) {
      this.fireMannedEmplacement();
    }
    if (this.isLeftDown && !this.player.isDead && !this.benchMenuOpen && !this.mountedEmplacementId) {
      if (this.equipment === 'smg' || this.equipment === 'pickaxe' || this.equipment === 'spade') {
        this.performAction();
      }
    }
    // NOTE: Right-click is intentionally NOT auto-repeated in the loop.
    // One click places exactly one block; holding the button does nothing
    // extra. This prevents accidentally placing multiple blocks per click.

    // ADS camera zoom. A manned cannon or mortar gets a tighter gunner zoom so
    // the fall of shot is readable at its 90-120m range.
    if (!this.mountedEmplacementId) this.manningZoom = false;
    let targetFov = 75;
    if (this.manningZoom) targetFov = 40;
    // A gun seat owns the view: a rifle ADS left on from before mounting must
    // not shrink the gunner's field of view.
    else if (this.isAiming && !this.mountedEmplacementId) targetFov = this.equipment === 'rifle' ? 45 : 55;
    if (Math.abs(this.player.camera.fov - targetFov) > 0.1) {
      this.player.camera.fov += (targetFov - this.player.camera.fov) * Math.min(dt * 12, 1);
      this.player.camera.updateProjectionMatrix();
    }

    if (this.currentWeaponModel) {
      const targetPos = this.isAiming ? this.adsPosition : this.hipPosition;
      this.currentWeaponModel.position.lerp(targetPos, Math.min(dt * 10, 1));
    }

    if (this.isReloadAnimating) {
      this.reloadAnimationTime += dt;
      if (this.reloadAnimationTime >= this.reloadAnimationDuration) {
        const weapon = this.weapons[this.equipment];
        if (weapon && weapon.magazineSize > 0) {
          const needed = weapon.magazineSize - weapon.currentAmmo;
          const online = this.gameMode === 'online';
          const loaded = online ? Math.min(needed, this.ammoReserve) : needed;
          weapon.currentAmmo += loaded;
          if (online) this.ammoReserve = Math.max(0, this.ammoReserve - loaded);
          weapon.isReloading = false;
        }
        this.isReloadAnimating = false;
      }
    }

    for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
      const flash = this.muzzleFlashes[i];
      flash.life += dt;

      // Animate flying incandescent sparks
      if (flash.sparks) {
        for (const sp of flash.sparks) {
          sp.mesh.position.addScaledVector(sp.velocity, dt);
          sp.velocity.multiplyScalar(0.92);
        }
      }

      if (flash.life >= flash.maxLife) {
        this.scene.remove(flash.light);
        this.scene.remove(flash.group);
        if (flash.sparks) {
          for (const sp of flash.sparks) {
            this.scene.remove(sp.mesh);
            sp.mesh.geometry.dispose();
            (sp.mesh.material as THREE.Material).dispose();
          }
        }
        flash.group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
        this.muzzleFlashes.splice(i, 1);
      }
    }

    for (let i = this.impactBursts.length - 1; i >= 0; i--) {
      const burst = this.impactBursts[i];
      burst.life += dt;
      const t = Math.min(1, burst.life / burst.maxLife);
      const flashMaterial = burst.flash.material as THREE.MeshBasicMaterial;
      flashMaterial.opacity = Math.max(0, 0.95 * (1 - t * 2.2));
      burst.flash.scale.setScalar(1 + t * 2.2);
      const dustMaterial = burst.dust.material as THREE.MeshBasicMaterial;
      dustMaterial.opacity = Math.max(0, 0.5 * (1 - t));
      burst.dust.scale.setScalar(1 + t * 2.8);
      const ringMaterial = burst.ring.material as THREE.MeshBasicMaterial;
      ringMaterial.opacity = Math.max(0, 0.75 * (1 - t));
      burst.ring.scale.setScalar(1 + t * 2.6);
      for (const chip of burst.chips) {
        chip.velocity.y -= 12 * dt;
        chip.mesh.position.addScaledVector(chip.velocity, dt);
        chip.mesh.rotation.x += dt * 9;
        (chip.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.95 * (1 - t));
      }
      if (burst.life >= burst.maxLife) {
        this.removeImpactBurst(burst);
        this.impactBursts.splice(i, 1);
      }
    }

    for (let i = this.bulletTracers.length - 1; i >= 0; i--) {
      const tracer = this.bulletTracers[i];
      const prevPos = tracer.mesh.position.clone();
      tracer.mesh.position.add(tracer.velocity.clone().multiplyScalar(dt));
      tracer.life += dt;

      // Audio bullet whiz when passing close to local player:
      if (!tracer.hasWhizzed && !this.player.isDead) {
        const rayDir = tracer.velocity.clone().normalize();
        const toPlayer = this.player.position.clone().add(new THREE.Vector3(0, 1.2, 0)).sub(prevPos);
        const t = toPlayer.dot(rayDir);
        if (t > 0 && t < tracer.velocity.length() * dt + 1.2) {
          const closestPt = prevPos.clone().addScaledVector(rayDir, t);
          const dist = closestPt.distanceTo(this.player.position.clone().add(new THREE.Vector3(0, 1.2, 0)));
          if (dist > 0.45 && dist < 3.2) {
            tracer.hasWhizzed = true;
            const pan = Math.sin(Math.atan2(closestPt.x - this.player.position.x, closestPt.z - this.player.position.z) - this.player.yaw);
            this.sounds.bulletWhiz(pan);
          }
        }
      }

      if (tracer.life >= tracer.maxLife) {
        if (tracer.targetDistance && tracer.targetDistance < 340 && !tracer.hasImpacted) {
          tracer.hasImpacted = true;
          this.createImpactSparks(tracer.mesh.position);
        }
        this.scene.remove(tracer.mesh);
        this.bulletTracers.splice(i, 1);
      }
    }

    // Update bullet shells with physics, ground bounces and fade-out
    for (let i = this.bulletShells.length - 1; i >= 0; i--) {
      const shell = this.bulletShells[i];
      shell.velocity.y -= 11.5 * dt; // Gravity
      shell.mesh.position.addScaledVector(shell.velocity, dt);
      shell.mesh.rotation.x += shell.rotationSpeed.x * dt;
      shell.mesh.rotation.y += shell.rotationSpeed.y * dt;
      shell.mesh.rotation.z += shell.rotationSpeed.z * dt;
      shell.life += dt;

      // Voxel terrain collision bounce
      const sx = Math.round(shell.mesh.position.x);
      const sy = Math.round(shell.mesh.position.y);
      const sz = Math.round(shell.mesh.position.z);
      if (this.world.isSolid(sx, sy, sz) && (shell.groundBounces || 0) < 3) {
        shell.groundBounces = (shell.groundBounces || 0) + 1;
        shell.velocity.y = Math.abs(shell.velocity.y) * 0.38;
        shell.velocity.x *= 0.55;
        shell.velocity.z *= 0.55;
        shell.rotationSpeed.multiplyScalar(0.5);
      }
      
      // Fade out in last 0.6 seconds
      if (shell.life > shell.maxLife - 0.6) {
        const opacity = Math.max(0, (shell.maxLife - shell.life) / 0.6);
        (shell.mesh.material as THREE.MeshStandardMaterial).opacity = opacity;
      }
      
      if (shell.life >= shell.maxLife) {
        this.scene.remove(shell.mesh);
        shell.mesh.geometry.dispose();
        (shell.mesh.material as THREE.Material).dispose();
        this.bulletShells.splice(i, 1);
      }
    }

    // Update celebratory capture fireworks
    for (let i = this.captureFireworks.length - 1; i >= 0; i--) {
      const fw = this.captureFireworks[i];
      fw.life += dt;
      fw.velocity.y -= 14.0 * dt; // Gravity
      fw.mesh.position.addScaledVector(fw.velocity, dt);
      fw.mesh.rotation.x += 4 * dt;
      fw.mesh.rotation.y += 4 * dt;

      if (fw.life > fw.maxLife - 0.5) {
        const op = Math.max(0, (fw.maxLife - fw.life) / 0.5);
        (fw.mesh.material as THREE.MeshBasicMaterial).opacity = op;
      }

      if (fw.life >= fw.maxLife) {
        this.scene.remove(fw.mesh);
        fw.mesh.geometry.dispose();
        (fw.mesh.material as THREE.Material).dispose();
        this.captureFireworks.splice(i, 1);
      }
    }

    this.updateFlags(dt);
    this.updateBots(dt);

    // Wait for the server to confirm our requested team before sending positions.
    if (this.networkClient && this.networkClient.isConnected() && this.onlineJoinConfirmed && !this.player.isDead && !this.drivingJeepId) {
      const now = performance.now();
      if (now - this.lastInputSendTime > this.inputSendRate) {
        this.lastInputSendTime = now;
        this.networkClient.sendPlayerInput({
          moveX: (this.player.hasKey('KeyD') ? 1 : 0) - (this.player.hasKey('KeyA') ? 1 : 0),
          moveZ: (this.player.hasKey('KeyW') ? 1 : 0) - (this.player.hasKey('KeyS') ? 1 : 0),
          jump: this.player.hasKey('Space'),
          crouch: this.player.isCrouching,
          sprint: this.player.isSprinting,
          yaw: this.player.yaw,
          pitch: this.player.pitch,
          position: { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z },
          equipment: this.equipment,
          isAiming: this.isAiming,
        });
      }
    }

    // Smoothly interpolate remote players
    for (const [, remote] of this.remotePlayers) {
      remote.mesh.position.lerp(remote.targetPosition, Math.min(dt * 15, 1));
      remote.mesh.rotation.y = remote.targetRotation.y;

      const dist = remote.mesh.position.distanceTo(remote.targetPosition);
      const isMoving = dist > 0.05;
      // Bot mesh children: 0: body, 1: head, 2: helmet, 3: leftArm, 4: rightArm, 5: leftLeg, 6: rightLeg
      const leftArm = remote.mesh.children[3] as THREE.Mesh;
      const rightArm = remote.mesh.children[4] as THREE.Mesh;
      const leftLeg = remote.mesh.children[5] as THREE.Mesh;
      const rightLeg = remote.mesh.children[6] as THREE.Mesh;

      if (isMoving) {
        const swing = Math.sin(performance.now() * 0.01) * 0.45;
        // Which way the body is actually travelling: a server bot that keeps its
        // aim on a pursuer while withdrawing crosses its own facing.
        const gait = gaitFor(
          remote.targetPosition.x - remote.mesh.position.x,
          remote.targetPosition.z - remote.mesh.position.z,
          remote.mesh.rotation.y,
        );
        if (leftLeg && rightLeg) {
          if (gait === 'strafe') {
            // Side-step: the legs scissor sideways instead of swinging fore/aft.
            leftLeg.rotation.x = 0;
            rightLeg.rotation.x = 0;
            leftLeg.rotation.z = swing * 0.55;
            rightLeg.rotation.z = -swing * 0.55;
          } else {
            // A backpedal reverses and shortens the stride; forwards is unchanged.
            const stride = gait === 'backpedal' ? -swing * 0.7 : swing;
            leftLeg.rotation.z = 0;
            rightLeg.rotation.z = 0;
            leftLeg.rotation.x = stride;
            rightLeg.rotation.x = -stride;
          }
        }
        // Arms swing only when running forwards: a bot (or player) firing over
        // its shoulder holds the weapon on the target.
        const armSwing = gait === 'forward' ? swing : 0;
        if (leftArm) leftArm.rotation.x = -armSwing;
        if (rightArm) rightArm.rotation.x = armSwing;
      } else {
        if (leftLeg) { leftLeg.rotation.x = 0; leftLeg.rotation.z = 0; }
        if (rightLeg) { rightLeg.rotation.x = 0; rightLeg.rotation.z = 0; }
        if (leftArm) leftArm.rotation.x = 0;
        if (rightArm) rightArm.rotation.x = 0;
      }
    }

    // Hit marker timer countdown (only flashes red on hit, then disappears)
    if (this.hitMarkerTimer > 0) {
      this.hitMarkerTimer -= dt;
      if (this.hitMarkerTimer <= 0) {
        this.hitMarkerTimer = 0;
      }
    }

    // Manage visibility of first-person equipment and third-person player avatar in spectator mode.
    // Manning a gun replaces the rifle with that gun's controls, so the hand
    // weapon goes away entirely.
    if (this.weaponContainer) {
      this.weaponContainer.visible = !this.isSpectating && !this.mountedEmplacementId;
    }
    if (this.highlightMesh && this.isSpectating) {
      this.highlightMesh.visible = false;
    }
    if (this.buildPreviewMesh && this.isSpectating) {
      this.buildPreviewMesh.visible = false;
    }
    if (this.localPlayerMesh) {
      this.localPlayerMesh.visible = this.isSpectating && !this.player.isDead;
      if (this.localPlayerMesh.visible) {
        this.localPlayerMesh.position.copy(this.player.position);
        this.localPlayerMesh.rotation.y = this.player.yaw;
      }
    }

    // Update target under crosshair for HUD information
    if (!this.player.isDead && !this.isSpectating) {
      const aimDir = this.player.getAimDirection();
      const eyePos = this.player.getEyePosition();
      const terrainHit = this.world.raycast(eyePos, aimDir, 350);
      const maxCheckDist = terrainHit ? terrainHit.distance : 350;
      let closestTargetName = '';
      let closestDist = maxCheckDist;

      for (const bot of this.bots) {
        if (bot.isDead || bot.team === this.playerTeam) continue;
        const dx = bot.position.x - eyePos.x;
        const dz = bot.position.z - eyePos.z;
        const horizDirSq = aimDir.x * aimDir.x + aimDir.z * aimDir.z;
        if (horizDirSq > 0.0001) {
          const t = (dx * aimDir.x + dz * aimDir.z) / horizDirSq;
          if (t > 0.4 && t < closestDist) {
            const rx = eyePos.x + aimDir.x * t;
            const rz = eyePos.z + aimDir.z * t;
            const ry = eyePos.y + aimDir.y * t;
            const hDist = Math.hypot(rx - bot.position.x, rz - bot.position.z);
            const vDist = ry - bot.position.y;
            if (hDist < 0.65 && vDist >= -0.1 && vDist <= 2.15) {
              closestDist = t;
              const isHead = vDist >= 1.45;
              closestTargetName = `🎯 [${bot.team.toUpperCase()}] ${bot.name} • ${Math.round(t)}m ${isHead ? '(HEADSHOT)' : ''}`;
            }
          }
        }
      }

      for (const remote of this.remotePlayers.values()) {
        if (remote.state.isDead || remote.state.team === this.playerTeam) continue;
        const targetPos = remote.mesh.position;
        const dx = targetPos.x - eyePos.x;
        const dz = targetPos.z - eyePos.z;
        const horizDirSq = aimDir.x * aimDir.x + aimDir.z * aimDir.z;
        if (horizDirSq > 0.0001) {
          const t = (dx * aimDir.x + dz * aimDir.z) / horizDirSq;
          if (t > 0.4 && t < closestDist) {
            const rx = eyePos.x + aimDir.x * t;
            const rz = eyePos.z + aimDir.z * t;
            const ry = eyePos.y + aimDir.y * t;
            const hDist = Math.hypot(rx - targetPos.x, rz - targetPos.z);
            const vDist = ry - targetPos.y;
            if (hDist < 0.72 && vDist >= -0.1 && vDist <= 2.25) {
              closestDist = t;
              const isHead = vDist >= 1.45;
              closestTargetName = `🎯 [${remote.state.team.toUpperCase()}] ${remote.state.name} • ${Math.round(t)}m ${isHead ? '(HEADSHOT)' : ''}`;
            }
          }
        }
      }

      this.player.targetInfo = closestTargetName;
    } else {
      this.player.targetInfo = '';
    }

    // Dynamic Spectator camera view with action tracking and free fly controls
    if (this.isSpectating) {
      if (this.spectatorMode === 'action') {
        // Auto-orbit around the active action center
        this.spectatorAngle += dt * 0.28;

        let desiredTarget = new THREE.Vector3(0, this.world.getOriginalGroundLevel() + 2, 0);
        let targetLabel = 'Midfield Overview';

        // 1. Prioritize tracking any active flag carrier
        if (this.redFlag?.carrier) {
          const carrierPos = this.redFlag.carrier.isPlayer ? this.player.position : this.redFlag.carrier.bot?.position;
          if (carrierPos) {
            desiredTarget = carrierPos.clone();
            targetLabel = `Carrier: ${this.redFlag.carrier.name} (RED FLAG)`;
          }
        } else if (this.blueFlag?.carrier) {
          const carrierPos = this.blueFlag.carrier.isPlayer ? this.player.position : this.blueFlag.carrier.bot?.position;
          if (carrierPos) {
            desiredTarget = carrierPos.clone();
            targetLabel = `Carrier: ${this.blueFlag.carrier.name} (BLUE FLAG)`;
          }
        } else {
          // 2. Track actively dueling bots or frontline vanguard
          const activeCombatBot = this.bots.find(b => !b.isDead && (b.burstRemaining > 0 || b.shootTimer < 0.3 || b.isBuilding || b.isDigging));
          if (activeCombatBot) {
            desiredTarget = activeCombatBot.position.clone();
            targetLabel = `${activeCombatBot.name} (${activeCombatBot.role.toUpperCase()} • ${activeCombatBot.weapon.toUpperCase()})`;
          } else {
            const livingBot = this.bots.find(b => !b.isDead);
            if (livingBot) {
              desiredTarget = livingBot.position.clone();
              targetLabel = `${livingBot.name} (${livingBot.role.toUpperCase()})`;
            }
          }
        }

        this.spectatorTrackedName = targetLabel;
        this.spectatorTarget.lerp(desiredTarget, Math.min(dt * 3.5, 1));

        const camDist = 24;
        const camHeight = 13;
        const camX = this.spectatorTarget.x + Math.sin(this.spectatorAngle) * camDist;
        const camZ = this.spectatorTarget.z + Math.cos(this.spectatorAngle) * camDist;
        const groundY = this.world.getGroundHeight(camX, camZ) + 3;
        const camY = Math.max(groundY, this.spectatorTarget.y + camHeight);

        this.spectatorPos.set(camX, camY, camZ);
        this.player.camera.position.copy(this.spectatorPos);
        this.player.camera.lookAt(this.spectatorTarget.x, this.spectatorTarget.y + 1.2, this.spectatorTarget.z);
      } else {
        // Free Fly Camera: 6-DOF free roaming
        this.spectatorTrackedName = 'Free Fly Roaming Cam';

        // Keyboard panning / steering
        if (this.spectatorTurnLeft) this.spectatorAngle += 2.4 * dt;
        if (this.spectatorTurnRight) this.spectatorAngle -= 2.4 * dt;
        if (this.spectatorPitchUp) {
          this.spectatorPitch += 1.8 * dt;
          this.spectatorPitch = Math.min(Math.PI / 2.2, this.spectatorPitch);
        }
        if (this.spectatorPitchDown) {
          this.spectatorPitch -= 1.8 * dt;
          this.spectatorPitch = Math.max(-Math.PI / 2.2, this.spectatorPitch);
        }

        const effectiveSpeed = this.spectatorSprint ? this.spectatorSpeed * 2.2 : this.spectatorSpeed;
        const moveSpeed = effectiveSpeed * dt;

        // View direction from yaw & pitch
        const forward = new THREE.Vector3(
          Math.sin(this.spectatorAngle) * Math.cos(this.spectatorPitch),
          Math.sin(this.spectatorPitch),
          Math.cos(this.spectatorAngle) * Math.cos(this.spectatorPitch)
        ).normalize();

        // Screen-right is forward x world-up: with forward = (sin a, 0, cos a),
        // right is (-cos a, 0, sin a). The old (+cos, 0, -sin) vector pointed
        // left, so A/D strafing felt mirrored in free-fly mode.
        const right = new THREE.Vector3(
          -Math.cos(this.spectatorAngle),
          0,
          Math.sin(this.spectatorAngle)
        ).normalize();

        if (this.spectatorMoveForward) this.spectatorPos.add(forward.clone().multiplyScalar(moveSpeed));
        if (this.spectatorMoveBackward) this.spectatorPos.sub(forward.clone().multiplyScalar(moveSpeed));
        if (this.spectatorMoveLeft) this.spectatorPos.sub(right.clone().multiplyScalar(moveSpeed));
        if (this.spectatorMoveRight) this.spectatorPos.add(right.clone().multiplyScalar(moveSpeed));
        if (this.spectatorFlyUp) this.spectatorPos.y += moveSpeed;
        if (this.spectatorFlyDown) this.spectatorPos.y -= moveSpeed;

        // Keep above terrain
        const groundY = this.world.getGroundHeight(this.spectatorPos.x, this.spectatorPos.z) + 1.2;
        if (this.spectatorPos.y < groundY) this.spectatorPos.y = groundY;

        this.player.camera.position.copy(this.spectatorPos);
        const lookTarget = this.spectatorPos.clone().add(forward);
        this.player.camera.lookAt(lookTarget);
      }
    } else if (seatedJeep) {
      // Chase camera behind the jeep. The player is pinned to the jeep origin
      // while seated, so a first-person camera here would sit inside the hull.
      const state = seatedJeep.state;
      const back = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
      this.player.camera.position.set(state.position.x + back.x * 7, state.position.y + 4, state.position.z + back.z * 7);
      this.player.camera.lookAt(state.position.x - back.x * 3, state.position.y + 1.4, state.position.z - back.z * 3);
    } else {
      // First-person player camera
      this.player.updateCamera();
    }

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message = '';
    }

    // Round clock: tick locally between server syncs so the HUD is smooth.
    if (this.roundIsServerDriven) {
      if (this.roundPhase === 'live') {
        this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt);
      } else {
        this.roundIntermission = Math.max(0, this.roundIntermission - dt);
      }
      if (this.roundWinnerTimer > 0) this.roundWinnerTimer = Math.max(0, this.roundWinnerTimer - dt);
    }

    // Latency probe: one round-trip every couple of seconds while connected.
    if (this.networkClient && this.networkClient.isConnected()) {
      this.pingTimer -= dt;
      if (this.pingTimer <= 0) {
        this.pingTimer = PING_INTERVAL_SECONDS;
        this.networkClient.ping(Date.now());
      }
    } else {
      this.pingMs = 0;
    }

    this.emitState();
    this.updateEmplacementFlashes(performance.now());
    this.renderer.render(this.scene, this.player.camera);
  };

  private findNearestEnemy(bot: Bot): { pos: THREE.Vector3; isPlayer: boolean; bot?: Bot } | null {
    let nearest: { pos: THREE.Vector3; isPlayer: boolean; bot?: Bot } | null = null;
    let nearestDist = Infinity;

    const botForward = new THREE.Vector3(-Math.sin(bot.mesh.rotation.y), 0, -Math.cos(bot.mesh.rotation.y));
    const wasRecentlyHit = Date.now() - bot.lastDamageTime < 3500;

    // Prioritize enemy flag carrier if our team's flag is stolen!
    const friendlyFlag = bot.team === 'blue' ? this.blueFlag : this.redFlag;
    if (friendlyFlag && friendlyFlag.carrier) {
      if (friendlyFlag.carrier.isPlayer && bot.team !== this.playerTeam && !this.player.isDead) {
        const dist = bot.position.distanceTo(this.player.position);
        if (dist < 160) {
          const toEnemy = this.player.position.clone().sub(bot.position).normalize();
          const dotProduct = botForward.dot(toEnemy);
          if (dist < 28 || wasRecentlyHit || dotProduct > -0.25) {
            return { pos: this.player.position.clone(), isPlayer: true };
          }
        }
      } else if (friendlyFlag.carrier.bot && !friendlyFlag.carrier.bot.isDead && friendlyFlag.carrier.bot.team !== bot.team) {
        const dist = bot.position.distanceTo(friendlyFlag.carrier.bot.position);
        if (dist < 160) {
          const toEnemy = friendlyFlag.carrier.bot.position.clone().sub(bot.position).normalize();
          const dotProduct = botForward.dot(toEnemy);
          if (dist < 28 || wasRecentlyHit || dotProduct > -0.25) {
            return { pos: friendlyFlag.carrier.bot.position.clone(), isPlayer: false, bot: friendlyFlag.carrier.bot };
          }
        }
      }
    }

    // Check player
    if (bot.team !== this.playerTeam && !this.player.isDead) {
      const dist = bot.position.distanceTo(this.player.position);
      if (dist < nearestDist && dist < 140) {
        const toPlayer = this.player.position.clone().sub(bot.position).normalize();
        const dotProduct = botForward.dot(toPlayer);
        // Detect if close (hearing footsteps/spades), if recently took damage, or if in wide FOV
        if (dist < 24 || wasRecentlyHit || dotProduct > -0.25) {
          nearestDist = dist;
          nearest = { pos: this.player.position.clone(), isPlayer: true };
        }
      }
    }

    // Check other bots
    for (const otherBot of this.bots) {
      if (otherBot === bot || otherBot.isDead || otherBot.team === bot.team) continue;
      const dist = bot.position.distanceTo(otherBot.position);
      if (dist < nearestDist && dist < 140) {
        const toEnemy = otherBot.position.clone().sub(bot.position).normalize();
        const dotProduct = botForward.dot(toEnemy);
        if (dist < 24 || wasRecentlyHit || dotProduct > -0.25) {
          nearestDist = dist;
          nearest = { pos: otherBot.position.clone(), isPlayer: false, bot: otherBot };
        }
      }
    }

    return nearest;
  }

  private updateBots(dt: number): void {
    const friendlyFlag = (team: Team) => team === 'blue' ? this.blueFlag : this.redFlag;
    const enemyFlag = (team: Team) => team === 'blue' ? this.redFlag : this.blueFlag;

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];

      // Riding shotgun: the jeep owns the body, so the foot AI stays out.
      const ride = this.localJeeps.find(vehicle => !vehicle.wreck && vehicle.passengerId === bot.name);
      if (ride && !bot.isDead) {
        bot.position.set(ride.position.x, ride.position.y, ride.position.z);
        bot.mesh.position.copy(bot.position);
        bot.mesh.visible = false;
        continue;
      }

      // Respawn handling
      if (bot.isDead) {
        const passengerJeep = this.localJeeps.find(vehicle => vehicle.passengerId === bot.name);
        if (passengerJeep) passengerJeep.passengerId = null;
        if (this.botJeepMissions.has(bot.name)) this.abandonBotJeepMission(bot);
        bot.respawnTimer -= dt;
        if (bot.respawnTimer <= 0) {
          bot.isDead = false;
          bot.hp = bot.maxHp;
          bot.mesh.visible = true;
          const spawnPos = this.getSafeSpawnPos(bot.team);
          bot.position.copy(spawnPos);
          bot.lastPos.copy(spawnPos);
          bot.stuckTimer = 0;
          bot.carryingFlag = false;
          if (bot.flagMesh) bot.flagMesh.visible = false;
          bot.reactionDelay = 0;
          bot.currentTargetKey = null;
          bot.consecutiveShots = 0;
          bot.mesh.position.copy(bot.position);
          bot.ammo = bot.maxAmmo;
          bot.isReloading = false;
          bot.reloadTimer = 0;
          bot.isDigging = false;
          bot.digTimer = 0;
          bot.digTarget = null;
          bot.nestId = null;
          bot.nestIdleTimer = 0;
          bot.nestCooldown = 0;
          bot.isBuilding = false;
          bot.buildTimer = 0;
          bot.buildTarget = null;
          bot.trenchDepth = 0;
          bot.isInTrench = false;
          bot.flankRoute = null;
          bot.flankProgress = 0;
          bot.inventoryBlocks = 14 + Math.floor(Math.random() * 10);
          bot.tacticalState = bot.role === 'defender' ? 'defending' : 'capturing';
          bot.tacticalStateTimer = 8 + Math.random() * 4;
          bot.buildCooldown = 2.0;
          bot.digCooldown = 3.0;
          bot.tacticalBlocksQueued = [];
          if (bot.bodyParts) {
            bot.bodyParts.weaponGroup.visible = true;
            bot.bodyParts.spadeGroup.visible = false;
            bot.bodyParts.blockGroup.visible = false;
          }
          this.updateBotNameTag(bot, bot.tacticalState === 'capturing' ? '🚩 RUSHING FLAG' : (bot.tacticalState === 'defending' ? '🛡️ DEFENDING' : '🎯 PATROLLING'), '#55aaff');
          // Face toward center/enemy territory
          const initialFacingDir = new THREE.Vector3(0, 0, bot.team === 'blue' ? 1 : -1);
          bot.mesh.rotation.y = Math.atan2(-initialFacingDir.x, -initialFacingDir.z);
        }
        continue;
      }

      // Safety: Void / fall check for bots. Bounds derive from the shared
      // WORLD_SIZE (map was enlarged; old hardcoded ±155 tele-killed bots in
      // the outer field that is now playable terrain).
      const VOID_BOUND = WORLD_SIZE / 2 - CHUNK_SIZE / 2;
      if (bot.position.y < -5 || bot.position.y > 60 || Math.abs(bot.position.x) > VOID_BOUND || Math.abs(bot.position.z) > VOID_BOUND) {
        bot.hp = 0;
        bot.isDead = true;
        bot.mesh.visible = false;
        bot.respawnTimer = 2; // Rapid recovery if fell into void
        if (bot.carryingFlag) {
          const carriedFlag = bot.team === 'blue' ? this.redFlag : this.blueFlag;
          if (carriedFlag) {
            this.resetFlagToBase(carriedFlag);
          }
          bot.carryingFlag = false;
        }
        continue;
      }

      // A bot on a jeep errand skips the infantry AI entirely: it is walking to
      // the workshop, boarding, or driving, which is the whole point of it.
      const jeepMission = this.botJeepMissions.get(bot.name);
      if (jeepMission) { this.updateBotJeepMission(bot, jeepMission, dt); continue; }

      // MG post duty: a bot manning a nest spends the frame shooting from it,
      // and one standing by a free nest climbs in. Both skip the foot AI.
      if (this.updateBotNest(bot, dt)) continue;

      const eFlag = enemyFlag(bot.team);
      const fFlag = friendlyFlag(bot.team);
      const homeBasePos = bot.team === 'blue' ? BLUE_FLAG_POS : RED_FLAG_POS;

      // Update cooldowns & state timer
      bot.buildCooldown = Math.max(0, bot.buildCooldown - dt);
      bot.digCooldown = Math.max(0, bot.digCooldown - dt);
      bot.jumpCooldown = Math.max(0, bot.jumpCooldown - dt);
      bot.tacticalStateTimer = Math.max(0, bot.tacticalStateTimer - dt);

      // Reload timer countdown
      if (bot.isReloading) {
        bot.reloadTimer -= dt;
        if (bot.reloadTimer <= 0) {
          bot.ammo = bot.maxAmmo;
          bot.isReloading = false;
        }
      }

      // Speech bubble timer & flinch handling
      if (bot.speechTimer > 0) {
        bot.speechTimer -= dt;
        if (bot.speechTimer <= 0) {
          bot.speechText = undefined;
          this.updateBotNameTag(bot, bot.tacticalState, bot.team === 'blue' ? '#60a5fa' : '#f87171');
        }
      }

      if (bot.flinchTimer > 0) {
        bot.flinchTimer -= dt;
        if (bot.bodyParts) {
          bot.bodyParts.head.rotation.x = Math.sin(bot.flinchTimer * 28) * 0.12;
        }
      }

      bot.combatJumpCooldown = Math.max(0, (bot.combatJumpCooldown || 0) - dt);

      // Find nearest enemy target with 360° awareness and wide FOV
      const enemyTarget = this.findNearestEnemy(bot);
      const distToEnemy = enemyTarget ? bot.position.distanceTo(enemyTarget.pos) : Infinity;
      const wasRecentlyHit = Date.now() - bot.lastDamageTime < 3200;

      // Contextual radio callouts on enemy visual contact
      if (enemyTarget && distToEnemy < 38 && Date.now() - (bot.lastRadioCallTime || 0) > 11000) {
        bot.lastRadioCallTime = Date.now();
        const callout = enemyTarget.isPlayer
          ? '🎯 Visual on enemy operative! Fire at will!'
          : (distToEnemy < 16 ? '⚠️ Close quarters contact!' : '🎯 Hostile in sector! Engaging!');
        this.addRadioMessage(bot.name, callout, bot.team, bot);
      }

      // Strafe dodging timer (flips direction periodically like human players)
      bot.dodgeTimer -= dt;
      if (bot.dodgeTimer <= 0) {
        bot.strafeDirection = -bot.strafeDirection;
        bot.dodgeTimer = 1.0 + Math.random() * 1.4;
      }

      // Combat agility: dynamic bunny-hop jumps during firefights
      if (enemyTarget && distToEnemy < 35 && bot.grounded && bot.combatJumpCooldown <= 0) {
        if (bot.archetype === 'assault' || Math.random() < 0.35) {
          bot.velocity.y = 6.8;
          bot.grounded = false;
          bot.combatJumpCooldown = 2.2 + Math.random() * 2.5;
        }
      }

      // Human crouch-peek cycle during combat (or crouch behind cover)
      if (enemyTarget && distToEnemy < 45) {
        bot.crouchTimer -= dt;
        if (bot.crouchTimer <= 0) {
          bot.isCrouching = !bot.isCrouching;
          bot.crouchTimer = bot.isCrouching ? (0.6 + Math.random() * 0.8) : (1.1 + Math.random() * 1.4);
        }
      } else if (!bot.isBuilding && !bot.isDigging && bot.tacticalState !== 'defending') {
        bot.isCrouching = false;
      }

      // TACTICAL OBJECTIVE DECISION-MAKING & DYNAMIC STATE TRANSITIONS
      const distToEFlag = Math.hypot(bot.position.x - eFlag.currentPos.x, bot.position.z - eFlag.currentPos.z);
      const distToHome = Math.hypot(bot.position.x - homeBasePos.x, bot.position.z - homeBasePos.z);
      // Smoothly blend lane offset to 0 as the bot approaches flag or base so it touches the exact coordinate!
      const flagApproachBlend = Math.max(0, Math.min(1, (distToEFlag - 5) / 25));
      const homeApproachBlend = Math.max(0, Math.min(1, (distToHome - 5) / 25));

      if (bot.tacticalState === 'capturing') {
        bot.targetPos.set(eFlag.currentPos.x + bot.laneOffset * 0.25 * flagApproachBlend, 0, eFlag.currentPos.z);
      } else if (bot.tacticalState === 'returning') {
        bot.targetPos.set(homeBasePos.x + bot.laneOffset * 0.25 * homeApproachBlend, 0, homeBasePos.z);
      }

      if (bot.carryingFlag) {
        // PRIORITY 1: Carrying enemy flag - sprint straight to home base!
        bot.targetPos.set(homeBasePos.x + bot.laneOffset * 0.25 * homeApproachBlend, 0, homeBasePos.z);
        bot.tacticalState = 'returning';
        bot.behaviorState = 'returnFlag';
        this.updateBotNameTag(bot, distToHome < 12 ? '🏃 SCORING CAPTURE!' : '🏃 RETURNING FLAG', '#e040fb');

        // Dynamic Tactical Cover: If pursued closely from behind, drop barricade behind!
        if (enemyTarget && distToEnemy < 18 && distToHome > 14 && bot.inventoryBlocks > 0 && bot.buildCooldown <= 0 && !bot.isBuilding) {
          const runDir = new THREE.Vector3(homeBasePos.x, 0, homeBasePos.z).sub(bot.position).setY(0).normalize();
          const backDist = 2.0;
          const backX = Math.round(bot.position.x - runDir.x * backDist);
          const backZ = Math.round(bot.position.z - runDir.z * backDist);
          const backY = Math.floor(this.world.getGroundHeight(backX, backZ)) + 1;
          if (this.canPlaceBlock(backX, backY, backZ)) {
            bot.isBuilding = true;
            bot.buildTimer = 0.25;
            bot.tacticalBlocksQueued = [{ x: backX, y: backY, z: backZ }];
            bot.buildCooldown = 4.5;
            if (bot.bodyParts) {
              bot.bodyParts.blockGroup.visible = true;
              bot.bodyParts.weaponGroup.visible = false;
              bot.bodyParts.spadeGroup.visible = false;
            }
            this.updateBotNameTag(bot, '🧱 RETREAT BARRICADE', '#00e676');
          }
        }
      } else if (fFlag && fFlag.carrier) {
        // PRIORITY 2: Friendly flag is stolen! Intercept enemy carrier!
        const carrierPos = fFlag.carrier.isPlayer ? this.player.position : fFlag.carrier.bot?.position;
        if (carrierPos) {
          bot.targetPos.copy(carrierPos);
        } else {
          bot.targetPos.set(eFlag.currentPos.x + bot.laneOffset * 0.25 * flagApproachBlend, eFlag.currentPos.y, eFlag.currentPos.z);
        }
        if (enemyTarget && distToEnemy < 40) {
          bot.tacticalState = 'shooting';
          this.updateBotNameTag(bot, '⚡ INTERCEPT SHOOTING', '#ff9100');
        } else {
          bot.tacticalState = 'capturing';
          this.updateBotNameTag(bot, '⚡ RUSH TO INTERCEPT', '#ff9100');
        }
      } else if (eFlag && eFlag.isDropped) {
        // PRIORITY 3: Enemy flag is dropped on the battlefield - rush to secure it!
        bot.targetPos.copy(eFlag.currentPos);
        bot.tacticalState = 'capturing';
        bot.behaviorState = 'rushFlag';
        this.updateBotNameTag(bot, '🚩 SECURE DROPPED FLAG', '#ffd700');
      } else if (fFlag && fFlag.isDropped) {
        // PRIORITY 4: Friendly flag is dropped - rush to return it!
        bot.targetPos.copy(fFlag.currentPos);
        bot.tacticalState = 'returning';
        bot.behaviorState = 'returnFlag';
        this.updateBotNameTag(bot, '🛡️ RECOVER OUR FLAG', '#00e5ff');
      } else if (eFlag && eFlag.carrier) {
        // PRIORITY 5: Teammate has enemy flag! Escort and protect carrier to home base!
        bot.targetPos.set(homeBasePos.x + bot.laneOffset * 0.25 * homeApproachBlend, 0, homeBasePos.z);
        bot.behaviorState = 'escort';
        if (enemyTarget && distToEnemy < 40) {
          bot.tacticalState = 'shooting';
          this.updateBotNameTag(bot, '🛡️ COVERING FIRE', '#ff3d00');
        } else {
          bot.tacticalState = 'capturing';
          this.updateBotNameTag(bot, '🛡️ ESCORTING FLAG', '#29b6f6');
        }
      } else if (eFlag && eFlag.isCaptured) {
        // PRIORITY 6: Enemy flag is in respawn cooldown! Advance to enemy base and position ready to grab it instantly!
        bot.targetPos.set(eFlag.currentPos.x + Math.sin(bot.laneOffset) * 4, eFlag.currentPos.y, eFlag.currentPos.z + Math.cos(bot.laneOffset) * 4);
        bot.tacticalState = 'capturing';
        this.updateBotNameTag(bot, '⏳ AWAITING FLAG', '#ffd700');
      } else {
        // STANDARD COMBAT & OBJECTIVE CYCLE
        // Check combat engagements:
        const maxEngageDist = bot.weapon === 'rifle' ? 120 : 65;
        if (enemyTarget && distToEnemy < maxEngageDist) {
          // Combat in progress!
          // Attackers and flag carriers only build cover if critically wounded (< 30 HP)
          const isFlagPusher = bot.role === 'attacker' || bot.carryingFlag || bot.tacticalState === 'capturing';
          const needsCover = (isFlagPusher ? (bot.hp < 30 && wasRecentlyHit) : (wasRecentlyHit || bot.isReloading || bot.hp < 55));

          if (needsCover && bot.inventoryBlocks > 0 && bot.buildCooldown <= 0 && !bot.isBuilding && !bot.isDigging && !bot.carryingFlag) {
            // SWITCH TO BUILDING TACTICAL COVER!
            const toEnemy = enemyTarget.pos.clone().sub(bot.position).setY(0).normalize();
            const perp = new THREE.Vector3(-toEnemy.z, 0, toEnemy.x);
            const buildDist = 2.0;
            const frontX = Math.round(bot.position.x + toEnemy.x * buildDist);
            const frontZ = Math.round(bot.position.z + toEnemy.z * buildDist);
            const frontY = Math.floor(this.world.getGroundHeightBelow(frontX, bot.position.y, frontZ)) + 1;

            const wingX = Math.round(frontX + perp.x);
            const wingZ = Math.round(frontZ + perp.z);
            const wingY = Math.floor(this.world.getGroundHeightBelow(wingX, bot.position.y, wingZ)) + 1;

            const queued: Array<{ x: number; y: number; z: number }> = [];
            if (this.canPlaceBlock(frontX, frontY, frontZ)) queued.push({ x: frontX, y: frontY, z: frontZ });
            if (this.canPlaceBlock(wingX, wingY, wingZ)) queued.push({ x: wingX, y: wingY, z: wingZ });

            if (queued.length > 0) {
              bot.tacticalState = 'building';
              bot.buildCooldown = 4.5 + Math.random() * 2.5;
              bot.isBuilding = true;
              bot.buildTimer = 0.22;
              bot.tacticalBlocksQueued = queued;
              if (bot.bodyParts) {
                bot.bodyParts.blockGroup.visible = true;
                bot.bodyParts.weaponGroup.visible = false;
                bot.bodyParts.spadeGroup.visible = false;
              }
              this.updateBotNameTag(bot, '🔨 BUILDING COVER', '#00e676');
            }
          } else if (needsCover && bot.inventoryBlocks <= 0 && bot.digCooldown <= 0 && !bot.isBuilding && !bot.isDigging && distToEnemy > 18 && bot.role === 'defender') {
            // Only defenders dig trenches when low on blocks
            bot.tacticalState = 'digging';
            bot.digCooldown = 5.0;
            bot.isDigging = true;
            bot.digTimer = 0.45;
            const aimAngle = Math.atan2(enemyTarget.pos.x - bot.position.x, enemyTarget.pos.z - bot.position.z);
            const digX = Math.floor(bot.position.x + Math.sin(aimAngle) * 1.5);
            const digZ = Math.floor(bot.position.z + Math.cos(aimAngle) * 1.5);
            const digY = Math.floor(this.world.getGroundHeightBelow(digX, bot.position.y, digZ));
            bot.digTarget = { x: digX, y: digY, z: digZ };
            if (bot.bodyParts) {
              bot.bodyParts.spadeGroup.visible = true;
              bot.bodyParts.weaponGroup.visible = false;
              bot.bodyParts.blockGroup.visible = false;
            }
            this.updateBotNameTag(bot, '⛏️ DIGGING TRENCH', '#ffab00');
          } else if (!bot.isBuilding && !bot.isDigging) {
            // If pushing objective, keep pushing while shooting! Otherwise skirmish
            if (!isFlagPusher) {
              bot.tacticalState = 'shooting';
            }
            if (bot.bodyParts) {
              bot.bodyParts.weaponGroup.visible = true;
              bot.bodyParts.blockGroup.visible = false;
              bot.bodyParts.spadeGroup.visible = false;
            }
            if (!isFlagPusher) {
              this.updateBotNameTag(bot, bot.isReloading ? '🔄 RELOADING' : '🎯 SHOOTING', bot.isReloading ? '#cfd8dc' : '#ff3d00');
            }
          }
        } else {
          // Out of direct combat - Evaluate strategic objective:
          if (bot.tacticalStateTimer <= 0) {
            // Re-roll objective phase based on role and field state
            const roll = Math.random();
            if (bot.role === 'attacker') {
              if (roll < 0.90) {
                bot.tacticalState = 'capturing';
                bot.tacticalStateTimer = 10 + Math.random() * 5;
                bot.targetPos.set(eFlag.currentPos.x + bot.laneOffset * 0.25, 0, eFlag.currentPos.z);
                this.updateBotNameTag(bot, '🚩 RUSHING FLAG', '#ffd700');
              } else {
                bot.tacticalState = 'flanking';
                bot.tacticalStateTimer = 6 + Math.random() * 3;
                this.updateBotNameTag(bot, '🏹 FLANKING', '#b388ff');
              }
            } else if (bot.role === 'defender') {
              if (roll < 0.45 && bot.inventoryBlocks > 0 && bot.buildCooldown <= 0) {
                const fwd = new THREE.Vector3(0, 0, bot.team === 'blue' ? 1 : -1);
                const perp = new THREE.Vector3(-fwd.z, 0, fwd.x);
                const bx = Math.round(bot.position.x + fwd.x * 2.0);
                const bz = Math.round(bot.position.z + fwd.z * 2.0);
                const by = Math.floor(this.world.getGroundHeight(bx, bz)) + 1;
                const wx = Math.round(bx + perp.x);
                const wz = Math.round(bz + perp.z);
                const wy = Math.floor(this.world.getGroundHeight(wx, wz)) + 1;

                const queued: Array<{ x: number; y: number; z: number }> = [];
                if (this.canPlaceBlock(bx, by, bz)) queued.push({ x: bx, y: by, z: bz });
                if (this.canPlaceBlock(wx, wy, wz)) queued.push({ x: wx, y: wy, z: wz });

                if (queued.length > 0) {
                  bot.tacticalState = 'building';
                  bot.tacticalStateTimer = 2.2;
                  bot.buildCooldown = 5.0;
                  bot.isBuilding = true;
                  bot.buildTimer = 0.25;
                  bot.tacticalBlocksQueued = queued;
                  if (bot.bodyParts) {
                    bot.bodyParts.blockGroup.visible = true;
                    bot.bodyParts.weaponGroup.visible = false;
                    bot.bodyParts.spadeGroup.visible = false;
                  }
                  this.updateBotNameTag(bot, '🧱 FORTIFYING BASE', '#00e676');
                }
              } else if (roll < 0.70 && bot.digCooldown <= 0) {
                bot.tacticalState = 'digging';
                bot.tacticalStateTimer = 1.8;
                bot.digCooldown = 6.0;
                bot.isDigging = true;
                bot.digTimer = 0.45;
                const digAngle = Math.random() * Math.PI * 2;
                const digX = Math.floor(bot.position.x + Math.sin(digAngle) * 1.5);
                const digZ = Math.floor(bot.position.z + Math.cos(digAngle) * 1.5);
                const digY = Math.floor(this.world.getGroundHeight(digX, digZ));
                bot.digTarget = { x: digX, y: digY, z: digZ };
                if (bot.bodyParts) {
                  bot.bodyParts.spadeGroup.visible = true;
                  bot.bodyParts.weaponGroup.visible = false;
                  bot.bodyParts.blockGroup.visible = false;
                }
                this.updateBotNameTag(bot, '⛏️ DIGGING TRENCH', '#ffab00');
              } else if (roll < 0.88) {
                bot.tacticalState = 'defending';
                bot.tacticalStateTimer = 5 + Math.random() * 4;
                const angle = Math.random() * Math.PI * 2;
                const dist = 8 + Math.random() * 14;
                bot.targetPos.set(homeBasePos.x + Math.cos(angle) * dist, 0, homeBasePos.z + Math.sin(angle) * dist);
                this.updateBotNameTag(bot, '🛡️ DEFENDING BASE', '#2979ff');
              } else {
                bot.tacticalState = 'capturing';
                bot.tacticalStateTimer = 6 + Math.random() * 3;
                bot.targetPos.set(eFlag.currentPos.x + bot.laneOffset, 0, eFlag.currentPos.z);
                this.updateBotNameTag(bot, '🚩 COUNTER-ATTACK', '#ffd700');
              }
            } else {
              // Support / Flanker
              if (roll < 0.50) {
                bot.tacticalState = 'capturing';
                bot.tacticalStateTimer = 6 + Math.random() * 4;
                bot.targetPos.set(eFlag.currentPos.x + bot.laneOffset, 0, eFlag.currentPos.z);
                this.updateBotNameTag(bot, '🚩 ADVANCING', '#ffd700');
              } else if (roll < 0.75 && bot.inventoryBlocks > 0 && bot.buildCooldown <= 0) {
                const fwd = new THREE.Vector3(0, 0, bot.team === 'blue' ? 1 : -1);
                const bx = Math.round(bot.position.x + fwd.x * 2.0);
                const bz = Math.round(bot.position.z + fwd.z * 2.0);
                const by = Math.floor(this.world.getGroundHeight(bx, bz)) + 1;
                if (this.canPlaceBlock(bx, by, bz)) {
                  bot.tacticalState = 'building';
                  bot.tacticalStateTimer = 2.0;
                  bot.buildCooldown = 5.0;
                  bot.isBuilding = true;
                  bot.buildTimer = 0.25;
                  bot.tacticalBlocksQueued = [{ x: bx, y: by, z: bz }];
                  if (bot.bodyParts) {
                    bot.bodyParts.blockGroup.visible = true;
                    bot.bodyParts.weaponGroup.visible = false;
                    bot.bodyParts.spadeGroup.visible = false;
                  }
                  this.updateBotNameTag(bot, '🧱 SUPPORT COVER', '#00e676');
                }
              } else {
                bot.tacticalState = 'shooting';
                bot.tacticalStateTimer = 4 + Math.random() * 3;
                if (bot.bodyParts) {
                  bot.bodyParts.weaponGroup.visible = true;
                  bot.bodyParts.blockGroup.visible = false;
                  bot.bodyParts.spadeGroup.visible = false;
                }
                this.updateBotNameTag(bot, '🎯 PATROLLING', '#ff6d00');
              }
            }
          }
        }
      }

      // Execute Building Process
      if (bot.isBuilding) {
        bot.buildTimer -= dt;
        if (bot.bodyParts) {
          bot.bodyParts.rightArm.rotation.x = -Math.PI / 3;
          bot.bodyParts.leftArm.rotation.x = -Math.PI / 6;
        }

        // Active anti-clipping: ensure bot smoothly steps back if too close to target block
        if (bot.tacticalBlocksQueued.length > 0) {
          const nextBlk = bot.tacticalBlocksQueued[0];
          const distToBlk = Math.hypot(bot.position.x - (nextBlk.x + 0.5), bot.position.z - (nextBlk.z + 0.5));
          if (distToBlk < 1.45) {
            const awayX = bot.position.x - (nextBlk.x + 0.5);
            const awayZ = bot.position.z - (nextBlk.z + 0.5);
            const len = Math.hypot(awayX, awayZ) || 0.01;
            bot.position.x += (awayX / len) * 2.2 * dt;
            bot.position.z += (awayZ / len) * 2.2 * dt;
            bot.position.y = this.world.getGroundHeightBelow(bot.position.x, bot.position.y, bot.position.z);
          }
        }

        if (bot.buildTimer <= 0) {
          if (bot.tacticalBlocksQueued.length > 0 && bot.inventoryBlocks > 0) {
            const blk = bot.tacticalBlocksQueued.shift()!;
            if (this.canPlaceBlock(blk.x, blk.y, blk.z)) {
              this.world.setVoxel(blk.x, blk.y, blk.z, VOXEL_BUILT);
              this.sounds.buildPlace();
              bot.inventoryBlocks--;
              this.resolveBotVoxelPenetration(bot);
              if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected()) {
                this.networkClient.sendBuild({ x: blk.x, y: blk.y, z: blk.z });
              }
            }
            bot.buildTimer = 0.28; // Next block in queue
          } else {
            // Finished building!
            bot.isBuilding = false;
            bot.tacticalBlocksQueued = [];
            bot.isCrouching = true;
            bot.crouchTimer = 2.5; // Crouch behind freshly built cover
            this.resolveBotVoxelPenetration(bot);
            if (bot.bodyParts) {
              bot.bodyParts.blockGroup.visible = false;
              bot.bodyParts.weaponGroup.visible = true;
            }
            // Immediately transition to shooting if enemy in sight!
            if (enemyTarget && distToEnemy < 48) {
              bot.tacticalState = 'shooting';
              this.updateBotNameTag(bot, '🎯 SHOOTING', '#ff3d00');
            } else if (bot.carryingFlag) {
              bot.tacticalState = 'returning';
              this.updateBotNameTag(bot, '🏃 RETURNING FLAG', '#e040fb');
            } else {
              bot.tacticalState = 'capturing';
              this.updateBotNameTag(bot, '🚩 RUSHING FLAG', '#ffd700');
            }
          }
        }
      }

      // Execute Digging Process
      if (bot.isDigging && bot.digTarget) {
        bot.digTimer -= dt;
        if (bot.bodyParts) {
          bot.bodyParts.rightArm.rotation.x = Math.sin(bot.digTimer * 22) * 0.9;
          bot.bodyParts.leftArm.rotation.x = -Math.PI / 4;
        }
        if (bot.digTimer <= 0) {
          const { x, y, z } = bot.digTarget;
          if (this.world.canDig(x, y, z)) {
            this.world.setVoxel(x, y, z, 0);
            if (this.world.canDig(x, y - 1, z)) {
              this.world.setVoxel(x, y - 1, z, 0); // 2-block deep trench
            }
            this.sounds.spadeHit();
            bot.inventoryBlocks += 2;
            bot.trenchDepth += 2;
            bot.isInTrench = true;
            if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected()) {
              this.networkClient.sendUseTool('spade', { x, y, z });
            }
          }
          bot.isDigging = false;
          bot.digTarget = null;
          bot.digTimer = 0;
          if (bot.bodyParts) {
            bot.bodyParts.spadeGroup.visible = false;
            bot.bodyParts.weaponGroup.visible = true;
          }
          // If we gathered blocks and are under threat, immediately switch to building cover!
          if (enemyTarget && distToEnemy < 45 && bot.inventoryBlocks > 0) {
            bot.tacticalState = 'building';
            bot.isBuilding = true;
            bot.buildTimer = 0.22;
            const toEnemy = enemyTarget.pos.clone().sub(bot.position).normalize();
            const bx = Math.floor(bot.position.x + toEnemy.x * 1.4);
            const bz = Math.floor(bot.position.z + toEnemy.z * 1.4);
            const by = Math.floor(this.world.getGroundHeight(bx, bz)) + 1;
            bot.tacticalBlocksQueued = [{ x: bx, y: by, z: bz }];
            if (bot.bodyParts) {
              bot.bodyParts.blockGroup.visible = true;
              bot.bodyParts.weaponGroup.visible = false;
            }
            this.updateBotNameTag(bot, '🔨 BUILDING COVER', '#00e676');
          } else {
            bot.tacticalState = 'shooting';
            this.updateBotNameTag(bot, '🎯 SHOOTING', '#ff3d00');
          }
        }
      }

      // Facing Direction & Combat Rotation
      let facingDir: THREE.Vector3;
      let moveDir: THREE.Vector3;

      const toTarget = bot.targetPos.clone().sub(bot.position);
      toTarget.y = 0;
      const targetDist = toTarget.length();

      const isObjectiveDriven = bot.carryingFlag || bot.tacticalState === 'capturing' || bot.tacticalState === 'returning';

      if (isObjectiveDriven) {
        // AGGRESSIVE OBJECTIVE CHARGE: bots run directly towards flag / base without stopping!
        const objDir = targetDist > 0.3 ? toTarget.clone().normalize() : new THREE.Vector3(0, 0, bot.team === 'blue' ? 1 : -1);

        if (enemyTarget && distToEnemy < 42) {
          // Face enemy squarely to fire weapon, but maintain relentless forward charge toward the flag!
          const toEnemy = enemyTarget.pos.clone().sub(bot.position);
          toEnemy.y = 0;
          facingDir = toEnemy.normalize();
          // Slight tactical weave (18%) while sprinting forward
          const weaveX = -objDir.z * bot.strafeDirection * 0.18;
          const weaveZ = objDir.x * bot.strafeDirection * 0.18;
          moveDir = new THREE.Vector3(objDir.x + weaveX, 0, objDir.z + weaveZ).normalize();
        } else {
          moveDir = objDir;
          facingDir = objDir.clone();
        }
      } else if (enemyTarget && distToEnemy < 48) {
        // Defensive / skirmish engagement: face enemy squarely and strafe
        const toEnemy = enemyTarget.pos.clone().sub(bot.position);
        toEnemy.y = 0;
        facingDir = toEnemy.normalize();

        const strafeVec = new THREE.Vector3(
          -facingDir.z * bot.strafeDirection,
          0,
          facingDir.x * bot.strafeDirection
        );

        if (distToEnemy > 18) {
          moveDir = strafeVec.clone().add(facingDir.clone().multiplyScalar(0.5)).normalize();
        } else {
          moveDir = strafeVec;
        }
      } else {
        // Out of combat: face towards destination
        moveDir = targetDist > 0.5 ? toTarget.clone().normalize() : new THREE.Vector3(0, 0, bot.team === 'blue' ? 1 : -1);
        facingDir = moveDir.clone();
      }

      // Apply yaw rotation towards facing direction
      const targetYaw = Math.atan2(-facingDir.x, -facingDir.z);
      const currentYaw = bot.mesh.rotation.y;
      let yawDiff = targetYaw - currentYaw;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      bot.mesh.rotation.y += yawDiff * Math.min(dt * 14, 1);

      // Aggressive speed tuning: rapid sprints to seize or return the flag
      let speed = bot.carryingFlag ? 7.8 : (bot.tacticalState === 'capturing' ? 7.0 : (bot.role === 'attacker' ? 6.2 : 5.0));
      if (bot.isBuilding) speed = 2.0;
      else if (bot.isDigging) speed = 1.4;
      else if (bot.isCrouching || bot.isInTrench) speed = 3.2;

      // Move bot forward in moveDir
      if (targetDist > 0.3 || (enemyTarget && distToEnemy < 50)) {
        // Multi-directional obstacle avoidance probe
        const probeX = bot.position.x + moveDir.x * 0.85;
        const probeZ = bot.position.z + moveDir.z * 0.85;
        const probeGround = this.world.getGroundHeightBelow(probeX, bot.position.y, probeZ);
        const stepHeight = probeGround - bot.position.y;

        // Proactive running jump over 1-block obstacles while sprinting
        if (bot.grounded && bot.jumpCooldown <= 0 && stepHeight >= 0.4 && stepHeight <= 1.25 && speed > 3.0) {
          bot.velocity.y = 7.0;
          bot.grounded = false;
          bot.jumpCooldown = 0.85;
        }

        // Steer around high walls (> 1.25m) using 45-degree ray probes, or breach obstacles
        if (stepHeight > 1.25) {
          // Breacher and assault combatants can actively breach and demolish obstructing blocks
          if (bot.archetype === 'breacher' || (bot.archetype === 'assault' && Math.random() < 0.4)) {
            const obstX = Math.round(probeX);
            const obstZ = Math.round(probeZ);
            const obstY = Math.round(probeGround);
            const voxelAhead = this.world.getVoxel(obstX, obstY, obstZ);
            if (voxelAhead && voxelAhead.type !== 0) {
              bot.isBreaching = true;
              bot.breachTimer = (bot.breachTimer || 0) + dt;
              if (bot.bodyParts) {
                bot.bodyParts.spadeGroup.visible = true;
                bot.bodyParts.weaponGroup.visible = false;
                bot.bodyParts.rightArm.rotation.x = Math.sin(bot.breachTimer * 22) * 0.9;
              }
              if (bot.breachTimer > 0.4) {
                bot.breachTimer = 0;
                this.sounds.pickaxeHit();
                const res = this.world.damageVoxel(obstX, obstY, obstZ, VOXEL_SHOT_DAMAGE);
                if (res.destroyed) {
                  bot.isBreaching = false;
                  if (bot.bodyParts) {
                    bot.bodyParts.spadeGroup.visible = false;
                    bot.bodyParts.weaponGroup.visible = true;
                  }
                  this.updateBotNameTag(bot, '💥 BREACH COMPLETE', '#10b981');
                } else {
                  this.updateBotNameTag(bot, '🔨 BREACHING WALL', '#f59e0b');
                }
              }
            }
          }

          const cos45 = 0.7071;
          const sin45 = 0.7071;
          const leftDirX = moveDir.x * cos45 - moveDir.z * sin45;
          const leftDirZ = moveDir.x * sin45 + moveDir.z * cos45;
          const rightDirX = moveDir.x * cos45 + moveDir.z * sin45;
          const rightDirZ = -moveDir.x * sin45 + moveDir.z * cos45;

          const leftGround = this.world.getGroundHeightBelow(bot.position.x + leftDirX * 0.9, bot.position.y, bot.position.z + leftDirZ * 0.9);
          const rightGround = this.world.getGroundHeightBelow(bot.position.x + rightDirX * 0.9, bot.position.y, bot.position.z + rightDirZ * 0.9);

          const leftClimb = leftGround - bot.position.y;
          const rightClimb = rightGround - bot.position.y;

          if (leftClimb <= 1.25 && (leftClimb < rightClimb || rightClimb > 1.25)) {
            moveDir.x = leftDirX;
            moveDir.z = leftDirZ;
          } else if (rightClimb <= 1.25) {
            moveDir.x = rightDirX;
            moveDir.z = rightDirZ;
          } else {
            const perpX = -moveDir.z * bot.strafeDirection;
            const perpZ = moveDir.x * bot.strafeDirection;
            moveDir.x = perpX;
            moveDir.z = perpZ;
          }
        } else if (bot.isBreaching) {
          bot.isBreaching = false;
          if (bot.bodyParts) {
            bot.bodyParts.spadeGroup.visible = false;
            bot.bodyParts.weaponGroup.visible = true;
          }
        }

        // Sub-stepped, axis-independent movement with smooth 1-voxel auto-step-up
        const stepDt = Math.min(dt, 0.05);
        const moveStepX = moveDir.x * speed * stepDt;
        const moveStepZ = moveDir.z * speed * stepDt;
        const maxClimb = (bot.isCrouching || bot.isBuilding || bot.tacticalState === 'building') ? 0.35 : 1.25;

        // Try movement along X axis
        if (Math.abs(moveStepX) > 0.0001) {
          const tryX = bot.position.x + moveStepX;
          if (!this.checkBotVoxelCollision(tryX, bot.position.y, bot.position.z, bot.name)) {
            bot.position.x = tryX;
          } else if (bot.grounded && !bot.isCrouching && maxClimb > 0.5) {
            // Foot obstacle: step-up onto target obstacle surface with headroom check
            const targetGroundY = this.world.getGroundHeight(tryX, bot.position.z);
            const climb = targetGroundY - bot.position.y;
            if (climb > 0.05 && climb <= maxClimb) {
              if (!this.checkBotVoxelCollision(tryX, targetGroundY, bot.position.z, bot.name)) {
                bot.position.x = tryX;
                bot.position.y = targetGroundY;
              }
            }
          }
        }

        // Try movement along Z axis
        if (Math.abs(moveStepZ) > 0.0001) {
          const tryZ = bot.position.z + moveStepZ;
          if (!this.checkBotVoxelCollision(bot.position.x, bot.position.y, tryZ, bot.name)) {
            bot.position.z = tryZ;
          } else if (bot.grounded && !bot.isCrouching && maxClimb > 0.5) {
            // Foot obstacle: step-up onto target obstacle surface with headroom check
            const targetGroundY = this.world.getGroundHeight(bot.position.x, tryZ);
            const climb = targetGroundY - bot.position.y;
            if (climb > 0.05 && climb <= maxClimb) {
              if (!this.checkBotVoxelCollision(bot.position.x, targetGroundY, tryZ, bot.name)) {
                bot.position.z = tryZ;
                bot.position.y = targetGroundY;
              }
            }
          }
        }

        // Continuous penetration resolution prevents clipping into any structures
        this.resolveBotVoxelPenetration(bot);

        // Advanced 4-Stage Anti-Stuck System:
        const distMoved = Math.hypot(bot.position.x - bot.lastPos.x, bot.position.z - bot.lastPos.z);
        if (distMoved < 0.035) {
          bot.stuckTimer += dt;
          // Stage 1: Jump over foot obstacles with forward impulse
          if (bot.stuckTimer > 0.22 && bot.grounded && bot.jumpCooldown <= 0) {
            bot.velocity.y = 7.5;
            bot.grounded = false;
            bot.jumpCooldown = 0.75;
          }
          // Stage 2: Dynamic lane shift & immediate target refresh
          if (bot.stuckTimer > 0.40) {
            bot.strafeDirection = -bot.strafeDirection;
            bot.laneOffset = (Math.random() > 0.5 ? 1 : -1) * (4 + Math.random() * 8);
            if (bot.carryingFlag) {
              bot.targetPos.set(homeBasePos.x + bot.laneOffset * 0.25, 0, homeBasePos.z);
            } else if (bot.tacticalState === 'capturing') {
              bot.targetPos.set(eFlag.currentPos.x + bot.laneOffset * 0.25, 0, eFlag.currentPos.z);
            }
          }
          // Stage 3: Destructive breach! Clear obstacles directly in front
          if (bot.stuckTimer > 0.75 && !bot.isDigging) {
            const fwdX = Math.round(bot.position.x + moveDir.x * 0.9);
            const fwdZ = Math.round(bot.position.z + moveDir.z * 0.9);
            const footY = Math.round(bot.position.y + 0.45);
            const headY = footY + 1;
            let breached = false;
            if (this.world.isSolid(fwdX, footY, fwdZ) && this.world.canDig(fwdX, footY, fwdZ)) {
              this.world.setVoxel(fwdX, footY, fwdZ, 0);
              breached = true;
            }
            if (this.world.isSolid(fwdX, headY, fwdZ) && this.world.canDig(fwdX, headY, fwdZ)) {
              this.world.setVoxel(fwdX, headY, fwdZ, 0);
              breached = true;
            }
            if (breached) {
              this.sounds.spadeHit();
              if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected()) {
                this.networkClient.sendUseTool('spade', { x: fwdX, y: footY, z: fwdZ });
              }
              bot.stuckTimer = 0.15;
            }
          }
          // Stage 4: Tactical lateral leap to clear stuck corner
          if (bot.stuckTimer > 1.2) {
            const perpX = -moveDir.z * bot.strafeDirection;
            const perpZ = moveDir.x * bot.strafeDirection;
            const testX = bot.position.x + perpX * 1.5;
            const testZ = bot.position.z + perpZ * 1.5;
            const testY = this.world.getGroundHeight(testX, testZ);
            if (!this.checkBotVoxelCollision(testX, testY, testZ, bot.name)) {
              bot.position.set(testX, testY, testZ);
            } else {
              bot.velocity.y = 8.0;
              bot.grounded = false;
            }
            bot.stuckTimer = 0;
            bot.lastPos.copy(bot.position);
          }
        } else {
          bot.stuckTimer = 0;
          bot.lastPos.copy(bot.position);
        }

        // Natural walking leg and arm animation
        bot.walkCycle += dt * (speed * 2.0);
        const legSwing = Math.sin(bot.walkCycle) * 0.5;
        if (bot.bodyParts) {
          bot.bodyParts.leftLeg.rotation.x = legSwing;
          bot.bodyParts.rightLeg.rotation.x = -legSwing;
        }
      } else {
        if (bot.bodyParts) {
          bot.bodyParts.leftLeg.rotation.x *= 0.85;
          bot.bodyParts.rightLeg.rotation.x *= 0.85;
        }
        bot.lastPos.copy(bot.position);
      }

      // Universal Gravity & Ground Clamping: Applied to EVERY bot whether moving or stationary
      const currentGroundY = this.world.getGroundHeightBelow(bot.position.x, bot.position.y, bot.position.z);
      if (!bot.grounded || bot.position.y > currentGroundY + 0.04) {
        bot.velocity.y -= 26.0 * dt;
        if (bot.velocity.y < -30) bot.velocity.y = -30;
        bot.position.y += bot.velocity.y * dt;

        if (bot.position.y <= currentGroundY) {
          bot.position.y = currentGroundY;
          bot.velocity.y = 0;
          bot.grounded = true;
        } else {
          bot.grounded = false;
        }
      } else {
        bot.position.y = currentGroundY;
        bot.velocity.y = 0;
        bot.grounded = true;
      }

      // Hard clamp: Ensure bot can never be suspended in the sky under any circumstance
      if (bot.position.y > currentGroundY + 3.0 && bot.velocity.y <= 0) {
        bot.position.y = currentGroundY;
        bot.velocity.y = 0;
        bot.grounded = true;
      }

      // Inter-bot gentle repulsion: prevents bots from stacking or trapping each other
      for (let j = i + 1; j < this.bots.length; j++) {
        const other = this.bots[j];
        if (other.isDead) continue;
        const dx = bot.position.x - other.position.x;
        const dz = bot.position.z - other.position.z;
        const d2 = dx * dx + dz * dz;
        const minDist = 0.85;
        if (d2 < minDist * minDist && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          const push = (minDist - d) * 0.5;
          const nx = dx / d;
          const nz = dz / d;
          bot.position.x += nx * push;
          bot.position.z += nz * push;
          other.position.x -= nx * push;
          other.position.z -= nz * push;
        }
      }

      // Ensure bot is completely free of any voxel overlap before rendering
      this.resolveBotVoxelPenetration(bot);
      bot.mesh.position.copy(bot.position);

      // Human-like aiming posture: raise weapon with both hands and track enemy vertically
      const combatDistThreshold = bot.weapon === 'rifle' ? 120 : 65;
      if (bot.bodyParts) {
        if (enemyTarget && distToEnemy < combatDistThreshold && !bot.isDigging && !bot.isBuilding) {
          const dy = enemyTarget.pos.y + 1.2 - (bot.position.y + 1.4);
          const horizDist = Math.max(1, Math.hypot(enemyTarget.pos.x - bot.position.x, enemyTarget.pos.z - bot.position.z));
          const aimPitch = Math.atan2(dy, horizDist);

          // Head tilts up/down looking at enemy
          bot.bodyParts.head.rotation.x = aimPitch * 0.6;
          bot.bodyParts.helmet.rotation.x = aimPitch * 0.6;

          // Two-handed combat weapon hold: right arm forward, left arm angled to support barrel
          bot.bodyParts.rightArm.rotation.x = -Math.PI / 2 + aimPitch;
          bot.bodyParts.rightArm.rotation.y = -0.15;
          bot.bodyParts.leftArm.rotation.x = -Math.PI / 2.2 + aimPitch;
          bot.bodyParts.leftArm.rotation.y = 0.35;
          bot.bodyParts.weaponGroup.rotation.x = aimPitch;
        } else {
          // Patrol carry posture: weapon lowered at chest
          bot.bodyParts.head.rotation.x = 0;
          bot.bodyParts.helmet.rotation.x = 0;
          bot.bodyParts.rightArm.rotation.x = -Math.PI / 4;
          bot.bodyParts.rightArm.rotation.y = -0.1;
          bot.bodyParts.leftArm.rotation.x = -Math.PI / 5;
          bot.bodyParts.leftArm.rotation.y = 0.2;
          bot.bodyParts.weaponGroup.rotation.x = 0;
        }
      }

      // Combat Shooting Logic (Rifle vs SMG)
      if (enemyTarget && distToEnemy < combatDistThreshold && !bot.isDigging && !bot.isBuilding) {
        // Human reaction delay handling when acquiring a new target or switching targets
        const targetKey = enemyTarget.isPlayer ? 'player' : (enemyTarget.bot?.name || 'bot');
        if (bot.currentTargetKey !== targetKey) {
          bot.currentTargetKey = targetKey;
          bot.reactionDelay = 0.16 + (1.0 - bot.skill) * 0.28 + Math.random() * 0.12;
          bot.consecutiveShots = 0;
        }

        if (bot.reactionDelay > 0) {
          bot.reactionDelay -= dt;
        }

        // If empty, initiate tactical reload
        if (bot.ammo <= 0 && !bot.isReloading) {
          bot.isReloading = true;
          bot.reloadTimer = bot.weapon === 'rifle' ? 2.0 : 1.6;
          bot.consecutiveShots = 0;
        }

        if (!bot.isReloading && bot.reactionDelay <= 0) {
          if (bot.burstRemaining > 0) {
            bot.burstTimer -= dt;
            if (bot.burstTimer <= 0) {
              bot.burstRemaining--;
              bot.burstTimer = 0.11;
              bot.ammo = Math.max(0, bot.ammo - 1);
              this.executeBotShot(bot, enemyTarget);
            }
          } else {
            bot.shootTimer -= dt;
            if (bot.shootTimer <= 0) {
              if (bot.weapon === 'smg') {
                const burstCount = Math.min(bot.ammo, 3 + Math.floor(Math.random() * 3));
                if (burstCount > 0) {
                  bot.burstRemaining = burstCount;
                  bot.burstTimer = 0;
                  bot.shootTimer = 0.85 + Math.random() * 0.5;
                }
              } else {
                // Rifle: single deliberate shot
                if (bot.ammo > 0) {
                  bot.ammo--;
                  this.executeBotShot(bot, enemyTarget);
                  bot.shootTimer = 0.8 + Math.random() * 0.45;
                }
              }
            }
          }
        }
      } else {
        bot.consecutiveShots = 0;
        bot.currentTargetKey = null;
      }
    }
  }

  private executeBotShot(bot: Bot, target: { pos: THREE.Vector3; isPlayer: boolean; bot?: Bot }): void {
    // Update bot mesh world matrix to ensure pinpoint gun barrel & receiver locators
    bot.mesh.updateMatrixWorld(true);
    let muzzlePos = new THREE.Vector3();
    let receiverPos = new THREE.Vector3();

    const botMuzzleObj = bot.weaponMesh?.getObjectByName('barrelMuzzle');
    const botEjectionObj = bot.weaponMesh?.getObjectByName('ejectionPort');

    if (botMuzzleObj) {
      botMuzzleObj.getWorldPosition(muzzlePos);
    } else {
      muzzlePos = bot.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    }

    if (botEjectionObj) {
      botEjectionObj.getWorldPosition(receiverPos);
    } else {
      receiverPos = muzzlePos.clone();
    }

    const targetHeight = target.isPlayer ? 1.1 : 1.15;
    const centerTargetPos = target.pos.clone().add(new THREE.Vector3(0, targetHeight, 0));
    const toTarget = centerTargetPos.clone().sub(muzzlePos);
    const idealDir = toTarget.clone().normalize();

    // Human shot deviation calculation:
    // 1. Weapon base cone of fire (rifle has tight deliberate aim, SMG has controlled spread)
    let spreadAngle = bot.weapon === 'rifle' ? 0.010 : 0.024;

    // 2. Skill scaling: higher skill has tighter aim (spread angle reduces with skill)
    spreadAngle *= (1.5 - bot.skill * 0.7);

    // 3. Movement and posture penalties/bonuses:
    const horizSpeed = Math.hypot(bot.velocity.x, bot.velocity.z);
    if (!bot.grounded) {
      spreadAngle *= 2.4; // Mid-air penalty: wild spray
    } else if (horizSpeed > 3.0) {
      spreadAngle *= 1.45; // Sprinting / running penalty
    } else if (bot.isCrouching) {
      spreadAngle *= 0.62; // Crouching stability bonus
    }

    // 4. Recoil and spray bloom from consecutive burst firing
    bot.consecutiveShots = (bot.consecutiveShots || 0) + 1;
    const sprayBloom = Math.min(2.4, 1.0 + bot.consecutiveShots * (bot.weapon === 'smg' ? 0.16 : 0.28));
    spreadAngle *= sprayBloom;

    // Orthogonal basis vectors for angular deviation
    const upRef = new THREE.Vector3(0, 1, 0);
    let rightVec = new THREE.Vector3().crossVectors(idealDir, upRef).normalize();
    if (rightVec.lengthSq() < 0.001) rightVec = new THREE.Vector3(1, 0, 0);
    const trueUp = new THREE.Vector3().crossVectors(rightVec, idealDir).normalize();

    // Dual-uniform distribution for natural bell-curve aiming error
    const devX = ((Math.random() + Math.random()) - 1.0) * spreadAngle;
    const devY = ((Math.random() + Math.random()) - 1.0) * spreadAngle + (bot.weapon === 'smg' ? 0.004 * Math.min(5, bot.consecutiveShots) : 0.002);

    const actualDir = idealDir.clone()
      .addScaledVector(rightVec, devX)
      .addScaledVector(trueUp, devY)
      .normalize();

    // 3D gunshot audio
    const distToPlayer = bot.position.distanceTo(this.player.position);
    const pan = Math.sin(Math.atan2(bot.position.x - this.player.position.x, bot.position.z - this.player.position.z) - this.player.yaw);
    this.sounds.playDistantShot(bot.weapon, distToPlayer, pan);

    // Terrain line-of-sight raycast along the actual fired trajectory
    const terrainHit = this.world.raycast(muzzlePos, actualDir, 300);

    // Target cylinder intersection test:
    let isHit = false;
    let hitPoint = new THREE.Vector3();
    let isHeadshot = false;

    // Solve closest approach along 3D ray to target center axis
    const dx = target.pos.x - muzzlePos.x;
    const dz = target.pos.z - muzzlePos.z;
    const horizDirSq = actualDir.x * actualDir.x + actualDir.z * actualDir.z;

    if (horizDirSq > 0.0001) {
      const t = (dx * actualDir.x + dz * actualDir.z) / horizDirSq;
      if (t > 0.4 && t < 300 && (!terrainHit || terrainHit.distance >= t - 0.2)) {
        const cx = muzzlePos.x + actualDir.x * t;
        const cz = muzzlePos.z + actualDir.z * t;
        const cy = muzzlePos.y + actualDir.y * t;
        const distXZ = Math.hypot(cx - target.pos.x, cz - target.pos.z);
        const inVerticalRange = cy >= target.pos.y - 0.1 && cy <= target.pos.y + 2.05;

        // Effective hitbox radius
        const targetRadius = 0.52;
        if (distXZ <= targetRadius && inVerticalRange) {
          isHit = true;
          hitPoint.set(cx, cy, cz);
          isHeadshot = cy >= target.pos.y + 1.45;
        }
      }
    }

    // Visual tracer and muzzle flash right from the gun barrel tip!
    const botTracerDist = isHit ? hitPoint.distanceTo(muzzlePos) : (terrainHit ? terrainHit.distance : 300);
    const botTracerSpeed = bot.weapon === 'rifle' ? 300 : 230;
    this.createMuzzleFlash(muzzlePos, actualDir);
    this.createBulletTracer(muzzlePos, actualDir, botTracerDist, botTracerSpeed);

    // Shell ejected right from the gun receiver!
    this.createBulletShell(receiverPos, actualDir, true, rightVec);

    if (isHit) {
      // IMPACT HIT! Spark flash at impact coordinate
      this.createImpactSparks(hitPoint);

      const headshotMult = isHeadshot ? 1.65 : 1.0;
      if (target.isPlayer) {
        const baseDmg = bot.weapon === 'rifle' ? 28 + Math.random() * 16 : 14 + Math.random() * 8;
        const dmg = Math.round(baseDmg * headshotMult);
        this.player.takeDamage(dmg);
        this.player.addCameraShake(isHeadshot ? 0.32 : 0.18);
        this.sounds.hurt();

        if (isHeadshot) {
          this.showMessage(`💥 Critical headshot received from ${bot.name}!`);
        }

        if (this.player.isDead) {
          if (this.player.carryingFlag) {
            const enemyF = this.playerTeam === 'blue' ? this.redFlag : this.blueFlag;
            if (enemyF) {
              enemyF.carrier = null;
              enemyF.isDropped = true;
              enemyF.dropTimer = 30;
              const dropY = this.world.getGroundHeight(this.player.position.x, this.player.position.z);
              enemyF.currentPos.set(this.player.position.x, dropY, this.player.position.z);
              enemyF.mesh.position.copy(enemyF.currentPos);
              enemyF.mesh.visible = true;
              this.showMessage(`🚩 ${enemyF.team.toUpperCase()} flag was dropped!`);
            }
            this.player.carryingFlag = false;
          }
          if (bot.team === 'red') this.redKills++; else this.blueKills++;
          this.sounds.killSound();
          this.showMessage(`☠️ You were eliminated by ${bot.name}!`);
        }
      } else if (target.bot) {
        const baseDmg = bot.weapon === 'rifle' ? 40 + Math.random() * 18 : 20 + Math.random() * 10;
        const dmg = this.absorbJeepDamage(target.bot, Math.round(baseDmg * headshotMult));
        target.bot.hp -= dmg;
        target.bot.lastDamageTime = Date.now();

        if (target.bot.hp <= 0) {
          target.bot.isDead = true;
          target.bot.mesh.visible = false;
          target.bot.respawnTimer = 4;

          // Drop flag if bot was carrying it!
          if (target.bot.carryingFlag) {
            const enemyF = target.bot.team === 'blue' ? this.redFlag : this.blueFlag;
            if (enemyF) {
              enemyF.carrier = null;
              enemyF.isDropped = true;
              enemyF.dropTimer = 30;
              const dropY = this.world.getGroundHeight(target.bot.position.x, target.bot.position.z);
              enemyF.currentPos.set(target.bot.position.x, dropY, target.bot.position.z);
              enemyF.mesh.position.copy(enemyF.currentPos);
              enemyF.mesh.visible = true;
              this.showMessage(`🚩 ${enemyF.team.toUpperCase()} flag was dropped by ${target.bot.name}!`);
            }
            target.bot.carryingFlag = false;
            if (target.bot.flagMesh) target.bot.flagMesh.visible = false;
          }

          if (bot.team === 'blue') this.blueKills++; else this.redKills++;
          this.showMessage(`🎯 ${bot.name} eliminated ${target.bot.name}!`);
        }
      }
    } else {
      // MISSED SHOT / TERRAIN IMPACT!
      // Bot bullets damage voxels in the world!
      if (terrainHit) {
        const voxel = this.world.getVoxel(terrainHit.voxelPos.x, terrainHit.voxelPos.y, terrainHit.voxelPos.z);
        if (voxel) {
          const result = this.world.damageVoxel(terrainHit.voxelPos.x, terrainHit.voxelPos.y, terrainHit.voxelPos.z, VOXEL_SHOT_DAMAGE);
          if (result.destroyed) {
            this.sounds.pickaxeHit();
          }
        }
        this.createImpactSparks(terrainHit.position, terrainHit.normal);
      }
    }
  }

  handleBuildClick(): void {
    this.tryBuild();
  }

  /** Mirror the authoritative round state into the HUD state. */
  private applyRoundSnapshot(round: RoundSnapshot): void {
    this.roundIsServerDriven = true;
    if (round.round) this.roundNumber = round.round;
    if (round.phase) this.roundPhase = round.phase;
    if (typeof round.timeLeft === 'number') this.roundTimeLeft = round.timeLeft;
    if (typeof round.intermission === 'number') this.roundIntermission = round.intermission;
    if (typeof round.duration === 'number' && round.duration > 0) this.roundDuration = round.duration;
    if (round.captures) {
      this.blueCaptures = round.captures.blue || 0;
      this.redCaptures = round.captures.red || 0;
    }
    if (round.wins) this.roundWins = { red: round.wins.red || 0, blue: round.wins.blue || 0 };
  }

  /** Resolve a combatant id to a display name + team for the killfeed. */
  private nameOf(id?: string | null): { name: string; team: Team | null } {
    if (!id) return { name: 'the world', team: null };
    if (id === this.localPlayerId) {
      return { name: this.playerName || 'You', team: this.playerTeam };
    }
    const remote = this.remotePlayers.get(id);
    if (remote) {
      return {
        name: remote.state.name || `Player ${id.slice(-4)}`,
        team: (remote.state.team as Team) ?? null,
      };
    }
    const fallback = id.startsWith('bot_') ? 'Bot' : 'Player';
    return { name: `${fallback} ${id.slice(-4)}`, team: null };
  }

  /** Append a death to the killfeed (client-side only, newest last). */
  private pushKillfeed(
    killerId: string | undefined,
    victimId: string,
    weapon?: string,
    isHeadshot: boolean = false,
  ): void {
    const killer = this.nameOf(killerId);
    const victim = this.nameOf(victimId);
    let label = 'Unknown';
    if (weapon === 'rifle' || weapon === 'smg') {
      label = WEAPONS[weapon]?.name ?? weapon.toUpperCase();
    } else if (weapon) {
      label = weapon.charAt(0).toUpperCase() + weapon.slice(1);
    } else if (!killerId) {
      label = 'World';
    }
    this.killfeed.push({
      id: ++this.killfeedSeq,
      killerId: killerId ?? null,
      victimId,
      killerName: killer.name,
      killerTeam: killer.team,
      victimName: victim.name,
      victimTeam: victim.team,
      weapon: label,
      isHeadshot,
      at: Date.now(),
    });
    if (this.killfeed.length > 6) this.killfeed.shift();
  }

  /** Enemies a friendly spotting post sees, computed locally for Bot Match
   *  and Beta; online play uses the server's authoritative report instead. */
  private localSpotContacts(): SpotContact[] {
    const posts = this.localEmplacements.filter((e) =>
      !e.wreck && e.kind === 'spottingPost' && e.team === this.playerTeam && e.hp > 0);
    if (posts.length === 0) return [];
    const seen = (x: number, z: number) => posts.some((post) =>
      Math.hypot(x - post.position.x, z - post.position.z) <= SPOTTING_POST_RADIUS);
    const contacts: SpotContact[] = [];
    for (const bot of this.bots) {
      if (bot.isDead || bot.team === this.playerTeam) continue;
      if (!seen(bot.position.x, bot.position.z)) continue;
      contacts.push({ id: bot.name, team: bot.team, position: { x: bot.position.x, y: bot.position.y, z: bot.position.z } });
    }
    for (const [id, remote] of this.remotePlayers) {
      if (remote.state.isDead || remote.state.team === this.playerTeam) continue;
      const position = remote.mesh.position;
      if (!seen(position.x, position.z)) continue;
      contacts.push({ id, team: remote.state.team, position: { x: position.x, y: position.y, z: position.z } });
    }
    return contacts;
  }

  /** Project spotted enemies to HUD percentages, dropping anything behind the
   *  camera or off screen. A report older than 1.5 s means the post is gone. */
  private spotContactsForHud(): SpotMarker[] {
    const contacts = this.gameMode === 'online'
      ? (performance.now() - this.spotReportAt < 1500 ? this.spottedContacts : [])
      : this.localSpotContacts();
    if (contacts.length === 0) return [];
    const camera = this.player.camera;
    camera.updateMatrixWorld();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const markers: SpotMarker[] = [];
    for (const contact of contacts) {
      const to = new THREE.Vector3(
        contact.position.x - camera.position.x,
        contact.position.y + 1.4 - camera.position.y,
        contact.position.z - camera.position.z,
      );
      if (to.dot(forward) <= 0) continue;
      const projected = new THREE.Vector3(contact.position.x, contact.position.y + 1.4, contact.position.z).project(camera);
      if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
      markers.push({
        id: contact.id,
        team: contact.team,
        xPct: (projected.x * 0.5 + 0.5) * 100,
        yPct: (-projected.y * 0.5 + 0.5) * 100,
        distance: Math.round(Math.hypot(contact.position.x - this.player.position.x, contact.position.z - this.player.position.z)),
      });
    }
    return markers;
  }

  private spotPostForHud(): SpotPostCoverage | null {
    return spotPostCoverage(
      this.gameMode === 'online' ? this.emplacedSnapshots.values() : this.localEmplacements,
      this.playerTeam,
      this.player.position,
      this.player.getForward(),
    );
  }

  private emitState(): void {
    if (this.onStateChange) {
      const weapon = this.weapons[this.equipment];
      // Online play keeps `flag.carrier` null on purpose: the server owns who
      // holds what (`server*FlagCarrierId`), and the visual flag stays hidden at
      // its post while a carrier wears the backpack copy. Reading the flag
      // objects there made every badge say "At Base" while a bot ran with the
      // flag, and hid enemy carriers from the carrier line. Offline matches
      // still have real carriers on the flag objects, so each mode reads its own.
      const serverFlags = this.gameMode === 'online';
      const carrierNameOf = (id: string | null): string => {
        if (!id) return '';
        if (id === this.localPlayerId) return `You (${this.playerTeam.toUpperCase()})`;
        const remote = this.remotePlayers.get(id);
        const state = remote?.state;
        if (!state) return '';
        const name = state.name ?? 'Soldier';
        return state.team ? `${name} (${state.team.toUpperCase()})` : name;
      };

      let carrierName = '';
      if (serverFlags) {
        carrierName = this.player.carryingFlag
          ? `You (${this.playerTeam.toUpperCase()})`
          : carrierNameOf(this.serverRedFlagCarrierId) || carrierNameOf(this.serverBlueFlagCarrierId);
      } else if (this.player.carryingFlag) {
        carrierName = `You (${this.playerTeam.toUpperCase()})`;
      } else if (this.redFlag?.carrier) {
        carrierName = `${this.redFlag.carrier.name} (${this.redFlag.carrier.isPlayer ? this.playerTeam.toUpperCase() : this.redFlag.carrier.bot?.team.toUpperCase()})`;
      } else if (this.blueFlag?.carrier) {
        carrierName = `${this.blueFlag.carrier.name} (${this.blueFlag.carrier.isPlayer ? this.playerTeam.toUpperCase() : this.blueFlag.carrier.bot?.team.toUpperCase()})`;
      }

      let blueFlagStatus: 'at_base' | 'carried' | 'dropped' | 'captured' = 'at_base';
      let blueFlagTimer = 0;
      if (this.blueFlag) {
        if (this.blueFlag.isCaptured) {
          blueFlagStatus = 'captured';
          blueFlagTimer = this.blueFlag.capturedTimer;
        } else if (serverFlags ? this.serverBlueFlagCarrierId !== null : !!this.blueFlag.carrier) {
          blueFlagStatus = 'carried';
        } else if (serverFlags ? !this.serverBlueFlagAtBase : this.blueFlag.isDropped) {
          blueFlagStatus = 'dropped';
          blueFlagTimer = serverFlags ? 0 : this.blueFlag.dropTimer;
        }
      }

      let redFlagStatus: 'at_base' | 'carried' | 'dropped' | 'captured' = 'at_base';
      let redFlagTimer = 0;
      if (this.redFlag) {
        if (this.redFlag.isCaptured) {
          redFlagStatus = 'captured';
          redFlagTimer = this.redFlag.capturedTimer;
        } else if (serverFlags ? this.serverRedFlagCarrierId !== null : !!this.redFlag.carrier) {
          redFlagStatus = 'carried';
        } else if (serverFlags ? !this.serverRedFlagAtBase : this.redFlag.isDropped) {
          redFlagStatus = 'dropped';
          redFlagTimer = serverFlags ? 0 : this.redFlag.dropTimer;
        }
      }

      // Feedback layer: expire old killfeed rows and damage arcs, then compute
      // where each recent damage source currently sits on screen.
      const wallNow = Date.now();
      this.killfeed = this.killfeed.filter((k) => wallNow - k.at < KILLFEED_SECONDS * 1000);
      const monoNow = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      this.damageSources = this.damageSources.filter((src) => src.until > monoNow);
      const viewForward = this.player.getForward();
      const damageIndicators = this.damageSources.map((src) =>
        Math.round(relativeBearingDegrees(this.player.position, viewForward, src)),
      );

      const bench = this.workshops ? benchPosition(this.workshops[this.playerTeam].position) : null;
      const benchDistance = bench ? this.player.position.distanceTo(new THREE.Vector3(bench.x, bench.y, bench.z)) : null;
      this.benchOpen = benchDistance !== null && benchDistance <= BENCH_REACH;
      const crate = this.nearbySupplyCrate();

      this.onStateChange({
        hp: this.player.hp,
        maxHp: this.player.maxHp,
        equipment: this.equipment,
        inventory: this.inventory + (this.gameMode === 'online' ? this.depositable : 0),
        depositable: this.depositable,
        workshopStock: this.workshops?.[this.playerTeam].stock ?? 0,
        workshopCapacity: this.workshops?.[this.playerTeam].capacity ?? 0,
        jeepNearby: !!this.nearestJeep(),
        jeepDriving: !!this.drivingJeepId,
        jeepRiding: !!this.ridingJeepId,
        jeepHp: this.drivingJeepId ? (this.jeeps.get(this.drivingJeepId)?.state.hp ?? 0) : 0,
        jeepSpeed: this.drivingJeepId ? (this.jeeps.get(this.drivingJeepId)?.state.speed ?? 0) : 0,
        workshopDistance: this.workshops ? this.player.position.distanceTo(new THREE.Vector3(
          this.workshops[this.playerTeam].position.x,
          this.workshops[this.playerTeam].position.y,
          this.workshops[this.playerTeam].position.z,
        )) : null,
        benchDistance,
        benchOpen: this.benchOpen,
        blueprints: [...this.craftedSlots],
        blueprintCatalogue: this.blueprintCatalogue,
        benchMenuOpen: this.benchMenuOpen,
        benchFeedback: this.benchMenuOpen ? this.benchFeedback : '',
        manningEmplacement: Boolean(this.mountedEmplacementId),
        manningKind: this.mountedEmplacementId
          ? (this.emplacedSnapshots.get(this.mountedEmplacementId)?.kind ?? null)
          : null,
        manningAmmo: this.mountedEmplacementId
          ? (this.emplacedSnapshots.get(this.mountedEmplacementId)?.ammo ?? null)
          : null,
        manningAim: this.mannedMortarAim(),
        emplacementNearby: this.nearbyMannableEmplacement() !== null,
        shellPacks: this.shellPacks,
        shellGunNearby: this.shellPackCandidate() !== null,
        crateNearby: crate !== null,
        crateStock: crate ? crate.stock : null,
        dismantleTarget: this.dismantleCandidate()?.type ?? null,
        isDead: this.player.isDead,
        respawnTimer: this.player.respawnTimer,
        hitMarker: this.hitMarkerTimer > 0,
        targetInfo: this.player.targetInfo || '',
        message: this.message,
        messageTimer: this.messageTimer,
        buildMode: false,  // Always false with instant placement
        buildValid: this.inventory + (this.gameMode === 'online' ? this.depositable : 0) > 0,
        blueKills: this.blueKills,
        redKills: this.redKills,
        blueCaptures: this.blueCaptures,
        redCaptures: this.redCaptures,
        isAiming: this.isAiming,
        currentAmmo: weapon ? weapon.currentAmmo : 0,
        magazineSize: weapon ? weapon.magazineSize : 0,
        ammoReserve: this.ammoReserve,
        ammoCost: gunStats(this.equipment)?.ammoCost ?? null,
        isReloading: weapon ? weapon.isReloading : false,
        playerCarryingFlag: this.player.carryingFlag,
        flagCarrierName: carrierName,
        isSpectating: this.isSpectating,
        spectatorMode: this.spectatorMode,
        spectatorTrackedName: this.spectatorTrackedName,
        isOnline: this.gameMode === 'online',
        connectedPlayersCount: this.remotePlayers.size + 1,
        isNetworkConnected: this.networkClient ? this.networkClient.isConnected() : false,
        transportName: this.networkClient ? this.networkClient.getTransport() : 'Local',
        localPlayerId: this.localPlayerId,
        blueFlagStatus,
        redFlagStatus,
        blueFlagTimer,
        redFlagTimer,
        radioLog: this.radioLog,
        scoreboard: this.getCachedScoreboard(),
        showScoreboard: this.tabHeld,
        roundIsServerDriven: this.roundIsServerDriven,
        roundNumber: this.roundNumber,
        roundPhase: this.roundPhase,
        roundTimeLeft: this.roundTimeLeft,
        roundIntermission: this.roundIntermission,
        roundDuration: this.roundDuration,
        roundWins: this.roundWins,
        roundWinner: this.roundWinner,
        killfeed: this.killfeed,
        damageIndicators,
        spotContacts: this.spotContactsForHud(),
        spotPost: this.spotPostForHud(),
        pingMs: this.pingMs,
        spawnProtected: this.spawnProtected,
        audioMuted: this.sounds.isMuted(),
        audioVolume: this.sounds.getVolume(),
      });
    }
  }

  /** Rebuild the scoreboard only when its contents actually changed — avoids
   *  allocating new objects every tick and re-rendering React at 60fps. */
  private getCachedScoreboard(): ScoreboardData | undefined {
    const sb = this.buildScoreboard();
    const json = JSON.stringify(sb);
    if (json !== this.lastScoreboardJson) {
      this.lastScoreboardJson = json;
      this.cachedScoreboard = sb;
    }
    return this.cachedScoreboard;
  }

  destroy(): void {
    this.running = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.clearGhost();
    for (const smoke of this.wreckSmoke.values()) smoke.dispose();
    this.wreckSmoke.clear();
    if (this.networkClient) {
      this.networkClient.disconnect();
    }
    window.removeEventListener('resize', this.boundResize);
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('wheel', this.boundWheel);
    document.removeEventListener('keydown', this.boundKeyDown);
    document.removeEventListener('keyup', this.boundKeyUp);
    document.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('blur', this.boundBlur);
    this.canvas.removeEventListener('contextmenu', this.boundContextMenu);
    this.renderer.dispose();
  }
}
