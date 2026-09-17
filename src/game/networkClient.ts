import { 
  ServerMessage, 
  ClientMessage, 
  GameState, 
  PlayerState, 
  PlayerInput 
} from '../shared/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private messageQueue: ClientMessage[] = [];
  
  public isSinglePlayer: boolean = false;
  public gameState: GameState | null = null;
  
  private onConnectCallback: (() => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private onMessageCallback: ((msg: ServerMessage) => void) | null = null;
  private onGameStateCallback: ((state: GameState) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private onPlayerJoinedCallback: ((player: PlayerState) => void) | null = null;
  private onPlayerLeftCallback: ((id: string) => void) | null = null;
  private onFlagCapturedCallback: ((team: 'red' | 'blue', scorer: string) => void) | null = null;

  constructor(serverUrl?: string) {
    // Store server URL for later use
    this.serverUrl = serverUrl;
    
    // Detect if running on GitHub Pages
    const isGitHubPages = window.location.hostname.includes('github.io');
    if (isGitHubPages) {
      console.log('[Network] Running on GitHub Pages - Single Player Mode');
      this.isSinglePlayer = true;
      this.initSinglePlayer();
    }
  }

  private serverUrl?: string;

  public get isConnected(): boolean {
    return this.connected || this.isSinglePlayer;
  }

  private initSinglePlayer() {
    // Initialize single player game state
    this.gameState = {
      players: [],
      flags: {
        red: { x: 0, y: 8, z: 95, captured: false },
        blue: { x: 0, y: 8, z: -95, captured: false }
      },
      scores: { red: 0, blue: 0 },
      timeRemaining: 600
    };
    this.connected = true;
    console.log('[Network] Single player mode initialized');
  }

  connect(serverUrl?: string): Promise<boolean> {
    if (this.isSinglePlayer) {
      if (this.onConnectCallback) this.onConnectCallback();
      return Promise.resolve(true);
    }

    const url = serverUrl || `ws://${window.location.hostname}:3000`;
    
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(url);
        
        this.ws.onopen = () => {
          console.log('[Network] Connected to server');
          this.connected = true;
          this.reconnectAttempts = 0;
          
          if (this.onConnectCallback) this.onConnectCallback();
          
          // Send queued messages
          this.messageQueue.forEach(msg => this.send(msg));
          this.messageQueue = [];
          
          resolve(true);
        };

        this.ws.onmessage = (event) => {
          try {
            const message: ServerMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (e) {
            console.error('[Network] Failed to parse message:', e);
          }
        };

        this.ws.onclose = () => {
          console.log('[Network] Disconnected from server');
          this.connected = false;
          
          if (this.onDisconnectCallback) this.onDisconnectCallback();
          
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => {
              console.log(`[Network] Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
              this.connect(serverUrl).then(resolve);
            }, 2000 * this.reconnectAttempts);
          } else {
            console.log('[Network] Max reconnect attempts reached - switching to single player');
            this.isSinglePlayer = true;
            this.initSinglePlayer();
            resolve(true);
          }
        };

        this.ws.onerror = (error) => {
          console.error('[Network] WebSocket error:', error);
          if (this.onErrorCallback) {
            this.onErrorCallback('Connection failed');
          }
        };
      } catch (e) {
        console.error('[Network] Failed to connect:', e);
        this.isSinglePlayer = true;
        this.initSinglePlayer();
        resolve(true);
      }
    });
  }

  private handleMessage(message: ServerMessage) {
    // Call general message callback
    if (this.onMessageCallback) {
      this.onMessageCallback(message);
    }

    switch (message.type) {
      case 'gameState':
        this.gameState = message.state;
        if (this.onGameStateCallback) {
          this.onGameStateCallback(message.state);
        }
        break;
      case 'playerJoined':
        if (this.onPlayerJoinedCallback) {
          this.onPlayerJoinedCallback(message.player);
        }
        break;
      case 'playerLeft':
        if (this.onPlayerLeftCallback) {
          this.onPlayerLeftCallback(message.playerId);
        }
        break;
      case 'flagCaptured':
        if (this.onFlagCapturedCallback) {
          this.onFlagCapturedCallback(message.team, message.scorer);
        }
        break;
      case 'error':
        if (this.onErrorCallback) {
          this.onErrorCallback(message.message);
        }
        break;
    }
  }

  send(message: ClientMessage) {
    if (this.isSinglePlayer) {
      // Handle single player logic locally
      this.handleSinglePlayerMessage(message);
      return;
    }

    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  private handleSinglePlayerMessage(message: ClientMessage) {
    if (!this.gameState) return;

    switch (message.type) {
      case 'playerInput':
        // Update local player position (handled by game loop)
        break;
      case 'shoot':
        // Handle shooting locally (add bot hits etc.)
        break;
      case 'useTool':
      case 'build':
        // Handle world modifications locally
        break;
      case 'reload':
      case 'toggleSpectator':
      case 'captureFlag':
      case 'join':
      case 'heartbeat':
        // Handled locally or ignored in single player
        break;
    }
  }

  sendJoin(team: 'red' | 'blue', position: { x: number; y: number; z: number }, name?: string) {
    // Legacy API with 3 args - adapt to new format
    this.send({ type: 'join', name: name || 'Player', team });
  }

  sendPlayerInput(input: PlayerInput) {
    this.send({ type: 'playerInput', input });
  }

  sendShoot(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    this.send({ type: 'shoot', x, y, z, dx, dy, dz });
  }

  sendUseTool(action: 'destroy' | 'build', x: number, y: number, z: number, blockType?: number) {
    this.send({ type: 'useTool', action, x, y, z, blockType });
  }

  sendBuild(x: number, y: number, z: number, blockType: number) {
    this.send({ type: 'build', x, y, z, blockType });
  }

  sendReload() {
    this.send({ type: 'reload' });
  }

  sendToggleSpectator() {
    this.send({ type: 'toggleSpectator' });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    if (this.onDisconnectCallback) this.onDisconnectCallback();
  }

  // Event callbacks - support both new and legacy API
  onConnect(callback: () => void) {
    this.onConnectCallback = callback;
  }

  onDisconnect(callback: () => void) {
    this.onDisconnectCallback = callback;
  }

  onMessage(eventTypeOrCallback: string | ((msg: ServerMessage) => void), callback?: (msg: any) => void) {
    // Support legacy API: onMessage('eventType', callback)
    if (typeof eventTypeOrCallback === 'string' && callback) {
      const eventType = eventTypeOrCallback;
      // Wrap the callback to filter by event type
      this.onMessageCallback = (msg: ServerMessage) => {
        if (msg.type === eventType) {
          callback(msg);
        }
      };
    } else if (typeof eventTypeOrCallback === 'function') {
      // New API: onMessage(callback)
      this.onMessageCallback = eventTypeOrCallback;
    }
  }

  onGameState(callback: (state: GameState) => void) {
    this.onGameStateCallback = callback;
  }

  onPlayerJoined(callback: (player: PlayerState) => void) {
    this.onPlayerJoinedCallback = callback;
  }

  onPlayerLeft(callback: (id: string) => void) {
    this.onPlayerLeftCallback = callback;
  }

  onFlagCaptured(callback: (team: 'red' | 'blue', scorer: string) => void) {
    this.onFlagCapturedCallback = callback;
  }

  onError(callback: (error: string) => void) {
    this.onErrorCallback = callback;
  }
}
