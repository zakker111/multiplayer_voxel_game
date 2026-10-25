import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { ServerGame, GameConnection } from './src/server/serverGame';
import { normalizeIp } from './src/server/banStore';
import { createLogger } from './src/server/logger';

const log = createLogger('server');

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
  clientIp?: string;
}

/** Simple timing-safe-ish comparison for the admin token. */
function tokenOk(provided: string | undefined, required: string): boolean {
  if (!required) return true; // no ADMIN_TOKEN set => local dev mode, allow all
  if (!provided) return false;
  if (provided.length !== required.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ required.charCodeAt(i);
  return diff === 0;
}

async function startServer() {
  const app = express();
  // Respect hosting platforms (Render, Railway, Fly.io) that inject PORT
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const startedAt = Date.now();

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

  // ---------------- Admin API (CLI + curl) ----------------
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
  if (!ADMIN_TOKEN) {
    log.warn('ADMIN_TOKEN not set — admin API open to localhost only. Set ADMIN_TOKEN to allow remote access.');
  }

  const adminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // The "localhost-only" fallback must be decided from the REAL socket address.
    // X-Forwarded-For is client-controlled: behind a proxy (Render et al.) any
    // remote caller could send "X-Forwarded-For: 127.0.0.1" and reach the
    // kick/ban endpoints while ADMIN_TOKEN is unset. The forwarded value is
    // still used for logging, and an unresolvable address is never "local".
    const socketIp = normalizeIp(req.socket.remoteAddress);
    const ip = normalizeIp(
      typeof req.headers['x-forwarded-for'] === 'string'
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : req.socket.remoteAddress,
    );
    const isLocal = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string) || '';
    if (tokenOk(provided, ADMIN_TOKEN) && (ADMIN_TOKEN || isLocal)) {
      return next();
    }
    log.warn(`admin request denied from ${ip} (socket ${socketIp})`);
    res.status(401).json({ error: 'Unauthorized: provide Authorization: Bearer <ADMIN_TOKEN>' });
  };

  const findTargets = (target: string): string[] => {
    // exact player id, else name match (case-insensitive)
    if (game.listPlayers().some((p) => p.id === target)) return [target];
    return game
      .listPlayers()
      .filter((p) => p.name.toLowerCase() === target.toLowerCase())
      .map((p) => p.id);
  };

  app.get('/api/admin/status', adminAuth, (_req, res) => {
    res.json({
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      players: game.listPlayers().length,
      bans: game.bans.list().length,
      banFile: game.bans.filePath,
      tickRate: 20,
    });
  });

  app.get('/api/admin/players', adminAuth, (_req, res) => {
    res.json({ players: game.listPlayers() });
  });

  app.get('/api/admin/bans', adminAuth, (_req, res) => {
    res.json({ bans: game.bans.list() });
  });

  app.post('/api/admin/kick', adminAuth, (req, res) => {
    const { target, reason } = req.body || {};
    if (!target) return res.status(400).json({ error: 'Missing "target" (playerId or name)' });
    const ids = findTargets(String(target));
    if (!ids.length) return res.status(404).json({ error: `No connected player matches "${target}"` });
    for (const id of ids) game.kickPlayer(id, reason || 'kicked by admin', false);
    log.info(`ADMIN kick: ${ids.join(',')} reason="${reason || 'n/a'}"`);
    res.json({ ok: true, kicked: ids });
  });

  app.post('/api/admin/ban', adminAuth, (req, res) => {
    const { kind = 'ip', value, reason } = req.body || {};
    if (!value) return res.status(400).json({ error: 'Missing "value" (ip or name)' });
    if (kind !== 'ip' && kind !== 'name') return res.status(400).json({ error: 'kind must be "ip" or "name"' });
    const kicked: string[] = [];
    if (kind === 'ip') {
      const norm = normalizeIp(String(value));
      const before = new Set(game.listPlayers().map((p) => p.id));
      game.banIp(norm, reason || 'banned by admin');
      const after = new Set(game.listPlayers().map((p) => p.id));
      for (const id of before) if (!after.has(id)) kicked.push(id);
    } else {
      game.bans.add('name', String(value).toLowerCase(), reason || 'banned by admin');
      const ids = game.listPlayers().filter((p) => p.name.toLowerCase() === String(value).toLowerCase()).map((p) => p.id);
      for (const id of ids) { game.kickPlayer(id, reason || 'banned by admin', false); kicked.push(id); }
      log.info(`ADMIN name-ban: ${value} reason="${reason || 'n/a'}"`);
    }
    res.json({ ok: true, kicked, bansTotal: game.bans.list().length });
  });

  app.post('/api/admin/unban', adminAuth, (req, res) => {
    const { kind = 'ip', value } = req.body || {};
    if (!value) return res.status(400).json({ error: 'Missing "value" (ip or name)' });
    const removed = kind === 'ip' ? game.unbanIp(String(value)) : game.bans.remove('name', String(value));
    res.json({ ok: true, removed });
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

    const sseConn: GameConnection & { close?: (code?: number, reason?: string) => void } = {
      send: (data: string) => {
        if (!res.writableEnded) {
          res.write(`data: ${data}\n\n`);
        }
      },
      isOpen: () => !res.writableEnded,
      close: () => { if (!res.writableEnded) res.end(); },
    };

    const playerId = game.addPlayer(sseConn, typeof req.headers['x-forwarded-for'] === 'string' ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress);
    log.info(`SSE client connected id=${playerId} ip=${normalizeIp(typeof req.headers['x-forwarded-for'] === 'string' ? String(req.headers['x-forwarded-for']).split(',')[0] : req.socket.remoteAddress)}`);

    req.on('close', () => {
      log.info(`SSE client closed id=${playerId}`);
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
        log.warn(`terminating inactive ws ip=${extWs.clientIp || 'client'}`);
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

    log.info(`ws client connected ip=${clientIp} total=${wss.clients.size}`);
    // Reject banned IPs immediately
    if (game.isIpBanned(clientIp)) {
      log.warn(`rejected banned ip=${clientIp}`);
      ws.close(4003, 'banned');
      return;
    }
    const playerId = game.addPlayer(ws, clientIp);

    ws.on('pong', () => {
      extWs.isAlive = true;
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString());
        game.handleMessage(playerId, message);
      } catch (error) {
        log.error('error handling message', (error as Error).message);
      }
    });

    ws.on('close', () => {
      log.info(`ws client disconnected id=${playerId} ip=${clientIp}`);
      game.removePlayer(playerId);
    });

    ws.on('error', (error) => {
      log.error('websocket error', (error as Error)?.message ?? String(error));
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

  log.info(`game loop started tickRate=${TICK_RATE}Hz`);

  server.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(gameInterval);
  });

  // Vite middleware in dev / static in prod
  if (process.env.NODE_ENV !== 'production') {
    // When the dev server is reached through a proxy (hosted preview, tunnel),
    // Vite rejects the proxied Host header with 403 Forbidden and nothing
    // renders. Allow exactly the hosts listed in VITE_ALLOWED_HOSTS
    // (comma-separated) — never a blanket allowlist.
    const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
        ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
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
    log.info(`Voxel FPS server listening on 0.0.0.0:${PORT} (admin: ${ADMIN_TOKEN ? 'token-protected' : 'localhost-only'})`);
  });
}

startServer().catch((err) => {
  log.error('failed to start server', (err as Error).stack ?? String(err));
  process.exit(1);
});
