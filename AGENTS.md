# 🤖 AGENTS.md — AI Developer & Autonomous Agent Guide

Welcome to the **Voxel FPS** codebase. This guide provides artificial intelligence agents, automated evaluation harnesses, and human developers with a complete technical architectural blueprint, directory map, collision systems reference, network protocol specification, and preview guidelines.

---

## 1. Project Overview

**Voxel FPS** is a full-stack, browser-based 3D voxel first-person shooter featuring Red vs Blue Capture the Flag (CTF) gameplay, fully destructible block terrain, procedural Web Audio spatial synthesis, autonomous tactical AI bots, and real-time multiplayer.

- **Frontend Tech Stack**: React 18, Three.js (`^0.186.0`), Tailwind CSS v4, Lucide React icons, Vite.
- **Backend Tech Stack**: Node.js, Express (`^5.2.1`), `ws` (`^8.21.3`), `esbuild`, `tsx`.
- **Target Runtime**: Node.js 18+ binding host `0.0.0.0` and `process.env.PORT` (default `3000`; Render injects its own).
- **Game Balance**: Server maintains a full `SERVER_BOT_COUNT` (default 10) roster per team at all times — humans retiring bots on join, bot backfills spawning on leave/kick/disconnect.
- **Authority Model**: The server is authoritative for damage, deaths, respawns, inventories, voxel edits, and all CTF events. Clients render state; they never decide it.

---

## 2. File Structure & Directory Map

```
├── .github/
│   └── workflows/
│       ├── ci.yml            # GitHub Actions: lint -> build -> test on every push/PR
│       └── deploy-pages.yml  # Optional static GitHub Pages client deployment
├── .env.example              # Example env config (PORT, NODE_ENV, ADMIN_TOKEN, bot + round tuning)
├── .gitignore                # Production git ignore configuration (node_modules, dist, etc.)
├── AGENTS.md                 # This AI agent & architectural reference documentation
├── DEPLOYMENT.md             # Deployment guide (Render primary; Docker, Cloudflare Tunnel, VPS+Nginx+PM2, GitHub Pages)
├── Dockerfile                # Multi-stage production container build
├── docker-compose.yml        # 1-command Docker service definition
├── LICENSE                   # MIT License
├── README.md                 # Public GitHub repository documentation and quick start
├── index.html                # Application HTML5 entry point with responsive styling
├── package.json              # NPM scripts, dependencies, and project metadata
├── public/.nojekyll          # Keeps GitHub Pages from running Jekyll on the client build
├── scripts/admin.ts          # Admin CLI: status/players/kick/ban/unban against the admin API
├── tests/                    # node:test regression suites: voxel rules, bots, flag drops,
│                             #   spawn bounds, weapon balance, rounds, spawn shield/regen/feedback
├── server.ts                 # Single production entry: Express static + WS server + admin API (reads process.env.PORT)
├── tsconfig.json             # TypeScript compiler options
├── vite.config.js            # Vite bundler configuration with Tailwind CSS plugin
└── src/
    ├── App.tsx               # Primary React HUD UI, start menu, scoreboard, ammo counters
    ├── index.css             # Global CSS with Tailwind CSS import (@import "tailwindcss";)
    ├── main.tsx              # React DOM bootstrap entry point
    ├── game/
    │   ├── game.ts           # Client game loop, input handling (one-click build, single-shot rifle),
    │   │                     # network handlers, server-authoritative respawn flag, spectator guards
    │   ├── networkClient.ts  # Client-side WebSocket manager for multiplayer synchronization
    │   ├── player.ts         # Player physics, camera controls, 9-point collision, weapon sway
    │   ├── sounds.ts         # Procedural Web Audio API sound synthesizer (3D spatial audio)
    │   └── world.ts          # Procedural 3D voxel terrain, raycasting, block damage & placement
    ├── server/
    │   ├── serverGame.ts     # Authoritative 20Hz tick loop, CTF state machines, respawn timers,
    │   │                     # ghost-input rejection, join/leave bot rebalancing, kick/ban hooks
    │   ├── serverBot.ts      # Server FSM bots (ENGAGE/FLANK/CAMP/ADVANCE/GRABFLAG/RETURN/BUILD/TRENCH/RETREAT)
    │   ├── serverPlayer.ts   # Server player state, throttled footsteps, inventories
    │   ├── serverWorld.ts    # Server voxel storage, delta sync, unified canBuild() flood-fill
    │   ├── logger.ts         # Structured timestamped [INFO]/[WARN] logging with subsystem tags
    │   ├── banStore.ts       # Persistent bans.json store (IP/name), checked at WS upgrade
    │   └── README.md         # Server-component reference (files, env vars, simulation model)
    └── shared/
        └── types.ts          # Shared network payloads, game state interfaces, and protocols
```

