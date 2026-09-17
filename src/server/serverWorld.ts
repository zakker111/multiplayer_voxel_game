import {
  WORLD_SIZE,
  CHUNK_SIZE,
  GROUND_LEVEL,
  MAX_BUILD_UP,
  MAX_DIG_DOWN,
  VOXEL_AIR,
  VOXEL_DIRT,
  VOXEL_STONE,
  VOXEL_GRASS,
  VOXEL_BUILT,
  Position,
  VoxelChange,
} from '../shared/types';

interface VoxelData {
  type: number;
  durability: number;
}

interface Chunk {
  voxels: Map<string, VoxelData>;
  dirty: boolean;
}

export class ServerWorld {
  private chunks: Map<string, Chunk> = new Map();
  private modifiedVoxels: Map<string, VoxelChange> = new Map();
  private isGeneratingTerrain: boolean = false;
  public serverTime: number = 0;

  constructor() {
    this.isGeneratingTerrain = true;
    this.generateTerrain();
    this.isGeneratingTerrain = false;
    console.log('Server world initialized');
  }

  updateTime(dt: number): void {
    this.serverTime += dt;
  }

  private getChunkKey(chunkX: number, chunkZ: number): string {
    return `${chunkX},${chunkZ}`;
  }

  private getVoxelKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private getChunkCoords(x: number, z: number): { chunkX: number; chunkZ: number } {
    return {
      chunkX: Math.floor(x / CHUNK_SIZE),
      chunkZ: Math.floor(z / CHUNK_SIZE),
    };
  }

  private getOrCreateChunk(chunkX: number, chunkZ: number): Chunk {
    const key = this.getChunkKey(chunkX, chunkZ);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = { voxels: new Map(), dirty: true };
      this.chunks.set(key, chunk);
    }
    return chunk;
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
          
          this.setVoxel(x, y, z, type, 3);
        }
      }
    }
    
    console.log('Terrain generated');
  }

  getVoxel(x: number, y: number, z: number): VoxelData | null {
    const { chunkX, chunkZ } = this.getChunkCoords(x, z);
    const chunk = this.chunks.get(this.getChunkKey(chunkX, chunkZ));
    if (!chunk) return null;
    
    return chunk.voxels.get(this.getVoxelKey(x, y, z)) || null;
  }

  setVoxel(x: number, y: number, z: number, type: number, durability: number = 3): void {
    const { chunkX, chunkZ } = this.getChunkCoords(x, z);
    const chunk = this.getOrCreateChunk(chunkX, chunkZ);
    
    if (type === VOXEL_AIR) {
      chunk.voxels.delete(this.getVoxelKey(x, y, z));
    } else {
      chunk.voxels.set(this.getVoxelKey(x, y, z), { type, durability });
    }
    
    chunk.dirty = true;
    
    // Track persistent voxel modifications for late-joining players
    if (!this.isGeneratingTerrain) {
      this.modifiedVoxels.set(this.getVoxelKey(x, y, z), { x, y, z, type, durability });
    }

    // Mark neighboring chunks dirty if on edge
    const localX = x - chunkX * CHUNK_SIZE;
    const localZ = z - chunkZ * CHUNK_SIZE;
    
    if (localX === 0) this.markChunkDirty(chunkX - 1, chunkZ);
    if (localX === CHUNK_SIZE - 1) this.markChunkDirty(chunkX + 1, chunkZ);
    if (localZ === 0) this.markChunkDirty(chunkX, chunkZ - 1);
    if (localZ === CHUNK_SIZE - 1) this.markChunkDirty(chunkX, chunkZ + 1);
  }

  getModifiedVoxels(): VoxelChange[] {
    return Array.from(this.modifiedVoxels.values());
  }

  private markChunkDirty(chunkX: number, chunkZ: number): void {
    const chunk = this.chunks.get(this.getChunkKey(chunkX, chunkZ));
    if (chunk) {
      chunk.dirty = true;
    }
  }

  isSolid(x: number, y: number, z: number): boolean {
    const voxel = this.getVoxel(x, y, z);
    return voxel !== null && voxel.type !== VOXEL_AIR;
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

  canDig(x: number, y: number, z: number): boolean {
    return y >= GROUND_LEVEL - MAX_DIG_DOWN;
  }

  canBuild(x: number, y: number, z: number): boolean {
    return y <= GROUND_LEVEL + MAX_BUILD_UP && !this.isSolid(x, y, z);
  }

  damageVoxel(x: number, y: number, z: number, damage: number): boolean {
    const voxel = this.getVoxel(x, y, z);
    if (!voxel) return false;
    
    voxel.durability -= damage;
    
    if (voxel.durability <= 0) {
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

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    let voxelX = Math.floor(origin.x);
    let voxelY = Math.floor(origin.y);
    let voxelZ = Math.floor(origin.z);

    const tDeltaX = Math.abs(1 / dx);
    const tDeltaY = Math.abs(1 / dy);
    const tDeltaZ = Math.abs(1 / dz);

    let tMaxX = dx > 0 ? (voxelX + 1 - origin.x) * tDeltaX : (origin.x - voxelX) * tDeltaX;
    let tMaxY = dy > 0 ? (voxelY + 1 - origin.y) * tDeltaY : (origin.y - voxelY) * tDeltaY;
    let tMaxZ = dz > 0 ? (voxelZ + 1 - origin.z) * tDeltaZ : (origin.z - voxelZ) * tDeltaZ;

    let distance = 0;

    for (let i = 0; i < maxDist * 3; i++) {
      if (this.isSolid(voxelX, voxelY, voxelZ)) {
        return {
          voxelPos: { x: voxelX, y: voxelY, z: voxelZ },
          distance,
        };
      }

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
      const voxel = this.getVoxel(nx, ny, nz);
      if (!voxel || voxel.type === VOXEL_AIR) continue;
      
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
        
        const voxel = this.getVoxel(nx, ny, nz);
        if (!voxel || voxel.type === VOXEL_AIR) continue;
        
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
        
        const voxel = this.getVoxel(nx, ny, nz);
        if (!voxel || voxel.type === VOXEL_AIR) continue;
        
        checked.add(nkey);
        queue.push({x: nx, y: ny, z: nz});
      }
    }
  }

  getDirtyChunks(): { chunkX: number; chunkZ: number; voxels: VoxelChange[] }[] {
    const dirtyChunks: { chunkX: number; chunkZ: number; voxels: VoxelChange[] }[] = [];

    for (const [key, chunk] of this.chunks) {
      if (chunk.dirty) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const voxels: VoxelChange[] = [];

        for (const [voxelKey, voxel] of chunk.voxels) {
          const [x, y, z] = voxelKey.split(',').map(Number);
          voxels.push({
            x,
            y,
            z,
            type: voxel.type,
            durability: voxel.durability,
          });
        }

        dirtyChunks.push({ chunkX, chunkZ, voxels });
        chunk.dirty = false;
      }
    }

    return dirtyChunks;
  }
}
