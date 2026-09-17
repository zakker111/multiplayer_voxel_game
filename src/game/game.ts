import * as THREE from 'three';
import { VoxelWorld, VOXEL_BUILT, VOXEL_SIZE } from './world';
import { Player } from './player';
import { SoundManager } from './sounds';
import { NetworkClient } from './networkClient';
import { PlayerState, PlayerInput, Position } from '../shared/types';

// Game Constants
const VERSION = "1.4.0"; // Spectator fix, Bot AI overhaul, Footsteps, Spawn dist
const FPS = 60;
const DT = 1 / FPS;
const GRAVITY = 30;
const JUMP_FORCE = 12;
const MOVE_SPEED = 6;
const SPRINT_MULTI = 1.6;
const CROUCH_MULTI = 0.4;
const REACH = 5;
const MOUSE_SENS = 0.002;
const FOV = 75;
const SKY_COLOR = 0x87CEEB;
const FOG_COLOR = 0x87CEEB;
const RENDER_DISTANCE = 60;
const CHUNK_SIZE = 16;
const TEXTURE_SCALE = 16;

export type EquipmentType = 'rifle' | 'smg' | 'spade' | 'pickaxe';
type Team = 'red' | 'blue';
type GameMode = 'multiplayer' | 'singleplayer' | 'online';

export interface GameState {
  hp: number;
  maxHp: number;
  equipment: EquipmentType;
  inventory: number;
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
  isReloading: boolean;
  playerCarryingFlag: boolean;
  flagCarrierName: string;
  isSpectating: boolean;
  spectatorMode?: 'action' | 'free';
  spectatorTrackedName?: string;
  isOnline?: boolean;
  connectedPlayersCount?: number;
  isNetworkConnected?: boolean;
  localPlayerId?: string | null;
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

interface Weapon {
  fireRate: number;
  lastFired: number;
  damage: { head: number; body: number };
  spread: number;
  name: string;
  magazineSize: number;
  currentAmmo: number;
  reloadTime: number;
  isReloading: boolean;
  reloadStartTime: number;
}

const TEAM_COLORS: Record<Team, { body: number; accent: number; legs: number; label: string }> = {
  red: { body: 0xcc2222, accent: 0xff4444, legs: 0x661111, label: 'RED' },
  blue: { body: 0x2244cc, accent: 0x4488ff, legs: 0x112266, label: 'BLUE' },
};

const BLUE_SPAWN_Z_MIN = -90;
const BLUE_SPAWN_Z_MAX = -75;
const RED_SPAWN_Z_MIN = 75;
const RED_SPAWN_Z_MAX = 90;
const SPAWN_X_RANGE = 20;

const BLUE_FLAG_POS = { x: 0, z: -80 };
const RED_FLAG_POS = { x: 0, z: 80 };

export class Game {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  world: VoxelWorld;
  player: Player;
  bots: Bot[] = [];
  equipment: EquipmentType = 'rifle';
  inventory: number = 0;
  lastActionTime: number = 0;
  isMouseDown: boolean = false;
  highlightMesh: THREE.Mesh;
  buildPreviewMesh: THREE.Mesh;
  muzzleFlash: THREE.PointLight;
  muzzleTimer: number = 0;
  hitMarkerTimer: number = 0;
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

