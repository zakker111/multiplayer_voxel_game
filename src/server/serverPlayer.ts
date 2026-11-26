import {
  PlayerState,
  Position,
  Rotation,
  PlayerInput,
  JUMP_FORCE,
  PLAYER_MAX_SPEED,
  PLAYER_MOVE_BURST_SECONDS,
  PLAYER_MAX_FALL_SPEED,
  WORLD_SIZE,
  GROUND_LEVEL,
  MAX_RESERVE_MAGAZINES,
  WEAPONS,
  gunStats,
  isEquipment,
  type EquipmentId,
} from '../shared/types';
import { ServerWorld } from './serverWorld';

/**
 * Client positions are validated by default. Only an operator can turn it off
 * (via MOVE_VALIDATION=off), never a client; automated harnesses that script
 * long-range teleports on purpose set it for their feature sweep.
 */
const MOVE_VALIDATION = process.env.MOVE_VALIDATION !== 'off';

export class ServerPlayer {
  id: string;
  name?: string;
  /** True for AI combatants; surfaced in getState() so clients can show them
   *  on the Tab scoreboard with a "BOT" tag. */
  isBotFlag = false;
  position: Position;
  rotation: Rotation;
  velocity: Position;
  hp: number = 100;
  maxHp: number = 100;
  team: 'red' | 'blue';
  isDead: boolean = false;
  equipment: 'rifle' | 'smg' | 'pickaxe' | 'spade' = 'rifle';
  isAiming: boolean = false;
  isCrouching: boolean = false;
  isSprinting: boolean = false;
  isGrounded: boolean = false;
  isShooting: boolean = false;
  carryingFlag: boolean = false;
  isSpectating: boolean = false;
  /** Client IP (normalized), set by ServerGame.addPlayer for admin/kick/ban tooling */
  ip?: string;
  /** Distance this player may still travel, credited by elapsed time. */
  private moveBudget = PLAYER_MAX_SPEED * PLAYER_MOVE_BURST_SECONDS;
  private lastMoveCreditAt = 0;
  
  // Footstep sound tracking
  lastFootstepTime: number = 0;
  footstepInterval: number = 0.5; // Base interval between footsteps in seconds
  
  /** Spawn invulnerability flag, refreshed by ServerGame on every spawn so
   *  `getState()` can tell the HUD (and remote clients) about the shield. */
  spawnProtected: boolean = false;

  // Magazine system
  currentAmmo: number = 10;
  magazineSize: number = 10;
  /** Rounds in the pouch besides the loaded magazine. A reload draws from here
   *  and nothing else refills it, so a squad that stops paying for magazines
   *  (workshop blocks at the bench) eventually runs dry. */
  reserveAmmo: number = 0;
  /** Shell packs carried for a cannon or mortar, bought at the bench. */
  shellPacks: number = 0;
  isReloading: boolean = false;
  reloadStartTime: number = 0;
  reloadTime: number = 2.0; // seconds
  
  private input: PlayerInput = {
    moveX: 0,
    moveZ: 0,
    jump: false,
    crouch: false,
    sprint: false,
    yaw: 0,
    pitch: 0,
  };

