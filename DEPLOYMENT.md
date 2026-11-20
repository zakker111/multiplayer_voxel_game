# 🚀 Deployment Guide — Voxel FPS CTF

How to get the game live for developers and playtesters. **Render is the primary, fully-tested path**; Docker, Cloudflare Tunnel, VPS, and GitHub Pages options are included for community servers.

---

## ✅ Current Game Behavior (what you're deploying)

- **Single process**: `server.ts` serves the built client (`dist/`) AND the authoritative WebSocket game server on `process.env.PORT`. No separate frontend hosting needed.
- **Always 10v10**: Server boots with `SERVER_BOT_COUNT` bots per team (default 10 → 20 total). A human joining retires one bot from *their* team; a human leaving/disconnecting/kicked triggers an instant backfill bot on that team.
- **Server-authoritative gameplay**: damage/death/respawn/inventory, voxel edits (`canBuild()` flood-fill identical to client), and all CTF events (pickup/drop/return/capture at unified 7.0m radius) are validated server-side. Dead/spectating players' inputs are rejected (no ghost meshes). Respawn restores 20 blocks.
- **Bots**: FSM AI (ENGAGE / FLANK / CAMP / ADVANCE / GRABFLAG / RETURN / ESCORT / DEFEND / BUILD / TRENCH / RETREAT), 130 HP, 36-block budget, revenge targeting, flag-carrier priority, LOS-checked fire with aim error and a human reaction delay, kiting/panic cover, and a four-plan defensive structure pool (trench, L-trench, bunker, firing-port bunker).
- **Rounds & survivability**: 30-minute rounds (`ROUND_MINUTES`) with a 20s intermission that resets captures, flags, workshops and spawns; 2.5s spawn shields (cancelled by your own shot) and out-of-combat regeneration (6 HP/s after 6s). All server-authoritative.
- **Workshops & jeeps (online & Beta)**: Each team has a protected workshop; mine blocks with the pickaxe and deposit with `E` (40 blocks buys a jeep with `G`, max 2 per team). One logistics bot per team mines and keeps its workshop stocked. Press `F` to enter/exit and WASD to drive. Flag carriers cannot ride.
- **Audio controls**: `M` or the HUD speaker button mutes all procedural sound; the HUD slider sets master volume. Settings persist in `localStorage`.
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

## ⭐ Option 1: Render Blueprint (Primary — auto-deploy from GitHub)

**Time:** first setup ~5 min, updates ~2–4 min · **Cost:** free tier · **Difficulty:** ⭐ Very Easy

This repo ships [`render.yaml`](render.yaml), so Render configures the whole service from that file — no build/start commands, region or env vars to type in. You only walk the Blueprint wizard and answer one prompt.

