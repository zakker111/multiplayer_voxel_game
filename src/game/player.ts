import * as THREE from 'three';
import { VoxelWorld } from './world';
import { BLUE_SPAWN_Z_MIN, BLUE_SPAWN_Z_MAX, RED_SPAWN_Z_MIN, RED_SPAWN_Z_MAX, SPAWN_X_RANGE } from '../shared/types';

export class Player {
  camera: THREE.PerspectiveCamera;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number = 0;
  pitch: number = 0;
  hp: number = 100;
  maxHp: number = 100;
  isDead: boolean = false;
  isGrounded: boolean = false;
  isSprinting: boolean = false;
  isCrouching: boolean = false;
  height: number = 1.7;
  crouchHeight: number = 1.2;
  radius: number = 0.3;
  speed: number = 5;
  sprintMultiplier: number = 1.6;
  crouchMultiplier: number = 0.3; // Slower crouching
  jumpForce: number = 8;
  gravity: number = 20;
  sensitivity: number = 0.002;
  respawnTimer: number = 0;
  targetInfo: string = '';
  team: 'red' | 'blue' = 'blue';
  onRespawn?: () => void;
  
  // CTF flag system
  carryingFlag: boolean = false;
  flagMesh: THREE.Group | null = null;

  // Smooth gameplay features
  headBobTime: number = 0;
  headBobIntensity: number = 0;
  weaponSwayX: number = 0;
  weaponSwayY: number = 0;
  cameraShake: number = 0;
  landingImpact: number = 0;
  isAiming: boolean = false;
  private lastVelocityY: number = 0;

  private keys: Set<string> = new Set();
  private crouchKeyPressed: boolean = false;
  private world: VoxelWorld;

  constructor(world: VoxelWorld) {
    this.world = world;
    const groundY = world.getGroundHeight(0, 0);
    this.position = new THREE.Vector3(0, groundY, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 700);
    this.updateCamera();
  }

  get currentHeight(): number {
    return this.isCrouching ? this.crouchHeight : this.height;
  }

  getForward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  getRight(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
  }

  getAimDirection(): THREE.Vector3 {
    // Use camera's actual forward direction for perfect crosshair alignment
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyQuaternion(this.camera.quaternion);
    return dir.normalize();
  }

  handleKeyDown(code: string): void {
    this.keys.add(code.toLowerCase());
    if (code === 'Space') this.jump();
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.isSprinting = true;
    if ((code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') && !this.crouchKeyPressed) {
      this.crouchKeyPressed = true;
      this.isCrouching = !this.isCrouching;
    }
  }

  handleKeyUp(code: string): void {
    this.keys.delete(code.toLowerCase());
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.isSprinting = false;
    if (code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') {
      this.crouchKeyPressed = false;
    }
  }

  hasKey(code: string): boolean {
    return this.keys.has(code.toLowerCase());
  }

  clearKeys(): void {
    this.keys.clear();
    this.isSprinting = false;
    this.crouchKeyPressed = false;
  }

  handleMouseMove(dx: number, dy: number): void {
    if (this.isDead) return;
    // Scale sensitivity dynamically during ADS zoom for steady long-range precision
    const sensMultiplier = this.isAiming ? (this.camera.fov / 75) * 0.75 : 1.0;
    const effectiveSens = this.sensitivity * sensMultiplier;
    this.yaw -= dx * effectiveSens;
    this.pitch -= dy * effectiveSens;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    
    // Add weapon sway based on mouse movement (reduced during ADS)
    this.addWeaponSway(dx * (this.isAiming ? 0.3 : 1.0), dy * (this.isAiming ? 0.3 : 1.0));
  }

  jump(): void {
    if (this.isDead) return;
    if (this.isGrounded) {
      this.velocity.y = this.jumpForce;
      this.isGrounded = false;
    }
  }

  takeDamage(amount: number): void {
    if (this.isDead) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die();
    }
  }

  die(): void {
    this.isDead = true;
    this.respawnTimer = 4;
  }

