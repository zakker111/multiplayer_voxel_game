# 🚀 Deployment Guide — Voxel FPS CTF

How to get the game live for developers and playtesters. **Render is the primary, fully-tested path**; Docker, Cloudflare Tunnel, VPS, and GitHub Pages options are included for community servers.

---

## ✅ Current Game Behavior (what you're deploying)

- **Single process**: `server.ts` serves the built client (`dist/`) AND the authoritative WebSocket game server on `process.env.PORT`. No separate frontend hosting needed.
- **Always 10v10**: Server boots with `SERVER_BOT_COUNT` bots per team (default 10 → 20 total). A human joining retires one bot from *their* team; a human leaving/disconnecting/kicked triggers an instant backfill bot on that team.
- **Server-authoritative gameplay**: damage/death/respawn/inventory, voxel edits (`canBuild()` flood-fill identical to client), and all CTF events (pickup/drop/return/capture at unified 7.0m radius) are validated server-side. Dead/spectating players' inputs are rejected (no ghost meshes). Respawn restores 20 blocks.
- **Bots**: FSM AI (ENGAGE / FLANK / CAMP / ADVANCE / GRABFLAG / RETURN / BUILD / TRENCH / RETREAT), 130 HP, 36-block budget, revenge targeting, flag-carrier priority, LOS-checked fire, and midfield trench wall construction.
- **Rounds & survivability**: 30-minute rounds (`ROUND_MINUTES`) with a 20s intermission that resets captures, flags and spawns; 2.5s spawn shields (cancelled by your own shot) and out-of-combat regeneration (6 HP/s after 6s). All server-authoritative.
- **Admin API + CLI**: structured logs, live kick/ban/unban, persistent bans enforced at WS connect.

### Environment Variables (see `.env.example`)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | Bind port (Render injects its own automatically) |
| `NODE_ENV` | `development` | Set `production` when hosted |
| `SERVER_BOT_COUNT` | `10` | Bots per team at startup & rebalance target |
| `SERVER_BOT_HP` | `130` | Bot max health |
| `SERVER_BOT_BLOCKS` | `36` | Bot build budget per life |
| `ROUND_MINUTES` | `30` | Round length in minutes (clock + reset between rounds) |
| `ADMIN_TOKEN` | *(empty)* | Enables remote admin API access; empty = localhost-only |
| `LOG_LEVEL` / `LOG_FILE` | `info` / *(none)* | Log verbosity, optional log file |

---

## ⭐ Option 1: Render (Primary — Auto-deploy from GitHub)

**Time:** first setup ~5 min, updates ~2–4 min · **Cost:** free tier · **Difficulty:** ⭐ Very Easy

