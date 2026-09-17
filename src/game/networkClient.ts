import { ServerToClientMessage, ClientToServerMessage, GameState } from '../shared/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private messageQueue: ClientToServerMessage[] = [];
  
  public isSinglePlayer: boolean = false;
  public gameState: GameState | null = null;
  
  private onGameStateCallback: ((state: GameState) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private onPlayerJoinedCallback: ((player: any) => void) | null = null;
  private onPlayerLeftCallback: ((id: string) => void) | null = null;
  private onFlagCapturedCallback: ((team: 'red' | 'blue', scorer: string) => void) | null = null;

  constructor() {
    // Detect if running on GitHub Pages
    const isGitHubPages = window.location.hostname.includes('github.io');
    if (isGitHubPages) {
      console.log('[Network] Running on GitHub Pages - Single Player Mode');
      this.isSinglePlayer = true;
      this.initSinglePlayer();
    }
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
          
          // Send queued messages
          this.messageQueue.forEach(msg => this.send(msg));
          this.messageQueue = [];
          
          resolve(true);
        };

        this.ws.onmessage = (event) => {
          try {
            const message: ServerToClientMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (e) {
            console.error('[Network] Failed to parse message:', e);
          }
        };

        this.ws.onclose = () => {
          console.log('[Network] Disconnected from server');
          this.connected = false;
          
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

  private handleMessage(message: ServerToClientMessage) {
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

  send(message: ClientToServerMessage) {
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

  private handleSinglePlayerMessage(message: ClientToServerMessage) {
    if (!this.gameState) return;

    switch (message.type) {
      case 'move':
        // Update local player position (handled by game loop)
        break;
      case 'shoot':
        // Handle shooting locally (add bot hits etc.)
        break;
      case 'destroyBlock':
      case 'placeBlock':
        // Handle world modifications locally
        break;
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  onGameState(callback: (state: GameState) => void) {
    this.onGameStateCallback = callback;
  }

  onPlayerJoined(callback: (player: any) => void) {
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