---

## 3. Game Modes & Lobby

1. **🌐 Online Multiplayer (`'online'` client mode)**:
   - Interactive lobby: **Official Server** (auto-detected `wss://` from page origin, or `ws://localhost:<PORT>` in dev) or a **Custom Server URL**, custom callsign, team pick (Blue/Red). Invite links via `?mode=online&team=red`.
   - Server synchronizes players, positions, equipment, flag states, voxel modifications, and match scores at 20Hz. Teams are kept at 10v10 by retiring a bot when a human joins that team and backfilling a bot when a human leaves/is kicked/disconnects.
   - Legacy client-side bots are DISABLED in online mode (server owns all bots) to prevent duplicates.
2. **🤖 Bot Match (`'multiplayer'` client mode)**:
   - Offline local simulation with client-side tactical AI bots on Red and Blue teams across the 448m arena (only used when NOT connected to a server).
   - Player can play as either team or enter Spectator mode (`P`).
3. **🧪 Free Sandbox (`'singleplayer'` client mode)**:
   - No bots or enemies; used for free building, terrain destruction testing, and weapon mechanics.

---

## 4. AI Preview & Sandbox Testing Guidelines

When evaluating, previewing, or debugging this application within automated AI harnesses or sandboxed iframes:

### URL Query Parameters for Automated Launch
The application supports direct URL launch parameters:
- `?mode=spectator`: Automatically starts a bot match and enters the cinematic AI tracking spectator camera.
- `?mode=bots`: Automatically starts a local bot match on the Blue team.
- `?mode=online`: Automatically connects to the local WebSocket multiplayer server.
- `?mode=sandbox`: Starts free sandbox mode.
- `&team=red` or `&team=blue`: Preselects team side (default: `blue`).
- `&server=<ws_url>`: Specifies custom WebSocket endpoint.

*Example*: `http://localhost:3000/?mode=spectator`

### Pointer-Lock-Free Navigation
Because browser iframe sandboxes often restrict the HTML5 Pointer Lock API:
- **Look / Camera Aiming**: Dragging with the mouse anywhere across the canvas rotates the view without requiring pointer lock.
- **Alternative Keyboard Aiming**: Arrow keys (`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`) steer the camera smoothly.
- **Spectator Controls**:
  - `P`: Toggles Spectator Mode on/off.
  - `C`: Toggles between **Action Combat Cam** (auto-orbits active firefights and flag carriers) and **Free-Fly Drone Cam** (WASD + Space/Shift to fly).

---

## 5. Arena Sizing, Spawns & Anti-Clipping System

### Arena Dimensions & Spawn Positioning
- **World Dimensions**: Arena size `WORLD_SIZE = 448` meters (`-224` to `+224` along X and Z; chunk-aligned at 28x28 chunks of 16m).
- **Flag Positions** (`BLUE_FLAG_POS` / `RED_FLAG_POS` in `src/shared/types.ts`):
  - Blue Flag: `(0, y, -160)`
  - Red Flag: `(0, y, +160)` — 320m apart, so a flag run crosses the whole arena
- **Spawn Zones**: Positioned deep behind home flags to ensure safe rallies and tactical progression:
  - Blue Team Spawn: `Z = -220` to `-200`, `X = ±32`
  - Red Team Spawn: `Z = +200` to `+220`, `X = ±32`
