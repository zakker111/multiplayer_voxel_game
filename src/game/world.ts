import * as THREE from 'three';

export const VOXEL_AIR = 0;
export const VOXEL_DIRT = 1;
export const VOXEL_STONE = 2;
export const VOXEL_GRASS = 3;
export const VOXEL_BUILT = 4;

export const WORLD_SIZE = 250;
export const GROUND_LEVEL = 8;
export const MAX_BUILD_UP = 20;
export const MAX_DIG_DOWN = 20;
export const VOXEL_SIZE = 1;
export const CHUNK_SIZE = 16;

export interface VoxelData {
  type: number;
  durability: number;
}

interface Chunk {
  voxels: Map<string, VoxelData>; // Local voxel storage for this chunk
  mesh: THREE.InstancedMesh | null;
  dirty: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  voxelIndices: Map<string, number>; // Fast lookup: voxel key -> instance index
}

export class VoxelWorld {
  mesh: THREE.Group;
  chunks: Map<string, Chunk> = new Map();
  
  private static sharedGeometry: THREE.BoxGeometry | null = null;
  private static sharedMaterial: THREE.MeshLambertMaterial | null = null;

  constructor() {
    console.log('VoxelWorld constructor started');
    this.mesh = new THREE.Group();
    
    if (!VoxelWorld.sharedGeometry) {
      VoxelWorld.sharedGeometry = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
    }
    if (!VoxelWorld.sharedMaterial) {
      // Use white material color so instance colors show through correctly
      VoxelWorld.sharedMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    }
    
    this.initializeChunks();
    this.generateTerrain();
    console.log('Terrain generated');
    this.rebuildAllChunks();
    console.log('All chunks rebuilt');
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private getChunkKey(x: number, z: number): string {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkZ = Math.floor(z / CHUNK_SIZE);
    return `${chunkX},${chunkZ}`;
  }

  private getOrCreateChunk(x: number, z: number): Chunk {
    const key = this.getChunkKey(x, z);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const chunkX = Math.floor(x / CHUNK_SIZE);
      const chunkZ = Math.floor(z / CHUNK_SIZE);
      chunk = {
        voxels: new Map(),
        mesh: null,
        dirty: true,
        minX: chunkX * CHUNK_SIZE,
        maxX: (chunkX + 1) * CHUNK_SIZE - 1,
        minZ: chunkZ * CHUNK_SIZE,
        maxZ: (chunkZ + 1) * CHUNK_SIZE - 1,
        voxelIndices: new Map(),
      };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  private initializeChunks(): void {
    const half = WORLD_SIZE / 2;
    const minChunkX = Math.floor(-half / CHUNK_SIZE);
    const maxChunkX = Math.floor(half / CHUNK_SIZE);
    const minChunkZ = Math.floor(-half / CHUNK_SIZE);
    const maxChunkZ = Math.floor(half / CHUNK_SIZE);

    for (let cx = minChunkX; cx <= maxChunkX; cx++) {
      for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
        const key = `${cx},${cz}`;
        this.chunks.set(key, {
          voxels: new Map(),
          mesh: null,
          dirty: true,
          minX: cx * CHUNK_SIZE,
          maxX: (cx + 1) * CHUNK_SIZE - 1,
          minZ: cz * CHUNK_SIZE,
          maxZ: (cz + 1) * CHUNK_SIZE - 1,
          voxelIndices: new Map(),
        });
      }
    }
  }

  getVoxel(x: number, y: number, z: number): VoxelData | null {
    const chunk = this.chunks.get(this.getChunkKey(x, z));
    if (!chunk) return null;
    return chunk.voxels.get(this.key(x, y, z)) || null;
  }

  setVoxel(x: number, y: number, z: number, type: number, durability: number = 3): void {
    const chunk = this.getOrCreateChunk(x, z);
    const key = this.key(x, y, z);
    
    if (type === VOXEL_AIR) {
      chunk.voxels.delete(key);
    } else {
      chunk.voxels.set(key, { type, durability });
    }
    
    chunk.dirty = true;
    
    // Mark neighboring chunks dirty if on edge
    const localX = x - chunk.minX;
    const localZ = z - chunk.minZ;
    
    if (localX === 0) this.markNeighborChunkDirty(x - 1, z);
    if (localX === CHUNK_SIZE - 1) this.markNeighborChunkDirty(x + 1, z);
    if (localZ === 0) this.markNeighborChunkDirty(x, z - 1);
    if (localZ === CHUNK_SIZE - 1) this.markNeighborChunkDirty(x, z + 1);
  }

  private markNeighborChunkDirty(x: number, z: number): void {
    const chunk = this.chunks.get(this.getChunkKey(x, z));
    if (chunk) {
      chunk.dirty = true;
    }
  }

  isSolid(x: number, y: number, z: number): boolean {
    const v = this.getVoxel(x, y, z);
    return v !== null && v.type !== VOXEL_AIR;
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
  }

  getGroundHeight(x: number, z: number): number {
    const ix = Math.round(x);
    const iz = Math.round(z);
    for (let y = GROUND_LEVEL + MAX_BUILD_UP + 5; y >= 0; y--) {
      if (this.isSolid(ix, y, iz)) {
        return y + 0.5;
      }
    }
    return 0;
  }

  // Returns solid ground level directly at or below currentY, preventing entities from snapping to overhead structures or ceilings
  getGroundHeightBelow(x: number, currentY: number, z: number): number {
    const ix = Math.round(x);
    const iz = Math.round(z);
    const startY = Math.min(GROUND_LEVEL + MAX_BUILD_UP + 5, Math.max(0, Math.floor(currentY + 1.25)));
    for (let y = startY; y >= 0; y--) {
      if (this.isSolid(ix, y, iz)) {
        return y + 0.5;
      }
    }
    return 0;
  }

  getOriginalGroundLevel(): number {
    return GROUND_LEVEL + 0.5;
  }

  canDig(x: number, y: number, z: number): boolean {
    return y >= GROUND_LEVEL - MAX_DIG_DOWN;
  }

  canBuild(x: number, y: number, z: number): boolean {
    // Check if within build height limit
    if (y > GROUND_LEVEL + MAX_BUILD_UP) {
      return false;
    }

    // Check if position is already occupied
    if (this.isSolid(x, y, z)) {
      return false;
    }

    // Check if this is a "built" voxel (not natural terrain)
    // Built voxels need support within 12 blocks
    if (y > GROUND_LEVEL) {
      // Check if there's support below or within 12 blocks
      if (!this.hasSupport(x, y, z, 12)) {
        return false;
      }
    }

    return true;
  }

  damageVoxel(x: number, y: number, z: number, damage: number): { destroyed: boolean; collapsed: number; collapsedVoxels: Array<{ x: number; y: number; z: number; type: number }> } {
    const v = this.getVoxel(x, y, z);
    if (!v) return { destroyed: false, collapsed: 0, collapsedVoxels: [] };
    
    v.durability -= damage;
    
    if (v.durability <= 0) {
      this.setVoxel(x, y, z, VOXEL_AIR);
      // Pass coordinates for localized collapse detection
      const collapseResult = this.collapseDisconnected(x, y, z);
      return { destroyed: true, collapsed: collapseResult.count, collapsedVoxels: collapseResult.voxels };
    }
    
    // Fast color update without rebuild
    this.updateVoxelColor(x, y, z, v.type, v.durability);
    return { destroyed: false, collapsed: 0, collapsedVoxels: [] };
  }

  // Localized collapse check - only checks neighbors of destroyed voxel
  collapseDisconnected(destroyedX?: number, destroyedY?: number, destroyedZ?: number): { count: number; voxels: Array<{ x: number; y: number; z: number; type: number }> } {
    if (destroyedX === undefined || destroyedY === undefined || destroyedZ === undefined) {
      return { count: 0, voxels: [] };
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
      
      const key = this.key(nx, ny, nz);
      if (checked.has(key)) continue;
      
      // Check if this voxel has support (path to ground within 12 blocks)
      if (!this.hasSupport(nx, ny, nz, 12)) {
        // This voxel and all connected voxels without support should collapse
        this.findUnsupportedChain(nx, ny, nz, toCollapse, checked);
      }
    }

    // Collect voxel data before removing them
    const collapsedVoxels: Array<{ x: number; y: number; z: number; type: number }> = [];
    
    // Remove all unsupported voxels
    for (const key of toCollapse) {
      const parts = key.split(',');
      const x = parseInt(parts[0]);
      const y = parseInt(parts[1]);
      const z = parseInt(parts[2]);
      
      // Get voxel type before removing
      const voxel = this.getVoxel(x, y, z);
      if (voxel) {
        collapsedVoxels.push({ x, y, z, type: voxel.type });
      }
      
      this.setVoxel(x, y, z, VOXEL_AIR);
    }

    return { count: toCollapse.length, voxels: collapsedVoxels };
  }

  // Check if a voxel has support (path to ground within maxDistance blocks)
  private hasSupport(x: number, y: number, z: number, maxDistance: number): boolean {
    const visited = new Set<string>();
    const queue: Array<{x: number, y: number, z: number, dist: number}> = [];
    
    queue.push({x, y, z, dist: 0});
    visited.add(this.key(x, y, z));

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      // If we reached ground level, we have support
      if (current.y <= GROUND_LEVEL) {
        return true;
      }
      
      // If we exceeded max distance, no support
      if (current.dist >= maxDistance) {
        continue;
      }

      // Check all 6 neighbors
      const neighbors = [
        [current.x + 1, current.y, current.z],
        [current.x - 1, current.y, current.z],
        [current.x, current.y + 1, current.z],
        [current.x, current.y - 1, current.z],
        [current.x, current.y, current.z + 1],
        [current.x, current.y, current.z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        const nkey = this.key(nx, ny, nz);
        if (visited.has(nkey)) continue;
        
        const voxel = this.getVoxel(nx, ny, nz);
        if (!voxel || voxel.type === VOXEL_AIR) continue;
        
        visited.add(nkey);
        queue.push({x: nx, y: ny, z: nz, dist: current.dist + 1});
      }
    }

    return false;
  }

  // Find all connected voxels that don't have support
  private findUnsupportedChain(x: number, y: number, z: number, toCollapse: string[], checked: Set<string>): void {
    const queue: Array<{x: number, y: number, z: number}> = [];
    queue.push({x, y, z});
    checked.add(this.key(x, y, z));

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = this.key(current.x, current.y, current.z);
      
      // Add to collapse list
      toCollapse.push(key);

      // Check all 6 neighbors
      const neighbors = [
        [current.x + 1, current.y, current.z],
        [current.x - 1, current.y, current.z],
        [current.x, current.y + 1, current.z],
        [current.x, current.y - 1, current.z],
        [current.x, current.y, current.z + 1],
        [current.x, current.y, current.z - 1],
      ];

      for (const [nx, ny, nz] of neighbors) {
        const nkey = this.key(nx, ny, nz);
        if (checked.has(nkey)) continue;
        
        const voxel = this.getVoxel(nx, ny, nz);
        if (!voxel || voxel.type === VOXEL_AIR) continue;
        
        checked.add(nkey);
        
        // Only continue if this neighbor also doesn't have support
        if (!this.hasSupport(nx, ny, nz, 12)) {
          queue.push({x: nx, y: ny, z: nz});
        }
      }
    }
  }

