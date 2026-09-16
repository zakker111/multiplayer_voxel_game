import { WebSocket } from 'ws';
import { ServerPlayer } from './serverPlayer';
import { ServerWorld } from './serverWorld';
import {
  ClientMessage,
  ServerMessage,
  PlayerState,
  Position,
  WEAPONS,
  TOOLS,
  VOXEL_AIR,
  BLUE_SPAWN_Z_MIN,
  BLUE_SPAWN_Z_MAX,
  RED_SPAWN_Z_MIN,
  RED_SPAWN_Z_MAX,
  SPAWN_X_RANGE,
  BLUE_FLAG_POS,
  RED_FLAG_POS,
} from '../shared/types';

export class ServerGame {
  private players: Map<string, ServerPlayer> = new Map();
  private world: ServerWorld;
  private connections: Map<string, WebSocket> = new Map();
  private scores = { red: 0, blue: 0 };
  private captures = { red: 0, blue: 0 };
  private lastShootTime: Map<string, number> = new Map();
  private lastToolTime: Map<string, number> = new Map();
  private inventories: Map<string, number> = new Map();
  
  // Flag positions (must match client)
  private readonly BLUE_FLAG_POS = BLUE_FLAG_POS;
  private readonly RED_FLAG_POS = RED_FLAG_POS;
  private readonly CAPTURE_DISTANCE = 3;
  
  // Flag state tracking
  private blueFlagAtBase: boolean = true;
  private redFlagAtBase: boolean = true;
  private blueFlagCarrier: string | null = null; // Player ID carrying blue flag
  private redFlagCarrier: string | null = null; // Player ID carrying red flag
  private droppedFlags: Array<{ position: Position; team: 'red' | 'blue'; respawnTimer: number }> = [];

  constructor() {
    this.world = new ServerWorld();
    console.log('Server game initialized');
  }

  addPlayer(ws: WebSocket): string {
    const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const spawnPos = this.getSpawnPosition('blue');
    
    const player = new ServerPlayer(playerId, spawnPos, 'blue');
    this.players.set(playerId, player);
    this.connections.set(playerId, ws);
    this.inventories.set(playerId, 20);
    
    // Send full init state to the new player
    const existingPlayersList: Array<{ id: string; state: PlayerState }> = [];
    for (const [id, p] of this.players) {
      existingPlayersList.push({ id, state: p.getState() });
    }

    this.sendToPlayer(playerId, {
      type: 'init',
      playerId,
      state: player.getState(),
      players: existingPlayersList,
      scores: this.scores,
      captures: this.captures,
      inventory: this.inventories.get(playerId) || 20,
      voxelChanges: this.world.getModifiedVoxels(),
    });
    
    console.log(`Player ${playerId} connected (total: ${this.players.size})`);
    return playerId;
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
    this.connections.delete(playerId);
    this.inventories.delete(playerId);
    this.lastShootTime.delete(playerId);
    this.lastToolTime.delete(playerId);
    
    this.broadcast({
      type: 'playerLeft',
      playerId,
    });
    
    console.log(`Player ${playerId} left (total: ${this.players.size})`);
  }

  handleMessage(playerId: string, message: ClientMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (message.type) {
      case 'join':
        // Handle team selection and initial spawn position
        player.team = message.team;
        if (message.name) {
          player.name = message.name;
        }
        if (message.position) {
          player.position = { ...message.position };
        } else {
          player.position = this.getSpawnPosition(message.team);
        }
        this.broadcast({
          type: 'playerUpdated',
          playerId,
          state: player.getState(),
        });
        this.broadcastExcept(playerId, {
          type: 'playerJoined',
          playerId,
          state: player.getState(),
        });
        break;

      case 'playerInput':
        player.applyInput(message.input);
        break;

      case 'shoot':
        this.handleShoot(playerId, message.origin, message.direction, message.targetId, message.isHeadshot);
        break;

      case 'useTool':
        this.handleUseTool(playerId, message.tool, message.target);
        break;

      case 'build':
        this.handleBuild(playerId, message.position);
        break;

      case 'reload':
        if (player.startReload()) {
          this.broadcast({
            type: 'playerUpdated',
            playerId,
            state: player.getState(),
          });
        }
        break;

      case 'pickupFlag':
        this.handleFlagPickup(playerId);
        break;

      case 'toggleSpectator':
        player.isSpectating = !player.isSpectating;
        this.broadcast({
          type: 'spectatorToggled',
          playerId,
          isSpectating: player.isSpectating,
        });
        console.log(`Player ${playerId} ${player.isSpectating ? 'entered' : 'exited'} spectator mode`);
        break;

      case 'footstep':
        // Broadcast footstep sound to all players except the sender
        this.broadcastExcept(playerId, {
          type: 'footstep',
          playerId,
          volume: message.volume,
          pitch: message.pitch,
        });
        break;

      case 'disconnect':
        this.removePlayer(playerId);
        break;
    }
  }