1. Push this repository to GitHub.
2. On [render.com](https://render.com): **New → Web Service** → connect the repo.
3. Configure:
   - **Environment:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
4. Do **not** hardcode a port — `server.ts` reads `process.env.PORT` (Render sets it). Optionally add `NODE_ENV=production`, `ADMIN_TOKEN=<secret>` in the Environment tab.
5. **Create Web Service** → Render gives `https://<app>.onrender.com` with full `wss://` support. The client auto-detects `window.location.protocol` and connects securely.

**Updates:** every `git push` to the watched branch triggers an automatic rebuild+redeploy (~2–4 min). If a build fails, Render keeps serving the previous version — check deploy logs. Free instances sleep when idle; first connection after inactivity takes ~30s to wake.

**Playtesters must hard-refresh** (Ctrl/Cmd+Shift+R) after each deploy to load the new client bundle.

**Share invite links:** in-game Multiplayer menu → **Copy Link**, or append `?mode=online&team=red` / `?mode=online&team=blue` to your URL. Anyone clicking joins your live server on that team (a bot steps aside automatically).

---

## 🐳 Option 2: Docker / docker-compose

```bash
docker compose up -d          # builds multi-stage image, runs on port 3000
docker compose logs -f        # watch structured server logs
```

Override env at runtime as needed, e.g.:
```bash
PORT=8080 SERVER_BOT_COUNT=5 ADMIN_TOKEN=secret docker compose up -d
```

---

## 🌉 Option 3: Cloudflare Tunnel (instant free internet exposure, no port forwarding)

```bash
npm run build && npm start &            # terminal 1
cloudflared tunnel --url http://localhost:3000   # terminal 2
```
Use the printed `https://<random>.trycloudflare.com` URL as your public game link (WebSocket works out of the box).

---

## 🖥️ Option 4: Linux VPS (Ubuntu 22.04 + Nginx + PM2 + SSL)

For low-latency community servers (DigitalOcean, Hetzner, AWS):

```bash
sudo apt update && sudo apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs && sudo npm install -g pm2

cd /var/www && sudo git clone <your-repo-url> && cd <repo>
sudo npm ci && sudo npm run build

pm2 start dist/server.cjs --name voxel-fps
pm2 save && pm2 startup
```

Nginx site with WebSocket upgrade (`/etc/nginx/sites-available/voxel-fps`):
```nginx
server {
    server_name your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/voxel-fps /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
Clients on HTTPS domains automatically use `wss://` — no code edits required anywhere.

---

## 📄 Option 5: GitHub Pages (static client only) + External Server

`.github/workflows/deploy-pages.yml` publishes the client to `https://<user>.github.io/<repo>/` on pushes to main. Pages is static (no game server), so players either:
- play local modes (Bot Match / Sandbox / Spectator), or
- open **Multiplayer → Custom Server** and paste your deployed server URL (Render/VPS/tunnel), or bake it into the link: `https://<user>.github.io/<repo>/?mode=online&server=wss://your-app.onrender.com`.

---

## 🛠️ Server Logs & Admin (Kick/Ban)

Logs are structured and timestamped: `[INFO] [game] …`, `[WARN] [net] …`, `[ADMIN] …` (view via Render service logs, `pm2 logs voxel-fps`, `docker compose logs -f`, etc.).

Admin API is **localhost-only unless `ADMIN_TOKEN` is set**. Ship the CLI (built by `npm run build` into `dist/admin.cjs`):

```bash
npm run admin -- status                          # uptime, players, bans
npm run admin -- players                         # ids/names/teams/IPs
npm run admin -- kick <id-or-name> "reason"      # session ends with 'kicked' message
npm run admin -- ban  <ip-or-name> "reason"      # persists to bans.json + kills session
npm run admin -- unban <ip-or-name>
npm run admin -- bans

# Against a remote deployment:
npm run admin -- players --url https://your-app.onrender.com --token $ADMIN_TOKEN
npm run admin -- ban 203.0.113.42 "cheating" --url https://your-app.onrender.com --token $ADMIN_TOKEN
```

Bans survive restarts (`bans.json`, gitignored) and are checked at the WebSocket upgrade stage, so banned players cannot reconnect. Kicking a player also triggers the same-team bot backfill, keeping the match 10v10.

---

## 🧪 Verifying a Deployment

```bash
curl https://<your-url>/api/status     # -> {"status":"online","tickRate":20,...}
```

Checklist:
1. Open the URL → main menu loads, terrain renders.
2. Join Multiplayer → HUD shows ~19 other entities (10v10 minus your retired bot); server log shows `human joined <team> — retiring bot`.
3. Close the tab → log shows backfill bot spawn; roster returns to 20.
4. Right-click ground → exactly one block; stacking/bridging accepted; mid-air rejected.
5. Rifle fires once per click; respawn grants 20 blocks; captures score only via the server.
6. HUD shows a killfeed row on a kill, a damage-direction arc when you are hit, a ping in ms, and a spawn-shield badge for ~2.5s after spawning (gone as soon as you fire).
7. `npm run admin -- status` responds (locally, or remotely with token).

---

## 🐛 Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| "Failed to connect to server" | Check `/api/status`; Render free tier may be sleeping — wait ~30s and retry |
| Old behavior after redeploy | Hard-refresh (Ctrl/Cmd+Shift+R); old bundles cache in tabs left open |
| Build failed on Render | Read deploy logs; run `npm run lint && npm run build` locally — CI enforces the same pipeline |
| WebSocket closes immediately | Reverse proxy missing `Upgrade`/`Connection` headers (see Nginx config above) |
| Teams not balancing | Confirm `SERVER_BOT_COUNT` is set consistently; check `[game]` logs for retire/backfill lines |
| Admin CLI 401/403 | Set `ADMIN_TOKEN` on the server and pass `--token`, or run the CLI on the server host itself |

---

## 🎯 Recommended Setups

- **Playtesting with friends:** Render free tier + invite links. Zero maintenance.
- **Community server:** VPS ($5/mo) + PM2 + Nginx + domain SSL, `ADMIN_TOKEN` set for moderation.
- **CI/demo client without server cost:** GitHub Pages + one shared Render/VPS server via Custom Server URL.

MIT licensed — see [LICENSE](LICENSE). Developer/architecture reference: [AGENTS.md](AGENTS.md).
