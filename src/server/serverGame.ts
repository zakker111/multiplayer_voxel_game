import { WebSocket } from 'ws';
import { ServerPlayer } from './serverPlayer';
import { ServerWorld } from './serverWorld';
import { ServerBot, BotContext, BotTargetInfo } from './serverBot';
import { createLogger } from './logger';
const log = createLogger('game');
import { BanStore, normalizeIp } from './banStore';
import {
  ClientMessage,
  ServerMessage,
  PlayerState,
  PlayerStats,
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

export interface GameConnection {
  send(data: string): void;
  isOpen?: () => boolean;
  readyState?: number;
  /** Optional close hook — SSE connections use this to end the HTTP response. */
  close?(code?: number, reason?: string): void;
}

export class ServerGame {
  private players: Map<string, ServerPlayer> = new Map();
  private world: ServerWorld;
  private connections: Map<string, WebSocket | GameConnection> = new Map();
  private scores = { red: 0, blue: 0 };
  private captures = { red: 0, blue: 0 };
  /** Per-combatant kill/death/capture tallies for the Tab scoreboard. */
  private playerStats: Map<string, PlayerStats> = new Map();
  private lastShootTime: Map<string, number> = new Map();
  private lastToolTime: Map<string, number> = new Map();
  private inventories: Map<string, number> = new Map();
  
  // Flag positions (must match client)
  private readonly BLUE_FLAG_POS = BLUE_FLAG_POS;
  private readonly RED_FLAG_POS = RED_FLAG_POS;
  private readonly CAPTURE_DISTANCE = 7.0; // Unified capture radius (matches client)
  
  // Flag state tracking
  private blueFlagAtBase: boolean = true;
  private redFlagAtBase: boolean = true;
  private blueFlagCarrier: string | null = null; // Player ID carrying blue flag
  private redFlagCarrier: string | null = null; // Player ID carrying red flag
  private blueFlagRespawnTimer: number = 0; // Disappears while respawning after capture
  private redFlagRespawnTimer: number = 0; // Disappears while respawning after capture
  private droppedFlags: Array<{ position: Position; team: 'red' | 'blue'; respawnTimer: number }> = [];

  // Respawn timers for networked players (client is authoritative on movement;
  // the server schedules respawns itself so dead players don't ghost-update)
  private respawnTimers: Map<string, number> = new Map();

  /** Persistent IP ban list shared with the admin CLI via BAN_FILE. */
  readonly bans: BanStore = BanStore.default();

  constructor() {
    this.world = new ServerWorld();
    this.bans.loadFromDisk();
    log.info(`initialized (ban file: ${this.bans.filePath}, bans active: ${this.bans.list().length})`);
    this.spawnDefaultBots();
  }

  // ---------------- AI Bots ----------------

  /** Spawn a balanced set of AI bots (flank / camp / build / trench behaviors).
   *  Default fills the match to 10v10; humans replacing bots via makeRoomForHuman(). */
  spawnDefaultBots(countPerTeam: number = Number(process.env.SERVER_BOT_COUNT ?? 10)): void {
    const names = [
      'Rook', 'Vex', 'Milo', 'Dana', 'Cinder', 'Flint', 'Echo', 'Wren',
      'Bishop', 'Kite', 'Onyx', 'Pike', 'Quill', 'Riven', 'Sable', 'Talon',
      'Umbra', 'Volt', 'Wisp', 'Zephyr', 'Ash', 'Bramble', 'Cobalt', 'Dusk',
    ];
    let i = 0;
    for (const team of ['blue', 'red'] as const) {
      for (let n = 0; n < countPerTeam; n++) {
        this.addBot(team, `🤖 ${names[i % names.length]}`);
        i++;
      }
    }
  }

  /** Kick one bot off the human's newly chosen team so teams stay balanced
   *  and total roster size stays constant (e.g. 10 per side in a 10v10). */
  private makeRoomForHuman(team: 'red' | 'blue'): void {
    if (!team) return;
    const bots = [...this.players.values()].filter(
      (p): p is ServerBot => p instanceof ServerBot && p.team === team,
    );
    if (bots.length === 0) return; // no bots left on this team — allow overflow
    // Remove the most recently added bot (last spawned) for a stable feel.
    const victim = bots[bots.length - 1];
    log.info(`human joined ${team} — retiring bot "${victim.name}" (${victim.id}) to keep balance`);
    this.removeBot(victim.id);
  }

  addBot(team: 'red' | 'blue', name: string): string {
    const botId = `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const spawnPos = this.getSpawnPosition(team);
    const bot = new ServerBot(botId, spawnPos, team, name);
    this.players.set(botId, bot);
    // No connection entry: broadcasts/sendToPlayer naturally skip bots,
    // and their state flows to clients via playerUpdated/broadcastState.
    this.broadcast({
      type: 'playerJoined',
      playerId: botId,
      state: bot.getState(),
    });
    log.info(`bot spawned id=${botId} name=${name} team=${team} total=${this.players.size}`);
    return botId;
  }

  removeBot(botId: string): void {
    if (!this.players.has(botId)) return;
    this.handlePlayerDeath(botId); // drops any carried flag properly
    this.players.delete(botId);
    this.respawnTimers.delete(botId);
    this.lastShootTime.delete(botId);
    this.lastToolTime.delete(botId);
    this.inventories.delete(botId);
    // Keep retired bots' stats until they rejoin — the scoreboard still shows
    // their kills/captures for the match (they remain part of the battle).
    this.broadcast({ type: 'playerLeft', playerId: botId });
  }

  private getBotContext(): BotContext {
    const targets: BotTargetInfo[] = [];
    for (const [id, p] of this.players) {
      targets.push({
        id,
        position: { ...p.position },
        team: p.team,
        isDead: p.isDead || p.isSpectating,
        carryingFlag: p.carryingFlag,
      });
    }
    const ctx: BotContext = {
      world: this.world,
      serverTime: this.world.serverTime,
      targets,
      friendlyDroppedFlagPos: null, // filled per-bot below via closure default
      canSee: (from, to) => this.hasLineOfSight(from, to),
      fireWeapon: (bot, target, aimDir, eyeY) => {
        const origin = { x: bot.position.x, y: bot.position.y + eyeY, z: bot.position.z };
        // Small inaccuracy jitter so tracers look human
        const spread = bot.equipment === 'smg' ? 0.03 : 0.004;
        const dir = {
          x: aimDir.x + (Math.random() - 0.5) * spread,
          y: aimDir.y + (Math.random() - 0.5) * spread,
          z: aimDir.z + (Math.random() - 0.5) * spread,
        };
        this.botShoot(bot.id, origin, dir, target.id);
      },
      buildBlock: (bot, pos) => {
        this.botBuild(bot.id, pos);
      },
    };
    return ctx;
  }

  private hasLineOfSight(from: Position, to: Position): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = this.world.raycast(from, dir, dist);
    return !hit || hit.distance >= dist - 1.0;
  }

  /** Bot fired at a validated target: apply weapon damage through the same
   *  authoritative pipeline used for humans (no client-reported hits). */
  private botShoot(botId: string, origin: Position, direction: Position, targetId: string): void {
    const bot = this.players.get(botId);
    const target = this.players.get(targetId);
    if (!bot || !target || bot.isDead || target.isDead) return;
    if (target.team === bot.team) return;

    const weapon = WEAPONS[bot.equipment as 'rifle' | 'smg'];
    if (!weapon) return;

    // Broadcast the shot so other clients render tracer/flash/sound
    this.broadcastExcept(botId, {
      type: 'playerShot',
      playerId: botId,
      origin,
      direction,
      weapon: bot.equipment,
    });
    this.broadcast({ type: 'playerUpdated', playerId: botId, state: bot.getState() });

    // Terrain must not block the bullet
    if (!this.hasLineOfSight(origin, { x: target.position.x, y: target.position.y + 1.1, z: target.position.z })) {
      // Hit wall instead — damage voxel along the ray
      const hit = this.world.raycast(origin, direction, 350);
      if (hit && hit.voxelPos) {
        this.damageAndBroadcastVoxel(hit.voxelPos);
      }
      return;
    }

    const dist = Math.hypot(
      target.position.x - origin.x,
      target.position.y + 1.1 - origin.y,
      target.position.z - origin.z,
    );
    // Headshot chance scales with accuracy distance
    const isHeadshot = dist < 25 && Math.random() < 0.18;
    const damage = isHeadshot ? weapon.damage.head : weapon.damage.body;

    this.applyDamage(targetId, damage, botId);
  }

  private damageAndBroadcastVoxel(pos: Position): void {
    const { x, y, z } = pos;
    const destroyed = this.world.damageVoxel(x, y, z, 1);
    const voxel = this.world.getVoxel(x, y, z);
    this.broadcast({
      type: 'voxelChanged',
      change: { x, y, z, type: voxel ? voxel.type : VOXEL_AIR, durability: voxel ? voxel.durability : 0 },
    });
    if (destroyed) {
      const collapsed = this.world.collapseDisconnected(x, y, z);
      for (const change of collapsed) {
        this.broadcast({ type: 'voxelChanged', change });
      }
    }
  }

  /** Centralized damage application (used by bot shots). Human shots keep
   *  their own path but respect the same death/respawn bookkeeping. */
  private applyDamage(targetId: string, damage: number, attackerId: string): void {
    const target = this.players.get(targetId);
    const attacker = this.players.get(attackerId);
    if (!target || target.isDead) return;

    target.takeDamage(damage);

    // Threat memory for bot victims: they hunt back toward their attacker
    if (target instanceof ServerBot && attackerId) {
      target.noteHitBy(attackerId, this.world.serverTime);
    }

    // Confirm the hit to the SHOOTER, not the victim: the client renders the
    // hit marker + headshot sound from this event, so sending it to the victim
    // made players see "you hit someone" feedback whenever a bot shot them.
    this.sendToPlayer(attackerId, { type: 'hitConfirmed', targetId, damage, isHeadshot: false });

    this.broadcast({ type: 'playerDamaged', playerId: targetId, damage, attackerId });
    this.broadcast({ type: 'playerUpdated', playerId: targetId, state: target.getState() });

    if (target.isDead) {
      this.handlePlayerDeath(targetId);
      if (attacker) {
        if (attacker.team === 'red') this.addTeamScore('red');
        else this.addTeamScore('blue');
        this.getStats(attacker.id).kills++;
        this.broadcastStats();
      }
      this.broadcast({ type: 'playerDied', playerId: targetId, killerId: attackerId });
      this.respawnTimers.set(targetId, 4.0);
    }
  }

  /**
   * Increment a team's kill score and broadcast the authoritative totals to
   * every client. Without this sync, clients only learn scores at `init`, so
   * kill feeds / HUD scores drift out of sync for everyone but the local
   * killer (whose optimistic increment never matches the server tally).
   */
  private addTeamScore(team: 'red' | 'blue'): void {
    this.scores[team]++;
    this.broadcast({ type: 'scoreUpdate', scores: { ...this.scores } });
  }

  /** Get (creating if needed) the scoreboard tally record for a combatant. */
  private getStats(id: string): PlayerStats {
    let s = this.playerStats.get(id);
    if (!s) {
      s = { kills: 0, deaths: 0, captures: 0 };
      this.playerStats.set(id, s);
    }
    return s;
  }

  /** Push authoritative per-player K/D/captures to every client so the Tab
   *  scoreboard stays in sync across all viewers (not just local estimates). */
  private broadcastStats(): void {
    const stats: Record<string, PlayerStats> = {};
    for (const [id, s] of this.playerStats) stats[id] = { ...s };
    this.broadcast({ type: 'statsUpdate', stats });
  }

  /** Bot places a building block (validated like human builds). */
  private botBuild(botId: string, position: Position): void {
    const bot = this.players.get(botId);
    if (!bot || !(bot instanceof ServerBot) || bot.isDead) return;
    const { x, y, z } = position;
    if (!this.canBuildAt(x, y, z)) return;
    this.world.setVoxel(x, y, z, 4, 3); // VOXEL_BUILT
    this.broadcast({
      type: 'voxelChanged',
      change: { x, y, z, type: 4, durability: 3 },
    });
  }

  private updateBots(ctx: BotContext): void {
    for (const [id, player] of this.players) {
      if (!(player instanceof ServerBot)) continue;
      if (player.isDead) continue;
      // Per-bot view of dropped flags belonging to its own team
      const own = ctx.friendlyDroppedFlagPos;
      const drop = this.droppedFlags.find((f) => f.team === player.team);
      ctx.friendlyDroppedFlagPos = drop ? drop.position : own;
      player.botUpdate(this.tickDt, ctx);
      ctx.friendlyDroppedFlagPos = null;
    }
  }

  private readonly tickDt: number = 1 / 20;

  addPlayer(ws: WebSocket | GameConnection, ip?: string): string {
    const playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const spawnPos = this.getSpawnPosition('blue');
    
    const player = new ServerPlayer(playerId, spawnPos, 'blue');
    player.ip = normalizeIp(ip);
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
      stats: Object.fromEntries(
        [...this.playerStats].map(([id, s]) => [id, { ...s }]),
      ),
      inventory: this.inventories.get(playerId) || 20,
      voxelChanges: this.world.getModifiedVoxels(),
      // Full authoritative flag snapshot so late joiners see flags that were
      // picked up / dropped / captured BEFORE they connected (events alone
      // would leave their visuals desynced).
      flags: {
        blue: {
          atBase: this.blueFlagAtBase,
          carrierId: this.blueFlagCarrier,
          respawnTimer: this.blueFlagRespawnTimer,
          droppedPosition: this.droppedFlags.find(f => f.team === 'blue')?.position ?? null,
        },
        red: {
          atBase: this.redFlagAtBase,
          carrierId: this.redFlagCarrier,
          respawnTimer: this.redFlagRespawnTimer,
          droppedPosition: this.droppedFlags.find(f => f.team === 'red')?.position ?? null,
        },
      },
    });
    
    log.info(`player connected id=${playerId} ip=${player.ip} name=${player.name ?? 'unnamed'} total=${this.players.size}`);
    return playerId;
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);

    // Drop any carried flag BEFORE the player is deleted. handlePlayerDeath()
    // bails out when the player is already gone, which used to strand the flag
    // on a disconnected ghost carrier and deadlock the round.
    this.dropCarriedFlag(playerId);

    this.players.delete(playerId);
    this.connections.delete(playerId);
    this.inventories.delete(playerId);
    this.lastShootTime.delete(playerId);
    this.lastToolTime.delete(playerId);
    this.respawnTimers.delete(playerId);
    
    this.broadcast({
      type: 'playerLeft',
      playerId,
    });
    
    log.info(`player left id=${playerId} ip=${player?.ip ?? '?'} name=${player?.name ?? 'unnamed'} total=${this.players.size}`);

    // Maintain the 10v10 roster: when a human vacates a slot, backfill it
    // with a fresh bot on the SAME team so teams never fall short.
    const team = player?.team;
    const wasHuman = !!player && !(player instanceof ServerBot);
    if (wasHuman && team) {
      const countOnTeam = [...this.players.values()].filter((p) => p.team === team).length;
      const target = Number(process.env.SERVER_BOT_COUNT ?? 10);
      if (countOnTeam < target) {
        const names = ['Rook', 'Vex', 'Milo', 'Dana', 'Cinder', 'Flint', 'Echo', 'Wren',
          'Bishop', 'Kite', 'Onyx', 'Pike', 'Quill', 'Riven', 'Sable', 'Talon'];
        this.addBot(team, `🤖 ${names[Math.floor(Math.random() * names.length)]}`);
        log.info(`backfill bot spawned for team=${team} to keep ${target}v${target}`);
      }
    }
  }

  /**
   * Forcibly disconnect a player. If `ban` is true, their IP is also added to
   * the persistent ban list (which live-reloads from BAN_FILE so the CLI can
   * edit it while the server runs).
   */
  kickPlayer(playerId: string, reason = 'kicked by admin', ban = false): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    if (ban && player.ip) {
      this.bans.add('ip', player.ip, reason);
      log.warn(`BANNED ${player.ip} (${playerId}) reason="${reason}" file=${this.bans.filePath}`);
    } else {
      log.warn(`KICKED ${playerId} ip=${player.ip ?? '?'} name=${player.name ?? 'unnamed'} reason="${reason}"`);
    }

    // Tell the client why it was disconnected before closing the socket.
    this.sendToPlayer(playerId, {
      type: 'kicked',
      reason,
      banned: ban,
    });
    this.closeConnection(playerId);
    this.removePlayer(playerId);
    return true;
  }

  banIp(ip: string, reason = 'banned by admin'): void {
    this.bans.add('ip', normalizeIp(ip), reason);
    log.warn(`BAN added ip=${normalizeIp(ip)} reason="${reason}"`);
    // Also kick anyone currently connected with that IP.
    for (const [id, p] of [...this.players]) {
      if (!(p instanceof ServerBot) && p.ip === normalizeIp(ip)) {
        this.kickPlayer(id, reason, false);
      }
    }
  }

  unbanIp(ip: string): boolean {
    const removed = this.bans.remove('ip', normalizeIp(ip));
    if (removed) log.info(`UNBAN ip=${normalizeIp(ip)}`);
    return removed;
  }

  isIpBanned(ip: string | undefined): boolean {
    return this.bans.isIpBanned(normalizeIp(ip)) !== null;
  }

  /** Snapshot of connected (non-bot) players for logs / status endpoint / CLI. */
  listPlayers(): Array<{ id: string; name: string; team: string; ip: string; hp: number; isDead: boolean; isSpectating: boolean }> {
    const out: Array<{ id: string; name: string; team: string; ip: string; hp: number; isDead: boolean; isSpectating: boolean }> = [];
    for (const [id, p] of this.players) {
      if (p instanceof ServerBot) continue;
      out.push({
        id,
        name: p.name ?? 'unnamed',
        team: p.team,
        ip: p.ip ?? 'unknown',
        hp: Math.round(p.hp),
        isDead: p.isDead,
        isSpectating: p.isSpectating,
      });
    }
    return out;
  }

  private closeConnection(playerId: string): void {
    const conn = this.connections.get(playerId);
    if (!conn) return;
    try {
      // WebSocket has .close(); SSE connections created by server.ts also
      // expose an optional close() that ends the HTTP response. Prefer the
      // explicit close hook so kicked SSE clients stop receiving events and
      // the browser's EventSource actually terminates (previously we only
      // sent a sentinel message and left the stream open forever).
      if (typeof conn.close === 'function') {
        conn.close(4000, 'kicked');
      } else if ('close' in conn && typeof (conn as WebSocket).close === 'function') {
        (conn as WebSocket).close(4000, 'kicked');
      } else if (typeof conn.send === 'function') {
        // Legacy SSE connection without a close hook — send sentinel then
        // end via isOpen contract.
        conn.send(JSON.stringify({ type: 'kicked', reason: 'kicked', banned: false }));
      }
    } catch {
      /* ignore */
    }
  }

  handleMessage(playerId: string, message: ClientMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (message.type) {
      case 'join':
        // Handle team selection and initial spawn position
        player.team = message.team;
        // Keep teams balanced: retire one bot from this team so the human
        // takes their slot (e.g. stays 10v10 with bots filling the roster).
        this.makeRoomForHuman(message.team);
        if (message.name) {
          player.name = message.name;
          // Name-based ban check: kick + extend to an IP ban for this session.
          const nameBan = this.bans.list().find(
            (b) => b.kind === 'name' && b.value.toLowerCase() === message.name!.toLowerCase(),
          );
          if (nameBan) {
            log.warn(`Rejected join by banned name "${message.name}" from ${player.ip ?? '?'}`);
            this.kickPlayer(playerId, `Banned account: ${nameBan.reason}`, false);
            return;
          }
        }
        if (message.position) {
          player.position = { ...message.position };
        } else {
          player.position = this.getSpawnPosition(message.team);
        }
        // Rejoining connections must never start life dead/eliminated: clear any
        // stale death/spectate state and pending respawn timers from a previous
        // session before the join is acknowledged ("spawn already dead" bug).
        this.respawnTimers.delete(playerId);
        if (!player.isSpectating) {
          player.respawn(player.position);
        } else {
          player.hp = player.maxHp;
          player.isDead = false;
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
        // Reject movement from dead players (prevents ghost position updates
        // while the respawn timer runs) and spectators (no world presence)
        if (!player.isDead && !player.isSpectating) {
          player.applyInput(message.input);
        }
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

      case 'captureFlag':
        this.handleFlagCapture(playerId);
        break;

      case 'toggleSpectator':
        // A spectator is frozen out of play, so a flag they were carrying would
        // be stranded on a non-moving player forever — drop it first.
        if (!player.isSpectating) this.dropCarriedFlag(playerId);
        player.isSpectating = !player.isSpectating;
        this.broadcast({
          type: 'spectatorToggled',
          playerId,
          isSpectating: player.isSpectating,
        });
        log.info(`player ${playerId} ${player.isSpectating ? 'entered' : 'exited'} spectator mode`);
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

      case 'requestRespawn':
        // Server-authoritative safe spawn. The client fires this right after
        // joining so the player materializes at a terrain-checked team spawn
        // instead of a stale (or hostile) client-reported position that could
        // place them inside enemy lines/terrain where hazards kill them on
        // the very first tick ("instant elimination on join" bug).
        {
          if (!player.isDead) {
            // Already alive: the server owns this player's position. Re-assert
            // it so a client that wrongly believes it died (e.g. a local
            // void-fall) recovers, but never teleport a live player back to
            // spawn — that was a free full-heal + escape (and let a flag
            // carrier teleport home with the enemy flag).
            this.broadcast({
              type: 'playerRespawned',
              playerId,
              position: { ...player.position },
            });
            this.broadcast({
              type: 'playerUpdated',
              playerId,
              state: player.getState(),
            });
            log.info(`player ${playerId} requested respawn while alive — re-asserted position`);
            break;
          }

          // Dead: drop anything they were carrying at the death spot first.
          this.dropCarriedFlag(playerId);

          const spawnPos = this.getSpawnPosition(player.team);
          player.respawn(spawnPos);
          // Clear any pending respawn timer so the scheduled respawn doesn't
          // fire redundantly on top of this one.
          this.respawnTimers.delete(playerId);
          this.inventories.set(playerId, 20);
          this.broadcast({
            type: 'playerRespawned',
            playerId,
            position: spawnPos,
          });
          this.sendToPlayer(playerId, {
            type: 'inventoryUpdated',
            inventory: 20,
          });
          this.broadcast({
            type: 'playerUpdated',
            playerId,
            state: player.getState(),
          });
          log.info(`player ${playerId} requested respawn at safe spawn`);
        }
        break;

      case 'disconnect':
        this.removePlayer(playerId);
        break;
    }
  }

  private handleShoot(playerId: string, origin: Position, direction: Position, clientTargetId?: string, clientIsHeadshot?: boolean): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating) return;

    const now = Date.now() / 1000;
    const weapon = WEAPONS[player.equipment as 'rifle' | 'smg'];
    if (!weapon) return;

    // Check magazine state
    if (player.isReloading) return;
    if (!player.useAmmo()) return; // Returns false if no ammo or reloading

    const lastTime = this.lastShootTime.get(playerId) || 0;
    if (now - lastTime < weapon.fireRate * 0.75) return; // Allow slight tolerance for network timing
    
    this.lastShootTime.set(playerId, now);
    
    // Set shooting state for sound effects. The game loop clears this flag
    // after ~100ms (see update()), so no per-shot timer is needed here.
    player.isShooting = true;
    
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

    // Raycast to find terrain hit distance (extended battlefield bullet range)
    const hit = this.world.raycast(origin, direction, 350);
    const maxDist = hit ? hit.distance : 350;

    // Suppression awareness: enemies within ~2m of the bullet's path were
    // nearly hit — bot victims react by seeking/digging cover ("pinned down").
    if (player.team !== undefined) {
      const rayLen = maxDist;
      for (const [tid, tgt] of this.players) {
        if (tid === playerId || tgt.isDead || tgt.team === player.team) continue;
        if (!(tgt instanceof ServerBot)) continue;
        const tx = tgt.position.x - origin.x;
        const ty = tgt.position.y + 1.0 - origin.y;
        const tz = tgt.position.z - origin.z;
        const dot = tx * direction.x + ty * direction.y + tz * direction.z;
        if (dot <= 0 || dot > rayLen) continue;
        const px = origin.x + direction.x * dot - tgt.position.x;
        const py = origin.y + direction.y * dot - (tgt.position.y + 1.0);
        const pz = origin.z + direction.z * dot - tgt.position.z;
        if (Math.hypot(px, py, pz) < 2.0) {
          tgt.noteIncoming(this.world.serverTime);
        }
      }
    }

    let confirmedTarget: { id: string; player: ServerPlayer; isHeadshot: boolean } | null = null;

    // 1. First priority: validate client-reported hit candidate if enemy was hit on shooter's screen
    if (clientTargetId && this.players.has(clientTargetId)) {
      const target = this.players.get(clientTargetId)!;
      if (!target.isDead && target.team !== player.team) {
        const dx = target.position.x - origin.x;
        // Aim at torso height (+1.0), matching the client's hit model, so the
        // server LoS ray uses the same endpoint the client actually shot at.
        const dy = target.position.y + 1.0 - origin.y;
        const dz = target.position.z - origin.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 1e-6 && dist <= 350) {
          // Line of sight check — normalize by the TRUE distance to the
          // torso point (previously divided by foot-level distance while
          // adding +1.0 to y, producing a skewed unit vector that could
          // fail LoS against terrain for legitimately-hit targets).
          const toTargetDir = { x: dx / dist, y: dy / dist, z: dz / dist };
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

      // Threat memory: bot victims hunt back toward whoever shot them
      if (target instanceof ServerBot) {
        target.noteHitBy(playerId, this.world.serverTime);
      }

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
          this.addTeamScore('red');
        } else {
          this.addTeamScore('blue');
        }
        this.getStats(playerId).kills++;
        this.broadcastStats();
        this.broadcast({
          type: 'playerDied',
          playerId: targetId,
          killerId: playerId,
        });

        // Respawn after 4s via the game loop tick (no setTimeout: survives
        // connection churn and dead players can't ghost-update meanwhile)
        this.respawnTimers.set(targetId, 4.0);
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
    if (!player || player.isDead || player.isSpectating) return;

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
    if (!player || player.isDead || player.isSpectating) return;

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
    if (!player || player.isDead || player.isSpectating) return;

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
        log.info(`RED flag picked up by ${playerId}`);
        
        this.broadcast({
          type: 'flagPickedUp',
          playerId: playerId,
          flagTeam: 'red',
        });
      } else if (player.team === 'red' && this.blueFlagAtBase) {
        this.blueFlagAtBase = false;
        this.blueFlagCarrier = playerId;
        player.carryingFlag = true;
        log.info(`BLUE flag picked up by ${playerId}`);
        
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

      if (distance < this.CAPTURE_DISTANCE) {
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

  private handleFlagCapture(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || player.isDead || player.isSpectating) return;

    // Validation: only a LIVE player who is actually carrying the enemy flag
    // AND standing at their home base may score. This blocks malicious or
    // buggy clients from sending fake 'captureFlag' messages for instant wins.
    const carryingEnemyFlag = player.team === 'blue'
      ? this.redFlagCarrier === playerId
      : this.blueFlagCarrier === playerId;
    if (!carryingEnemyFlag) return;

    const homeBase = player.team === 'blue' ? this.BLUE_FLAG_POS : this.RED_FLAG_POS;
    const distance = Math.hypot(player.position.x - homeBase.x, player.position.z - homeBase.z);
    if (distance > 7.0) return; // Match the client's capture radius to avoid desyncs

    if (player.team === 'blue') {
      this.captures.blue++;
      this.redFlagAtBase = false; // Disappears!
      this.redFlagCarrier = null;
      this.redFlagRespawnTimer = 8.0;
    } else {
      this.captures.red++;
      this.blueFlagAtBase = false; // Disappears!
      this.blueFlagCarrier = null;
      this.blueFlagRespawnTimer = 8.0;
    }
    player.carryingFlag = false;
    this.getStats(playerId).captures++;
    this.broadcastStats();
    log.info(`FLAG CAPTURED by ${playerId} (${player.team}) — score blue:${this.captures.blue} red:${this.captures.red}`);

    this.broadcast({
      type: 'flagCaptured',
      team: player.team,
      // The captured flag is the ENEMY flag (blue scores by carrying red home)
      flagTeam: player.team === 'blue' ? 'red' : 'blue',
      playerId: playerId,
      captures: this.captures,
    });
  }

  /**
   * Drop any flag this player is carrying onto the ground at their feet.
   *
   * Every path that takes a carrier out of play (death, disconnect, entering
   * spectator, teleport-respawn) MUST call this while the player still exists
   * in `players`. Otherwise the carrier id keeps pointing at a player who is
   * gone or frozen, no dropped-flag entry is created, and the flag can never be
   * picked up, returned or captured again — the CTF round deadlocks.
   */
  private dropCarriedFlag(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.carryingFlag) return;

    player.carryingFlag = false;

    // Snap the dropped flag to solid ground so clients (and late joiners
    // reading the init snapshot) never render it floating in mid-air.
    const dropY = this.world.getGroundHeight(player.position.x, player.position.z);
    const position = { x: player.position.x, y: dropY + 0.5, z: player.position.z };

    if (this.blueFlagCarrier === playerId) {
      this.blueFlagCarrier = null;
      this.droppedFlags.push({ position, team: 'blue', respawnTimer: 60 });
      this.broadcast({ type: 'flagDropped', position, flagTeam: 'blue', playerId });
    } else if (this.redFlagCarrier === playerId) {
      this.redFlagCarrier = null;
      this.droppedFlags.push({ position, team: 'red', respawnTimer: 60 });
      this.broadcast({ type: 'flagDropped', position, flagTeam: 'red', playerId });
    }
  }

  private handlePlayerDeath(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Scoreboard bookkeeping: count the death (handlePlayerDeath is the single
    // choke point every kill path funnels through, so deaths can't be missed).
    this.getStats(playerId).deaths++;
    this.broadcastStats();

    this.dropCarriedFlag(playerId);
  }

  update(dt: number): void {
    // Advance authoritative server clock (used for footstep throttling etc.)
    this.world.updateTime(dt);

    // Clear stale shooting flags once the 100ms window has elapsed.
    // Done in the game loop instead of per-shot setTimeout so state stays
    // consistent even if a socket closes mid-timeout. (lastShootTime is in seconds)
    const nowSec = Date.now() / 1000;
    for (const player of this.players.values()) {
      if (player instanceof ServerBot) continue; // bots manage their own shoot flag via botUpdate
      if (player.isShooting && nowSec - (this.lastShootTime.get(player.id) || 0) > 0.1) {
        player.isShooting = false;
      }
    }

    // Process scheduled respawns for dead networked players
    if (this.respawnTimers.size > 0) {
      for (const [playerId, timer] of this.respawnTimers) {
        const remaining = timer - dt;
        if (remaining <= 0) {
          this.respawnTimers.delete(playerId);
          const player = this.players.get(playerId);
          if (player && player.isDead) {
            const spawnPos = this.getSpawnPosition(player.team);
            player.respawn(spawnPos);
            // Restore build inventory on respawn (matches join-time value)
            this.inventories.set(playerId, 20);
            if (player instanceof ServerBot) {
              player.refillBlocks();
            }
            this.broadcast({
              type: 'playerRespawned',
              playerId,
              position: spawnPos,
            });
            this.sendToPlayer(playerId, {
              type: 'inventoryUpdated',
              inventory: 20,
            });
          }
        } else {
          this.respawnTimers.set(playerId, remaining);
        }
      }
    }

    // Update all players (humans use client-authoritative input; bots run AI)
    const botCtx = this.getBotContext();
    for (const player of this.players.values()) {
      if (player instanceof ServerBot) continue; // handled below via botUpdate
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

    // Run bot AI (movement, aiming, flanking, camping, building)
    this.updateBots(botCtx);
    
    // Update dropped flag timers
    this.updateDroppedFlags(dt);

    // Update captured flags respawn timers (flags disappear during this period)
    if (this.blueFlagRespawnTimer > 0) {
      this.blueFlagRespawnTimer -= dt;
      if (this.blueFlagRespawnTimer <= 0) {
        this.blueFlagRespawnTimer = 0;
        this.blueFlagAtBase = true;
        this.broadcast({
          type: 'flagReturned',
          flagTeam: 'blue',
        });
      }
    }
    if (this.redFlagRespawnTimer > 0) {
      this.redFlagRespawnTimer -= dt;
      if (this.redFlagRespawnTimer <= 0) {
        this.redFlagRespawnTimer = 0;
        this.redFlagAtBase = true;
        this.broadcast({
          type: 'flagReturned',
          flagTeam: 'red',
        });
      }
    }
    
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
      if (player.isDead || player.isSpectating) continue;

      if (!player.carryingFlag) {
        // Auto-check flag pickup
        this.handleFlagPickup(playerId);
      } else {
        // Carrying flag: check if reached home base to score
        const homeBase = player.team === 'blue' ? this.BLUE_FLAG_POS : this.RED_FLAG_POS;
        const dx = player.position.x - homeBase.x;
        const dz = player.position.z - homeBase.z;
        const distance = Math.hypot(dx, dz);

        if (distance < 6.5) {
          // SCORE A CAPTURE! Flag disappears on capture and enters respawn timer
          if (player.team === 'blue') {
            this.captures.blue++;
            this.redFlagAtBase = false; // Disappears!
            this.redFlagCarrier = null;
            this.redFlagRespawnTimer = 8.0;
          } else {
            this.captures.red++;
            this.blueFlagAtBase = false; // Disappears!
            this.blueFlagCarrier = null;
            this.blueFlagRespawnTimer = 8.0;
          }
          player.carryingFlag = false;
          log.info(`FLAG CAPTURED by ${playerId} (${player.team}) — score blue:${this.captures.blue} red:${this.captures.red}`);

          // Broadcast capture event (flag disappears across all clients).
          // NOTE: the captured flag is the ENEMY flag. Team 'blue' scores by
          // carrying the RED flag home, so we must send flagTeam:'red'.
          this.broadcast({
            type: 'flagCaptured',
            team: player.team,
            flagTeam: player.team === 'blue' ? 'red' : 'blue',
            playerId: playerId,
            captures: this.captures,
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

  private isConnOpen(conn: WebSocket | GameConnection): boolean {
    if ('isOpen' in conn && typeof conn.isOpen === 'function') {
      return conn.isOpen();
    }
    return (conn as WebSocket).readyState === WebSocket.OPEN;
  }

  private sendToPlayer(playerId: string, message: ServerMessage): void {
    const conn = this.connections.get(playerId);
    if (conn && this.isConnOpen(conn)) {
      conn.send(JSON.stringify(message));
    }
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const conn of this.connections.values()) {
      if (this.isConnOpen(conn)) {
        conn.send(data);
      }
    }
  }

  private broadcastExcept(exceptPlayerId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const [playerId, conn] of this.connections) {
      if (playerId !== exceptPlayerId && this.isConnOpen(conn)) {
        conn.send(data);
      }
    }
  }
}
