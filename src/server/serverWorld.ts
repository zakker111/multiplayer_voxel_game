import {
  WORLD_SIZE,
  WORLD_HALF,
  GROUND_LEVEL,
  MAX_BUILD_UP,
  MAX_DIG_DOWN,
  VOXEL_AIR,
  VOXEL_DIRT,
  VOXEL_STONE,
  VOXEL_GRASS,
  VOXEL_BUILT,
  VOXEL_MAX_DURABILITY,
  VOXEL_DURABILITY_EPSILON,
  Position,
  VoxelChange,
  isWorkshopProtectedCell,
  WORKSHOP_CENTERS,
} from '../shared/types';

interface VoxelData {
  type: number;
  durability: number;
}

/** Vertical window the server stores. Terrain spans 0..GROUND_LEVEL, building is
 *  capped at GROUND_LEVEL + MAX_BUILD_UP and digging at GROUND_LEVEL -
 *  MAX_DIG_DOWN, so this window covers every legal cell with margin to spare
 *  while the array stays one byte per cell. */
const WORLD_MIN_Y = GROUND_LEVEL - MAX_DIG_DOWN - 8;
const WORLD_MAX_Y = GROUND_LEVEL + MAX_BUILD_UP + 8;
const WORLD_LAYERS = WORLD_MAX_Y - WORLD_MIN_Y + 1;

export class ServerWorld {
  /** Block type per cell, 0 = air. One flat array instead of a Map entry per
   *  solid voxel: the old chunk maps cost ~115 bytes per voxel (2.2M of them,
   *  ~244 MB of heap), this is one byte per cell (~15 MB) and faster to read. */
  private readonly types = new Uint8Array(WORLD_SIZE * WORLD_SIZE * WORLD_LAYERS);
  /** Live voxel records for cells that have been written (built, mined or
   *  damaged), keyed by cell index. Untouched terrain lives in `types` alone at
   *  VOXEL_MAX_DURABILITY, so this holds thousands of entries, not 2.2M — and
   *  because these are the same objects `getVoxel` hands out, a caller holding
   *  a block still sees later chip damage on it. */
  private readonly voxelObjects = new Map<number, VoxelData>();
  private readonly modifiedVoxels = new Map<number, VoxelChange>();
  private isGeneratingTerrain: boolean = false;
  public serverTime: number = 0;

  constructor() {
    this.isGeneratingTerrain = true;
    this.generateTerrain();
    this.levelWorkshopSites();
    this.isGeneratingTerrain = false;
    console.log('Server world initialized');
  }

  updateTime(dt: number): void {
    this.serverTime += dt;
  }

  /** Flat index into `types`, or -1 for a cell outside the stored window. */
  private indexOf(x: number, y: number, z: number): number {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return -1;
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return -1;
    const ix = x + WORLD_HALF;
    const iz = z + WORLD_HALF;
    if (ix < 0 || ix >= WORLD_SIZE || iz < 0 || iz >= WORLD_SIZE) return -1;
    return ((y - WORLD_MIN_Y) * WORLD_SIZE + iz) * WORLD_SIZE + ix;
  }

  private getVoxelKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private generateTerrain(): void {
    const half = WORLD_SIZE / 2;

    for (let x = -half; x < half; x++) {
      for (let z = -half; z < half; z++) {
        const height = GROUND_LEVEL + Math.floor(Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2);

        for (let y = 0; y <= height; y++) {
          let type = VOXEL_DIRT;
          if (y === height) type = VOXEL_GRASS;
          else if (y < height - 2) type = VOXEL_STONE;

          this.setVoxel(x, y, z, type, VOXEL_MAX_DURABILITY);
        }
      }
    }

    console.log('Terrain generated');
  }

