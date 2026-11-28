# 🎮 Voxel FPS — Capture The Flag

A high-performance, full-stack 3D voxel first-person shooter with Red vs Blue Capture the Flag gameplay, a fully destructible/buildable voxel world, vicious tactical AI bots (server-side), and real-time authoritative multiplayer. Built with React 18, Three.js, TypeScript, Vite, Express, and `ws`.

![Version](https://img.shields.io/badge/version-1.6.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-5.7+-blue.svg)
![Tests](https://img.shields.io/badge/tests-306%2F306%20passing-brightgreen.svg)

---

## ✨ Features

- **🚩 Server-Authoritative Capture The Flag**: Full CTF loop on a 512-meter arena with base flags (±140m), rear spawns (±210–240m), pickup/drop/return timers, carrier HUD tracking, and victory scoring. All flag logic is validated server-side (carrier identity + unified 7.0m capture radius) — clients can no longer fake captures. Online, the HUD flag badges and the carrier line read the server's carrier ids (the flag mesh stays hidden at its post while carried), so a bot running with a flag reads as taken under its own name instead of "At Base".
- **🛡️ Spawn Protection & Regeneration**: Every spawn grants 2.5s of immunity that your own first shot cancels (so it can't be used as an attack shield). Out of combat for 6s and you regenerate 6 HP/s instead of limping around at 12 HP until the next bullet. Both are server-authoritative.
- **📣 Combat Feedback**: A killfeed naming killer, weapon and victim (headshots flagged), a damage-direction arc that tracks the shooter as you turn, and a live ping readout so you can tell a bad aim day from a bad connection.
- **⏱️ Timed Rounds**: Every match is split into rounds (30 minutes by default, `ROUND_MINUTES` to override). The clock is authoritative and mirrored to the HUD; when it hits zero the team with more captures takes the round, flags return to their stands, scoring freezes for a 20s intermission, and everyone respawns for a clean next round. Rounds won are tracked per team for the session.
- **🌐 Real-Time Multiplayer**: A single Node.js process serves both the web client and an authoritative WebSocket game server at 20Hz. Join via the in-game lobby (official or custom `wss://` server URL, custom callsign, team pick) or share invite links (`?mode=online&team=red`). The lobby's probed list tells a server the browser *blocks* (an http address on an https page) apart from one that is down: the row explains that the page is https, offers the address on a **Copy address** button, and suggests opening it in its own tab or serving it behind https.
- **⚖️ Always 10v10**: The server runs a full 10-vs-10 bot battle by default. When a human joins, one bot is retired from *that human's team*; when a human leaves/disconnects/is kicked, a replacement bot respawns on the same team. Matches never go short-sided.
- **🤖 Vicious FSM Bots**: 20 server-side AI bots (130 HP each, tunable via env) driven by a finite-state machine: `ENGAGE`, `FLANK`, `CAMP`, `ADVANCE`, `GRABFLAG`, `RETURN`, `ESCORT`, `DEFEND`, `BUILD`, `TRENCH`, `RETREAT`. They revenge-target killers, prioritize enemy flag carriers, escort their own runner, hold defensive posts, shoot with line-of-sight checks, aim error, distance falloff and a short target-acquisition reaction delay, harvest blocks, kite and drop panic cover, and build trenches, L-trenches, bunkers or firing-port bunkers. Each team starts with two dedicated firebase engineers: assault engineers dig one forward firebase 40–95m short of the stand, while support engineers build a main position plus a 10m side annex; non-engineers keep fighting.
- **🧱 Destructible & Buildable Voxel World**: Procedural terrain; gunfire blasts voxels (3 hits), spade digs trenches, pickaxe harvests blocks into inventory. Building supports stacking, bridging, and tower play — placement validated by a unified client/server `canBuild()` flood-fill (structural support + adjacency), so what you see is what the server accepts.
- **🎯 Crew-Served Guns**: Blueprint builds include MG nests, cannons, mortars, supply crates and spotting posts. Press **F** to man one: your hand weapon disappears so the seat reads clearly, a cannon or mortar gets a right-click gunner zoom, and the mortar HUD prints its landing point (**X / Z / range**) while every round scatters inside the blast ring instead of cratering the same tile.
- **🛠️ Dismantle Your Own Builds (online)**: Press **X** next to a friendly emplacement to tear it down; its blueprint cost — and anything a supply crate held — goes back to the workshop stock, so a misplaced nest is no longer permanent. A crewed build comes down too: its gunner (bot or player) steps out through the same safe exit a wrecked build uses. The same key scuttles a friendly jeep in reach: its cost returns to the stock and its crew steps out, so a vehicle wedged in a doorway is not 40 blocks of dead weight for the round. Built voxel blocks already come back when the pickaxe breaks them.
- **🏭 Team Workshops (online)**: Each team has a protected garage east of its base and a shared stockpile (starts at 80, capacity 200). Mine natural terrain with the pickaxe and press **E** near your workshop to deposit. Mined blocks can also be used for building; free respawn blocks and recovered built blocks cannot be deposited. Carried mined blocks are lost on respawn, and stockpiles reset each round. Jeeps are available for 40 team blocks.
- **🚙 Blocky Jeeps (online)**: Press G near your team workshop to build a two-seat jeep for 40 team blocks (maximum two active per team). Press F to board an empty jeep as driver or a driven one as passenger; WASD drives and Space brakes. Vehicles are server-controlled, absorb enemy shots and leave a temporary wreck when destroyed. Flag carriers cannot ride, and drivers cannot pick up flags or fire. Leaving the driver's seat or losing the jeep also puts the passenger safely on the ground. Assault bots can build and drive jeeps toward objectives using the vehicle's real rectangular footprint; one bot per team drives while engineers and defenders stay on foot, and line bots hop into a free passenger seat when a driven team jeep comes within reach. A crewed jeep draws team-coloured driver and passenger figures in its seats, so it reads as occupied from outside.
- **🧪 Beta Development Mode**: A menu option (`?mode=beta`) that runs the **full authoritative online code path** — workshops, jeeps and workshop logistics bots included — while online CTF stays the main game. Use it to playtest new server-side features before they land for everyone; the HUD shows a Beta badge.
- **⏳ Mode-Aware Loading Screen**: Every start mode opens on a deployment screen with that mode's title and three field tips (workshop and jeep for Beta, crew-served guns for Online, flag runs for Bot Match, tools for Sandbox). The bar is indeterminate and sweeps until the first rendered frame — no simulated percentages or fixed waits, so a slow device never appears frozen at a fake "82%". If the arena fails to build, the screen keeps the tips and offers **Try again** / **Back to menu** instead of hanging. A slow server is not a failed one: at 8 s the overlay adds a "still trying" line (and Back to menu) while the client keeps re-dialling, and only a full minute of silence reaches the dead-server card — so a cold Render instance or a tunnel that is re-establishing still lands in the game.
- **🏗️ One Click, One Block**: Right-click places exactly one block per click (no hold-spam). With rifle/SMG equipped, right-click toggles iron sights instead.
- **🔫 WW2 Arsenal**: M1 Garand rifle (semi-auto — one shot per click, true single-fire), Thompson SMG (hold to auto-fire), Trench Spade, Pickaxe. Iron sights, recoil, muzzle flash, hit markers.
- **👁️ Spectator Mode & Accessibility**: Press `P` for the cinematic orbiting spectator camera (follows firefights and flag carriers). Drag-to-look and arrow-key steering work without pointer lock (iframe/AI-harness friendly). Spectators are hard-blocked server-side from shooting, building, capturing, and pickups.
- **🔊 Master Audio Controls**: Mute instantly with `M` or the in-game speaker button, and set master volume from the HUD slider. Every procedural effect (gunfire, footsteps, spatial shots, cues) routes through one master gain, and the setting persists across reloads.
- **📡 Structured Server Logs + Admin CLI**: Timestamped `[INFO]/[WARN]` logs tagged by subsystem. Kick or ban players live from the command line (`npm run admin -- ...`) via a localhost-only (or `ADMIN_TOKEN`-protected) admin API. Bans persist to `bans.json` and are enforced at WebSocket connect time.
- **✅ Test-Ready**: Automated regression suite (`npm test`) covering voxel place/stack/bridge/mine rules and end-to-end bot trench construction, wired into GitHub Actions CI.

---

## 🕹️ Controls Reference

| Action | Control | Notes |
| :--- | :--- | :--- |
| **Move** | `W`, `A`, `S`, `D` | Smooth acceleration & ground collision |
| **Look / Aim** | `Mouse Move` | Click canvas to lock aim; or drag / use Arrow Keys |
| **Alternative Aim** | `↑`, `↓`, `←`, `→` | Keyboard camera steering (ideal for previewing/AI agents) |
| **Fire / Mine** | `Left Click` | Rifle fires once per click; SMG/tools auto-fire while held |
| **Build** | `Right Click` | Places exactly ONE block per click (tool equipped); toggles iron sights with rifle/SMG. Never shoots or mines. |
| **Weapons / Tools** | `1`, `2`, `3`, `4` | 1: Rifle, 2: SMG, 3: Spade, 4: Pickaxe (or Mouse Wheel) |
| **Reload** | `R` | Reloads magazine with animation |
| **Workshop deposit** | `E` | In online & Beta play, deposit mined blocks while near your team's garage |
| **Build jeep** | `G` | At your online/Beta workshop; costs 40 team blocks |
| **Dismantle / scuttle** | `X` | Online & Beta: tears down a friendly emplacement (crewing it is no obstacle — the gunner steps out) or scuttles a friendly jeep in reach (the crew steps out); the cost (plus any crate contents) returns to the workshop |
| **Enter / exit jeep** | `F` | Team jeep only, either seat (online & Beta); exit requires clear space |
| **Drive / brake** | `WASD` / `Space` | Accelerate, reverse, steer / brake while driving |
| **Gunner zoom** | `Right Click` | While manning a cannon or mortar: toggles a tighter zoom on the target |
| **Jump** | `Space` | Jump over obstacles and climb terrain |
| **Sprint** | `Shift` | High-speed dash |
| **Crouch** | `C` or `Ctrl` | Lowers profile, tightens spread, speeds up footsteps interval |
| **Mute Audio** | `M` | Toggles all game audio; HUD slider sets master volume (persisted) |
| **Spectate** | `P` | Cinematic battle-tracking camera |

---

## 🚀 Run it on your own computer

**Prerequisite:** [Node.js 18+](https://nodejs.org). Nothing else — the launcher installs the rest.

### One click

| System | How to start the server |
| :--- | :--- |
| **Windows** | Double-click **`start-server.bat`** |
| **Linux / macOS** | `./start-server.sh` in the game folder |

Both run the same launcher (`scripts/start-local.mjs`, also `npm run serve`). The
first run installs dependencies and builds the client + server; later runs skip
straight to starting. It prints the addresses to share, then runs the game:

```
──────────────────────────────────────────────────────────
  Voxel FPS server
──────────────────────────────────────────────────────────
  This computer      http://localhost:3000
  Same network       http://192.168.1.24:3000   <- friends on your Wi-Fi/LAN

  Playing across the internet needs a public address:
    - forward TCP 3000 on your router, then share http://<your-public-ip>:3000
    - or use a tunnel / VPS (see DEPLOYMENT.md)
──────────────────────────────────────────────────────────
```

Options (either the `.bat`/`.sh` or `npm run serve --`):

```bash
start-server.bat 4000        # Windows: use port 4000 instead of 3000
./start-server.sh 4000       # Linux/macOS
start-server.bat --rebuild   # force a client + server rebuild, then start
```

Open the printed URL, pick **Multiplayer**, and the full 10v10 bot battle is
already running — you drop into it with the team you choose.

### Playing with other people

1. **Same Wi-Fi / LAN** — everyone opens the *Same network* address the launcher
   printed (`http://<your-lan-ip>:<port>`). On Windows, allow Node.js through the
   firewall when it asks, or add a TCP rule for the port. Nothing else to set up.
2. **Over the internet** — the server needs a public address. Pick one:
   - **Port forward** TCP 3000 (or the port you chose) on your router to this
     computer, then share `http://<your-public-ip>:3000`.
   - **Tunnel**: `cloudflared tunnel --url http://localhost:3000` (or `ssh -R`,
     Tailscale) and share the generated URL — good for a quick game with a friend.
   - **Hosted**: run the same launcher or `npm start` on a VPS, or use the
     Render/Docker setups in [DEPLOYMENT.md](DEPLOYMENT.md).
3. **Joining** — open the server's URL, choose **Multiplayer**, and pick the
   server in the list or type its address into the field under the list. Invite
   links carry the server too: `?mode=online&team=red&server=ws://host:port`.

> One process serves both the web client and the authoritative WebSocket game
> server, so a single `http://ip:port` address is all a player needs — no
> separate static host.

### 🔎 Choosing a server in the lobby

The **Multiplayer → Choose Server** box checks servers and shows whether each one
is up, with its live socket count:

- **This server** — the one that served the page, always listed.
- **Entries from `public/servers.json`** — a JSON array; add your own as
  `{ "name": "My LAN game", "url": "http://192.168.1.24:3000" }` (`ws://`,
  `wss://` and bare `host:port` also work). It ships empty: the page's own server
  is always listed.
- **Saved servers** — every server this browser has joined before.

Click a row to select it, then **Connect & Deploy**; anything not listed goes in
the address field underneath. **Check again** re-probes. An http server listed
on an https page shows as **needs https** and cannot be clicked — the browser
blocks that request, so open the server's own URL instead.
The probe is a `GET /api/status`, which also returns `{ status, connectedPlayers,
roster, round }` for scripts; `GET /api/health` is the minimal liveness check.

### Manual setup (development)

```bash
git clone https://github.com/<your-org>/<your-repo>.git
cd <your-repo>
npm install

# Development: Vite + the game server in one process (PORT, default 3000)
npm run dev

# Full verification pipeline (used by CI)
npm run lint      # tsc --noEmit
npm test          # node --test tests/  (306 regression tests)
npm run smoke     # live WS/HTTP/SSE check against a running server
npm run build     # vite bundle + dist/server.cjs + dist/admin.cjs
npm start         # production server (reads process.env.PORT)

# Commit pending changes and push the current branch (uses the git bundled
# with Freebuff when none is installed; explains the token prompt)
bash scripts/push-github.sh
```

With `npm run dev` the client is rebuilt live (hot reload); use the one-click
launcher or `npm run build && npm start` when you want the production bundle that
players should use.

---

## 🌍 Deploying (Render-first)

This project is configured for **Render** auto-deploy from GitHub:

1. Push this repository to GitHub (branch watched by Render, usually `main`).
2. Render detects the push → runs `npm install && npm run build` → starts `npm start`.
3. `server.ts` reads `process.env.PORT` automatically — no port config needed beyond Render's default env var.
4. Deploys take ~2–4 minutes. Players must **hard-refresh** (Ctrl/Cmd+Shift+R) to get new client bundles.

Environment variables (see `.env.example`):

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP/WebSocket bind port (Render injects its own) |
| `NODE_ENV` | `development` | Set `production` on hosted deploys |
| `SERVER_BOT_COUNT` | `10` | Bots per team at startup (total = 2×) |
| `SERVER_BOT_HP` | `130` | Bot max health |
| `ROUND_MINUTES` | `30` | Round length in minutes (clock + reset between rounds) |
| `SPAWN_PROTECTION_SECONDS` | `2.5` | Spawn immunity (shared constant in `src/shared/types.ts`) |
| `REGEN_DELAY_SECONDS` / `REGEN_RATE` | `6` / `6` | Out-of-combat wait before healing, then HP per second |
| `ADMIN_TOKEN` | *(empty)* | Required for remote kick/ban CLI access; empty = localhost-only admin API |

Alternative deploy targets (Docker, Cloudflare Tunnel, VPS+Nginx+PM2, GitHub Pages static client + external server) are covered in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## 🛠️ Server Logs & Admin (Kick / Ban)

The server emits structured, timestamped logs: `[INFO] [game] …`, `[WARN] [net] …`, `[ADMIN] …`.

Manage live matches from any shell (works locally or remotely with `ADMIN_TOKEN`):

```bash
npm run build                      # builds dist/admin.cjs too

npm run admin -- status            # uptime, connected players, active bans
npm run admin -- players           # list player ids, names, teams, IPs
npm run admin -- kick <id|name> "reason"
npm run admin -- ban <ip|name> "reason"     # persists to bans.json, kills live session
npm run admin -- unban <ip|name>
npm run admin -- bans              # list active bans

# Remote against a deployed server:
npm run admin -- players --url https://your-app.onrender.com --token $ADMIN_TOKEN
```

Banned IPs/names are rejected at the WebSocket upgrade stage with a clear message. Kicks send a specific `kicked` message so clients show why they were removed.

---

## 🧪 Testing & Playtesting

- **Automated**: `npm test` runs 306 regression tests against the real server classes — voxel build/mine rules (ground place, stack, bridge, reject mid-air/height/occupied, mine-to-destruction, collapse check), bot TRENCH construction and stuck-state handling, engineer assignment and forward-base/annex construction, workshop deposits/jeep economics, bot jeep driving and workshop logistics bots, rally staging, structure telemetry, every emplacement kind's place/damage/dismantle path, CTF flag drop rules, spawn bounds, weapon balance, the round lifecycle, and the spawn-shield/regen/killfeed/latency layer. GitHub Actions CI (`ci.yml`) runs lint → build → test on every push/PR.
- **Bot simulation**: `npm run measure:bots -- 30` runs a headless 30-minute bot-only round against the real server. It reports pickups, captures, deaths, structure starts and completions, blocks placed and stuck recoveries. On the old 448m layout (±160 stands with the spawn band only 32m behind them) runs produced 0–12 captures and 12–63 pickups; on the current 512m layout (±140 stands, ±210–240 spawns) two 30-minute runs produced 17 and 33 captures with 38 and 88 pickups, 381–411 deaths, 1428–3284 blocks and completed structures of every kind. Two samples per layout, so read the direction as measured and the exact numbers as noisy.
- **Beta battle simulation**: `node scripts/beta-simulate.mjs 30 30 3 10 12345` runs three full 30-minute 10v10 matches on the real server tick loop (rounds, blueprints, jeeps, workshops and bots), reporting round-scoped captures, pickups, returns, flag droughts, hardware by kind, jeeps and stalls. The last argument is a seed, so the same command reproduces the report exactly (run *i* uses `seed + i - 1`); every run prints its seed and the banner prints the rerun command. The harness checks its own counters and throws instead of reporting an impossible number.
- **Live smoke test**: with a server running on `SMOKE_PORT` (default 3110), `npm run smoke` drives WS join/input/respawn, malformed frames, the HTTP token auth path and the SSE init stream.
- **Manual playtest checklist**:
  1. Open the site → Multiplayer → join Blue. Verify one blue bot disappears (log: `human joined blue — retiring bot …`).
  2. Take damage — HP bar updates once (no double-apply flashes).
  3. Die → wait for respawn → verify you spawn with **20 blocks**, and you do NOT instantly die again.
  4. Right-click on ground → exactly one block; click again → second block; stack and bridge sideways works; mid-air placement is rejected.
  5. Left-click with rifle → single shot per click. Hold with SMG → continuous fire.
  6. Run onto the enemy flag within 7m → server grants pickup; carry home → capture counts. Kill a carrier → flag drops at their body.
  7. Leave the match (close tab) → log shows backfill bot spawned, roster returns to 10v10.
  8. Press `P` → spectator cam; try to shoot/build as spectator → blocked. Starting a mode shows its loading screen (title + tips + sweeping bar) and clears it only once the arena's first frame renders.
  9. Kill/be killed → killfeed row appears with the weapon used; getting shot shows a red direction arc; the status strip shows a ping in ms.
 10. Get hit, then break contact for ~6s → HP regenerates; spawn → 2.5s shield badge, and firing cancels it.
 11. Stand at your team's bench, press `B`, click **Buy** on *Ammo magazine* → team stock drops by the weapon's magazine price (3 rifle / 2 SMG) and the HUD pouch count rises; empty the magazine and reload to watch the pouch fall.

---

## 📁 Project Architecture

```
├── .github/workflows/
│   ├── ci.yml                 # lint → build → test on every push/PR
│   └── deploy-pages.yml       # optional static GitHub Pages client
├── scripts/admin.ts           # CLI for kick/ban/status against admin API
├── tests/                     # node:test suites: voxel rules, bots, bot engineers, flag drops,
│                              #   spawns, weapon balance, rounds, spawn shield/regen/feedback
├── src/
│   ├── game/                  # CLIENT
│   │   ├── game.ts            # Game loop, input handling (one-click build,
│   │   │                      #   single-shot rifle), network message handlers,
│   │   │                      #   server-authoritative respawn flag, spectator guards
│   │   ├── player.ts          # Local player physics, 9-point collision, weapons
│   │   ├── world.ts           # Client voxel world + canBuild() flood-fill
│   │   ├── sounds.ts          # Procedural Web Audio: master mute/volume, no assets
│   │   └── networkClient.ts   # WebSocket client, keepalive, wss:// autodetect
│   ├── server/                # AUTHORITATIVE SERVER
│   │   ├── serverGame.ts      # 20Hz tick loop, CTF state machines, respawn timers,
│   │   │                      #   ghost-input rejection, join/leave bot rebalancing,
│   │   │                      #   kick/ban enforcement hooks
│   │   ├── serverBot.ts       # FSM bots: ENGAGE/FLANK/CAMP/ADVANCE/GRABFLAG/
│   │   │                      #   RETURN/BUILD/TRENCH/RETREAT (+trench planner)
│   │   ├── serverPlayer.ts    # Server player state, throttled footsteps, inventories
│   │   ├── serverWorld.ts     # Server voxel storage, delta sync, unified canBuild()
│   │   ├── logger.ts          # Structured timestamped logging
│   │   ├── banStore.ts        # Persistent bans.json store (IP/name)
│   │   └── README.md          # Server-component reference
│   ├── shared/types.ts        # Network protocol & shared game types
│   ├── App.tsx                # React HUD, menus, scoreboard, lobby
│   └── main.tsx               # React entry
├── server.ts                  # Single production entry: Express static + WS + admin API
├── start-server.bat / .sh     # one-click local server (port arg, installs+builds on first run)
├── scripts/start-local.mjs    # the launcher both wrappers call (also `npm run serve`)
├── public/servers.json        # servers the lobby probes and lists
├── Dockerfile / docker-compose.yml
├── index.html, vite.config.js, tsconfig.json, package.json
└── README.md / DEPLOYMENT.md / AGENTS.md / .env.example
```

**Key invariants** (enforced across client & server):
- Server is authoritative for damage, deaths, respawns, inventory, voxel edits, and all CTF events. Clients render, never decide.
- Dead/spectating players' `playerInput` is rejected server-side (no ghost meshes).
- Respawn always restores 20 blocks (players) / 36-block budget (bots).
- `canBuild()` uses identical logic client & server: seed the flood-fill from the temporarily-filled target cell, require grounded structural support.
- Team size is kept at `SERVER_BOT_COUNT` per side at all times via retire-on-join / backfill-on-leave.
- HP is authoritative in both directions: damage takes it down, out-of-combat regen brings it back (6 HP/s after 6s). Spawn shields (2.5s) block both damage paths and are cancelled by your own shot.
- Map bounds, spawns, flags and every weapon/round/feedback constant live in `src/shared/types.ts`; neither side may re-declare them.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
