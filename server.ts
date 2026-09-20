import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { ServerGame, GameConnection } from './src/server/serverGame';

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
  clientIp?: string;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const server = http.createServer(app);

  // Create game instance & WebSocket server
  const game = new ServerGame();
  const wss = new WebSocketServer({ noServer: true });

  // Health and status check endpoints
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: Date.now() });
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      status: 'online',
      serverTime: Date.now(),
      connectedPlayers: wss.clients.size,
      tickRate: 20,
      version: '1.0.0',
    });
  });

  // SSE Game stream fallback (guarantees connectivity behind HTTP proxies, iframes, and restrictive firewalls)
  app.get('/api/game/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders?.();

    // Send initial keepalive comment to open the stream
    res.write(': sse-connected\n\n');

    const conn: GameConnection = {
      send: (data: string) => {
        if (!res.writableEnded) {
          res.write(`data: ${data}\n\n`);
        }
      },
      isOpen: () => !res.writableEnded,
    };

    const playerId = game.addPlayer(conn);
    console.log(`📡 SSE Client connected (${playerId})`);

    req.on('close', () => {
      console.log(`📡 SSE Client closed (${playerId})`);
      game.removePlayer(playerId);
    });
  });

  app.post('/api/game/message', (req, res) => {
    const { playerId, message } = req.body || {};
    if (playerId && message) {
      game.handleMessage(playerId, message);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Missing playerId or message' });
    }
  });

  // Keep-alive heartbeat to prevent reverse proxies (Cloud Run, Nginx, Cloudflare) from dropping idle connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as AliveWebSocket;
      if (extWs.isAlive === false) {
        console.log(`⏰ Terminating inactive WebSocket connection from ${extWs.clientIp || 'client'}`);
        return ws.terminate();
      }
      extWs.isAlive = false;
      ws.ping();
    });
  }, 25000);

  wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    const extWs = ws as AliveWebSocket;
    extWs.isAlive = true;

    const forwarded = request.headers['x-forwarded-for'];
    const clientIp = typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : request.socket.remoteAddress || 'unknown';
    extWs.clientIp = clientIp;

    console.log(`👤 Client connected from ${clientIp} (Total clients: ${wss.clients.size})`);
    const playerId = game.addPlayer(ws);

    ws.on('pong', () => {
      extWs.isAlive = true;
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString());
        game.handleMessage(playerId, message);
      } catch (error) {
        console.error('❌ Error handling message:', error);
      }
    });

    ws.on('close', () => {
      console.log(`👋 Client disconnected (${playerId}) from ${clientIp}`);
      game.removePlayer(playerId);
    });

    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
    });
  });

  // Handle WebSocket upgrade for root path and /ws
  server.on('upgrade', (request, socket, head) => {
    const { url, headers } = request;
    // Don't intercept Vite HMR websocket in dev mode
    if (
      url?.startsWith('/@vite') ||
      url?.includes('vite') ||
      headers['sec-websocket-protocol'] === 'vite-hmr'
    ) {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Game tick loop - 20 ticks per second
  const TICK_RATE = 20;
  const TICK_INTERVAL = 1000 / TICK_RATE;
  const gameInterval = setInterval(() => {
    game.update(TICK_INTERVAL / 1000);
    game.broadcastState();
  }, TICK_INTERVAL);

  console.log(`⚙️  Game server loop started with tick rate: ${TICK_RATE}Hz`);

  server.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(gameInterval);
  });

  // Vite middleware in dev / static in prod
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎮 Voxel FPS Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