  /** A flat, immutable floor for the workshop and its future vehicle pad.
   *  Record changes so clients with the original procedural terrain receive it. */
  private levelWorkshopSites(): void {
    for (const center of Object.values(WORKSHOP_CENTERS)) {
      for (let x = center.x - 5; x <= center.x + 17; x++) {
        for (let z = center.z - 7; z <= center.z + 7; z++) {
          for (let y = GROUND_LEVEL - 1; y <= GROUND_LEVEL + 2; y++) {
            const desired = y < GROUND_LEVEL ? VOXEL_DIRT : y === GROUND_LEVEL ? VOXEL_GRASS : VOXEL_AIR;
            const existing = this.getVoxel(x, y, z);
            if ((existing?.type ?? VOXEL_AIR) === desired) continue;
            const durability = desired === VOXEL_AIR ? 0 : VOXEL_MAX_DURABILITY;
            this.setVoxel(x, y, z, desired, durability);
            const index = this.indexOf(x, y, z);
            if (index >= 0) this.modifiedVoxels.set(index, { x, y, z, type: desired, durability });
          }
        }
      }
    }
  }

  getVoxel(x: number, y: number, z: number): VoxelData | null {
    const index = this.indexOf(x, y, z);
    if (index < 0) return null;
    const type = this.types[index];
    if (type === VOXEL_AIR) return null;
    // A written cell returns its live record; untouched terrain is a snapshot at
    // full durability (nothing can chip it without first creating a record).
    return this.voxelObjects.get(index) ?? { type, durability: VOXEL_MAX_DURABILITY };
  }

  setVoxel(x: number, y: number, z: number, type: number, durability: number = VOXEL_MAX_DURABILITY): void {
    if (!this.isGeneratingTerrain && isWorkshopProtectedCell(x, z)) return;
    const index = this.indexOf(x, y, z);
    if (index < 0) return;

    this.types[index] = type;
    // Terrain and workshop leveling run before anyone can hold a voxel handle,
    // so they only fill the type array; allocating a record per terrain cell
    // would put the 2.2M objects straight back.
    if (type === VOXEL_AIR || this.isGeneratingTerrain) this.voxelObjects.delete(index);
    else this.voxelObjects.set(index, { type, durability });

    // Track persistent voxel modifications for late-joining players.
    if (!this.isGeneratingTerrain) {
      this.modifiedVoxels.set(index, { x, y, z, type, durability });
    }
  }

  getModifiedVoxels(): VoxelChange[] {
    return Array.from(this.modifiedVoxels.values());
  }

  isSolid(x: number, y: number, z: number): boolean {
    // Read the type array directly: this is the hottest query in the game
    // (ground snapshots, raycasts, bot line-of-sight) and must not allocate.
    const index = this.indexOf(x, y, z);
    return index >= 0 && this.types[index] !== VOXEL_AIR;
  }

  getGroundHeight(x: number, z: number): number {
    const ix = Math.round(x);
    const iz = Math.round(z);

    // Search from high above down to find the topmost solid block
    for (let y = GROUND_LEVEL + MAX_BUILD_UP + 10; y >= 0; y--) {
      if (this.isSolid(ix, y, iz)) {
        return y + 1; // Return position ON TOP of the solid block
      }
    }

    // Fallback to base ground level if nothing found
    return GROUND_LEVEL;
  }

  // Returns ground level at or directly beneath currentY, preventing entities from snapping to overhead structures
  getGroundHeightBelow(x: number, currentY: number, z: number): number {
    const ix = Math.round(x);
    const iz = Math.round(z);
    const startY = Math.min(GROUND_LEVEL + MAX_BUILD_UP + 10, Math.max(0, Math.floor(currentY + 1.25)));
    for (let y = startY; y >= 0; y--) {
      if (this.isSolid(ix, y, iz)) {
        return y + 1;
      }
    }
    return GROUND_LEVEL;
  }

  canDig(_x: number, y: number, _z: number): boolean {
    return y >= GROUND_LEVEL - MAX_DIG_DOWN;
  }