  private getBaseColor(type: number): number {
    const colors: Record<number, number> = {
      [VOXEL_DIRT]: 0x8B6914,
      [VOXEL_STONE]: 0x808080,
      [VOXEL_GRASS]: 0x4a8c3f,
      [VOXEL_BUILT]: 0xc4a35a,
    };
    return colors[type] || 0xffffff;
  }

  private getColorWithDurability(type: number, durability: number): THREE.Color {
    const baseColor = this.getBaseColor(type);
    const factor = durability / 3;
    const r = ((baseColor >> 16) & 0xFF) / 255 * factor;
    const g = ((baseColor >> 8) & 0xFF) / 255 * factor;
    const b = (baseColor & 0xFF) / 255 * factor;
    return new THREE.Color(r, g, b);
  }

  // Fast color update using instance colors
  updateVoxelColor(x: number, y: number, z: number, type: number, durability: number): void {
    const chunk = this.chunks.get(this.getChunkKey(x, z));
    if (!chunk || !chunk.mesh) return;

    const key = this.key(x, y, z);
    const index = chunk.voxelIndices.get(key);
    if (index === undefined) return;

    const color = this.getColorWithDurability(type, durability);
    chunk.mesh.setColorAt(index, color);
    if (chunk.mesh.instanceColor) {
      chunk.mesh.instanceColor.needsUpdate = true;
    }
  }