- **Out-of-world check**: `isOutOfWorld()` / `VOID_KILL_Y` are derived from `WORLD_SIZE`
  (`WORLD_HALF`); never hardcode a map bound — a stale `124` was what made spawns
  self-eliminate on the 448m map.
- **Guaranteed Solid Ground & Headroom**:
  - Spawning checks up to 25 candidate spots using `world.getGroundHeight(x, z)` to position entity feet exactly on the surface (`pos.y = groundY`).
  - Headspace clearance is verified at `y + 0.8` and `y + 1.6` meters to prevent entities from ever spawning embedded inside blocks.

### Voxel Data & Sizing
- Voxel coordinates are integer grid values: `x, y, z` centered at `(x, y, z)`.
- Voxel bounding box: `[x - 0.5, x + 0.5] × [y - 0.5, y + 0.5] × [z - 0.5, z + 0.5]`.
- Voxel size is `VOXEL_SIZE = 1.0` meter.
- Types: `0 = AIR`, `1 = DIRT`, `2 = STONE`, `3 = GRASS`, `4 = BUILT` (player-placed).
- **Raycasting Coordinate Alignment**: Because voxels are centered at `(x, y, z)` with boundaries at `(x ± 0.5, y ± 0.5, z ± 0.5)`, voxel raycasting algorithms (`world.raycast` and `serverWorld.raycast`) offset the ray origin by `+0.5` (`sx = origin.x + 0.5`, etc.). This maps the voxel cubes cleanly onto the standard integer grid cells `[voxel, voxel + 1]`, guaranteeing that bullets and tools hit the exact voxel and surface boundary without offset drift.

### Entity Clearance Check (`doesVoxelIntersectAnyEntity` & `canPlaceBlock`)
Located in `src/game/game.ts` and `src/server/serverGame.ts`:
- **`doesVoxelIntersectAnyEntity(x, y, z, ignoreBot?)`**:
  Calculates the Axis-Aligned Bounding Box (AABB) of the target voxel `[x - 0.5, x + 0.5] × [y - 0.5, y + 0.5] × [z - 0.5, z + 0.5]` and checks for intersection with the player's bounding cylinder (`radius = 0.45`, `height = player.currentHeight`) and all active bots' bounding cylinders (`radius = 0.48`, `height = 1.95`).
- **`canPlaceBlock(x, y, z, ignoreBot?)`**:
  Verifies that the target voxel is supported by adjacent/ground voxels (`world.canBuild`) AND does not intersect any living entity. Blocks are rejected if any entity is inside the space.

### Bot Movement 3D Collision (`checkBotVoxelCollision`)
Located in `src/game/game.ts`:
- Checks a 9-point radial footprint at 3 distinct vertical elevations (`y + 0.15`, `y + 0.9`, `y + 1.65`).
- Uses integer grid rounding (`Math.round`) matching Three.js voxel centers.
- Moving bots test X and Z axes independently with `checkBotVoxelCollision` before applying translation.
- **Maximum Step-Up**: Bots cannot step up onto obstacles higher than `0.35m` while crouching or building (preventing climbing atop freshly placed barricades). Normal walking step-up threshold is `1.1m`.

### De-Penetration Routine (`resolveBotVoxelPenetration`)
- Runs continuously after movement steps, after block placement, and immediately before copying coordinates to the visual Three.js mesh.
- If an entity's center is somehow embedded in a voxel, it calculates the shortest escape vector to the voxel boundary and pushes the bot outward safely.
- Checks all 8 neighboring voxel columns at multiple height levels and applies smooth radial pushback if overlapping.

### Tactical Queue Spacing
- Bots queue barricades and cover at a minimum distance of `2.0m` from their current position.
- In `isBuilding`, if a bot is closer than `1.45m` to the queued block, it automatically steps backward away from the placement coordinate before setting the voxel.

---

## 6. Server-Side Bot AI (`src/server/serverBot.ts`)