  respawn(team: 'red' | 'blue' = 'blue', customPos?: THREE.Vector3): void {
    this.isDead = false;
    this.hp = this.maxHp;
    
    if (customPos) {
      this.position.copy(customPos);
    } else {
      // Spawn in team spawn zone far behind base flag
      const zMin = team === 'blue' ? BLUE_SPAWN_Z_MIN : RED_SPAWN_Z_MIN;
      const zMax = team === 'blue' ? BLUE_SPAWN_Z_MAX : RED_SPAWN_Z_MAX;
      let spawnX = 0;
      let spawnZ = (zMin + zMax) / 2;
      let groundY = this.world.getGroundHeight(spawnX, spawnZ);

      for (let attempt = 0; attempt < 20; attempt++) {
        const testX = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
        const testZ = zMin + Math.random() * (zMax - zMin);
        const testY = this.world.getGroundHeight(testX, testZ);
        // Verify head space is completely clear of solid voxels
        const vx = Math.round(testX);
        const vz = Math.round(testZ);
        if (!this.world.isSolid(vx, Math.round(testY + 0.8), vz) && !this.world.isSolid(vx, Math.round(testY + 1.6), vz)) {
          spawnX = testX;
          spawnZ = testZ;
          groundY = testY;
          break;
        }
      }
      this.position.set(spawnX, groundY, spawnZ);
    }
    this.velocity.set(0, 0, 0);
    
    // Face toward enemy team (Blue at -Z faces +Z; Red at +Z faces -Z)
    this.yaw = team === 'blue' ? Math.PI : 0;
    this.pitch = 0;
    
    // Note: Ammo reset is handled by the game class after calling respawn
  }

  private isPointInSolid(x: number, y: number, z: number): boolean {
    // Voxels are centered at integer coordinates
    const vx = Math.round(x);
    const vy = Math.round(y);
    const vz = Math.round(z);
    return this.world.isSolid(vx, vy, vz);
  }

  private checkCollisionAt(pos: THREE.Vector3): boolean {
    const r = this.radius;
    const h = this.currentHeight;

    // Check at ankles (above floor), middle, and head level
    const yChecks = [
      pos.y + 0.15,          // Above ground surface contact point
      pos.y + h * 0.5,       // Middle
      pos.y + h - 0.1,       // Just below head
    ];

    for (const cy of yChecks) {
      // Check 9 points: center + 8 around the radius
      const points = [
        [pos.x, pos.z],                    // Center
        [pos.x - r, pos.z],                // Left
        [pos.x + r, pos.z],                // Right
        [pos.x, pos.z - r],                // Front
        [pos.x, pos.z + r],                // Back
        [pos.x - r * 0.7, pos.z - r * 0.7], // Diagonal corners
        [pos.x + r * 0.7, pos.z - r * 0.7],
        [pos.x - r * 0.7, pos.z + r * 0.7],
        [pos.x + r * 0.7, pos.z + r * 0.7],
      ];
      for (const [cx, cz] of points) {
        if (this.isPointInSolid(cx, cy, cz)) return true;
      }
    }
    return false;
  }

  // Check if player can step up over a 1-voxel obstacle
  private canStepUp(currentPos: THREE.Vector3, newPos: THREE.Vector3): boolean {
    const stepHeight = 1.0; // Can step up 1 voxel
    const testPos = newPos.clone();
    testPos.y = currentPos.y + stepHeight;
    
    // Check if there's space above the obstacle
    if (!this.checkCollisionAt(testPos)) {
      return true;
    }
    return false;
  }

  // Check if player is standing on ground (feet touching solid)
  private isOnGround(pos: THREE.Vector3): boolean {
    const r = this.radius * 0.8;
    // Check just below feet
    const belowY = pos.y - 0.08;
    
    const points = [
      [pos.x, pos.z],
      [pos.x - r, pos.z],
      [pos.x + r, pos.z],
      [pos.x, pos.z - r],
      [pos.x, pos.z + r],
    ];
    
    for (const [cx, cz] of points) {
      if (this.isPointInSolid(cx, belowY, cz)) return true;
    }
    return false;
  }