1. Make sure the branch Render will watch (`main`) contains `render.yaml`.
2. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub.
3. **New +** (top right) → **Blueprint**.
4. **Connect a repository** → `zakker111/multiplayer_voxel_game`. If it is not listed, click **Configure account** and grant Render access to that repo, then come back and refresh the list.
5. Name the Blueprint (e.g. `voxel-fps`) and confirm **Branch: main** → **Deploy Blueprint**.
   - Render parses `render.yaml` and shows one **Web Service** named `voxel-fps-ctf` (Node, Free plan, Oregon).
   - It prompts for **`ADMIN_TOKEN`** — the only value you supply. See [ADMIN_TOKEN](#admin_token-during-setup) below.
6. Watch the first deploy. Render prints its own lines (`Cloning from https://github.com/…`, the build, then `Build successful 🎉`). The app then logs three lines, in this order, each prefixed `<ISO timestamp> [LEVEL] [server]`:
   - `ADMIN_TOKEN not set — admin API open to localhost only. Set ADMIN_TOKEN to allow remote access.` (warn — only when you left the prompt blank)
   - `game loop started tickRate=20Hz`
   - `Voxel FPS server listening on 0.0.0.0:<port> (admin: localhost-only)` — the suffix reads `token-protected` when you supplied a token

   Render marks the deploy **Live** once the service answers its health check on `/api/status`. That only proves the HTTP side is up, so open the page as well.
7. Read your URL off the service page: `https://<service-name>.onrender.com`. Nothing else to configure: with no `?server=` override the client builds its socket URL from `window.location.host`, using `wss://` whenever the page is served over HTTPS.

### What `render.yaml` sets

| Field | Value |
| :--- | :--- |
| `runtime` / `plan` / `region` | `node` / `free` / `oregon` |
| `branch` / `autoDeployTrigger` | `main` / `commit` (redeploy on every push) |
| `buildCommand` | `npm ci --include=dev && npm run build` — `--include=dev` is required because Vite and esbuild are devDependencies and `NODE_ENV=production` |
| `startCommand` | `npm start` (`node dist/server.cjs`; binds Render's injected `$PORT`) |
| `healthCheckPath` | `/api/status` |
| `envVars` | `NODE_ENV=production`, `SERVER_BOT_COUNT=10`, `ROUND_MINUTES=30`, `TRUST_PROXY=1` (each is described in the environment table above), plus `ADMIN_TOKEN` — see below |

`TRUST_PROXY=1` is what lets the per-IP socket caps and IP bans see the real client address behind Render's proxy; leave it unset if the server is ever exposed directly, since the header is client-controlled.

Change any of these by editing `render.yaml` and pushing to `main`; the Blueprint re-syncs itself. Use the dashboard **Environment** tab only for secret values.

### ADMIN_TOKEN during setup

`ADMIN_TOKEN` is declared with `sync: false`, which means Render asks for it during Blueprint creation and never reads the value back from git.

- **Leave it blank** (recommended to start): the admin API stays reachable from the server host only, so remote `npm run admin` calls return 401. Nothing else is affected — the match, CTF, bots and building all work normally.
- **Paste a long random secret**: remote moderation works, e.g. `npm run admin -- players --url https://<url>.onrender.com --token <secret>`.

Render only prompts on the *first* creation. To set or rotate it later: service → **Environment** → `ADMIN_TOKEN` → **Save changes** → the service restarts. A Blueprint update from git leaves `sync: false` variables untouched.

**Updates:** every push to `main` triggers a rebuild+redeploy (~2–4 min). If a build fails, Render keeps serving the previous version — check the deploy logs.

**Free tier behaviour** ([Render's free limits](https://render.com/docs/free)): an instance spins down after 15 minutes with no inbound traffic — meaning no HTTP request *and* no WebSocket message from an existing connection. An active match keeps it awake (the client sends input at 20Hz); an idle server sleeps, and the next visitor sees Render's loading page for about a minute while it boots. Each workspace gets 750 instance hours per calendar month, and exhausting them suspends every free service until the next month. The filesystem is ephemeral, so `bans.json` is lost on redeploy, restart **and** on every spin-down.

**Playtesters must hard-refresh** (Ctrl/Cmd+Shift+R) after each deploy to load the new client bundle.

**Share invite links:** in-game Multiplayer menu → **Copy Link**, or append `?mode=online&team=red` / `?mode=online&team=blue` to your URL. Developers can use `?mode=beta` for the development build (identical authoritative server, Beta HUD badge). Anyone clicking joins your live server on that team (a bot steps aside automatically).

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

Bans persist to `bans.json` (gitignored; path overridable with `BAN_FILE`) and are checked at the WebSocket upgrade stage, so banned players cannot reconnect. They survive restarts on a host with a persistent disk (local, Docker volume, VPS); on Render's free tier the filesystem is ephemeral, so a redeploy, restart or spin-down clears them. Kicking a player also triggers the same-team bot backfill, keeping the match 10v10.

---

## 🧪 Verifying a Deployment

```bash
curl https://<your-url>.onrender.com/api/status
```

```json
{
  "status": "online",
  "serverTime": 1795174981254,
  "connectedPlayers": 0,
  "tickRate": 20,
  "version": "1.0.0",
  "round": {
    "round": 1,
    "phase": "live",
    "timeLeft": 1796.05,
    "intermission": 0,
    "captures": { "red": 0, "blue": 0 },
    "touches": { "red": 0, "blue": 0 },
    "returns": { "red": 0, "blue": 0 },
    "wins": { "red": 0, "blue": 0 },
    "duration": 1800
  }
}
```

The `round` block is the authoritative round state: `captures` is the score, and `touches` / `returns` / `wins` are the tiebreak counters (enemy-flag pickups, own-flag returns, rounds won) used when captures are level at 0:0. `duration` is the configured round length, so with `ROUND_MINUTES=30` it must read `1800`; `timeLeft` is fractional seconds counting down from there, and `serverTime`/`timeLeft` above are one sample a few seconds into a round.

`connectedPlayers` counts open WebSocket sockets, **not** the roster: a freshly deployed server reports `0` even though ~20 bots are already playing, and `1` per connected browser. The bots are only visible in-game (or through the token-protected admin API).

Before opening the game, confirm `/api/status` answers 200 with `"status":"online"`, `"tickRate":20`, and all four counter pairs under `round`.

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
| "Failed to connect to server" | Check `/api/status`; Render free tier may be sleeping — wait ~1 min and retry |
| Blueprint wizard shows no repository | **Configure account** on the connect step and grant Render access to the repo |
| Blueprint asks for `ADMIN_TOKEN` and you are unsure | Leave it blank; the game runs normally and the admin API stays localhost-only. Add a secret later in the **Environment** tab |
| Blueprint rejected `render.yaml` | Validate the field names against [the Blueprint spec](https://render.com/docs/blueprint-spec); errors name the offending key |
| No audio | Browsers only start audio after your first interaction — click the canvas once, then press `M` or use the HUD speaker/slider to check mute and volume |
| Old behavior after redeploy | Hard-refresh (Ctrl/Cmd+Shift+R); old bundles cache in tabs left open |
| Build failed on Render | Read deploy logs; run `npm run lint && npm run build` locally — CI enforces the same pipeline |
| WebSocket closes immediately | Reverse proxy missing `Upgrade`/`Connection` headers (see Nginx config above) |
| Teams not balancing | Confirm `SERVER_BOT_COUNT` is set consistently; check `[game]` logs for retire/backfill lines |
| Admin CLI 401/403 | Set `ADMIN_TOKEN` on the server (**Environment** tab) and pass `--token`, or run the CLI on the server host itself. On Render, leaving the Blueprint prompt blank means remote admin stays disabled by design |

---

## 🎯 Recommended Setups

- **Playtesting with friends:** Render free tier + invite links. Zero maintenance.
- **Community server:** VPS ($5/mo) + PM2 + Nginx + domain SSL, `ADMIN_TOKEN` set for moderation.
- **CI/demo client without server cost:** GitHub Pages + one shared Render/VPS server via Custom Server URL.

MIT licensed — see [LICENSE](LICENSE). Developer/architecture reference: [AGENTS.md](AGENTS.md).