Bots are authoritative server entities running a finite-state machine. Defaults: **10 per team** (`SERVER_BOT_COUNT`), **130 HP** (`SERVER_BOT_HP`), **36-block** build budget (`SERVER_BOT_BLOCKS`), 4s respawn (same as humans).

### States
- **`ENGAGE`** — strafe & shoot visible enemies (LOS raycast checks, aim error, combat reaction throttle).
- **`FLANK`** — swing wide around the enemy line before pushing in.
- **`CAMP`** — hold a spot, crouch, pre-aim common lanes, snipe on sight.
- **`ADVANCE`** — push toward the enemy half along lane offsets.
- **`GRABFLAG`** — navigate to the enemy flag and take it (server validates pickup at radius 7.0).
- **`RETURN`** — carry the flag home; may build cover when pinned mid-field.
- **`BUILD`** — harvest/place blocks for near-base cover or rush towers (respects `canBuild()` + entity clearance).
- **`TRENCH`** — dig and wall a fortified fighting trench on the midfield approach lane (progressive plan of ~9-cell wall, 2 high, one cell placed every other tick; blocked-transition guard refreshes `stateUntil` so a half-built wall still completes cleanly).
- **`RETREAT`** — fall back when low HP, out of ammo, or surrounded.

### Intelligence Behaviors
- **Revenge targeting**: last damager gets short-term priority.
- **Flag-carrier priority**: bots hunt the enemy carrier and defend their own.
- Transition guard protects multi-tick jobs (TRENCH) from random re-decisions while keeping legitimate exits (RETURN/RETREAT) open.
- Bots respect the same anti-clipping pipeline as players (`canPlaceBlock`, de-penetration, step-up limits).
- **Objective commit**: a bot in `GRABFLAG` only abandons the run for enemies inside
  `OBJECTIVE_COMMIT_RANGE` (24m) and only retreats below `OBJECTIVE_RETREAT_HP` (15%),
  and it fires on the move. Before this, any visible enemy (75m) cancelled the run.
- **Known limitation (measured, not fixed)**: bot-only matches rarely complete flag
  runs — a 10-minute headless match (20 bots) produced zero pickups and no bot got
  closer than ~50m to an enemy stand, because every attacker crosses 300m of open
  ground against an equal number of defenders with no cover play or push coordination.
  CTF scoring therefore depends on human players or a future AI pass (roles, cover
  usage, respawn-wave timing). Don't assume the objective is exercised just because
  `GRABFLAG`/`RETURN` exist in the state machine.

### Rounds (`serverGame.ts`)
- A round is a fixed-length window of CTF: `ROUND_MINUTES` (default 30) → `roundSeconds`. Rounds are long on purpose (448m arena, ~320m flag runs).
- `updateRound(dt)` runs from the game loop: live → clock down → `endRound()` (more captures wins, equal is a draw) → 20s intermission → `startNextRound()` (captures reset, flags home, everyone respawns at their own spawn).
- Scoring is frozen outside a live round: `handleFlagPickup()` and `handleFlagCapture()` early-return, and `update()` skips `checkFlagCaptures()`. The world keeps simulating so the battle stays alive through the intermission.
- `getRoundSnapshot()` is the single source for the HUD (`init` + `roundUpdate`) and `/api/status`.
- `tests/roundLifecycle.test.mjs` drives a shortened round through the real `ServerGame` clock.

### Spawn protection & regeneration (`serverGame.ts`)
- Every real spawn (join, manual respawn, scheduled respawn, round start) calls
  `grantSpawnProtection()`: `SPAWN_PROTECTION_SECONDS` (2.5s) of immunity.
- Both damage paths are gated — `applyDamage()` (bots) and the human shot raycast
  in `handleShoot()` — and a shielded hit returns **before** the hit marker, so it
  cannot leak kills, score or stats. The shield is dropped early by the player's
  own shot (`clearSpawnProtection()` in `handleShoot`, `clearSpawnProtection(botId)`
  on bot fire), so it can never be used offensively. Death also clears it.