  constructor(id: string, position: Position, team: 'red' | 'blue') {
    this.id = id;
    this.position = { ...position };
    this.rotation = { yaw: 0, pitch: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.team = team;
    this.applyWeaponLoadout();
  }

  /** What each gun still carries this life. A swap hands back the rounds it
   *  left with: refilling on swap made two key presses (2 then 1) free ammo and
   *  bypassed the bench economy entirely. */
  private carriedAmmo: Record<EquipmentId, { magazine: number; pouch: number }> = {
    rifle: { magazine: 0, pouch: 0 },
    smg: { magazine: 0, pouch: 0 },
    pickaxe: { magazine: 0, pouch: 0 },
    spade: { magazine: 0, pouch: 0 },
  };

  /** Fresh life: every gun starts at its table loadout. Called on spawn and
   *  respawn only — never on a weapon swap. */
  private applyWeaponLoadout(): void {
    for (const gun of ['rifle', 'smg'] as const) {
      const stats = WEAPONS[gun];
      this.carriedAmmo[gun] = {
        magazine: stats.magazineSize,
        pouch: stats.magazineSize * stats.reserveMagazines,
      };
    }
    this.syncCarriedAmmo();
  }

  /** Point the active magazine/pouch at the equipped item's carried rounds
   *  (tools have none, and their entries stay at zero). */
  private syncCarriedAmmo(): void {
    const stats = gunStats(this.equipment);
    this.magazineSize = stats ? stats.magazineSize : 0;
    this.reloadTime = stats ? stats.reloadTime : 0;
    this.isReloading = false;
    this.currentAmmo = this.carriedAmmo[this.equipment].magazine;
    this.reserveAmmo = this.carriedAmmo[this.equipment].pouch;
  }

  /** Rounds the pouch may hold for the equipped gun (0 for tools). */
  reserveCapacity(): number {
    const stats = gunStats(this.equipment);
    return stats ? stats.magazineSize * MAX_RESERVE_MAGAZINES : 0;
  }

  applyInput(input: PlayerInput): void {
    // Malformed/partial inputs (e.g. a build-only payload missing movement
    // fields) must never replace the stored input wholesale — that would
    // leave moveX/moveZ/yaw undefined and crash the tick loop in
    // shouldPlayFootstep(). Merge defensively instead.
    this.input = {
      ...this.input,
      ...input,
      moveX: Number.isFinite(input.moveX) ? input.moveX : this.input.moveX,
      moveZ: Number.isFinite(input.moveZ) ? input.moveZ : this.input.moveZ,
      yaw: Number.isFinite(input.yaw) ? input.yaw : this.input.yaw,
      pitch: Number.isFinite(input.pitch) ? input.pitch : this.input.pitch,
    };
    this.rotation.yaw = this.input.yaw;
    this.rotation.pitch = this.input.pitch;
    this.isCrouching = !!this.input.crouch;
    this.isSprinting = !!this.input.sprint;
    // Whitelist the item id: equipment is client-supplied, and an unknown
    // string would otherwise land in `equipment`, break every HUD lookup and
    // silently disable shooting for that player.
    if (isEquipment(input.equipment) && input.equipment !== this.equipment) {
      this.changeEquipment(input.equipment);
    }
    if (input.isAiming !== undefined) this.isAiming = input.isAiming;
    if (input.position) {
      const half = WORLD_SIZE / 2;
      if (
        input.position.x >= -half && input.position.x <= half &&
        input.position.z >= -half && input.position.z <= half &&
        input.position.y >= -20 && input.position.y <= 60
      ) {
        const next = MOVE_VALIDATION ? this.clampClientPosition(input.position) : input.position;
        this.position.x = next.x;
        this.position.y = next.y;
        this.position.z = next.z;
      }
    }
  }

  /**
   * Accept the client's position only as far as it could have travelled since
   * the previous update. Movement is client-simulated, so this is the one place
   * a modified client could otherwise teleport — e.g. straight onto the enemy
   * flag. Over-spending is clamped rather than rejected outright: a lagging
   * client keeps moving at the legal rate instead of freezing out of sync with
   * the server, while a teleport or speed hack gains no ground at all.
   */
  private clampClientPosition(target: Position): Position {
    const now = Date.now();
    const elapsed = Math.min(
      Math.max(now - this.lastMoveCreditAt, 0) / 1000,
      PLAYER_MOVE_BURST_SECONDS,
    );
    this.lastMoveCreditAt = now;
    const capacity = PLAYER_MAX_SPEED * PLAYER_MOVE_BURST_SECONDS;
    this.moveBudget = Math.min(this.moveBudget + PLAYER_MAX_SPEED * elapsed, capacity);

    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const distance = Math.hypot(dx, dz);
    const allowed = Math.min(distance, this.moveBudget);
    this.moveBudget -= allowed;
    const scale = distance > 0 ? allowed / distance : 0;

    // Vertical: jump/fall envelope only, so a hand-crafted y cannot levitate.
    const maxUp = JUMP_FORCE * elapsed + 0.25;
    const maxDown = PLAYER_MAX_FALL_SPEED * elapsed + 0.5;
    const y = Math.min(Math.max(target.y, this.position.y - maxDown), this.position.y + maxUp);

    return { x: this.position.x + dx * scale, y, z: this.position.z + dz * scale };
  }

  isAlive(): boolean {
    return !this.isDead && !this.isSpectating;
  }

  update(_dt: number, world: ServerWorld): void {
    if (this.isDead) return;

    // Skip physics and movement for spectators
    if (this.isSpectating) {
      this.updateReload();
      return;
    }

    this.updateReload();

    // The client is authoritative on position (sent via playerInput), so derive
    // "grounded" from the player's Y level instead of running full physics here.
    this.isGrounded = Math.abs(this.position.y - GROUND_LEVEL) < 0.6;

    // Check for footstep generation (throttled via lastFootstepTime + serverTime)
    if (this.shouldPlayFootstep(world)) {
      this.lastFootstepTime = world.serverTime;
      // Footstep will be sent via serverGame broadcast
    }
  }
  
  private shouldPlayFootstep(world: ServerWorld): boolean {
    // Only play footsteps when moving and grounded
    const moveSpeed = Math.sqrt(this.input.moveX * this.input.moveX + this.input.moveZ * this.input.moveZ);
    if (moveSpeed < 0.1 || !this.isGrounded) return false;
    
    // Calculate interval based on sprinting and crouching
    let interval = this.footstepInterval;
    if (this.isSprinting) {
      interval *= 0.6; // Faster footsteps when sprinting
    } else if (this.isCrouching) {
      interval *= 1.5; // Slower footsteps when crouching
    }
    
    // Check if enough time has passed since last footstep
    const timeSinceLastStep = world.serverTime - this.lastFootstepTime;
    if (timeSinceLastStep >= interval) {
      return true;
    }
    
    return false;
  }
  
  getFootstepData(world: ServerWorld): { volume: number; pitch: number } | null {
    if (!this.isGrounded) return null;
    
    const moveSpeed = Math.sqrt(this.input.moveX * this.input.moveX + this.input.moveZ * this.input.moveZ);
    if (moveSpeed < 0.1) return null;

    // Throttle: only emit a footstep once the interval has elapsed, otherwise
    // every tick (20Hz) would broadcast a sound event (footstep spam).
    let stepInterval = this.footstepInterval;
    if (this.isSprinting) {
      stepInterval *= 0.6;
    } else if (this.isCrouching) {
      stepInterval *= 1.5;
    }
    if (world.serverTime - this.lastFootstepTime < stepInterval) return null;
    this.lastFootstepTime = world.serverTime;
    
    // Volume based on movement speed and stance
    let volume = 0.3; // Base volume
    if (this.isSprinting) {
      volume = 0.8; // Louder when sprinting
    } else if (this.isCrouching) {
      volume = 0.15; // Quieter when crouching
    }
    
    // Add some randomness to pitch
    const pitch = 0.9 + Math.random() * 0.2; // 0.9 to 1.1
    
    return { volume, pitch };
  }

  takeDamage(amount: number): void {
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.isDead = true;
    }
  }

