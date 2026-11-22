import { ClientMessage, ServerMessage, PlayerInput, Position } from '../shared/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;
  private channel: BroadcastChannel | null = null;
  private messageHandlers: Map<string, (message: any) => void> = new Map();
  private reconnectDelay = 2000;
  /** Pending retry after a fallback stream is dropped by a proxy. */
  private reconnectTimer: number | null = null;
  private serverUrl: string;
  private onConnectCallback: (() => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  /** Set once per lost session, so the game hears "disconnected" exactly once. */
  private disconnectNotified = false;
  
  public localPeerId: string;
  public assignedPlayerId: string | null = null;
  /** Session token from `init`; the HTTP/SSE fallback must present it so the
   *  server can bind a POSTed message to this connection's player. */
  private sessionToken: string | null = null;
  /** Messages sent before `init` (token) arrives, flushed once it does. */
  private queuedMessages: ClientMessage[] = [];
  public transport: 'websocket' | 'sse' | 'broadcast' | 'connecting' = 'connecting';
  /** Identity asserted on every session — see adoptSession(). */
  private team: 'red' | 'blue';
  private name: string;
  private lastKnownPos: Position = { x: 0, y: 10, z: 0 };
  private connectedPeers: Set<string> = new Set();
  private wsConnected = false;
  private sseConnected = false;

  constructor(serverUrl?: string, team: 'red' | 'blue' = 'blue', name = 'Soldier') {
    this.localPeerId = `peer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.team = team;
    this.name = name;

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
      } catch (err) {
        console.warn('BroadcastChannel not available:', err);
      }
    }
  }

  private handleBroadcastMessage(data: any): void {
    if (!data || !data.senderId || data.senderId === this.localPeerId) return;
    // When a server is active it owns player and vehicle state. BroadcastChannel
    // peer duplicates otherwise appear as ghost on-foot players beside jeeps.
    if (this.wsConnected || this.sseConnected) return;

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
          name: this.name,
          team: this.team,
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

  /** HTTP origin of the configured game server, for the SSE/HTTP fallback.
   *
   *  It must follow `&server=`, not the page origin: on a static host (GitHub
   *  Pages) a relative path asks the static host for game routes it does not
   *  serve, so the fallback 404s and the game looks dead even when a server is
   *  configured. */
  private httpBaseUrl(): string {
    return this.serverUrl.replace(/^ws/i, 'http').replace(/\/+$/, '');
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
          this.disconnectNotified = false;
          if (this.onConnectCallback) {
            this.onConnectCallback();
          }
          resolve();
        } else if (transportType === 'sse' && !this.wsConnected) {
          // A fallback that opens after the initial connection has ended is a
          // fresh server session and must send join again.
          this.transport = 'sse';
          this.onConnectCallback?.();
        }
      };

      // 1. Try WebSocket primary connection
      try {
        // A retry must not leave the previous socket dangling.
        if (this.ws) {
          // Detach the handler: closing it on purpose is not a lost session.
          this.ws.onclose = null;
          try { this.ws.close(); } catch { /* already closed */ }
          this.ws = null;
        }
        this.ws = new WebSocket(this.serverUrl);

        // A slow upgrade is not a failure. Over a tunnel or a slow mobile link
        // the handshake plus the ~100 KB `init` frame takes a couple of seconds,
        // and the old 2.2s cut-off moved those players onto the SSE stream. Any
        // proxy that caps long-lived responses (Serveo closes a stream at ~10s)
        // then closed that stream, EventSource silently re-opened it as a
        // brand-new player, and the game looped connect -> join -> leave forever
        // while looking "connected". Only fall back once the socket is really
        // unusable, and give the init frame time to arrive.
        const wsTimeout = setTimeout(() => {
          if (this.wsConnected || this.sseConnected) return;
          // Still open: the 8s init timeout below is what decides a silent socket.
          if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
          this.connectSSE(finishConnect);
        }, 10000);

        // An accepted upgrade is not a working session: a proxy or a half-open
        // socket can complete the handshake and never deliver the `init` frame.
        // Treating that as connected made Beta look alive while no state ever
        // arrived — bots frozen and every mine/build/shoot silently dropped.
        let initTimeout: ReturnType<typeof setTimeout> | null = null;
        const failSilentSocket = (why: string) => {
          if (initTimeout) { clearTimeout(initTimeout); initTimeout = null; }
          if (this.wsConnected || this.sseConnected) return;
          console.warn(`WebSocket ${why} — dropping it and retrying`);
          try { this.ws?.close(); } catch { /* ignore */ }
          this.ws = null;
          this.connectSSE(finishConnect);
        };

        this.ws.onopen = () => {
          clearTimeout(wsTimeout);
          initTimeout = setTimeout(() => failSilentSocket('delivered no init within 8s'), 8000);
        };

        this.ws.onmessage = (event) => {
          if (!this.wsConnected) {
            if (initTimeout) { clearTimeout(initTimeout); initTimeout = null; }
            finishConnect('websocket');
          }
          try {
            this.handleMessage(JSON.parse(event.data) as ServerMessage);
          } catch (error) {
            console.error('Error parsing WS message:', error);
          }
        };

        this.ws.onclose = () => {
          const hadSession = this.wsConnected;
          this.wsConnected = false;
          if (hadSession) this.notifyDisconnect();
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
      const sseUrl = `${this.httpBaseUrl()}/api/game/events`;
      this.sse = new EventSource(sseUrl);

      this.sse.onopen = () => {
        this.sseConnected = true;
        this.disconnectNotified = false;
        this.transport = 'sse';
        if (onSuccess) onSuccess('sse');
        else if (this.onConnectCallback) this.onConnectCallback();
      };

      this.sse.onmessage = (event) => {
        try {
          if (!event.data || event.data.startsWith(':')) return;
          this.handleMessage(JSON.parse(event.data) as ServerMessage);
        } catch (err) {
          console.error('Error parsing SSE event data:', err);
        }
      };

      // EventSource reopens by itself, but a reopened stream is a *new* server
      // session: the old player leaves and a fresh one joins. Behind a proxy that
      // cuts long-lived streams that is an endless join/leave loop, so drop the
      // dead stream and go back to the WebSocket transport instead.
      this.sse.onerror = () => {
        console.warn('SSE stream status update');
        if (!this.sse || this.sse.readyState !== EventSource.CLOSED) return;
        const hadSession = this.sseConnected;
        try { this.sse.close(); } catch { /* already closed */ }
        this.sse = null;
        this.sseConnected = false;
        if (hadSession) this.notifyDisconnect();
        if (this.transport === 'sse') this.transport = 'connecting';
        if (this.reconnectTimer === null) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.wsConnected || this.sseConnected) return;
            this.connect();
          }, this.reconnectDelay);
        }
      };
    } catch (err) {
      console.warn('SSE fallback error:', err);
    }
  }

  private handleMessage(message: ServerMessage): void {
    // Both transports funnel through here, so a session is adopted — and joined —
    // in exactly one place, whether it arrived on the socket or a reopened stream.
    if (message.type === 'init') this.adoptSession(message);
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    }
  }

  /** Take ownership of a freshly opened server session and join it. */
  private adoptSession(message: ServerMessage): void {
    const init = message as { playerId?: string; sessionToken?: unknown };
    if (typeof init.playerId === 'string') this.assignedPlayerId = init.playerId;
    this.sessionToken = typeof init.sessionToken === 'string' ? init.sessionToken : null;
    this.flushQueuedMessages();
    this.send({ type: 'join', team: this.team, name: this.name });
  }

  send(message: ClientMessage): void {
    // 1. Send via WebSocket if open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else if (this.sseConnected && this.sessionToken) {
      // 2. Send via HTTP POST, authenticated by the session token from `init`.
      this.postSse(message);
    } else if (this.sseConnected) {
      // init has not landed yet — hold the message (bounded) until it does.
      if (this.queuedMessages.length < 50) this.queuedMessages.push(message);
    }

    // 3. Always mirror to local browser tabs for immediate zero-latency peer sync
    if (this.channel) {
      this.mirrorToLocalPeers(message);
    }
  }

  private postSse(message: ClientMessage): void {
    if (!this.sessionToken) return;
    fetch(`${this.httpBaseUrl()}/api/game/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.sessionToken, message }),
    }).catch((err) => console.warn('HTTP game message send warning:', err));
  }

  private flushQueuedMessages(): void {
    if (!this.sessionToken || !this.sseConnected || this.queuedMessages.length === 0) return;
    const queued = this.queuedMessages;
    this.queuedMessages = [];
    for (const message of queued) this.postSse(message);
  }

  private mirrorToLocalPeers(message: ClientMessage): void {
    switch (message.type) {
      case 'join':
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
          team: this.team,
          name: this.name,
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

      case 'pickupFlag':
        this.channel?.postMessage({
          type: 'peer_flag_picked',
          senderId: this.localPeerId,
          flagTeam: this.team === 'blue' ? 'red' : 'blue',
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

  /** Tell the game that a live session ended, once, before any reconnect. */
  private notifyDisconnect(): void {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.onDisconnectCallback?.();
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    // Only a real server connection counts. The BroadcastChannel merely mirrors
    // messages between this browser's own tabs, so including it made online/Beta
    // play report "connected" with no server: no state arrived (no bots) and
    // every action was dropped silently.
    return this.wsConnected || this.sseConnected;
  }

  // Helper methods for common messages
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

  sendRequestRespawn(): void {
    this.send({ type: 'requestRespawn' });
  }

  sendFootstep(volume: number, pitch: number): void {
    this.send({ type: 'footstep', volume, pitch });
  }

  /** Round-trip latency probe: the server echoes the timestamp straight back. */
  ping(t: number): void {
    this.send({ type: 'ping', t });
  }
}