  // Push player out of solid voxels if stuck
  private pushOutOfSolids(pos: THREE.Vector3): THREE.Vector3 {
    const result = pos.clone();
    const r = this.radius;
    const h = this.currentHeight;

    // Check if player is currently inside a solid
    if (!this.checkCollisionAt(result)) {
      return result; // Not stuck, return as-is
    }

    // Try to push player out in each direction
    const pushDistance = 0.1;
    const directions = [
      [pushDistance, 0, 0],
      [-pushDistance, 0, 0],
      [0, 0, pushDistance],
      [0, 0, -pushDistance],
      [0, pushDistance, 0],
    ];

    for (const [dx, dy, dz] of directions) {
      const testPos = result.clone();
      testPos.x += dx;
      testPos.y += dy;
      testPos.z += dz;
      
      if (!this.checkCollisionAt(testPos)) {
        return testPos; // Found a non-colliding position
      }
    }

    // If still stuck, move up until free
    for (let i = 0; i < 10; i++) {
      result.y += 0.5;
      if (!this.checkCollisionAt(result)) {
        return result;
      }
    }

    return result;
  }

  private findGroundBelow(x: number, z: number): number {
    return this.world.getGroundHeight(x, z);
  }

  update(dt: number): void {
    if (this.isDead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        if (this.onRespawn) {
          this.onRespawn();
        } else {
          this.respawn(this.team);
        }
      }
      this.updateCamera();
      return;
    }

    // First, check if player is stuck and push them out
    if (this.checkCollisionAt(this.position)) {
      const pushedPos = this.pushOutOfSolids(this.position);
      this.position.copy(pushedPos);
    }

