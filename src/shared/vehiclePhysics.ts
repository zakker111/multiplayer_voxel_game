import { WORLD_HALF, vehicleSpec, type Footprint, type Position, type VehicleKind } from './types';

/**
 * Vehicle physics shared by the authoritative server and the offline client:
 * how a jeep finds the ground, whether a body fits, and where a driver can
 * step out. Pure functions over a one-method world interface, so the two sides
 * cannot drift apart.
 */

/** What the vehicle helpers may ask of a world: one solid-voxel query. */
export interface SolidSampler {
  isSolid(x: number, y: number, z: number): boolean;
}

/** A vehicle body taking part in a clearance test. */
export interface VehicleBody {
  id: string;
  kind: VehicleKind;
  position: Position;
  yaw: number;
}

/** An infantry body taking part in a clearance test. */
export interface InfantryBody {
  id: string;
  position: Position;
  isDead?: boolean;
  isSpectating?: boolean;
}

/** Everything a clearance test may collide with, and who to ignore. */
export interface ClearanceBodies {
  vehicles?: Iterable<VehicleBody>;
  players?: Iterable<InfantryBody>;
  ignoreVehicleId?: string | null;
  ignorePlayerId?: string | null;
}

/** One 1×1 voxel cell as a footprint, for the grid scan in vehicleClear. */
const CELL: Footprint = { halfWidth: 0.5, halfLength: 0.5, height: 1 };

/** Separating-axis test for two oriented footprints on the XZ plane. Touching
 *  edges count as clear, so parked vehicles can be adjacent, and each side uses
 *  its own spec so vehicles and emplacements of different sizes compare
 *  correctly. */
export function vehicleRectsOverlap(
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

/**
 * Ground a vehicle would sit on at (x, z). Samples a nine-point ring around the
 * centre: the surface must be within one voxel of level across the whole
 * footprint and within one voxel of where the vehicle is now, so a one-voxel
 * step is drivable while a wall or a taller drop is not. Returns the height, or
 * null when the spot is not drivable.
 */
export function vehicleGround(sampler: SolidSampler, x: number, z: number, currentY: number): number | null {
  const heights: number[] = [];
  for (const [ox, oz] of [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
    const gx = Math.round(x + ox), gz = Math.round(z + oz);
    let top: number | null = null;
    for (let y = Math.floor(currentY + 0.5); y >= Math.floor(currentY - 2.5); y--) {
      if (sampler.isSolid(gx, y, gz)) { top = y + 0.5; break; }
    }
    if (top === null) return null;
    heights.push(top);
  }
  const high = Math.max(...heights), low = Math.min(...heights);
  return high - low <= 1 && Math.abs(high - currentY) <= 1 ? high : null;
}

/**
 * Exact oriented-box footprint: movement collision uses the vehicle's real
 * rectangle rather than a circumscribed circle that rejected gaps it physically
 * fits through. No solid voxel may sit inside the body, no other vehicle may
 * overlap it, and no live infantry capsule may be inside it.
 */
export function vehicleClear(
  sampler: SolidSampler, position: Position, yaw: number, spec: Footprint, bodies: ClearanceBodies = {},
): boolean {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  // Heading used by the movement equation; side is perpendicular to it.
  const forward = { x: -sin, z: -cos };
  const side = { x: cos, z: -sin };
  const extentX = spec.halfLength * Math.abs(forward.x) + spec.halfWidth * Math.abs(side.x);
  const extentZ = spec.halfLength * Math.abs(forward.z) + spec.halfWidth * Math.abs(side.z);
  if (Math.abs(position.x) + extentX >= WORLD_HALF || Math.abs(position.z) + extentZ >= WORLD_HALF) return false;
  for (let x = Math.floor(position.x - extentX - 0.5); x <= Math.ceil(position.x + extentX + 0.5); x++) {
    for (let z = Math.floor(position.z - extentZ - 0.5); z <= Math.ceil(position.z + extentZ + 0.5); z++) {
      if (!vehicleRectsOverlap(position.x, position.z, yaw, spec, x, z, 0, CELL)) continue;
      for (let y = Math.floor(position.y + 0.5); y <= Math.ceil(position.y + spec.height - 0.5); y++) {
        if (sampler.isSolid(x, y, z)) return false;
      }
    }
  }
  for (const other of bodies.vehicles ?? []) {
    const otherSpec = vehicleSpec(other.kind);
    if (other.id === bodies.ignoreVehicleId) continue;
    if (Math.abs(other.position.y - position.y) >= (spec.height + otherSpec.height) / 2) continue;
    if (vehicleRectsOverlap(position.x, position.z, yaw, spec, other.position.x, other.position.z, other.yaw, otherSpec)) return false;
  }
  for (const body of bodies.players ?? []) {
    if (body.id === bodies.ignorePlayerId || body.isDead || body.isSpectating) continue;
    if (Math.abs(body.position.y - position.y) >= spec.height) continue;
    // Infantry capsule (0.5m radius) against the vehicle rectangle.
    const dx = body.position.x - position.x, dz = body.position.z - position.z;
    const localForward = dx * forward.x + dz * forward.z;
    const localSide = dx * side.x + dz * side.z;
    const clampedForward = Math.max(-spec.halfLength, Math.min(spec.halfLength, localForward));
    const clampedSide = Math.max(-spec.halfWidth, Math.min(spec.halfWidth, localSide));
    if (Math.hypot(localForward - clampedForward, localSide - clampedSide) < 0.5) return false;
  }
  return true;
}

/**
 * Where a body stepping out of a vehicle can stand: a ring of spots around the
 * vehicle, swept sideways first and then wider, each needing solid ground close
 * to the vehicle's height, a body-sized gap, no other infantry and no other
 * vehicle. Null means there is nowhere safe this frame.
 */
export function vehicleExitSpot(
  sampler: SolidSampler, vehicle: VehicleBody, bodies: ClearanceBodies = {},
): Position | null {
  const spec = vehicleSpec(vehicle.kind);
  const players = [...(bodies.players ?? [])];
  const vehicles = [...(bodies.vehicles ?? [])];
  // Step out sideways, then further: the first ring clears the body itself.
  for (const radius of [spec.halfLength + 1.5, spec.halfLength + 2.5, spec.halfLength + 4]) {
    for (let i = 0; i < 8; i++) {
      const angle = vehicle.yaw + i * Math.PI / 4;
      const x = vehicle.position.x + Math.cos(angle) * radius, z = vehicle.position.z + Math.sin(angle) * radius;
      const y = vehicleGround(sampler, x, z, vehicle.position.y);
      if (y === null || Math.abs(x) >= WORLD_HALF - 1 || Math.abs(z) >= WORLD_HALF - 1) continue;
      let clear = true;
      for (const dx of [-0.45, 0.45]) for (const dz of [-0.45, 0.45]) for (const dy of [0.3, 1, 1.8]) {
        if (sampler.isSolid(Math.round(x + dx), Math.round(y + dy), Math.round(z + dz))) clear = false;
      }
      if (!clear) continue;
      if (players.some(p => p.id !== bodies.ignorePlayerId && !p.isDead && !p.isSpectating &&
        Math.abs(p.position.y - y) < 2 && Math.hypot(p.position.x - x, p.position.z - z) < 1)) continue;
      if (vehicles.some(v => v.id !== vehicle.id && v.id !== bodies.ignoreVehicleId &&
        Math.abs(v.position.y - y) < 2 && Math.hypot(v.position.x - x, v.position.z - z) < 3)) continue;
      return { x, y, z };
    }
  }
  return null;
}
