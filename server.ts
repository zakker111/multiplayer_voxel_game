import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { ServerGame, GameConnection } from './src/server/serverGame';
import { normalizeIp } from './src/server/banStore';
import { ConnectionLimiter, TokenBucket } from './src/server/limits';
import type { ClientMessage } from './src/shared/types';
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
      // Live head-count (bots included): `connectedPlayers` is sockets only, so
      // an active bot match would otherwise look empty to monitoring.
      roster: game.getRosterCounts(),
      // Round clock: lets ops see which round is live without opening the game.
      round: game.getRoundSnapshot(),
    });
  });

  // ---------------- Admin API (CLI + curl) ----------------
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
  if (!ADMIN_TOKEN) {
    log.warn('ADMIN_TOKEN not set — admin API open to localhost only. Set ADMIN_TOKEN to allow remote access.');
  }

  // Client identity for per-IP caps and IP bans. X-Forwarded-For is client
  // controlled, so it is only honoured when the deployment really sits behind a
  // reverse proxy (TRUST_PROXY=1). Otherwise a caller could rotate fake IPs to
  // dodge the caps and bans, or forge one to get another player banned.
  const TRUST_PROXY = process.env.TRUST_PROXY === '1';
  const clientIpOf = (req: {
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  }): string => {
    if (TRUST_PROXY) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.trim()) {
        return normalizeIp(forwarded.split(',')[0].trim());
      }
    }
    return normalizeIp(req.socket.remoteAddress);
  };

  const adminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // The "localhost-only" fallback is decided from the REAL socket address, so
    // a forged X-Forwarded-For can never reach kick/ban while ADMIN_TOKEN is
    // unset. The forwarded value, when trusted, is only used for logging.
    const socketIp = normalizeIp(req.socket.remoteAddress);
    const ip = clientIpOf(req);
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

  // ---------------- SSE fallback sessions ----------------
  // Every SSE GET registers a server-side player, and EventSource reconnects on
  // its own — so a client that keeps losing the stream minted a new "unnamed"
  // ghost player per attempt, each one receiving state and occupying a slot.
  // Bound the sessions and make teardown run exactly once per session.
  const SSE_MAX_SESSIONS = Number(process.env.SSE_MAX_SESSIONS) || 32;
  const SSE_MAX_PER_IP = Number(process.env.SSE_MAX_PER_IP) || 16;
  const sseSessions = new Map<string, { ip: string; res: express.Response }>();
  let lastSseRejectLog = 0;

  /** Tear down one fallback session: close its stream and drop its player. */
  const closeSseSession = (playerId: string, reason: string): void => {
    const session = sseSessions.get(playerId);
    if (!session) return; // already torn down (close and error can both fire)
    sseSessions.delete(playerId);
    try {
      if (!session.res.writableEnded) session.res.end();
    } catch {
      /* the client is already gone */
    }
    game.removePlayer(playerId);
    log.info(`SSE client closed id=${playerId} (${reason}) sessions=${sseSessions.size}`);
  };

  // SSE Game stream fallback (guarantees connectivity behind HTTP proxies, iframes, and restrictive firewalls)
  app.get('/api/game/events', (req, res) => {
    const ip = clientIpOf(req);

    // Banned clients are refused here too, or the fallback would be a way back in.
    if (game.isIpBanned(ip)) {
      log.warn(`SSE rejected ip=${ip} (banned)`);
      res.status(403).json({ error: 'Banned' });
      return;
    }

    let ipSessions = 0;
    for (const session of sseSessions.values()) if (session.ip === ip) ipSessions++;
    if (sseSessions.size >= SSE_MAX_SESSIONS || ipSessions >= SSE_MAX_PER_IP) {
      // Reject rather than register another player. EventSource retries on its
      // own, so throttle this line instead of logging one per retry.
      const now = Date.now();
      if (now - lastSseRejectLog > 10000) {
        lastSseRejectLog = now;
        log.warn(`SSE rejected ip=${ip} (sessions ${sseSessions.size}/${SSE_MAX_SESSIONS}, this ip ${ipSessions}/${SSE_MAX_PER_IP})`);
      }
      res.status(503).json({ error: 'Too many fallback streams — connect with the WebSocket server' });
      return;
    }

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

    const playerId = game.addPlayer(sseConn, ip);
    sseSessions.set(playerId, { ip, res });
    log.info(`SSE client connected id=${playerId} ip=${ip} sessions=${sseSessions.size}`);

    // Request close, response close and write errors can all fire for one dead
    // stream; closeSseSession is idempotent so the player is removed once.
    req.on('close', () => closeSseSession(playerId, 'request closed'));
    res.on('close', () => closeSseSession(playerId, 'response closed'));
    res.on('error', () => closeSseSession(playerId, 'response error'));
  });

  app.post('/api/game/message', (req, res) => {
    // The HTTP fallback is not bound to a socket, so it must present the session
    // token issued in `init`. Trusting a client-supplied playerId let anyone act
    // as any player (spoof captures, rejoin, respawn someone else).
    const { token, message } = req.body || {};
    const playerId = game.resolveSessionToken(token);
    if (!playerId) return res.status(401).json({ error: 'Invalid or missing session token' });
    if (!message || typeof message !== 'object') {
      return res.status(400).json({ error: 'Missing message' });
    }
    try {
      game.handleMessage(playerId, message as ClientMessage);
      return res.json({ ok: true });
    } catch (error) {
      log.error('error handling HTTP message', (error as Error).message);
      return res.status(500).json({ error: 'Message failed' });
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

  // ---------------- WebSocket limits ----------------
  // Every socket registers a player and every frame is handled on the 20Hz
  // loop, so one client could otherwise open thousands of sockets or spam
  // input. Bound the sockets (globally and per IP) and give each socket a
  // message budget: 60/s sustained comfortably covers the client's 20Hz input
  // stream plus shooting, building and driving actions.
  const WS_MAX_CLIENTS = Number(process.env.WS_MAX_CLIENTS) || 64;
  const WS_MAX_PER_IP = Number(process.env.WS_MAX_PER_IP) || 32;
  const WS_MSG_RATE = Number(process.env.WS_MSG_RATE) || 60;
  const WS_MSG_BURST = Number(process.env.WS_MSG_BURST) || 120;
  const wsLimiter = new ConnectionLimiter(WS_MAX_CLIENTS, WS_MAX_PER_IP);
  let lastWsRejectLog = 0;

  wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    const extWs = ws as AliveWebSocket;
    extWs.isAlive = true;

    const clientIp = clientIpOf(request);
    extWs.clientIp = clientIp;

    // Take the slot and register its release before any early return below, so
    // a banned client or a throwing addPlayer cannot leak a slot for the rest of
    // the process's life.
    if (!wsLimiter.tryAdd(clientIp)) {
      log.warn(`ws closed over-cap socket ip=${clientIp} (sockets ${wsLimiter.total}/${WS_MAX_CLIENTS})`);
      ws.close(1013, 'server full');
      return;
    }

    // Per-socket message budget: a flood is dropped here so it never reaches
    // the game loop.
    const messageBudget = new TokenBucket(WS_MSG_RATE, WS_MSG_BURST);
    let droppedFrames = 0;
    let playerId: string | undefined;

    ws.on('close', () => {
      wsLimiter.remove(clientIp);
      if (playerId) game.removePlayer(playerId);
      log.info(`ws client disconnected id=${playerId ?? 'unjoined'} ip=${clientIp} total=${wsLimiter.total}/${WS_MAX_CLIENTS}`);
    });

    log.info(`ws client connected ip=${clientIp} total=${wsLimiter.total}/${WS_MAX_CLIENTS}`);
    const id = game.addPlayer(ws, clientIp);
    playerId = id;

    ws.on('pong', () => {
      extWs.isAlive = true;
    });

    ws.on('message', (data: Buffer | string) => {
      if (!messageBudget.tryConsume()) {
        // Over budget: drop the frame. A client that keeps flooding is hung up
        // on rather than left burning parse time every frame (queued frames
        // still arrive while closing, so only act on the open socket).
        if (++droppedFrames > 200 && ws.readyState === WebSocket.OPEN) {
          log.warn(`ws closing flooding client id=${id} ip=${clientIp}`);
          ws.close(1008, 'message rate exceeded');
        }
        return;
      }
      // Consecutive drops only: a socket that overruns its budget occasionally
      // must not accumulate its way to a disconnect over hours of play.
      droppedFrames = 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        // Garbage frame from a client (or a proxy). Not a server fault, and it
        // must not be able to flood the error log — drop it at debug level.
        log.debug('dropped malformed frame');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
        log.debug('dropped frame without a message type');
        return;
      }
      try {
        game.handleMessage(id, parsed as ClientMessage);
      } catch (error) {
        log.error('error handling message', (error as Error).message);
      }
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
    // Refuse banned clients and over-cap sockets before the handshake completes:
    // a banned client never gets a socket or a player slot, and a flood cannot
    // open thousands of connections just to have them closed afterwards.
    const upgradeIp = clientIpOf(request);
    const now = Date.now();
    const rejectUpgrade = (status: string, detail: string) => {
      if (now - lastWsRejectLog > 10000) {
        lastWsRejectLog = now;
        log.warn(`ws upgrade rejected ip=${upgradeIp} (${detail})`);
      }
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (game.isIpBanned(upgradeIp)) {
      rejectUpgrade('403 Forbidden', 'banned');
      return;
    }
    if (!wsLimiter.canAccept(upgradeIp)) {
      rejectUpgrade(
        '503 Service Unavailable',
        `sockets ${wsLimiter.total}/${WS_MAX_CLIENTS}, this ip ${wsLimiter.countFor(upgradeIp)}/${WS_MAX_PER_IP}`,
      );
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
