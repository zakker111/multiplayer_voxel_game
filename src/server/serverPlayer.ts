import {
  PlayerState,
  Position,
  Rotation,
  PlayerInput,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  CROUCH_MULTIPLIER,
  JUMP_FORCE,
  GRAVITY,
  PLAYER_HEIGHT,
  CROUCH_HEIGHT,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from '../shared/types';
import { ServerWorld } from './serverWorld';

export class ServerPlayer {
  id: string;
  name?: string;
  position: Position;
  rotation: Rotation;
  velocity: Position;
  hp: number = 100;
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
  
  // Footstep sound tracking
  lastFootstepTime: number = 0;
  footstepInterval: number = 0.5; // Base interval between footsteps in seconds
  
  // Magazine system
  currentAmmo: number = 10;
  magazineSize: number = 10;
  isReloading: boolean = false;
  reloadStartTime: number = 0;
  reloadTime: number = 2.0; // seconds
  
  // Weapon-specific magazine sizes
  private static readonly MAGAZINE_SIZES = {
    rifle: 10,
    smg: 30,
    pickaxe: 0,
    spade: 0
  };
  
  private static readonly RELOAD_TIMES = {
    rifle: 2.0,
    smg: 1.5,
    pickaxe: 0,
    spade: 0
  };

  private input: PlayerInput = {
    forward: 0,
    right: 0,
    moveX: 0,
    moveZ: 0,
    jump: false,
    crouch: false,
    sprint: false,
    shoot: false,
    yaw: 0,
    pitch: 0,
  };

  constructor(id: string, position: Position, team: 'red' | 'blue') {
    this.id = id;
    this.position = { ...position };
    this.rotation = { yaw: 0, pitch: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.team = team;
  }

  applyInput(input: PlayerInput): void {
    this.input = input;
    this.rotation.yaw = input.yaw;
    this.rotation.pitch = input.pitch;
    this.isCrouching = input.crouch;
    this.isSprinting = input.sprint;
    if (input.equipment && input.equipment !== this.equipment) {
      const validEquipment = ['rifle', 'smg', 'pickaxe', 'spade'].includes(input.equipment) 
        ? (input.equipment as 'rifle' | 'smg' | 'pickaxe' | 'spade')
        : this.equipment;
      if (validEquipment !== this.equipment) {
        this.changeEquipment(validEquipment);
      }
    }
    if (input.isAiming !== undefined) this.isAiming = input.isAiming;
    if (input.position) {
      const half = WORLD_SIZE / 2;
      if (
        input.position.x >= -half && input.position.x <= half &&
        input.position.z >= -half && input.position.z <= half &&
        input.position.y >= -20 && input.position.y <= 60
      ) {
        this.position.x = input.position.x;
        this.position.y = input.position.y;
        this.position.z = input.position.z;
      }
    }
  }

  update(dt: number, world: ServerWorld): void {
    if (this.isDead) return;
    
    // Skip physics and movement for spectators
    if (this.isSpectating) {
      this.updateReload();
      return;
    }
    
    this.updateReload();
    
    // Check for footstep generation
    if (this.shouldPlayFootstep(dt, world)) {
      this.lastFootstepTime = world.serverTime;
      // Footstep will be sent via serverGame broadcast
    }
  }
  
  private shouldPlayFootstep(dt: number, world: ServerWorld): boolean {
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

  private checkCollision(x: number, y: number, z: number, height: number, world: ServerWorld): boolean {
    const radius = PLAYER_RADIUS;
    
    // Check multiple points around the player
    for (let dy = 0; dy < height; dy += 0.5) {
      for (let dx = -radius; dx <= radius; dx += radius) {
        for (let dz = -radius; dz <= radius; dz += radius) {
          const checkX = Math.floor(x + dx);
          const checkY = Math.floor(y + dy);
          const checkZ = Math.floor(z + dz);
          
          if (world.isSolid(checkX, checkY, checkZ)) {
            return true;
          }
        }
      }
    }
    
    return false;
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
    this.hp = 100;
    this.isDead = false;
    // Reset magazine on respawn
    this.currentAmmo = ServerPlayer.MAGAZINE_SIZES[this.equipment];
    this.magazineSize = ServerPlayer.MAGAZINE_SIZES[this.equipment];
    this.isReloading = false;
  }

  changeEquipment(equipment: 'rifle' | 'smg' | 'pickaxe' | 'spade'): void {
    this.equipment = equipment;
    this.magazineSize = ServerPlayer.MAGAZINE_SIZES[equipment];
    this.currentAmmo = this.magazineSize;
    this.isReloading = false;
    this.reloadTime = ServerPlayer.RELOAD_TIMES[equipment];
  }

  startReload(): boolean {
    if (this.isReloading || this.currentAmmo === this.magazineSize) {
      return false;
    }
    if (this.equipment === 'pickaxe' || this.equipment === 'spade') {
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
      this.currentAmmo = this.magazineSize;
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
      isReloading: this.isReloading,
      aimTransition: this.isAiming ? 1 : 0, // Sync aiming state
      carryingFlag: this.carryingFlag,
    };
  }
}