  respawn(position: Position): void {
    this.position = { ...position };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.hp = this.maxHp;
    this.isDead = false;
    // Reset magazine and pouch on respawn
    this.applyWeaponLoadout();
  }

  changeEquipment(equipment: EquipmentId): void {
    if (equipment === this.equipment) return;
    // Keep what the outgoing item still carries; the new one resumes its own.
    this.carriedAmmo[this.equipment] = { magazine: this.currentAmmo, pouch: this.reserveAmmo };
    this.equipment = equipment;
    this.syncCarriedAmmo();
  }

  startReload(): boolean {
    if (this.isReloading || this.currentAmmo === this.magazineSize) {
      return false;
    }
    // No pouch round to load: the magazine cannot be topped up without buying
    // more at the bench. (Tools exit above, since their magazine is empty.)
    if (this.reserveAmmo <= 0) {
      return false;
    }
    
    this.isReloading = true;
    this.reloadStartTime = Date.now() / 1000;
    return true;
  }

  updateReload(): void {
    if (!this.isReloading) return;
    
    const now = Date.now() / 1000;
    const elapsed = now - this.reloadStartTime;
    
    if (elapsed >= this.reloadTime) {
      // Only load what the pouch can pay for; a partial pouch leaves the
      // magazine short instead of conjuring rounds.
      const needed = this.magazineSize - this.currentAmmo;
      const loaded = Math.min(needed, this.reserveAmmo);
      this.currentAmmo += loaded;
      this.reserveAmmo -= loaded;
      this.isReloading = false;
    }
  }

  useAmmo(): boolean {
    if (this.isReloading || this.currentAmmo <= 0) {
      return false;
    }
    this.currentAmmo--;
    return true;
  }

  getState(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      position: { ...this.position },
      rotation: { ...this.rotation },
      velocity: { ...this.velocity },
      hp: this.hp,
      team: this.team,
      isDead: this.isDead,
      equipment: this.equipment,
      isAiming: this.isAiming,
      isCrouching: this.isCrouching,
      isSprinting: this.isSprinting,
      isShooting: this.isShooting,
      currentAmmo: this.currentAmmo,
      magazineSize: this.magazineSize,
      reserveAmmo: this.reserveAmmo,
      shellPacks: this.shellPacks,
      isReloading: this.isReloading,
      aimTransition: this.isAiming ? 1 : 0, // Sync aiming state
      carryingFlag: this.carryingFlag,
      spawnProtected: this.spawnProtected || undefined,
      isBot: this.isBotFlag || undefined, // scoreboard "BOT" tag for AI combatants
    };
  }
}