- `updateHealth(dt)` (from `update()`) expires shields (broadcasting the state so
  the HUD badge disappears) and regenerates `REGEN_RATE` HP/s once a player has
  been quiet for `REGEN_DELAY_SECONDS` (6s). HP is synced only when the visible
  integer changes, never per tick.
- The client applies HP in **both** directions from `playerUpdated` (damage and
  regen); it used to ignore any HP increase, so healed players never saw it.

### Feedback layer (`game.ts` / `App.tsx`)
- `killfeed`: the client builds rows from `playerDied` (server sends `weapon` +
  `isHeadshot`); names are resolved client-side because the server only knows ids.
- `damageIndicators`: `playerDamaged` on the local player records the **attacker's
  world position**, and each frame the bearing is recomputed with
  `relativeBearingDegrees()` (shared, pure) so the arc keeps pointing at the
  shooter while you turn. Degrees: 0 = ahead, +90 = right, ±180 = behind.
- `pingMs`: the client sends `{ type: 'ping', t }` every 2s and the server echoes
  `{ type: 'pong', t }`; the HUD shows the round-trip time (green/amber/red).
- `tests/feedback.test.mjs` covers the shield on both damage paths, regen timing
  and caps, ping/pong, the killfeed payload and the bearing math.

### Join/Leave Rebalancing (`serverGame.ts`)
- `replaceBotWithPlayer(team)` kills & removes one bot from the joining human's team (fallback: other team, then fresh spawn).
- `removePlayer()` drops any carried flag, clears respawn timers, and calls `spawnBotForTeam(team)` if that team fell below target size.

---

## 7. Multiplayer WebSocket Protocol

The WebSocket protocol uses lightweight JSON messages over `ws://` (or `wss://` in SSL environments).

All messages are JSON. The server REJECTS `playerInput`/`shoot`/`build`/`useTool`/`pickupFlag` from dead or spectating clients (ghost-update protection) and validates every voxel edit through `serverWorld.canBuild()` / mining rules.

### Client -> Server Messages
The single source of truth is `ClientMessage` in `src/shared/types.ts`.
- `join`: `{ type: 'join', team: 'red' | 'blue', position?: Position, name?: string }`
- `playerInput`: `{ type: 'playerInput', input: PlayerInput }` where `PlayerInput` is
  `{ moveX, moveZ, jump, crouch, sprint, yaw, pitch, position?, equipment?, isAiming? }`
- `shoot`: `{ type: 'shoot', origin: Position, direction: Position, targetId?: string, isHeadshot?: boolean }`
  (`targetId` is only a hint: the server re-raycasts and validates line of sight.)
- `useTool`: `{ type: 'useTool', tool: 'pickaxe' | 'spade', target: Position }`
- `build`: `{ type: 'build', position: Position }`
- `reload`: `{ type: 'reload' }`
- `pickupFlag`: `{ type: 'pickupFlag' }` (the server decides which flag by proximity)
- `captureFlag`: `{ type: 'captureFlag', team: 'red' | 'blue' }`
- `toggleSpectator`: `{ type: 'toggleSpectator' }`
- `footstep`: `{ type: 'footstep', volume: number, pitch: number }`
- `requestRespawn`: `{ type: 'requestRespawn' }`
- `ping`: `{ type: 'ping', t: number }` — echoed back as `pong` for the latency readout
- `disconnect`: `{ type: 'disconnect' }`

### Server -> Client Messages
`ServerMessage` in `src/shared/types.ts` is authoritative; summary:
- `init`: assigned `playerId`, own `state`, all `players`, `scores`, `captures`,
  `stats`, `inventory`, modified `voxelChanges`, full `flags` snapshot and the
  current `round` — so a late joiner is immediately in sync.
- `playerJoined` / `playerUpdated` / `playerLeft`: roster and per-player state
  (positions, rotation, HP, equipment, ammo, `carryingFlag`, `spawnProtected`, `isBot`).