  canBuild(x: number, y: number, z: number): boolean {
    if (isWorkshopProtectedCell(x, z)) return false;
    // Height limit
    if (y > GROUND_LEVEL + MAX_BUILD_UP) return false;

    // Position must be empty
    if (this.isSolid(x, y, z)) return false;

    // A block must attach to something: adjacent solid voxel, or at/below
    // terrain height (which includes digging into ground). Without this,
    // mid-air placement passed validation on the server but failed the
    // client's support flood-fill, causing builds to silently desync/fail.
    const hasAdjacentSolid =
      this.isSolid(x + 1, y, z) ||
      this.isSolid(x - 1, y, z) ||
      this.isSolid(x, y + 1, z) ||
      this.isSolid(x, y - 1, z) ||
      this.isSolid(x, y, z + 1) ||
      this.isSolid(x, y, z - 1);

    const columnTop = this.getGroundHeight(x, z) - 1; // topmost solid cell in column
    const restingOnGround = y <= columnTop;

    if (!hasAdjacentSolid && !restingOnGround) return false;

    // Structural support: connectivity to ground within 12 blocks. The
    // flood-fill must start from the *filled* cell, so temporarily mark it
    // solid before checking (same logic as the client's VoxelWorld.canBuild).
    // Write straight into the type array so this probe is NOT recorded in
    // modifiedVoxels (late joiners must not receive phantom add+delete pairs).
    if (y > GROUND_LEVEL) {
      const index = this.indexOf(x, y, z);
      if (index >= 0) {
        const previous = this.types[index];
        this.types[index] = VOXEL_BUILT;
        const supported = this.hasSupport(x, y, z, 12);
        this.types[index] = previous;
        if (!supported) return false;
      }
    }

    return true;
  }

  damageVoxel(x: number, y: number, z: number, damage: number): boolean {
    if (isWorkshopProtectedCell(x, z)) return false;
    const index = this.indexOf(x, y, z);
    if (index < 0 || this.types[index] === VOXEL_AIR) return false;

    let voxel = this.voxelObjects.get(index);
    if (!voxel) {
      voxel = { type: this.types[index], durability: VOXEL_MAX_DURABILITY };
      this.voxelObjects.set(index, voxel);
    }
    voxel.durability -= damage;

    if (voxel.durability <= VOXEL_DURABILITY_EPSILON) {
      this.setVoxel(x, y, z, VOXEL_AIR, 0);
      return true;
    }

    return false;
  }

  raycast(origin: Position, direction: Position, maxDist: number): { voxelPos: Position; distance: number } | null {
    const EPSILON = 1e-8;
    const dx = Math.abs(direction.x) < EPSILON ? (direction.x >= 0 ? EPSILON : -EPSILON) : direction.x;
    const dy = Math.abs(direction.y) < EPSILON ? (direction.y >= 0 ? EPSILON : -EPSILON) : direction.y;
    const dz = Math.abs(direction.z) < EPSILON ? (direction.z >= 0 ? EPSILON : -EPSILON) : direction.z;

    // Shift origin by +0.5 to align centered voxels [-0.5, +0.5] with integer grid boundaries [0, 1]
    const sx = origin.x + 0.5;
    const sy = origin.y + 0.5;
    const sz = origin.z + 0.5;

    let voxelX = Math.floor(sx);
    let voxelY = Math.floor(sy);
    let voxelZ = Math.floor(sz);

    if (this.isSolid(voxelX, voxelY, voxelZ)) {
      return {
        voxelPos: { x: voxelX, y: voxelY, z: voxelZ },
        distance: 0,
      };
    }

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    const tDeltaX = Math.abs(1 / dx);
    const tDeltaY = Math.abs(1 / dy);
    const tDeltaZ = Math.abs(1 / dz);

    let tMaxX = dx > 0 ? (voxelX + 1 - sx) * tDeltaX : (sx - voxelX) * tDeltaX;
    let tMaxY = dy > 0 ? (voxelY + 1 - sy) * tDeltaY : (sy - voxelY) * tDeltaY;
    let tMaxZ = dz > 0 ? (voxelZ + 1 - sz) * tDeltaZ : (sz - voxelZ) * tDeltaZ;

    let distance = 0;

    for (let i = 0; i < maxDist * 3; i++) {
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          voxelX += stepX;
          distance = tMaxX;
          tMaxX += tDeltaX;
        } else {
          voxelZ += stepZ;
          distance = tMaxZ;
          tMaxZ += tDeltaZ;
        }
      } else {
        if (tMaxY < tMaxZ) {
          voxelY += stepY;
          distance = tMaxY;
          tMaxY += tDeltaY;
        } else {
          voxelZ += stepZ;
          distance = tMaxZ;
          tMaxZ += tDeltaZ;
        }
      }

      if (distance > maxDist) break;

