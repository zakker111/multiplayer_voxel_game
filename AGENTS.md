# 🤖 AGENTS.md — AI Developer & Autonomous Agent Guide

Welcome to the **Voxel FPS** codebase. This guide provides artificial intelligence agents, automated evaluation harnesses, and human developers with a complete technical architectural blueprint, directory map, collision systems reference, network protocol specification, and preview guidelines.

---

## 1. Project Overview

**Voxel FPS** is a full-stack, browser-based 3D voxel first-person shooter featuring Red vs Blue Capture the Flag (CTF) gameplay, fully destructible block terrain, procedural Web Audio spatial synthesis, autonomous tactical AI bots, and real-time multiplayer.

- **Frontend Tech Stack**: React 18, Three.js (`^0.186.0`), Tailwind CSS v4, Lucide React icons, Vite.
- **Backend Tech Stack**: Node.js, Express (`^5.2.1`), `ws` (`^8.21.3`), `esbuild`, `tsx`.
- **Target Runtime**: Node.js 18+ container binding exclusively to host `0.0.0.0` and port `3000`.

---

## 2. File Structure & Directory Map

```
├── .github/
│   └── workflows/
│       ├── ci.yml            # Automated GitHub Actions test, lint, and build verification
│       └── deploy-pages.yml  # Automated GitHub Pages client deployment
├── .env.example              # Example environment configuration (PORT, NODE_ENV)
├── .gitignore                # Production git ignore configuration (node_modules, dist, etc.)
├── AGENTS.md                 # This AI agent & architectural reference documentation
├── DEPLOYMENT.md             # Complete step-by-step deployment guide (Railway, Render, VPS, Tunnels)
├── Dockerfile                # Multi-stage production container build
├── docker-compose.yml        # 1-command Docker service definition
├── LICENSE                   # MIT License
├── README.md                 # Public GitHub repository documentation and quick start
├── index.html                # Application HTML5 entry point with responsive styling
├── metadata.json             # AI Studio app metadata & capability declarations
├── package.json              # NPM scripts, dependencies, and project metadata
├── server.ts                 # Unified Express + Vite dev & WebSocket production server
├── tsconfig.json             # TypeScript compiler options
├── vite.config.ts            # Vite bundler configuration with Tailwind CSS plugin
└── src/
    ├── App.tsx               # Primary React HUD UI, start menu, scoreboard, ammo counters
    ├── index.css             # Global CSS with Tailwind CSS import (@import "tailwindcss";)
    ├── main.tsx              # React DOM bootstrap entry point
    ├── game/
    │   ├── game.ts           # Core client game loop, Three.js scene, bot AI, collision, spectator
    │   ├── networkClient.ts  # Client-side WebSocket manager for multiplayer synchronization
    │   ├── player.ts         # Player physics, camera controls, 9-point collision, weapon sway
    │   ├── sounds.ts         # Procedural Web Audio API sound synthesizer (3D spatial audio)
    │   └── world.ts          # Procedural 3D voxel terrain, raycasting, block damage & placement
    ├── server/
    │   ├── server.ts         # Standalone server entry point
    │   ├── serverGame.ts     # Authoritative server game loop, match state, 20Hz tick loop
    │   ├── serverPlayer.ts   # Server player representation and physics state
    │   └── serverWorld.ts    # Server-side voxel storage and delta updates
    └── shared/
        └── types.ts          # Shared network payloads, game state interfaces, and protocols
```

---

## 3. Game Modes & Lobby

1. **🌐 Online Multiplayer (`'online'` client mode)**:
   - Features an interactive **Multiplayer Server Lobby** allowing players to choose either the **Official Server** (`ws://` on port 3000) or specify a **Custom Server URL** (`ws://...` / `wss://...`), pick a custom soldier callsign, and choose their team side (Blue or Red).
   - Server synchronizes players, positions, equipment, flag states, voxel modifications, and match scores.
2. **🤖 Bot Match (`'multiplayer'` client mode)**:
   - Client runs local simulation with autonomous tactical AI bots on Red and Blue teams across the expanded 320m arena.
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
- **World Dimensions**: Expanded arena size `WORLD_SIZE = 320` meters (`-160` to `+160` along X and Z).
- **Flag Positions**:
  - Blue Flag: `(0, y, -95)`
  - Red Flag: `(0, y, +95)`
- **Spawn Zones**: Positioned deep behind home flags to ensure safe rallies and tactical progression:
  - Blue Team Spawn: `Z = -120` to `-145`, `X = ±32`
  - Red Team Spawn: `Z = +120` to `+145`, `X = ±32`