  private rebuildChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    // Remove old mesh
    if (chunk.mesh) {
      this.mesh.remove(chunk.mesh);
      chunk.mesh.dispose();
      chunk.mesh = null;
    }
    chunk.voxelIndices.clear();

    // Collect exposed voxels - ONLY from this chunk's local storage
    const positions: { x: number; y: number; z: number; type: number; durability: number; key: string }[] = [];

    for (const [voxelKey, v] of chunk.voxels) {
      const parts = voxelKey.split(',');
      const x = parseInt(parts[0]);
      const y = parseInt(parts[1]);
      const z = parseInt(parts[2]);

      // Check if exposed (has at least one air neighbor)
      const exposed = !this.isSolid(x + 1, y, z) || !this.isSolid(x - 1, y, z) ||
        !this.isSolid(x, y + 1, z) || !this.isSolid(x, y - 1, z) ||
        !this.isSolid(x, y, z + 1) || !this.isSolid(x, y, z - 1);

      if (!exposed) continue;

      positions.push({ x, y, z, type: v.type, durability: v.durability, key: voxelKey });
    }

    if (positions.length === 0) return;

    // Create InstancedMesh for this chunk
    const mesh = new THREE.InstancedMesh(
      VoxelWorld.sharedGeometry!,
      VoxelWorld.sharedMaterial!,
      positions.length
    );

    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      matrix.setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, matrix);

      color.copy(this.getColorWithDurability(p.type, p.durability));
      mesh.setColorAt(i, color);

      // Store index for fast color updates
      chunk.voxelIndices.set(p.key, i);
    }

    mesh.instanceMatrix.needsUpdate = true;
    // Force instance color buffer to be created and updated
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    } else {
      // If instanceColor doesn't exist yet, we need to initialize it
      const colors = new Float32Array(positions.length * 3);
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        const c = this.getColorWithDurability(p.type, p.durability);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    }
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    chunk.mesh = mesh;
    this.mesh.add(mesh);
  }

  private rebuildAllChunks(): void {
    for (const [key, chunk] of this.chunks) {
      this.rebuildChunk(key);
      chunk.dirty = false;
    }
  }

  // Call once per frame to handle deferred rebuilds
  update(forceAll: boolean = false): void {
    // Rebuild dirty chunks (up to 8 per frame, or all if forceAll is true)
    let rebuilt = 0;
    const maxRebuild = forceAll ? 9999 : 8;
    for (const [key, chunk] of this.chunks) {
      if (chunk.dirty && (forceAll || rebuilt < maxRebuild)) {
        this.rebuildChunk(key);
        chunk.dirty = false;
        rebuilt++;
      }
    }
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDist: number): {
    hit: boolean;
    position: THREE.Vector3;
    normal: THREE.Vector3;
    voxelPos: { x: number; y: number; z: number };
    distance: number;
  } | null {
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

    const normal = new THREE.Vector3();
    let dist = 0;

    for (let i = 0; i < maxDist * 3; i++) {
      if (this.isSolid(voxelX, voxelY, voxelZ)) {
        return {
          hit: true,
          position: new THREE.Vector3(voxelX, voxelY, voxelZ),
          normal: normal.clone(),
          voxelPos: { x: voxelX, y: voxelY, z: voxelZ },
          distance: dist,
        };
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          voxelX += stepX;
          dist = tMaxX;
          tMaxX += tDeltaX;
          normal.set(-stepX, 0, 0);
        } else {
          voxelZ += stepZ;
          dist = tMaxZ;
          tMaxZ += tDeltaZ;
          normal.set(0, 0, -stepZ);
        }
      } else {
        if (tMaxY < tMaxZ) {
          voxelY += stepY;
          dist = tMaxY;
          tMaxY += tDeltaY;
          normal.set(0, -stepY, 0);
        } else {
          voxelZ += stepZ;
          dist = tMaxZ;
          tMaxZ += tDeltaZ;
          normal.set(0, 0, -stepZ);
        }
      }

      if (dist > maxDist) break;
    }

    return null;
  }
}