  hipPosition: THREE.Vector3 = new THREE.Vector3(0.3, -0.3, -0.6);
  adsPosition: THREE.Vector3 = new THREE.Vector3(0, -0.2, -0.45);

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
  }> = [];

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
  }> = [];

  muzzleFlashes: Array<{
    light: THREE.PointLight;
    mesh: THREE.Mesh;
    life: number;
    maxLife: number;
  }> = [];

  blueFlag!: Flag;
  redFlag!: Flag;
  captureZoneSize: number = 4;

  gameMode: GameMode = 'multiplayer';

  networkClient: NetworkClient | null = null;
  serverUrl?: string;
  playerName?: string;
  remotePlayers: Map<string, { mesh: THREE.Group; state: PlayerState; targetPosition: THREE.Vector3; targetRotation: THREE.Euler; lastShootingTime: number }> = new Map();
  localPlayerId: string | null = null;
  lastInputSendTime: number = 0;
  inputSendRate: number = 50;

  private boundResize: () => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  weapons: Record<string, Weapon> = {
    rifle: {
      fireRate: 0.4, lastFired: 0, damage: { head: 100, body: 34 }, spread: 0.0005,
      name: 'Rifle', magazineSize: 10, currentAmmo: 10, reloadTime: 2.0,
      isReloading: false, reloadStartTime: 0
    },
    smg: {
      fireRate: 0.1, lastFired: 0, damage: { head: 100, body: 34 }, spread: 0.04,
      name: 'SMG', magazineSize: 30, currentAmmo: 30, reloadTime: 1.5,
      isReloading: false, reloadStartTime: 0
    },
    spade: {
      fireRate: 0.5, lastFired: 0, damage: { head: 40, body: 25 }, spread: 0,
      name: 'Spade', magazineSize: 0, currentAmmo: 0, reloadTime: 0,
      isReloading: false, reloadStartTime: 0
    },
    pickaxe: {
      fireRate: 0.5, lastFired: 0, damage: { head: 40, body: 25 }, spread: 0,
      name: 'Pickaxe', magazineSize: 0, currentAmmo: 0, reloadTime: 0,
      isReloading: false, reloadStartTime: 0
    },
  };

  constructor(canvas: HTMLCanvasElement, mode: GameMode = 'multiplayer', team: Team = 'blue', serverUrl?: string, playerName?: string) {
    try {
      console.log('Game constructor started', { mode, team, serverUrl, playerName });
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.sounds = new SoundManager();
    this.gameMode = mode;
    this.playerTeam = team;
    this.serverUrl = serverUrl;
    this.playerName = playerName;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87CEEB);
    this.scene.fog = new THREE.Fog(0x87CEEB, 60, 150);

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

    console.log('Creating world...');
    this.world = new VoxelWorld();
    this.scene.add(this.world.mesh);
    console.log('World created and added to scene');

    this.addTeamZoneMarkers();

    console.log('Creating player...');
    this.player = new Player(this.world);
    this.player.team = team;
    const spawnPos = this.getSafeSpawnPos(team);
    this.player.position.copy(spawnPos);
    this.player.yaw = team === 'blue' ? Math.PI : 0;
    this.player.updateCamera();
    this.player.onRespawn = () => this.handlePlayerRespawn();
    console.log('Player created');

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

    if (this.gameMode === 'multiplayer') {
      console.log('Spawning bots...');
      this.spawnTeamBots('blue', 6);
      this.spawnTeamBots('red', 7);
      console.log('Bots spawned');
    }

    if (this.gameMode === 'online') {
      this.initializeNetwork();
    }
    
    this.boundResize = this.onResize.bind(this);
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundWheel = this.onWheel.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundKeyUp = this.onKeyUp.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);

    window.addEventListener('resize', this.boundResize);
    canvas.addEventListener('mousedown', this.boundMouseDown);
    canvas.addEventListener('mouseup', this.boundMouseUp);
    canvas.addEventListener('wheel', this.boundWheel);
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    document.addEventListener('mousemove', this.boundMouseMove);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
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

    this.addTeamFlag(BLUE_FLAG_POS.x, BLUE_FLAG_POS.z, 0x2244cc, 'BLUE BASE');
    this.addTeamFlag(RED_FLAG_POS.x, RED_FLAG_POS.z, 0xcc2222, 'RED BASE');
  }

  private addTeamFlag(x: number, z: number, color: number, _label: string): void {
    const groundY = this.world.getGroundHeight(x, z);
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 4, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, groundY + 2, z);
    this.scene.add(pole);

    const flagGeo = new THREE.PlaneGeometry(1.5, 1);
    const flagMat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(x + 0.8, groundY + 3.5, z);
    this.scene.add(flag);
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
    
    const rifleBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.8, roughness: 0.2 })
    );
    rifleBarrel.rotation.x = Math.PI / 2;
    rifleBarrel.position.set(0, 0.01, -0.65);
    rifle.add(rifleBarrel);
    
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
    
    const smgBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.35, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.8, roughness: 0.2 })
    );
    smgBarrel.rotation.x = Math.PI / 2;
    smgBarrel.position.set(0, 0.01, -0.4);
    smg.add(smgBarrel);
    
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

    // Ensure any carrying bot drops their back flag
    for (const b of this.bots) {
      if (b.carryingFlag && (b.team !== flag.team)) {
        b.carryingFlag = false;
        if (b.flagMesh) b.flagMesh.visible = false;
      }
    }
  }

  private updateFlags(dt: number): void {
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
      if (i === 0) {
        role = 'defender'; // 1 dedicated base defender
      } else if (i === 1) {
        role = 'flanker';
      } else {
        role = 'attacker'; // All others are aggressive flag rushers!
      }

      // Weapons: Flankers prefer SMGs for close ambush; defenders prefer rifles for long range
      let weapon: 'rifle' | 'smg';
      if (role === 'flanker') {
        weapon = Math.random() < 0.8 ? 'smg' : 'rifle';
      } else if (role === 'defender') {
        weapon = Math.random() < 0.8 ? 'rifle' : 'smg';
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
      const { sprite: nameTag, canvas: nameTagCanvas, texture: nameTagTexture } = this.createBotNameTag(team, botName);
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
        jumpCooldown: 0, skill: 0.65 + Math.random() * 0.35,
        aggression: 0.6 + Math.random() * 0.4,
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
        inventoryBlocks: 14 + Math.floor(Math.random() * 10),
        isDigging: false,
        digTimer: 0,
        digTarget: null,
        trenchDepth: 0,
        isInTrench: false,
        isBuilding: false,
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

  private createBotNameTag(team: Team, name: string): { sprite: THREE.Sprite; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.4, 0.9, 1);
    return { sprite, canvas, texture };
  }

  private updateBotNameTag(bot: Bot, actionText: string, actionColor: string): void {
    if (!bot.nameTagCanvas || !bot.nameTagTexture) return;
    if (bot.lastDrawnState === actionText) return;
    bot.lastDrawnState = actionText;

    const ctx = bot.nameTagCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 256, 96);

    // Bot name in bold with dark halo
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = bot.team === 'blue' ? '#55aaff' : '#ff5555';
    ctx.fillText(bot.name, 128, 28);

    // Status action pill
    ctx.shadowBlur = 0;
    const badgeY = 44;
    const badgeHeight = 32;
    ctx.font = 'bold 15px Arial, sans-serif';
    const textWidth = ctx.measureText(actionText).width;
    const badgeWidth = Math.min(240, Math.max(130, textWidth + 24));
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
    ctx.fillText(actionText, 128, badgeY + 22);

    bot.nameTagTexture.needsUpdate = true;
  }

  private initializeNetwork(): void {
    this.networkClient = new NetworkClient(this.serverUrl);

    this.networkClient.onConnect(() => {
      this.showMessage(`Connected to game server as ${this.playerTeam.toUpperCase()}!`);
      this.networkClient!.sendJoin(this.playerTeam, {
        x: this.player.position.x,
        y: this.player.position.y,
        z: this.player.position.z,
      }, this.playerName);
    });

    this.networkClient.onDisconnect(() => {
      this.showMessage('Disconnected from server. Reconnecting...');
    });

    // Handle full init message
    this.networkClient.onMessage('init', (msg: any) => {
      this.localPlayerId = msg.playerId;
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
      if (msg.voxelChanges && Array.isArray(msg.voxelChanges) && msg.voxelChanges.length > 0) {
        for (const change of msg.voxelChanges) {
          this.world.setVoxel(change.x, change.y, change.z, change.type, change.durability);
        }
        this.world.update(true);
      }
      this.showMessage(`🟢 Online Match Ready! (${this.playerTeam.toUpperCase()} Team)`);
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
        if (msg.state?.hp !== undefined && msg.state.hp < this.player.hp) {
          this.player.hp = msg.state.hp;
          this.sounds.hurt();
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
        remote.mesh.visible = !msg.state.isDead;
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

    // Handle local player damaged
    this.networkClient.onMessage('playerDamaged', (msg: any) => {
      if (msg.playerId === this.localPlayerId) {
        this.player.takeDamage(msg.damage);
        this.sounds.hurt();
      } else {
        const remote = this.remotePlayers.get(msg.playerId);
        if (remote) {
          remote.state.hp = Math.max(0, remote.state.hp - msg.damage);
        }
      }
    });

    // Handle player died
    this.networkClient.onMessage('playerDied', (msg: any) => {
      if (msg.playerId === this.localPlayerId) {
        this.player.die();
        this.player.respawnTimer = 4;
        this.sounds.deathSound();
        this.showMessage('☠️ You were eliminated! Respawning in 4s...');
      } else {
        const remote = this.remotePlayers.get(msg.playerId);
        if (remote) {
          remote.mesh.visible = false;
          remote.state.isDead = true;
          remote.state.hp = 0;
        }
        if (msg.killerId === this.localPlayerId) {
          if (this.playerTeam === 'blue') this.blueKills++; else this.redKills++;
          this.sounds.killSound();
          this.showMessage(`🎯 You eliminated Player ${msg.playerId.slice(-4)}!`);
        }
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
      if (type !== 0 && durability < 3) {
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

    // Handle flag pickup
    this.networkClient.onMessage('flagPickedUp', (msg: any) => {
      const isLocal = msg.playerId === this.localPlayerId;
      const flag = msg.flagTeam === 'blue' ? this.blueFlag : this.redFlag;
      if (flag) {
        flag.isDropped = false;
        flag.mesh.visible = false; // Flag disappears when taken until returned
        if (isLocal) {
          this.player.carryingFlag = true;
          flag.carrier = { isPlayer: true, name: 'You' };
          this.sounds.flagPickup();
          this.showMessage(`🚩 YOU TOOK THE ${msg.flagTeam.toUpperCase()} FLAG! RUN TO BASE!`);
        } else {
          flag.carrier = { isPlayer: false, name: `Player ${msg.playerId.slice(-4)}` };
          this.sounds.flagAlarm();
          this.showMessage(`⚠️ ${msg.flagTeam.toUpperCase()} FLAG TAKEN by Player ${msg.playerId.slice(-4)}!`);
        }
      }
    });

    // Handle flag dropped
    this.networkClient.onMessage('flagDropped', (msg: any) => {
      const flag = msg.flagTeam === 'blue' ? this.blueFlag : this.redFlag;
      if (flag) {
        flag.currentPos.set(msg.position.x, msg.position.y + 0.5, msg.position.z);
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
      if (flag) {
        this.resetFlagToBase(flag);
        this.showMessage(`🛡️ ${msg.flagTeam.toUpperCase()} FLAG RETURNED TO BASE!`);
      }
    });

    // Handle flag captured
    this.networkClient.onMessage('flagCaptured', (msg: any) => {
      this.blueCaptures = msg.captures.blue;
      this.redCaptures = msg.captures.red;
      const capturedFlag = msg.team === 'blue' ? this.redFlag : this.blueFlag;
      if (capturedFlag) {
        // Disappear upon capture!
        capturedFlag.carrier = null;
        capturedFlag.isDropped = false;
        capturedFlag.isCaptured = true;
        capturedFlag.capturedTimer = 8.0;
        capturedFlag.mesh.visible = false;
        capturedFlag.light.intensity = 0;
      }
      this.sounds.flagCapture();
      if (msg.playerId === this.localPlayerId) {
        this.player.carryingFlag = false;
        this.showMessage(`🏆 YOU CAPTURED THE ENEMY FLAG! (+1 SCORE) Flag respawns in 8s...`);
      } else {
        this.showMessage(`🏆 ${msg.team.toUpperCase()} TEAM SCORED A FLAG CAPTURE! Flag respawns in 8s...`);
      }
    });

    // Handle spectator toggled from other players
    this.networkClient.onMessage('spectatorToggled', (msg: any) => {
      // Track remote player spectator state (for future use)
      console.log(`Player ${msg.playerId} ${msg.isSpectating ? 'entered' : 'exited'} spectator mode`);
    });

    this.networkClient.onMessage('footstep', (msg: any) => {
      // Play footstep sound for other players using SoundManager
      const pan = Math.sin(Math.atan2(msg.position?.x || 0, msg.position?.z || 0) - this.player.yaw);
      this.sounds.playFootstepRemote(msg.volume, msg.pitch, pan);
    });

    this.networkClient.connect().catch((err) => {
      console.error('Failed to connect to server:', err);
      this.showMessage('Failed to connect to server');
    });
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

  private renderRemotePlayerShot(playerId: string, origin: Position, direction: Position, weaponType: string): void {
    const o = new THREE.Vector3(origin.x, origin.y, origin.z);
    const d = new THREE.Vector3(direction.x, direction.y, direction.z);
    this.createMuzzleFlash(o, d);
    this.createBulletTracer(o, d);
    this.createBulletShell(o, d);
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

  private onMouseDown(e: MouseEvent): void {
    if (this.isSpectating) {
      // In spectator mode, clicking/dragging steers the camera
      if (e.button === 0 || e.button === 2) {
        this.isMouseDown = true;
      }
      return;
    }
    if (e.button === 0) {
      this.isMouseDown = true;
      this.performAction();
    } else if (e.button === 2) {
      if (this.equipment === 'rifle' || this.equipment === 'smg') {
        this.isAiming = !this.isAiming;
      } else {
        // Instant snappy block placement like Minecraft
        this.tryBuild();
      }
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0 || e.button === 2) this.isMouseDown = false;
  }

  private onWheel(e: WheelEvent): void {
    if (this.isSpectating) {
      // Adjust drone flight speed
      this.spectatorSpeed = Math.max(10, Math.min(90, this.spectatorSpeed - e.deltaY * 0.04));
      this.showMessage(`🚀 Spectator Flight Speed: ${Math.round(this.spectatorSpeed)} m/s (Scroll to adjust)`);
      return;
    }
    const items: EquipmentType[] = ['rifle', 'smg', 'spade', 'pickaxe'];
    const idx = items.indexOf(this.equipment);
    this.equipment = e.deltaY > 0 ? items[(idx + 1) % 4] : items[(idx - 1 + 4) % 4];
    this.switchWeaponModel(this.equipment);
    this.isAiming = false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'KeyP') {
      this.toggleSpectator();
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

    // Normal player mode controls:
    if (e.code === 'Digit1') { this.equipment = 'rifle'; this.switchWeaponModel('rifle'); }
    if (e.code === 'Digit2') { this.equipment = 'smg'; this.switchWeaponModel('smg'); }
    if (e.code === 'Digit3') { this.equipment = 'spade'; this.switchWeaponModel('spade'); }
    if (e.code === 'Digit4') { this.equipment = 'pickaxe'; this.switchWeaponModel('pickaxe'); }
    if (e.code === 'KeyR') this.startReload();

    this.player.handleKeyDown(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
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
      
      if (this.networkClient && this.networkClient.isConnected) {
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
      this.player.clearKeys();

      if (this.weaponContainer) this.weaponContainer.visible = true;
      if (this.localPlayerMesh) this.localPlayerMesh.visible = false;
      this.player.updateCamera();
      this.showMessage('🎯 Player First-Person: Active');
      
      if (this.networkClient && this.networkClient.isConnected) {
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
    canvas.requestPointerLock();
  }

  private performAction(): void {
    if (this.player.isDead) return;
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

    const dir = this.player.getAimDirection();
    const muzzlePos = this.player.camera.position.clone().add(dir.clone().multiplyScalar(0.5));
    
    this.createMuzzleFlash(muzzlePos, dir.clone());
    this.createBulletTracer(muzzlePos, dir.clone());
    this.createBulletShell(muzzlePos, dir.clone());
    
    // Play appropriate sound based on weapon
    if (this.equipment === 'rifle') {
      this.sounds.rifleShot();
    } else if (this.equipment === 'smg') {
      this.sounds.smgShot();
    }

    const hit = this.world.raycast(muzzlePos, dir, 100);
    const voxelDist = hit ? hit.distance : 100;
    if (hit) {
      const voxel = this.world.getVoxel(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z);
      if (voxel) {
        const destroyed = this.world.damageVoxel(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z, 1);
        if (destroyed) {
          this.world.updateVoxelColor(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z, 0, 0);
        }
      }
    }

    // Check hit on enemy remote players
    let hitRemoteId: string | null = null;
    let hitIsHeadshot = false;

    for (const [id, remote] of this.remotePlayers) {
      if (remote.state.isDead || remote.state.team === this.playerTeam) continue;
      const toRemote = remote.mesh.position.clone().sub(this.player.position);
      const dot = toRemote.dot(dir);
      if (dot > 0 && dot < 100 && dot < voxelDist) {
        const closestPoint = this.player.position.clone().add(dir.clone().multiplyScalar(dot));
        const horizontalDist = Math.hypot(closestPoint.x - remote.mesh.position.x, closestPoint.z - remote.mesh.position.z);
        const verticalDist = closestPoint.y - remote.mesh.position.y;
        if (horizontalDist < 0.75 && verticalDist >= -0.2 && verticalDist <= 2.3) {
          hitRemoteId = id;
          hitIsHeadshot = verticalDist >= 1.45;
          this.hitMarkerTimer = 0.25;
          this.sounds.hitMarker();
          if (hitIsHeadshot) this.sounds.headshot();
          break;
        }
      }
    }

    // Send shoot event to network server with hit candidate
    if (this.networkClient && this.networkClient.isConnected) {
      this.networkClient.sendShoot(
        muzzlePos.x, muzzlePos.y, muzzlePos.z,
        dir.x, dir.y, dir.z
      );
    }

    // Check hit on enemy bots with realistic hitbox (head and body)
    for (const bot of this.bots) {
      if (bot.isDead || bot.team === this.playerTeam) continue;
      const toBot = bot.position.clone().sub(this.player.position);
      const dot = toBot.dot(dir);
      if (dot > 0 && dot < 60 && dot < voxelDist) {
        const closestPoint = this.player.position.clone().add(dir.clone().multiplyScalar(dot));
        const horizontalDist = Math.hypot(closestPoint.x - bot.position.x, closestPoint.z - bot.position.z);
        const verticalDist = closestPoint.y - bot.position.y;

        // Bot hitbox: horizontal radius 0.65m, vertical height 0 to 2.1m
        if (horizontalDist < 0.65 && verticalDist >= 0 && verticalDist <= 2.1) {
          const isHeadshot = verticalDist >= 1.5;
          const damage = isHeadshot ? weapon.damage.head : weapon.damage.body;

          bot.hp -= damage;
          bot.lastDamageTime = Date.now();
          this.hitMarkerTimer = 0.2;
          this.sounds.hitMarker();

          if (bot.hp <= 0) {
            bot.isDead = true;
            bot.mesh.visible = false;
            bot.respawnTimer = 4;

            // Drop flag if bot was carrying it so it reappears on the ground
            if (bot.carryingFlag) {
              const carriedFlag = bot.team === 'blue' ? this.redFlag : this.blueFlag;
              if (carriedFlag) {
                carriedFlag.carrier = null;
                carriedFlag.isDropped = true;
                carriedFlag.dropTimer = 30;
                const dropY = this.world.getGroundHeight(bot.position.x, bot.position.z);
                carriedFlag.currentPos.set(bot.position.x, dropY, bot.position.z);
                carriedFlag.mesh.position.copy(carriedFlag.currentPos);
                carriedFlag.mesh.visible = true; // Dropped flag appears on ground!
                this.showMessage(`🚩 ${carriedFlag.team.toUpperCase()} flag was dropped by ${bot.name}!`);
              }
              bot.carryingFlag = false;
            }

            if (this.playerTeam === 'blue') this.blueKills++; else this.redKills++;
            this.sounds.killSound();
            this.showMessage(`🎯 You killed ${bot.name} ${isHeadshot ? '(HEADSHOT!)' : ''}`);
          }
          break; // Bullet hit target
        }
      }
    }
  }

  private usePickaxe(now: number): void {
    if (now - this.lastActionTime < 0.3) return;
    this.lastActionTime = now;
    
    const dir = this.player.getAimDirection();
    const origin = this.player.camera.position.clone().add(dir.clone().multiplyScalar(0.5));
    const hit = this.world.raycast(origin, dir, 5);
    
    if (hit) {
      const result = this.world.damageVoxel(hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z, 3);
      if (result.destroyed) {
        this.inventory++;
        this.sounds.pickaxeHit();
      }
      if (this.networkClient && this.networkClient.isConnected) {
        this.networkClient.sendUseTool('destroy', hit.voxelPos.x, hit.voxelPos.y, hit.voxelPos.z, 0);
      }
    }
  }

  private useSpade(now: number): void {
    if (now - this.lastActionTime < 0.3) return;
    this.lastActionTime = now;
    
    const dir = this.player.getAimDirection();
    const origin = this.player.camera.position.clone().add(dir.clone().multiplyScalar(0.5));
    const hit = this.world.raycast(origin, dir, 5);
    
    if (hit) {
      // Dig trench: remove target voxel and the one below it (2 tiles)
      const vx = hit.voxelPos.x;
      const vy = hit.voxelPos.y;
      const vz = hit.voxelPos.z;
      
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
      if (this.networkClient && this.networkClient.isConnected) {
        this.networkClient.sendUseTool('destroy', vx, vy, vz, 0);
      }
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
  private checkBotVoxelCollision(x: number, y: number, z: number, radius = 0.38, height = 1.85): boolean {
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
    if (this.inventory <= 0) return;
    
    const dir = this.player.getAimDirection();
    const origin = this.player.camera.position.clone().add(dir.clone().multiplyScalar(0.5));
    const hit = this.world.raycast(origin, dir, 6);
    
    if (hit) {
      const px = hit.voxelPos.x + Math.round(hit.normal.x);
      const py = hit.voxelPos.y + Math.round(hit.normal.y);
      const pz = hit.voxelPos.z + Math.round(hit.normal.z);
      
      if (!this.world.isSolid(px, py, pz) && this.canPlaceBlock(px, py, pz)) {
        this.world.setVoxel(px, py, pz, VOXEL_BUILT, 3);
        this.inventory--;
        this.sounds.buildPlace();
        if (this.networkClient && this.networkClient.isConnected) {
          this.networkClient.sendBuild(px, py, pz, 4);
        }
        
        // Add instant visual feedback - flash the placed block
        this.createBlockPlacementEffect(px, py, pz);
      }
    }
  }

  private createBlockPlacementEffect(x: number, y: number, z: number): void {
    // Create a quick flash effect at the placement location
    const flashGeo = new THREE.BoxGeometry(VOXEL_SIZE * 1.1, VOXEL_SIZE * 1.1, VOXEL_SIZE * 1.1);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0x88ff88, transparent: true, opacity: 0.7 });
    const flashMesh = new THREE.Mesh(flashGeo, flashMat);
    flashMesh.position.set(x + 0.5, y + 0.5, z + 0.5);
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

  private createImpactSparks(position: THREE.Vector3, normal?: THREE.Vector3): void {
    const sparkGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9 });
    const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
    sparkMesh.position.copy(position);
    if (normal) sparkMesh.position.addScaledVector(normal, 0.08);
    this.scene.add(sparkMesh);

    const fadeOut = () => {
      sparkMat.opacity -= 0.2;
      sparkMesh.scale.multiplyScalar(0.9);
      if (sparkMat.opacity > 0) {
        requestAnimationFrame(fadeOut);
      } else {
        this.scene.remove(sparkMesh);
        sparkGeo.dispose();
        sparkMat.dispose();
      }
    };
    requestAnimationFrame(fadeOut);
  }

  private startReload(): void {
    const weapon = this.weapons[this.equipment];
    if (!weapon || weapon.magazineSize === 0 || weapon.isReloading || weapon.currentAmmo === weapon.magazineSize) return;
    weapon.isReloading = true;
    weapon.reloadStartTime = performance.now() / 1000;
    this.isReloadAnimating = true;
    this.reloadAnimationTime = 0;
    this.reloadAnimationDuration = weapon.reloadTime;
    this.sounds.reload();
    if (this.networkClient && this.networkClient.isConnected) {
      this.networkClient.sendReload();
    }
  }

  private createMuzzleFlash(position: THREE.Vector3, direction: THREE.Vector3): void {
    const light = new THREE.PointLight(0xffaa00, 5, 8);
    light.position.copy(position);
    this.scene.add(light);

    const flashGeo = new THREE.SphereGeometry(0.15, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.9 });
    const flashMesh = new THREE.Mesh(flashGeo, flashMat);
    flashMesh.position.copy(position);
    this.scene.add(flashMesh);

    this.muzzleFlashes.push({ light, mesh: flashMesh, life: 0, maxLife: 0.08 });
  }

  private createBulletTracer(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const tracerGeo = new THREE.BoxGeometry(0.03, 0.03, 0.6);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffea00, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(tracerGeo, tracerMat);
    mesh.position.copy(origin);
    mesh.lookAt(origin.clone().add(direction));
    this.scene.add(mesh);

    const velocity = direction.clone().multiplyScalar(220);
    this.bulletTracers.push({ mesh, velocity, life: 0, maxLife: 0.5, hasWhizzed: false, hasImpacted: false });
  }

  private createBulletShell(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const shellGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.03, 8);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xDAA520, metalness: 0.8, roughness: 0.2 });
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.position.copy(origin);
    
    // Rotate shell to be horizontal
    mesh.rotation.z = Math.PI / 2;
    
    this.scene.add(mesh);

    // Eject shell to the right and slightly up
    const right = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
    const velocity = right.multiplyScalar(3).add(new THREE.Vector3(0, 2, 0));
    const rotationSpeed = new THREE.Vector3(
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10
    );

    this.bulletShells.push({ mesh, velocity, rotationSpeed, life: 0, maxLife: 2 });
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
    this.inventory = 0;
    this.player.carryingFlag = false;
    this.isReloadAnimating = false;
    this.reloadAnimationTime = 0;
    this.sounds.respawn();
    this.showMessage(`🎖️ Respawned at ${this.playerTeam.toUpperCase()} Base!`);

    if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected) {
      this.networkClient.sendPlayerInput({
        forward: 0,
        right: 0,
        jump: false,
        crouch: false,
        sprint: false,
        shoot: false,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
      });
    }
  }

  start(): void {
    this.animate();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    this.player.update(dt);
    this.world.update();

    // Continuous fire for SMG and tools while holding mouse button
    if (this.isMouseDown && !this.player.isDead) {
      if (this.equipment === 'smg' || this.equipment === 'pickaxe' || this.equipment === 'spade') {
        this.performAction();
      }
    }

    // ADS camera zoom
    const targetFov = this.isAiming ? (this.equipment === 'rifle' ? 45 : 55) : 75;
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
          weapon.currentAmmo = weapon.magazineSize;
          weapon.isReloading = false;
        }
        this.isReloadAnimating = false;
      }
    }

    for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
      const flash = this.muzzleFlashes[i];
      flash.life += dt;
      if (flash.life >= flash.maxLife) {
        this.scene.remove(flash.light);
        this.scene.remove(flash.mesh);
        this.muzzleFlashes.splice(i, 1);
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
        this.scene.remove(tracer.mesh);
        this.bulletTracers.splice(i, 1);
      }
    }

    // Update bullet shells
    for (let i = this.bulletShells.length - 1; i >= 0; i--) {
      const shell = this.bulletShells[i];
      shell.velocity.y -= 9.8 * dt; // Gravity
      shell.mesh.position.add(shell.velocity.clone().multiplyScalar(dt));
      shell.mesh.rotation.x += shell.rotationSpeed.x * dt;
      shell.mesh.rotation.y += shell.rotationSpeed.y * dt;
      shell.mesh.rotation.z += shell.rotationSpeed.z * dt;
      shell.life += dt;
      
      // Fade out in last 0.5 seconds
      if (shell.life > shell.maxLife - 0.5) {
        const opacity = (shell.maxLife - shell.life) / 0.5;
        (shell.mesh.material as THREE.MeshStandardMaterial).opacity = opacity;
      }
      
      if (shell.life >= shell.maxLife) {
        this.scene.remove(shell.mesh);
        this.bulletShells.splice(i, 1);
      }
    }

    this.updateFlags(dt);
    this.updateBots(dt);

    // Send network player input to server
    if (this.networkClient && this.networkClient.isConnected && !this.player.isDead) {
      const now = performance.now();
      if (now - this.lastInputSendTime > this.inputSendRate) {
        this.lastInputSendTime = now;
        this.networkClient.sendPlayerInput({
          forward: (this.player.hasKey('KeyW') ? 1 : 0) - (this.player.hasKey('KeyS') ? 1 : 0),
          right: (this.player.hasKey('KeyD') ? 1 : 0) - (this.player.hasKey('KeyA') ? 1 : 0),
          jump: this.player.hasKey('Space'),
          crouch: this.player.isCrouching,
          sprint: this.player.isSprinting,
          shoot: false,
          yaw: this.player.yaw,
          pitch: this.player.pitch,
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
        if (leftLeg) leftLeg.rotation.x = swing;
        if (rightLeg) rightLeg.rotation.x = -swing;
        if (leftArm) leftArm.rotation.x = -swing;
        if (rightArm) rightArm.rotation.x = swing;
      } else {
        if (leftLeg) leftLeg.rotation.x = 0;
        if (rightLeg) rightLeg.rotation.x = 0;
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

    // Manage visibility of first-person equipment and third-person player avatar in spectator mode
    if (this.weaponContainer) {
      this.weaponContainer.visible = !this.isSpectating;
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

        const right = new THREE.Vector3(
          Math.cos(this.spectatorAngle),
          0,
          -Math.sin(this.spectatorAngle)
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
    } else {
      // First-person player camera
      this.player.updateCamera();
    }

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message = '';
    }

    this.emitState();
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
        if (dist < 85) {
          const toEnemy = this.player.position.clone().sub(bot.position).normalize();
          const dotProduct = botForward.dot(toEnemy);
          if (dist < 22 || wasRecentlyHit || dotProduct > -0.25) {
            return { pos: this.player.position.clone(), isPlayer: true };
          }
        }
      } else if (friendlyFlag.carrier.bot && !friendlyFlag.carrier.bot.isDead && friendlyFlag.carrier.bot.team !== bot.team) {
        const dist = bot.position.distanceTo(friendlyFlag.carrier.bot.position);
        if (dist < 85) {
          const toEnemy = friendlyFlag.carrier.bot.position.clone().sub(bot.position).normalize();
          const dotProduct = botForward.dot(toEnemy);
          if (dist < 22 || wasRecentlyHit || dotProduct > -0.25) {
            return { pos: friendlyFlag.carrier.bot.position.clone(), isPlayer: false, bot: friendlyFlag.carrier.bot };
          }
        }
      }
    }

    // Check player
    if (bot.team !== this.playerTeam && !this.player.isDead) {
      const dist = bot.position.distanceTo(this.player.position);
      if (dist < nearestDist && dist < 70) {
        const toPlayer = this.player.position.clone().sub(bot.position).normalize();
        const dotProduct = botForward.dot(toPlayer);
        // Detect if close (hearing footsteps/spades), if recently took damage, or if in wide FOV
        if (dist < 18 || wasRecentlyHit || dotProduct > -0.25) {
          nearestDist = dist;
          nearest = { pos: this.player.position.clone(), isPlayer: true };
        }
      }
    }

    // Check other bots
    for (const otherBot of this.bots) {
      if (otherBot === bot || otherBot.isDead || otherBot.team === bot.team) continue;
      const dist = bot.position.distanceTo(otherBot.position);
      if (dist < nearestDist && dist < 70) {
        const toEnemy = otherBot.position.clone().sub(bot.position).normalize();
        const dotProduct = botForward.dot(toEnemy);
        if (dist < 18 || wasRecentlyHit || dotProduct > -0.25) {
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

      // Respawn handling
      if (bot.isDead) {
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

      // Safety: Void / fall check for bots
      if (bot.position.y < -5 || bot.position.y > 60 || Math.abs(bot.position.x) > 155 || Math.abs(bot.position.z) > 155) {
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

      // Find nearest enemy target with 360° awareness and wide FOV
      const enemyTarget = this.findNearestEnemy(bot);
      const distToEnemy = enemyTarget ? bot.position.distanceTo(enemyTarget.pos) : Infinity;
      const wasRecentlyHit = Date.now() - bot.lastDamageTime < 3200;
      const isUnderAttack = wasRecentlyHit || (enemyTarget && distToEnemy < 40);

      // Strafe dodging timer (flips direction periodically like human players)
      bot.dodgeTimer -= dt;
      if (bot.dodgeTimer <= 0) {
        bot.strafeDirection = -bot.strafeDirection;
        bot.dodgeTimer = 1.0 + Math.random() * 1.4;
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
        if (enemyTarget && distToEnemy < 48) {
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
              if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected) {
                this.networkClient.sendBuild(blk.x, blk.y, blk.z, 4);
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
            if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected) {
              this.networkClient.sendUseTool('destroy', x, y, z, 0);
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

        // Steer around high walls (> 1.25m) using 45-degree ray probes
        if (stepHeight > 1.25) {
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
        }

        // Sub-stepped, axis-independent movement with smooth 1-voxel auto-step-up
        const stepDt = Math.min(dt, 0.05);
        const moveStepX = moveDir.x * speed * stepDt;
        const moveStepZ = moveDir.z * speed * stepDt;
        const maxClimb = (bot.isCrouching || bot.isBuilding || bot.tacticalState === 'building') ? 0.35 : 1.25;

        // Try movement along X axis
        if (Math.abs(moveStepX) > 0.0001) {
          const tryX = bot.position.x + moveStepX;
          if (!this.checkBotVoxelCollision(tryX, bot.position.y, bot.position.z)) {
            bot.position.x = tryX;
          } else if (bot.grounded && !bot.isCrouching && maxClimb > 0.5) {
            // Foot obstacle: step-up onto target obstacle surface with headroom check
            const targetGroundY = this.world.getGroundHeight(tryX, bot.position.z);
            const climb = targetGroundY - bot.position.y;
            if (climb > 0.05 && climb <= maxClimb) {
              if (!this.checkBotVoxelCollision(tryX, targetGroundY, bot.position.z)) {
                bot.position.x = tryX;
                bot.position.y = targetGroundY;
              }
            }
          }
        }

        // Try movement along Z axis
        if (Math.abs(moveStepZ) > 0.0001) {
          const tryZ = bot.position.z + moveStepZ;
          if (!this.checkBotVoxelCollision(bot.position.x, bot.position.y, tryZ)) {
            bot.position.z = tryZ;
          } else if (bot.grounded && !bot.isCrouching && maxClimb > 0.5) {
            // Foot obstacle: step-up onto target obstacle surface with headroom check
            const targetGroundY = this.world.getGroundHeight(bot.position.x, tryZ);
            const climb = targetGroundY - bot.position.y;
            if (climb > 0.05 && climb <= maxClimb) {
              if (!this.checkBotVoxelCollision(bot.position.x, targetGroundY, tryZ)) {
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
              if (this.gameMode === 'online' && this.networkClient && this.networkClient.isConnected) {
                this.networkClient.sendUseTool('destroy', fwdX, footY, fwdZ, 0);
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
            if (!this.checkBotVoxelCollision(testX, testY, testZ)) {
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
      if (bot.bodyParts) {
        if (enemyTarget && distToEnemy < 50 && !bot.isDigging && !bot.isBuilding) {
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
      if (enemyTarget && distToEnemy < 50 && !bot.isDigging && !bot.isBuilding) {
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
    const origin = bot.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    const targetHeight = target.isPlayer ? 1.1 : 1.15;
    const centerTargetPos = target.pos.clone().add(new THREE.Vector3(0, targetHeight, 0));
    const toTarget = centerTargetPos.clone().sub(origin);
    const dist = toTarget.length();
    const idealDir = toTarget.clone().normalize();

    // Human shot deviation calculation:
    // 1. Weapon base cone of fire (rifle has tight deliberate aim, SMG has wider cone)
    let spreadAngle = bot.weapon === 'rifle' ? 0.024 : 0.052;

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
    const terrainHit = this.world.raycast(origin, actualDir, 75);

    // Target cylinder intersection test:
    let isHit = false;
    let hitPoint = new THREE.Vector3();
    let isHeadshot = false;

    // Solve closest approach along 3D ray to target center axis
    const dx = target.pos.x - origin.x;
    const dz = target.pos.z - origin.z;
    const horizDirSq = actualDir.x * actualDir.x + actualDir.z * actualDir.z;

    if (horizDirSq > 0.0001) {
      const t = (dx * actualDir.x + dz * actualDir.z) / horizDirSq;
      if (t > 0.4 && (!terrainHit || terrainHit.distance >= t - 0.2)) {
        const cx = origin.x + actualDir.x * t;
        const cz = origin.z + actualDir.z * t;
        const cy = origin.y + actualDir.y * t;
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

    // Visual tracer and muzzle flash along the real trajectory
    this.createMuzzleFlash(origin, actualDir);
    this.createBulletTracer(origin, actualDir);

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
        const dmg = Math.round(baseDmg * headshotMult);
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
      // MISSED SHOT!
      // If the bullet struck terrain, spawn ricochet / block impact sparks!
      if (terrainHit) {
        this.createImpactSparks(terrainHit.position, terrainHit.normal);
      }
    }
  }

  handleBuildClick(): void {
    this.tryBuild();
  }

  private emitState(): void {
    if (this.onStateChange) {
      const weapon = this.weapons[this.equipment];
      let carrierName = '';
      if (this.player.carryingFlag) {
        carrierName = `You (${this.playerTeam.toUpperCase()})`;
      } else if (this.redFlag?.carrier) {
        carrierName = `${this.redFlag.carrier.name} (${this.redFlag.carrier.isPlayer ? this.playerTeam.toUpperCase() : this.redFlag.carrier.bot?.team.toUpperCase()})`;
      } else if (this.blueFlag?.carrier) {
        carrierName = `${this.blueFlag.carrier.name} (${this.blueFlag.carrier.isPlayer ? this.playerTeam.toUpperCase() : this.blueFlag.carrier.bot?.team.toUpperCase()})`;
      }

      this.onStateChange({
        hp: this.player.hp,
        maxHp: this.player.maxHp,
        equipment: this.equipment,
        inventory: this.inventory,
        isDead: this.player.isDead,
        respawnTimer: this.player.respawnTimer,
        hitMarker: this.hitMarkerTimer > 0,
        targetInfo: this.player.targetInfo || '',
        message: this.message,
        messageTimer: this.messageTimer,
        buildMode: false,  // Always false with instant placement
        buildValid: this.inventory > 0,
        blueKills: this.blueKills,
        redKills: this.redKills,
        blueCaptures: this.blueCaptures,
        redCaptures: this.redCaptures,
        isAiming: this.isAiming,
        currentAmmo: weapon ? weapon.currentAmmo : 0,
        magazineSize: weapon ? weapon.magazineSize : 0,
        isReloading: weapon ? weapon.isReloading : false,
        playerCarryingFlag: this.player.carryingFlag,
        flagCarrierName: carrierName,
        isSpectating: this.isSpectating,
        spectatorMode: this.spectatorMode,
        spectatorTrackedName: this.spectatorTrackedName,
        isOnline: this.gameMode === 'online',
        connectedPlayersCount: this.remotePlayers.size + 1,
        isNetworkConnected: this.networkClient ? this.networkClient.isConnected : false,
        localPlayerId: this.localPlayerId,
      });
    }
  }

  destroy(): void {
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
    this.renderer.dispose();
  }
}