      if (this.isSolid(voxelX, voxelY, voxelZ)) {
        return {
          voxelPos: { x: voxelX, y: voxelY, z: voxelZ },
          distance,
        };
      }
    }

    return null;
  }

  collapseDisconnected(destroyedX?: number, destroyedY?: number, destroyedZ?: number): VoxelChange[] {
    if (destroyedX === undefined || destroyedY === undefined || destroyedZ === undefined) {
      return [];
    }

    const toCollapse: string[] = [];
    const checked = new Set<string>();

    // Check all 6 neighbors of the destroyed voxel
    const neighbors = [
      [destroyedX + 1, destroyedY, destroyedZ],
      [destroyedX - 1, destroyedY, destroyedZ],
      [destroyedX, destroyedY + 1, destroyedZ],
      [destroyedX, destroyedY - 1, destroyedZ],
      [destroyedX, destroyedY, destroyedZ + 1],
      [destroyedX, destroyedY, destroyedZ - 1],
    ];

    for (const [nx, ny, nz] of neighbors) {
      if (!this.isSolid(nx, ny, nz) || isWorkshopProtectedCell(nx, nz)) continue;

      const key = this.getVoxelKey(nx, ny, nz);
      if (checked.has(key)) continue;

      // Check if this voxel has support (path to ground within 12 blocks)
      if (!this.hasSupport(nx, ny, nz, 12)) {
        this.findUnsupportedChain(nx, ny, nz, toCollapse, checked);
      }
    }

    const changes: VoxelChange[] = [];
    for (const key of toCollapse) {
      const parts = key.split(',');
      const x = parseInt(parts[0]);
      const y = parseInt(parts[1]);
      const z = parseInt(parts[2]);

      if (isWorkshopProtectedCell(x, z)) continue;
      this.setVoxel(x, y, z, VOXEL_AIR, 0);
      changes.push({ x, y, z, type: VOXEL_AIR, durability: 0 });
    }

    return changes;
  }

  private hasSupport(x: number, y: number, z: number, maxDistance: number): boolean {
    const visited = new Set<string>();
    const queue: Array<{x: number, y: number, z: number, dist: number}> = [];

    queue.push({x, y, z, dist: 0});
    visited.add(this.getVoxelKey(x, y, z));

    let queueHead = 0;
    while (queueHead < queue.length) {
      const current = queue[queueHead++];

      if (current.y <= GROUND_LEVEL) {
        return true;
      }

      if (current.dist >= maxDistance) {
        continue;
      }

      const neighbors = [
        [current.x + 1, current.y, current.z],
        [current.x - 1, current.y, current.z],
        [current.x, current.y + 1, current.z],
        [current.x, current.y - 1, current.z],
        [current.x, current.y, current.z + 1],
        [current.x, current.y, current.z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        const nkey = this.getVoxelKey(nx, ny, nz);
        if (visited.has(nkey)) continue;
        if (!this.isSolid(nx, ny, nz)) continue;

        visited.add(nkey);
        queue.push({x: nx, y: ny, z: nz, dist: current.dist + 1});
      }
    }

    return false;
  }

  private findUnsupportedChain(x: number, y: number, z: number, toCollapse: string[], checked: Set<string>): void {
    const queue: Array<{x: number, y: number, z: number}> = [];
    queue.push({x, y, z});
    checked.add(this.getVoxelKey(x, y, z));

    let queueHead = 0;
    while (queueHead < queue.length) {
      const current = queue[queueHead++];
      toCollapse.push(this.getVoxelKey(current.x, current.y, current.z));

      const neighbors = [
        [current.x + 1, current.y, current.z],
        [current.x - 1, current.y, current.z],
        [current.x, current.y + 1, current.z],
        [current.x, current.y - 1, current.z],
        [current.x, current.y, current.z + 1],
        [current.x, current.y, current.z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        const nkey = this.getVoxelKey(nx, ny, nz);
        if (checked.has(nkey)) continue;
        if (!this.isSolid(nx, ny, nz) || isWorkshopProtectedCell(nx, nz)) continue;

        checked.add(nkey);
        queue.push({x: nx, y: ny, z: nz});
      }
    }
  }
}