  private handleShoot(playerId: string, origin: Position, direction: Position, clientTargetId?: string, clientIsHeadshot?: boolean): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return;

    const now = Date.now() / 1000;
    const weapon = WEAPONS[player.equipment as 'rifle' | 'smg'];
    if (!weapon) return;

    // Check magazine state
    if (player.isReloading) return;
    if (!player.useAmmo()) return; // Returns false if no ammo or reloading

    const lastTime = this.lastShootTime.get(playerId) || 0;
    if (now - lastTime < weapon.fireRate * 0.75) return; // Allow slight tolerance for network timing
    
    this.lastShootTime.set(playerId, now);
    
    // Set shooting state for sound effects
    player.isShooting = true;
    setTimeout(() => {
      player.isShooting = false;
    }, 100);
    
    // Broadcast updated magazine state
    this.broadcast({
      type: 'playerUpdated',
      playerId,
      state: player.getState(),
    });

    // Broadcast shot event to all other players for tracers, flash and sound
    this.broadcastExcept(playerId, {
      type: 'playerShot',
      playerId,
      origin,
      direction,
      weapon: player.equipment,
    });

    // Raycast to find terrain hit distance
    const hit = this.world.raycast(origin, direction, 100);
    const maxDist = hit ? hit.distance : 100;

    let confirmedTarget: { id: string; player: ServerPlayer; isHeadshot: boolean } | null = null;

    // 1. First priority: validate client-reported hit candidate if enemy was hit on shooter's screen
    if (clientTargetId && this.players.has(clientTargetId)) {
      const target = this.players.get(clientTargetId)!;
      if (!target.isDead && target.team !== player.team) {
        const dist = Math.hypot(
          target.position.x - origin.x,
          target.position.y - origin.y,
          target.position.z - origin.z
        );
        if (dist <= 100) {
          // Line of sight check
          const toTargetDir = {
            x: (target.position.x - origin.x) / dist,
            y: (target.position.y + 1.0 - origin.y) / dist,
            z: (target.position.z - origin.z) / dist,
          };
          const terrainHit = this.world.raycast(origin, toTargetDir, dist);
          if (!terrainHit || terrainHit.distance >= dist - 1.2) {
            confirmedTarget = {
              id: clientTargetId,
              player: target,
              isHeadshot: !!clientIsHeadshot,
            };
          }
        }
      }
    }

    // 2. Second priority / fallback: 3D raycast against all enemy players
    if (!confirmedTarget) {
      let closestDist = maxDist;

      for (const [targetId, target] of this.players) {
        if (targetId === playerId || target.isDead) continue;
        if (target.team === player.team) continue; // No friendly fire

        const toTarget = {
          x: target.position.x - origin.x,
          y: target.position.y - origin.y,
          z: target.position.z - origin.z,
        };

        const dot = toTarget.x * direction.x + toTarget.y * direction.y + toTarget.z * direction.z;
        if (dot > 0 && dot < closestDist) {
          const pointOnRay = {
            x: origin.x + direction.x * dot,
            y: origin.y + direction.y * dot,
            z: origin.z + direction.z * dot,
          };
          const horizDist = Math.hypot(pointOnRay.x - target.position.x, pointOnRay.z - target.position.z);
          const vertDist = pointOnRay.y - target.position.y;

          if (horizDist < 0.85 && vertDist >= -0.3 && vertDist <= 2.3) {
            const isHeadshot = vertDist >= 1.45;
            confirmedTarget = { id: targetId, player: target, isHeadshot };
            closestDist = dot;
          }
        }
      }
    }