- **Guaranteed Solid Ground & Headroom**:
  - Spawning checks up to 25 candidate spots using `world.getGroundHeight(x, z)` to position entity feet exactly on the surface (`pos.y = groundY`).
  - Headspace clearance is verified at `y + 0.8` and `y + 1.6` meters to prevent entities from ever spawning embedded inside blocks.

### Voxel Data & Sizing
- Voxel coordinates are integer grid values: `x, y, z` centered at `(x, y, z)`.
- Voxel bounding box: `[x - 0.5, x + 0.5] × [y - 0.5, y + 0.5] × [z - 0.5, z + 0.5]`.
- Voxel size is `VOXEL_SIZE = 1.0` meter.
- Types: `0 = AIR`, `1 = GRASS`, `2 = DIRT`, `3 = STONE`, `4 = BUILT`.
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

## 6. Tactical AI State Machine

Bots operate an autonomous decision-making cycle in `src/game/game.ts`:

### Roles
- **Attacker**: Primary objective is rushing the enemy flag and breaking defensive lines.
- **Defender**: Patrols home base perimeter, fortifies flag stand with cover, and intercepts infiltrators.
- **Support / Flanker**: Escorts flag carriers, lays down covering fire, and digs tactical trenches.

### States
- **`'capturing'`**: Navigates toward the enemy flag base using lane offsets.
- **`'returning'`**: Active when carrying the enemy flag; sprints directly toward home base.
- **`'shooting'`**: Faces enemy squarely, engages in lateral strafe dodging, human-like crouch-peeking, and aims weapon vertically with dual-arm Three.js posture.
- **`'building'`**: Equips block, ensures safe separation, and places tactical barricades (`'🧱 RETREAT BARRICADE'`, `'🔨 BUILDING COVER'`, `'🧱 FORWARD COVER'`, `'🧱 FORTIFYING BASE'`).
- **`'digging'`**: Equips trench spade, excavates forward ground to harvest blocks and create defensive trenches.
- **`'defending'`**: Patrols concentric radii around the home team's flag stand.

---

## 7. Multiplayer WebSocket Protocol

The WebSocket protocol uses lightweight JSON messages over `ws://` (or `wss://` in SSL environments).

### Client -> Server Messages
- `join`: `{ type: 'join', name: string, team: 'red' | 'blue' }`
- `input`: `{ type: 'input', position: Vector3, rotation: { yaw, pitch }, isCrouching, isSprinting }`
- `shoot`: `{ type: 'shoot', origin: Vector3, direction: Vector3, weapon: 'rifle' | 'smg' }`
- `build`: `{ type: 'build', position: { x, y, z } }`
- `useTool`: `{ type: 'useTool', tool: 'spade' | 'pickaxe', target: { x, y, z } }`
- `pickupFlag`: `{ type: 'pickupFlag', team: 'red' | 'blue' }`
- `dropFlag`: `{ type: 'dropFlag' }`

### Server -> Client Messages
- `init`: Sends assigned `playerId`, team, map dimensions, and initial player/flag states.
- `state`: 20Hz tick state synchronization (player positions, rotations, animations, health).
- `voxelChanged`: Broadcasts block additions, damages, and destructions.
- `flagCaptured` / `flagDropped` / `flagReturned`: Updates CTF match objective states.
- `sound`: Broadcasts sound triggers (shots, impacts) with spatial coordinates for procedural Web Audio synthesis.

---

## 8. Build, Lint & Run Commands

```bash
# Install dependencies
npm install

# Type-check and lint both client & server without building
npm run lint

# Development mode (runs tsx server.ts with Vite middleware on port 3000)
npm run dev

# Production build (bundles client with Vite and server with esbuild into dist/server.cjs)
npm run build

# Start production server
npm start
```

---

## 9. Rules for Future AI Contributors

1. **Preserve Anti-Clipping Invariants**: Any new block placement or building mechanics MUST pass through `canPlaceBlock` and include de-penetration resolution. Never bypass entity intersection checks.
2. **Keep Networking Port Fixed**: Always bind to port `3000` and host `0.0.0.0`.
3. **No External Audio Assets**: Maintain procedural Web Audio API synthesis in `src/game/sounds.ts` to ensure zero external asset loading dependencies.
4. **Icons**: Exclusively use `lucide-react` for UI icons.
5. **Pointer-Lock Accessibility**: Always keep mouse-drag look and keyboard arrow steering functional alongside Pointer Lock.
