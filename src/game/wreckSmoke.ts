import * as THREE from 'three';
import type { Position } from '../shared/types';

/** Staggered puffs read as one continuous plume; too few read as stray dots. */
const PUFFS = 16;
const PUFF_LIFE = 3.4;
const PUFF_LIFE_SPREAD = 2.6;

/** Soft round puff shared by every smoke column. */
let puffTexture: THREE.CanvasTexture | null = null;

function smokeTexture(): THREE.CanvasTexture {
  if (puffTexture) return puffTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.42)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  puffTexture = new THREE.CanvasTexture(canvas);
  puffTexture.colorSpace = THREE.SRGBColorSpace;
  return puffTexture;
}

/** One puff's own motion: it drifts sideways while it rises, then respawns. */
interface Puff {
  age: number;
  life: number;
  offsetX: number;
  offsetZ: number;
  driftX: number;
  driftZ: number;
  rise: number;
}

/** A looping column of dark puffs over one destroyed vehicle or build. A wreck
 *  never moves again, so the column is placed once and only its puffs animate. */
export class WreckSmoke {
  readonly points: THREE.Points;
  private readonly scene: THREE.Scene;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly attribute: THREE.BufferAttribute;
  private readonly positions = new Float32Array(PUFFS * 3);
  private readonly puffs: Puff[] = [];
  private readonly x: number;
  private readonly y: number;
  private readonly z: number;

  constructor(scene: THREE.Scene, position: Position) {
    this.scene = scene;
    this.x = position.x;
    // Above the roof of every build and vehicle, so the plume never emerges
    // from inside the wreck's own geometry.
    this.y = position.y + 1.7;
    this.z = position.z;
    for (let i = 0; i < PUFFS; i++) {
      const puff: Puff = { age: 0, life: 1, offsetX: 0, offsetZ: 0, driftX: 0, driftZ: 0, rise: 1 };
      this.puffs.push(puff);
      // Stagger the column at birth instead of growing it from one puff.
      this.respawn(puff, true);
    }
    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.geometry.setAttribute('position', this.attribute);
    this.material = new THREE.PointsMaterial({
      map: smokeTexture(),
      color: 0x3a3a3a,
      size: 2.2,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    // Positions change every frame, so three's cached bounds would cull the plume.
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
    this.write();
  }

  private respawn(puff: Puff, staggered: boolean): void {
    puff.life = PUFF_LIFE + Math.random() * PUFF_LIFE_SPREAD;
    puff.age = staggered ? Math.random() * puff.life : 0;
    puff.offsetX = (Math.random() - 0.5) * 1.1;
    puff.offsetZ = (Math.random() - 0.5) * 1.1;
    puff.driftX = (Math.random() - 0.5) * 0.6;
    puff.driftZ = (Math.random() - 0.5) * 0.6;
    puff.rise = 0.5 + Math.random() * 0.5;
  }

  private write(): void {
    for (let i = 0; i < this.puffs.length; i++) {
      const puff = this.puffs[i];
      this.positions[i * 3] = this.x + puff.offsetX + puff.driftX * puff.age;
      this.positions[i * 3 + 1] = this.y + puff.age * puff.rise;
      this.positions[i * 3 + 2] = this.z + puff.offsetZ + puff.driftZ * puff.age;
    }
    this.attribute.needsUpdate = true;
  }

  update(dt: number): void {
    for (const puff of this.puffs) {
      puff.age += dt;
      if (puff.age >= puff.life) this.respawn(puff, false);
    }
    this.write();
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
