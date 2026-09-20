import { ClientMessage, ServerMessage, PlayerState, PlayerInput, Position } from '../shared/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;
  private channel: BroadcastChannel | null = null;
  private messageHandlers: Map<string, (message: any) => void> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  private serverUrl: string;
  private onConnectCallback: (() => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  
  public localPeerId: string;
  public assignedPlayerId: string | null = null;
  public transport: 'websocket' | 'sse' | 'broadcast' | 'connecting' = 'connecting';
  private lastKnownTeam: 'red' | 'blue' = 'blue';
  private lastKnownName: string = 'Soldier';
  private lastKnownPos: Position = { x: 0, y: 10, z: 0 };
  private connectedPeers: Set<string> = new Set();
  private wsConnected = false;
  private sseConnected = false;

  constructor(serverUrl?: string) {
    this.localPeerId = `peer_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;

    if (serverUrl && serverUrl.trim()) {
      let url = serverUrl.trim();
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        url = `${protocol}${url}`;
      }
      this.serverUrl = url;
    } else if (typeof window !== 'undefined') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.serverUrl = `${protocol}//${window.location.host}`;
    } else {
      this.serverUrl = 'ws://localhost:3000';
    }

    // Initialize BroadcastChannel for instant zero-latency multi-tab/window mesh sync
    this.initBroadcastChannel();
  }

  private initBroadcastChannel(): void {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('voxel_fps_multiplayer_mesh');
        this.channel.onmessage = (event) => {
          this.handleBroadcastMessage(event.data);
        };
        console.log('📡 Local multi-tab peer synchronization active');
      } catch (err) {
        console.warn('BroadcastChannel not available:', err);
      }
    }
  }

  private handleBroadcastMessage(data: any): void {
    if (!data || !data.senderId || data.senderId === this.localPeerId) return;

    switch (data.type) {
      case 'peer_join':
        this.connectedPeers.add(data.senderId);
        // Dispatch playerJoined
        this.handleMessage({
          type: 'playerJoined',
          playerId: data.senderId,
          state: {
            id: data.senderId,
            name: data.name || 'Remote Soldier',
            team: (data.team as 'red' | 'blue') || 'red',
            position: data.position || { x: 0, y: 10, z: 0 },
            rotation: { yaw: 0, pitch: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            hp: 100,
            isDead: false,
            equipment: 'rifle',
            isAiming: false,
            isCrouching: false,
            isSprinting: false,
            carryingFlag: false,
          },
        } as any);

        // Reply with our presence so the new peer knows about us!
        this.channel?.postMessage({
          type: 'peer_announce',
          senderId: this.localPeerId,
          name: this.lastKnownName,
          team: this.lastKnownTeam,
          position: this.lastKnownPos,
        });
        break;

      case 'peer_announce':
        this.connectedPeers.add(data.senderId);
        this.handleMessage({
          type: 'playerJoined',
          playerId: data.senderId,
          state: {
            id: data.senderId,
            name: data.name || 'Remote Soldier',
            team: (data.team as 'red' | 'blue') || 'red',
            position: data.position || { x: 0, y: 10, z: 0 },
            rotation: { yaw: 0, pitch: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            hp: 100,
            isDead: false,
            equipment: 'rifle',
            isAiming: false,
            isCrouching: false,
            isSprinting: false,
            carryingFlag: false,
          },
        } as any);
        break;

      case 'peer_input':
        this.handleMessage({
          type: 'playerUpdated',
          playerId: data.senderId,
          state: {
            id: data.senderId,
            name: data.name || 'Remote Soldier',
            team: (data.team as 'red' | 'blue') || 'red',
            position: data.input.position || { x: 0, y: 10, z: 0 },
            rotation: { yaw: data.input.yaw, pitch: data.input.pitch },
            velocity: { x: 0, y: 0, z: 0 },
            hp: 100,
            isDead: false,
            equipment: data.input.equipment || 'rifle',
            isAiming: false,
            isCrouching: data.input.crouch || false,
            isSprinting: data.input.sprint || false,
            carryingFlag: false,
          },
        } as any);
        break;

      case 'peer_shot':
        this.handleMessage({
          type: 'playerShot',
          playerId: data.senderId,
          origin: data.origin,
          direction: data.direction,
          weapon: data.weapon || 'rifle',
        } as any);
        break;

      case 'peer_voxel':
        this.handleMessage({
          type: 'voxelChanged',
          change: data.change,
        } as any);
        break;

      case 'peer_flag_picked':
        this.handleMessage({
          type: 'flagPickedUp',
          playerId: data.senderId,
          flagTeam: data.flagTeam,
        } as any);
        break;

      case 'peer_flag_dropped':
        this.handleMessage({
          type: 'flagDropped',
          position: data.position,
          flagTeam: data.flagTeam,
        } as any);
        break;

      case 'peer_flag_returned':
        this.handleMessage({
          type: 'flagReturned',
          flagTeam: data.flagTeam,
        } as any);
        break;

      case 'peer_flag_captured':
        this.handleMessage({
          type: 'flagCaptured',
          playerId: data.senderId,
          team: data.team,
          captures: data.captures || { red: 0, blue: 0 },
        } as any);
        break;

      case 'peer_leave':
        this.connectedPeers.delete(data.senderId);
        this.handleMessage({
          type: 'playerLeft',
          playerId: data.senderId,
        } as any);
        break;
    }
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getTransport(): string {
    if (this.wsConnected) return 'WebSocket';
    if (this.sseConnected) return 'HTTP SSE';
    if (this.channel) return 'Multi-Tab Mesh';
    return 'Connecting...';
  }

  getConnectedPeerCount(): number {
    return this.connectedPeers.size;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;

      const finishConnect = (transportType: 'websocket' | 'sse') => {
        if (!settled) {
          settled = true;
          this.transport = transportType;
          if (transportType === 'websocket') this.wsConnected = true;
          if (transportType === 'sse') this.sseConnected = true;
          this.reconnectAttempts = 0;
          if (this.onConnectCallback) {
            this.onConnectCallback();
          }
          resolve();
        }
      };

      // 1. Try WebSocket primary connection
      try {
        console.log('Connecting to WebSocket server:', this.serverUrl);
        this.ws = new WebSocket(this.serverUrl);

        const wsTimeout = setTimeout(() => {
          if (!this.wsConnected && !this.sseConnected) {
            console.log('WebSocket connection taking long, initiating HTTP SSE fallback...');
            this.connectSSE(finishConnect);
          }
        }, 2200);

        this.ws.onopen = () => {
          clearTimeout(wsTimeout);
          console.log('✅ Connected via WebSocket');
          finishConnect('websocket');
        };

        this.ws.onmessage = (event) => {
          try {
            const message: ServerMessage = JSON.parse(event.data);
            if (message.type === 'init') {
              this.assignedPlayerId = (message as any).playerId;
            }
            this.handleMessage(message);
          } catch (error) {
            console.error('Error parsing WS message:', error);
          }
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          this.wsConnected = false;
          if (!this.sseConnected) {
            this.connectSSE(finishConnect);
          }
        };

        this.ws.onerror = (error) => {
          console.warn('WebSocket connection note (initiating fallback):', error);
          if (!this.wsConnected && !this.sseConnected) {
            this.connectSSE(finishConnect);
          }
        };
      } catch (error) {
        console.warn('WebSocket init exception, falling back to SSE:', error);
        this.connectSSE(finishConnect);
      }

      // If both fail, resolve with Multi-Tab mesh active
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.transport = 'broadcast';
          if (this.onConnectCallback) this.onConnectCallback();
          resolve();
        }
      }, 3500);
    });
  }

  private connectSSE(onSuccess?: (type: 'sse') => void): void {
    if (this.sse || this.sseConnected || typeof window === 'undefined') return;

    try {
      console.log('Connecting to HTTP Server-Sent Events (SSE) stream at /api/game/events...');
      const sseUrl = '/api/game/events';
      this.sse = new EventSource(sseUrl);

      this.sse.onopen = () => {
        console.log('✅ Connected via HTTP Server-Sent Events (SSE)');
        this.sseConnected = true;
        this.transport = 'sse';
        if (onSuccess) onSuccess('sse');
        if (this.onConnectCallback) this.onConnectCallback();
      };

      this.sse.onmessage = (event) => {
        try {
          if (!event.data || event.data.startsWith(':')) return;
          const message: ServerMessage = JSON.parse(event.data);
          if (message.type === 'init') {
            this.assignedPlayerId = (message as any).playerId;
          }
          this.handleMessage(message);
        } catch (err) {
          console.error('Error parsing SSE event data:', err);
        }
      };

      this.sse.onerror = () => {
        console.warn('SSE stream status update');
      };
    } catch (err) {
      console.warn('SSE fallback error:', err);
    }
  }

  private handleMessage(message: ServerMessage): void {
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    }
  }

  send(message: ClientMessage): void {
    // 1. Send via WebSocket if open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else if (this.sseConnected) {
      // 2. Send via HTTP POST
      fetch('/api/game/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: this.assignedPlayerId || this.localPeerId,
          message,
        }),
      }).catch((err) => console.warn('HTTP game message send warning:', err));
    }

    // 3. Always mirror to local browser tabs for immediate zero-latency peer sync
    if (this.channel) {
      this.mirrorToLocalPeers(message);
    }
  }

  private mirrorToLocalPeers(message: ClientMessage): void {
    switch (message.type) {
      case 'join':
        this.lastKnownTeam = message.team;
        if (message.name) this.lastKnownName = message.name;
        if (message.position) this.lastKnownPos = message.position;
        this.channel?.postMessage({
          type: 'peer_join',
          senderId: this.localPeerId,
          team: message.team,
          name: message.name,
          position: message.position,
        });
        break;

      case 'playerInput':
        this.channel?.postMessage({
          type: 'peer_input',
          senderId: this.localPeerId,
          input: message.input,
          team: this.lastKnownTeam,
          name: this.lastKnownName,
        });
        break;

      case 'shoot':
        this.channel?.postMessage({
          type: 'peer_shot',
          senderId: this.localPeerId,
          origin: message.origin,
          direction: message.direction,
        });
        break;

      case 'build':
        this.channel?.postMessage({
          type: 'peer_voxel',
          senderId: this.localPeerId,
          change: {
            x: message.position.x,
            y: message.position.y,
            z: message.position.z,
            type: 4,
            durability: 3,
          },
        });
        break;

      case 'useTool':
        if (message.tool === 'spade') {
          this.channel?.postMessage({
            type: 'peer_voxel',
            senderId: this.localPeerId,
            change: {
              x: message.target.x,
              y: message.target.y,
              z: message.target.z,
              type: 0,
              durability: 0,
            },
          });
        }
        break;

      case 'pickupFlag':
        this.channel?.postMessage({
          type: 'peer_flag_picked',
          senderId: this.localPeerId,
          flagTeam: this.lastKnownTeam === 'blue' ? 'red' : 'blue',
        });
        break;

      case 'captureFlag':
        this.channel?.postMessage({
          type: 'peer_flag_captured',
          senderId: this.localPeerId,
          team: message.team,
        });
        break;
    }
  }

  onMessage(type: string, handler: (message: any) => void): void {
    this.messageHandlers.set(type, handler);
  }

  onConnect(callback: () => void): void {
    this.onConnectCallback = callback;
    if (this.wsConnected || this.sseConnected) {
      callback();
    }
  }

  onDisconnect(callback: () => void): void {
    this.onDisconnectCallback = callback;
  }

  disconnect(): void {
    if (this.channel) {
      this.channel.postMessage({
        type: 'peer_leave',
        senderId: this.localPeerId,
      });
      this.channel.close();
      this.channel = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.sse) {
      this.sse.close();
      this.sse = null;
    }
    this.wsConnected = false;
    this.sseConnected = false;
  }

  isConnected(): boolean {
    return this.wsConnected || this.sseConnected || (this.channel !== null);
  }

  // Helper methods for common messages
  sendJoin(team: 'red' | 'blue', position?: Position, name?: string): void {
    this.send({ type: 'join', team, position, name });
  }

  sendPlayerInput(input: PlayerInput): void {
    this.send({ type: 'playerInput', input });
  }

  sendShoot(origin: Position, direction: Position, hitTarget?: { targetId: string; isHeadshot: boolean }): void {
    this.send({
      type: 'shoot',
      origin,
      direction,
      targetId: hitTarget?.targetId,
      isHeadshot: hitTarget?.isHeadshot,
    });
  }

  sendReload(): void {
    this.send({ type: 'reload' });
  }

  sendUseTool(tool: 'pickaxe' | 'spade', target: Position): void {
    this.send({ type: 'useTool', tool, target });
  }

  sendBuild(position: Position): void {
    this.send({ type: 'build', position });
  }

  sendToggleSpectator(): void {
    this.send({ type: 'toggleSpectator' });
  }

  sendFootstep(volume: number, pitch: number): void {
    this.send({ type: 'footstep', volume, pitch });
  }
}