- `playerShot`: `{ playerId, origin, direction, weapon }` for tracers/muzzle flash.
- `hitConfirmed`: `{ targetId, damage, isHeadshot }` sent to the **shooter** only.
- `playerDamaged`: `{ playerId, damage, attackerId? }` — feedback only; clients do
  not apply HP deltas from it (the authoritative `playerUpdated` follows).
- `playerDied`: `{ playerId, killerId?, weapon?, isHeadshot? }` — drives the killfeed.
- `playerRespawned`: `{ playerId, position }`; the server schedules respawns (4s).
- `voxelChanged`: `{ change: { x, y, z, type, durability } }`; `chunkUpdated` for bulk chunks.
- `inventoryUpdated`: block count sync (respawn resets to 20).
- `scoreUpdate` / `statsUpdate`: authoritative team scores and per-player K/D/captures.
- `flagPickedUp` / `flagDropped` / `flagReturned` / `flagCaptured`: CTF events
  (`flagDropped` carries the ground position and optional former carrier).
- `roundUpdate`: `{ round: RoundSnapshot }` — ~1Hz plus every phase change; clients
  count the clock down locally in between.
- `roundEnded`: `{ round, winner: 'red'|'blue'|'draw', captures, wins }`.
- `pong`: `{ t }` — echo of `ping`, used only to measure latency.
- `spectatorToggled`, `footstep`, `gameState`, `kicked`: spectator mirroring, remote
  footstep audio, full-state fallback and kick/ban notices.

---

## 8. Build, Lint & Run Commands

```bash
npm install
npm run lint        # tsc --noEmit (client + server)
npm test            # node --test tests/ — 54 regression tests (voxel rules, bots, rounds, spawn shield/regen, feedback)
                    # (pretest bundles src/server/serverWorld.ts, serverBot.ts, shared/types.ts into dist/tests/)
npm run dev         # tsx server.ts with Vite middleware (PORT, default 3000)
npm run build       # vite bundle + dist/server.cjs + dist/admin.cjs (esbuild)
npm start           # production server (reads process.env.PORT)
npm run admin -- status|players|kick|ban|unban|bans [--url ... --token ...]
```

---

## 9. Rules for Future AI Contributors

1. **Preserve Anti-Clipping Invariants**: Any new block placement or building mechanics MUST pass through `canPlaceBlock` and include de-penetration resolution. Never bypass entity intersection checks.
2. **Port From Environment**: Bind host `0.0.0.0` and `process.env.PORT ?? 3000`. Never hardcode ports (Render compatibility).
3. **No External Audio Assets**: Maintain procedural Web Audio API synthesis in `src/game/sounds.ts` to ensure zero external asset loading dependencies.
4. **Icons**: Exclusively use `lucide-react` for UI icons.
5. **Pointer-Lock Accessibility**: Always keep mouse-drag look and keyboard arrow steering functional alongside Pointer Lock.
6. **Server Authority Is Non-Negotiable**: New combat/objective/inventory features must be validated server-side first; clients mirror state only. Keep `canBuild()` logic byte-identical between `src/game/world.ts` and `src/server/serverWorld.ts`.
7. **Input Contract**: Right-click builds exactly ONE block per click (never shoot/mine); rifle fires once per left-click; SMG/tools auto-fire while held. Preserve separate `isLeftDown`/`isRightDown` tracking.
8. **Balance Invariant**: Any code path that removes a player (leave, kick, ban) MUST trigger same-team bot backfill; any join MUST retire a bot from that team. Update `tests/` when changing these rules.
9. **Weapon Stats Have One Home**: Damage, fire rate, spread, magazine, reload and range falloff live ONLY in `WEAPONS` (`src/shared/types.ts`). Both the client (`src/game/game.ts`, via `makeWeapon`) and the server (`serverGame` / `serverPlayer` / `serverBot`) must read it, and every hit must go through `weaponDamage()` so range falloff matches. Re-declaring a stat is what made the client's SMG hit for 34/100 while the server dealt 20/34. `tests/weaponBalance.test.mjs` fails if a gun literal reappears in the client.