    // Arrow keys for camera rotation (accessibility & preview without pointer lock)
    const turnRate = (this.isAiming ? 1.3 : 2.2) * dt;
    if (this.keys.has('arrowleft')) this.yaw += turnRate;
    if (this.keys.has('arrowright')) this.yaw -= turnRate;
    if (this.keys.has('arrowup')) {
      this.pitch += turnRate * 0.75;
      this.pitch = Math.min(Math.PI / 2 - 0.01, this.pitch);
    }
    if (this.keys.has('arrowdown')) {
      this.pitch -= turnRate * 0.75;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, this.pitch);
    }

    const moveDir = new THREE.Vector3(0, 0, 0);
    const forward = this.getForward();
    const right = this.getRight();

    if (this.keys.has('keyw')) moveDir.add(forward);
    if (this.keys.has('keys')) moveDir.sub(forward);
    if (this.keys.has('keya')) moveDir.sub(right);
    if (this.keys.has('keyd')) moveDir.add(right);

    if (moveDir.length() > 0) moveDir.normalize();

    let speed = this.speed;
    if (this.isSprinting && !this.isCrouching) speed *= this.sprintMultiplier;
    if (this.isCrouching) speed *= this.crouchMultiplier;

    // Smooth acceleration for better movement feel
    const targetVelX = moveDir.x * speed;
    const targetVelZ = moveDir.z * speed;
    const acceleration = this.isGrounded ? 15 : 8; // Faster acceleration on ground
    
    this.velocity.x += (targetVelX - this.velocity.x) * Math.min(acceleration * dt, 1);
    this.velocity.z += (targetVelZ - this.velocity.z) * Math.min(acceleration * dt, 1);

    // Check if on ground BEFORE applying gravity
    this.isGrounded = this.isOnGround(this.position);

    // Only apply gravity if not grounded AND not jumping up
    if (!this.isGrounded) {
      this.velocity.y -= this.gravity * dt;
      if (this.velocity.y < -30) this.velocity.y = -30;
    } else if (this.velocity.y <= 0) {
      // Reset vertical velocity when on ground AND not jumping
      this.velocity.y = 0;
    }

    const newPos = this.position.clone();

    // Move X axis with collision detection and step-up
    newPos.x += this.velocity.x * dt;
    if (this.checkCollisionAt(newPos)) {
      // Try to step up over 1-voxel obstacle
      if (this.isGrounded && this.canStepUp(this.position, newPos)) {
        newPos.y = this.position.y + 1.0;
      } else {
        newPos.x = this.position.x;
        this.velocity.x = 0;
      }
    }

    // Move Z axis with collision detection and step-up
    newPos.z += this.velocity.z * dt;
    if (this.checkCollisionAt(newPos)) {
      // Try to step up over 1-voxel obstacle
      if (this.isGrounded && this.canStepUp(this.position, newPos)) {
        newPos.y = this.position.y + 1.0;
      } else {
        newPos.z = this.position.z;
        this.velocity.z = 0;
      }
    }

    // Move Y axis with collision detection
    newPos.y += this.velocity.y * dt;
    if (this.checkCollisionAt(newPos)) {
      if (this.velocity.y < 0) {
        // Falling and hit something - snap to ground
        this.isGrounded = true;
        const groundY = this.findGroundBelow(newPos.x, newPos.z);
        newPos.y = groundY;
      } else {
        // Hit ceiling
        newPos.y = this.position.y;
      }
      this.velocity.y = 0;
    }

    // Safety: if player falls into void, eliminate them so they respawn properly at base
    if (newPos.y < -8 || Math.abs(newPos.x) > 124 || Math.abs(newPos.z) > 124) {
      this.hp = 0;
      this.die();
      return;
    }

    // Final check: if still colliding, push out again
    if (this.checkCollisionAt(newPos)) {
      const pushedPos = this.pushOutOfSolids(newPos);
      newPos.copy(pushedPos);
    }

    // Detect landing impact
    if (this.isGrounded && this.lastVelocityY < -5) {
      this.landingImpact = Math.min(Math.abs(this.lastVelocityY) * 0.02, 0.15);
    }
    this.lastVelocityY = this.velocity.y;

    this.position.copy(newPos);
    this.updateCamera(dt);
  }

  updateCamera(dt: number = 0.016): void {
    // Calculate head bobbing
    const horizontalSpeed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    if (this.isGrounded && horizontalSpeed > 0.5) {
      const bobSpeed = this.isSprinting ? 12 : 8;
      const bobAmount = this.isSprinting ? 0.06 : 0.04;
      this.headBobTime += dt * bobSpeed;
      this.headBobIntensity = Math.sin(this.headBobTime) * bobAmount;
    } else {
      this.headBobIntensity *= 0.9; // Smooth fade out
    }

    // Calculate weapon sway based on mouse movement
    const swayDecay = 0.85;
    this.weaponSwayX *= swayDecay;
    this.weaponSwayY *= swayDecay;

    // Apply landing impact decay
    this.landingImpact *= 0.9;

    // Apply camera shake decay
    this.cameraShake *= 0.9;

    this.camera.position.copy(this.position);
    this.camera.position.y += this.currentHeight * 0.85;
    
    // Apply head bobbing
    this.camera.position.y += this.headBobIntensity;
    
    // Apply landing impact (camera dip)
    this.camera.position.y -= this.landingImpact;
    
    // Apply camera shake
    if (this.cameraShake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.cameraShake;
      this.camera.position.y += (Math.random() - 0.5) * this.cameraShake;
    }
    
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  addWeaponSway(dx: number, dy: number): void {
    this.weaponSwayX += dx * 0.001;
    this.weaponSwayY += dy * 0.001;
    // Clamp sway
    this.weaponSwayX = Math.max(-0.05, Math.min(0.05, this.weaponSwayX));
    this.weaponSwayY = Math.max(-0.05, Math.min(0.05, this.weaponSwayY));
  }

  addCameraShake(intensity: number): void {
    this.cameraShake = Math.max(this.cameraShake, intensity);
  }

  getEyePosition(): THREE.Vector3 {
    return new THREE.Vector3(
      this.position.x,
      this.position.y + this.currentHeight * 0.85,
      this.position.z
    );
  }
}