    if (confirmedTarget) {
      const damage = confirmedTarget.isHeadshot ? weapon.damage.head : weapon.damage.body;
      const target = confirmedTarget.player;
      const targetId = confirmedTarget.id;

      target.takeDamage(damage);

      // Notify attacker of confirmed hit
      this.sendToPlayer(playerId, {
        type: 'hitConfirmed',
        targetId,
        damage,
        isHeadshot: confirmedTarget.isHeadshot,
      });

      // Notify victim and everyone of damage
      this.broadcast({
        type: 'playerDamaged',
        playerId: targetId,
        damage,
        attackerId: playerId,
      });

      // Broadcast updated target state (HP sync)
      this.broadcast({
        type: 'playerUpdated',
        playerId: targetId,
        state: target.getState(),
      });

      if (target.isDead) {
        // Handle flag drop
        this.handlePlayerDeath(targetId);

        if (player.team === 'red') {
          this.scores.red++;
        } else {
          this.scores.blue++;
        }
        this.broadcast({
          type: 'playerDied',
          playerId: targetId,
          killerId: playerId,
        });

        // Respawn after 4s (matching client timer)
        setTimeout(() => {
          const spawnPos = this.getSpawnPosition(target.team);
          target.respawn(spawnPos);
          // Reset inventory on respawn
          this.inventories.set(targetId, 0);
          this.broadcast({
            type: 'playerRespawned',
            playerId: targetId,
            position: spawnPos,
          });
          // Send inventory update to the respawned player
          this.sendToPlayer(targetId, {
            type: 'inventoryUpdated',
            inventory: 0,
          });
        }, 4000);
      }

      return;
    }

