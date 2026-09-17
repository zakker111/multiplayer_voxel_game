import { ClientMessage, ServerMessage, PlayerState, PlayerInput, Position } from '../shared/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Map<string, (message: any) => void> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  private serverUrl: string;
  private onConnectCallback: (() => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;

  constructor(serverUrl?: string) {
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
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      try {
        console.log('Connecting to server:', this.serverUrl);
        this.ws = new WebSocket(this.serverUrl);

        this.ws.onopen = () => {
          settled = true;
          console.log('Connected to server');
          this.reconnectAttempts = 0;
          if (this.onConnectCallback) {
            this.onConnectCallback();
          }
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: ServerMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('Error parsing message:', error);
          }
        };

        this.ws.onclose = () => {
          console.log('Disconnected from server');
          if (this.onDisconnectCallback) {
            this.onDisconnectCallback();
          }
          if (!settled) {
            settled = true;
            resolve();
          }
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.warn('WebSocket notice (non-fatal):', error);
          if (!settled) {
            settled = true;
            resolve();
          }
        };
      } catch (error) {
        console.warn('Connection notice (non-fatal):', error);
        if (!settled) {
          settled = true;
          resolve();
        }
      }
    });
  }

  private handleMessage(message: ServerMessage): void {
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    } else {
      console.warn('No handler for message type:', message.type);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      setTimeout(() => {
        this.connect().catch((error) => {
          console.error('Reconnection failed:', error);
        });
      }, this.reconnectDelay);
    } else {
      console.error('Max reconnection attempts reached');
    }
  }

  send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('Cannot send message: WebSocket not connected');
    }
  }

  onMessage(type: string, handler: (message: any) => void): void {
    this.messageHandlers.set(type, handler);
  }

  onConnect(callback: () => void): void {
    this.onConnectCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.onDisconnectCallback = callback;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