    // Hit voxel (if bullet hit block and didn't hit player first)
    if (hit && hit.voxelPos) {
      const { x, y, z } = hit.voxelPos;
      const destroyed = this.world.damageVoxel(x, y, z, 1);
      
      if (destroyed) {
        const voxel = this.world.getVoxel(x, y, z);
        this.broadcast({
          type: 'voxelChanged',
          change: {
            x,
            y,
            z,
            type: voxel ? voxel.type : VOXEL_AIR,
            durability: voxel ? voxel.durability : 0,
          },
        });
        
        // Check for collapse
        const collapsed = this.world.collapseDisconnected(x, y, z);
        for (const change of collapsed) {
          this.broadcast({
            type: 'voxelChanged',
            change,
          });
        }
      } else {
        const voxel = this.world.getVoxel(x, y, z);
        if (voxel) {
          this.broadcast({
            type: 'voxelChanged',
            change: {
              x,
              y,
              z,
              type: voxel.type,
              durability: voxel.durability,
            },
          });
        }
      }
    }
  }

  private handleUseTool(playerId: string, tool: 'pickaxe' | 'spade', target: Position): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return;

    const now = Date.now() / 1000;
    const toolData = TOOLS[tool];
    
    const lastTime = this.lastToolTime.get(playerId) || 0;
    if (now - lastTime < toolData.cooldown * 0.75) return;
    
    this.lastToolTime.set(playerId, now);

    const { x, y, z } = target;
    const destroyed = this.world.damageVoxel(x, y, z, toolData.damage);
    
    if (destroyed) {
      if (toolData.harvests) {
        const inventory = (this.inventories.get(playerId) || 0) + 1;
        this.inventories.set(playerId, inventory);
        this.sendToPlayer(playerId, {
          type: 'inventoryUpdated',
          inventory,
        });
      }
      
      const voxel = this.world.getVoxel(x, y, z);
      this.broadcast({
        type: 'voxelChanged',
        change: {
          x,
          y,
          z,
          type: voxel ? voxel.type : VOXEL_AIR,
          durability: voxel ? voxel.durability : 0,
        },
      });
      
      // Check for collapse
      const collapsed = this.world.collapseDisconnected(x, y, z);
      for (const change of collapsed) {
        this.broadcast({
          type: 'voxelChanged',
          change,
        });
      }
    } else {
      const voxel = this.world.getVoxel(x, y, z);
      if (voxel) {
        this.broadcast({
          type: 'voxelChanged',
          change: {
            x,
            y,
            z,
            type: voxel.type,
            durability: voxel.durability,
          },
        });
      }
    }
  }

  private canBuildAt(x: number, y: number, z: number): boolean {
    if (!this.world.canBuild(x, y, z)) return false;
    
    // Check if block intersects any connected player
    for (const player of this.players.values()) {
      if (player.isDead) continue;
      const pr = 0.45;
      const ph = 1.9;
      if (
        player.position.x + pr > x && player.position.x - pr < x + 1 &&
        player.position.y + ph > y && player.position.y < y + 1 &&
        player.position.z + pr > z && player.position.z - pr < z + 1
      ) {
        return false;
      }
    }
    return true;
  }

  private handleBuild(playerId: string, position: Position): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return;

    const inventory = this.inventories.get(playerId) || 0;
    if (inventory <= 0) return;

    const { x, y, z } = position;
    
    if (this.canBuildAt(x, y, z)) {
      this.world.setVoxel(x, y, z, 4, 3); // VOXEL_BUILT
      this.inventories.set(playerId, inventory - 1);
      
      this.sendToPlayer(playerId, {
        type: 'inventoryUpdated',
        inventory: inventory - 1,
      });
      
      this.broadcast({
        type: 'voxelChanged',
        change: {
          x,
          y,
          z,
          type: 4,
          durability: 3,
        },
      });
    }
  }

  private handleFlagPickup(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead) return;

    // Check if player is already carrying a flag
    if (this.blueFlagCarrier === playerId || this.redFlagCarrier === playerId) {
      return;
    }

    // Check if player is near enemy flag at base
    const enemyFlagPos = player.team === 'blue' ? this.RED_FLAG_POS : this.BLUE_FLAG_POS;
    const dx = player.position.x - enemyFlagPos.x;
    const dz = player.position.z - enemyFlagPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance < this.CAPTURE_DISTANCE) {
      // Check if flag is at base
      if (player.team === 'blue' && this.redFlagAtBase) {
        this.redFlagAtBase = false;
        this.redFlagCarrier = playerId;
        player.carryingFlag = true;
        
        this.broadcast({
          type: 'flagPickedUp',
          playerId: playerId,
          flagTeam: 'red',
        });
      } else if (player.team === 'red' && this.blueFlagAtBase) {
        this.blueFlagAtBase = false;
        this.blueFlagCarrier = playerId;
        player.carryingFlag = true;
        
        this.broadcast({
          type: 'flagPickedUp',
          playerId: playerId,
          flagTeam: 'blue',
        });
      }
    }

    // Check if player is near dropped flags
    const enemyFlagTeam = player.team === 'blue' ? 'red' : 'blue';
    for (let i = this.droppedFlags.length - 1; i >= 0; i--) {
      const droppedFlag = this.droppedFlags[i];
      const dx = player.position.x - droppedFlag.position.x;
      const dz = player.position.z - droppedFlag.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance < 2.5) {
        if (droppedFlag.team === enemyFlagTeam) {
          // Pick up dropped enemy flag
          this.droppedFlags.splice(i, 1);
          
          if (enemyFlagTeam === 'red') {
            this.redFlagCarrier = playerId;
          } else {
            this.blueFlagCarrier = playerId;
          }
          player.carryingFlag = true;
          
          this.broadcast({
            type: 'flagPickedUp',
            playerId: playerId,
            flagTeam: enemyFlagTeam,
          });
        } else if (droppedFlag.team === player.team) {
          // Return friendly dropped flag to base
          this.droppedFlags.splice(i, 1);
          if (player.team === 'blue') {
            this.blueFlagAtBase = true;
          } else {
            this.redFlagAtBase = true;
          }
          this.broadcast({
            type: 'flagReturned',
            flagTeam: player.team,
          });
        }
      }
    }
  }

  private handlePlayerDeath(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Drop flag if carrying
    if (player.carryingFlag) {
      player.carryingFlag = false;
      
      if (this.blueFlagCarrier === playerId) {
        this.blueFlagCarrier = null;
        this.droppedFlags.push({
          position: { ...player.position },
          team: 'blue',
          respawnTimer: 60,
        });
        
        this.broadcast({
          type: 'flagDropped',
          position: { ...player.position },
          flagTeam: 'blue',
        });
      } else if (this.redFlagCarrier === playerId) {
        this.redFlagCarrier = null;
        this.droppedFlags.push({
          position: { ...player.position },
          team: 'red',
          respawnTimer: 60,
        });
        
        this.broadcast({
          type: 'flagDropped',
          position: { ...player.position },
          flagTeam: 'red',
        });
      }
    }
  }

  update(dt: number): void {
    // Update all players
    for (const player of this.players.values()) {
      player.update(dt, this.world);
      
      // Check and broadcast footstep sounds
      const footstepData = player.getFootstepData(this.world);
      if (footstepData) {
        this.broadcastExcept(player.id, {
          type: 'footstep',
          playerId: player.id,
          volume: footstepData.volume,
          pitch: footstepData.pitch,
        });
      }
    }
    
    // Update dropped flag timers
    this.updateDroppedFlags(dt);
    
    // Check for flag captures
    this.checkFlagCaptures();
  }
  
  private updateDroppedFlags(dt: number): void {
    for (let i = this.droppedFlags.length - 1; i >= 0; i--) {
      const droppedFlag = this.droppedFlags[i];
      droppedFlag.respawnTimer -= dt;
      
      if (droppedFlag.respawnTimer <= 0) {
        // Return flag to base
        this.droppedFlags.splice(i, 1);
        
        if (droppedFlag.team === 'blue') {
          this.blueFlagAtBase = true;
        } else {
          this.redFlagAtBase = true;
        }
        
        this.broadcast({
          type: 'flagReturned',
          flagTeam: droppedFlag.team,
        });
      }
    }
  }
  
  private checkFlagCaptures(): void {
    for (const [playerId, player] of this.players) {
      if (player.isDead) continue;

      if (!player.carryingFlag) {
        // Auto-check flag pickup
        this.handleFlagPickup(playerId);
      } else {
        // Carrying flag: check if reached home base to score
        const homeBase = player.team === 'blue' ? this.BLUE_FLAG_POS : this.RED_FLAG_POS;
        const dx = player.position.x - homeBase.x;
        const dz = player.position.z - homeBase.z;
        const distance = Math.hypot(dx, dz);

        if (distance < 5) {
          // SCORE A CAPTURE!
          if (player.team === 'blue') {
            this.captures.blue++;
            this.redFlagAtBase = true;
            this.redFlagCarrier = null;
          } else {
            this.captures.red++;
            this.blueFlagAtBase = true;
            this.blueFlagCarrier = null;
          }
          player.carryingFlag = false;

          // Broadcast capture event
          this.broadcast({
            type: 'flagCaptured',
            team: player.team,
            playerId: playerId,
            captures: this.captures,
          });

          // Broadcast flag returned
          this.broadcast({
            type: 'flagReturned',
            flagTeam: player.team === 'blue' ? 'red' : 'blue',
          });
        }
      }

      // Check if player walks over friendly dropped flag to return it
      const friendlyTeam = player.team;
      for (let i = this.droppedFlags.length - 1; i >= 0; i--) {
        const droppedFlag = this.droppedFlags[i];
        if (droppedFlag.team === friendlyTeam) {
          const dx = player.position.x - droppedFlag.position.x;
          const dz = player.position.z - droppedFlag.position.z;
          if (Math.hypot(dx, dz) < 3.5) {
            this.droppedFlags.splice(i, 1);
            if (friendlyTeam === 'blue') this.blueFlagAtBase = true;
            else this.redFlagAtBase = true;

            this.broadcast({
              type: 'flagReturned',
              flagTeam: friendlyTeam,
            });
          }
        }
      }
    }
  }

  broadcastState(): void {
    // Send individual player updates instead of full state
    for (const [playerId, player] of this.players) {
      this.broadcastExcept(playerId, {
        type: 'playerUpdated',
        playerId,
        state: player.getState(),
      });
    }
  }

  private getSpawnPosition(team: 'red' | 'blue'): Position {
    const zMin = team === 'blue' ? BLUE_SPAWN_Z_MIN : RED_SPAWN_Z_MIN;
    const zMax = team === 'blue' ? BLUE_SPAWN_Z_MAX : RED_SPAWN_Z_MAX;
    let bestX = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
    let bestZ = zMin + Math.random() * (zMax - zMin);
    let bestY = this.world.getGroundHeight(bestX, bestZ);

    for (let attempt = 0; attempt < 20; attempt++) {
      const x = (Math.random() - 0.5) * SPAWN_X_RANGE * 2;
      const z = zMin + Math.random() * (zMax - zMin);
      const y = this.world.getGroundHeight(x, z);
      const vx = Math.round(x);
      const vz = Math.round(z);
      if (!this.world.isSolid(vx, Math.round(y + 0.8), vz) && !this.world.isSolid(vx, Math.round(y + 1.6), vz)) {
        bestX = x;
        bestZ = z;
        bestY = y;
        break;
      }
    }
    return { x: bestX, y: bestY, z: bestZ };
  }

  private distanceToRay(point: Position, rayOrigin: Position, rayDir: Position): number {
    const toPoint = {
      x: point.x - rayOrigin.x,
      y: point.y - rayOrigin.y,
      z: point.z - rayOrigin.z,
    };
    
    const dot = toPoint.x * rayDir.x + toPoint.y * rayDir.y + toPoint.z * rayDir.z;
    
    if (dot < 0) return Infinity;
    
    const closest = {
      x: rayOrigin.x + rayDir.x * dot,
      y: rayOrigin.y + rayDir.y * dot,
      z: rayOrigin.z + rayDir.z * dot,
    };
    
    const dx = point.x - closest.x;
    const dy = point.y - closest.y;
    const dz = point.z - closest.z;
    
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private sendToPlayer(playerId: string, message: ServerMessage): void {
    const ws = this.connections.get(playerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private broadcastExcept(exceptPlayerId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const [playerId, ws] of this.connections) {
      if (playerId !== exceptPlayerId && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}
