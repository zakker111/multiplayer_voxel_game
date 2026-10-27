# Voxel FPS — Server Component

The authoritative game server for the Voxel FPS CTF game. It owns the 20 Hz tick
loop, the voxel world, combat, the CTF objective, rounds and the bot AI. Clients
send input and mirror state; they never decide outcomes.

The full product documentation (features, controls, deployment, AI-agent guide)
lives in the repo root: [README.md](../../README.md), [DEPLOYMENT.md](../../DEPLOYMENT.md)
and [AGENTS.md](../../AGENTS.md). This file only covers the server internals.

## Files

| File | Role |
| :--- | :--- |
| `../../server.ts` | Entry point: Express static hosting for `dist/`, HTTP API (`/api/status`, admin), WebSocket upgrade, 20 Hz loop |
| `serverGame.ts` | Players, connections, combat validation, CTF objective, rounds, scores, bot orchestration |
| `serverPlayer.ts` | Server-side player state, movement, ammo/reload, damage, footsteps |
| `serverBot.ts` | FSM bot AI (see below) |
| `serverWorld.ts` | Voxel storage, chunked dirty tracking, raycasts, `canBuild()` |
| `logger.ts` | Structured timestamped logging (`[INFO]` / `[WARN]` / `[ERROR]` + subsystem tag) |
| `banStore.ts` | Persistent `bans.json` store for IP/name bans |

## Running

The server and the built client are one process — there is no separate "server
script". From the repository root:

```bash
npm install
npm run dev      # tsx server.ts + Vite middleware (development, PORT=3000)
npm run build    # vite build + dist/server.cjs + dist/admin.cjs
npm start        # node dist/server.cjs (production)
```

`dist/server.cjs` therefore needs `dist/` (the client bundle) next to it.
There is no `npm run server` script and no `TICK_RATE` variable: the tick rate
is fixed at 20 Hz (`server.ts`), and the port comes from `PORT` (default `3000`).

### Environment variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP + WebSocket bind port |
| `NODE_ENV` | `development` | `production` disables the Vite middleware |
| `ADMIN_TOKEN` | *(empty)* | Remote admin access; empty = localhost-only admin API |
| `SERVER_BOT_COUNT` | `10` | Bots per team at startup and the rebalance target |
| `SERVER_BOT_HP` | `130` | Bot max HP |
| `SERVER_BOT_BLOCKS` | `36` | Bot build budget per life |
| `ROUND_MINUTES` | `30` | Round length in minutes |
| `BAN_FILE` | `bans.json` | Where persistent bans are stored |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FILE` | *(none)* | Also append logs to this file |

## Simulation model

- **20 Hz tick** (`serverGame.update(dt)`): respawn timers, player movement,
  bot AI, dropped-flag timers, captured-flag return timers, round clock,
  spawn-shield expiry, health regeneration and flag-capture checks.
- **Server-authoritative combat**: shots are validated against the shooter's
  weapon (rate limit + ammo), then resolved by a server raycast with line-of-sight
  and range falloff (`weaponDamage()`). Damage, kills, scores and stats are only
  ever applied on the server.
- **Spawn protection**: 2.5 s of immunity at every real spawn, cancelled by the
  player's own shot, and applied on both damage paths.
- **Regeneration**: 6 HP/s after 6 s without taking damage.
- **Rounds**: `ROUND_MINUTES` of CTF, then an intermission that resets captures,
  flags and spawns. Scoring is frozen outside a live round.
- **Roster**: the server keeps `SERVER_BOT_COUNT` combatants per team. A human
  joining retires one bot from that team; a leave/kick/disconnect spawns a
  backfill bot.

Shared constants (world size, spawns, flags, weapon table, round/feedback
timings) live in `src/shared/types.ts` — do not re-declare them here.

## Bot AI (`serverBot.ts`)

States: `ENGAGE`, `FLANK`, `CAMP`, `ADVANCE`, `GRABFLAG`, `RETURN`, `BUILD`,
`TRENCH`, `RETREAT`. Bots check line of sight before firing, revenge-target their
last attacker, prioritize enemy flag carriers, harvest and place blocks through
the same `canBuild()` / entity-clearance rules as players, and build midfield
trench walls with a multi-tick plan guarded from re-decision.

## Protocol

The wire format is a small JSON schema defined once in
`src/shared/types.ts` (`ClientMessage` / `ServerMessage`). Do not hand-document
or duplicate it: add a variant there and both sides type-check.

Server → client highlights: `init` (full snapshot incl. round state),
`playerJoined` / `playerUpdated` / `playerLeft`, `playerShot`,
`hitConfirmed`, `playerDamaged` / `playerDied` (with `weapon` + `isHeadshot`),
`playerRespawned`, `voxelChanged`, `inventoryUpdated`, `scoreUpdate`,
`statsUpdate`, `flagPickedUp` / `flagDropped` / `flagReturned` / `flagCaptured`,
`roundUpdate` / `roundEnded`, `pong`, `kicked`.

Client → server: `join`, `playerInput`, `shoot`, `useTool`, `build`, `reload`,
`pickupFlag`, `captureFlag`, `toggleSpectator`, `footstep`, `requestRespawn`,
`ping`, `disconnect`.

## Security model

- Dead and spectating clients have `playerInput` / `shoot` / `build` /
  `useTool` / flag actions rejected (no ghost entities).
- Voxel edits are re-validated server-side (`canBuild()`, durability, reach).
- Weapon fire rate and magazines are enforced server-side; a replayed shot
  consumes nothing and deals nothing.
- Bans are checked at the WebSocket upgrade stage and persist across restarts.
- Admin endpoints require either a loopback peer or `ADMIN_TOKEN`.

## Tests

From the repository root: `npm test` (54 `node:test` cases). The suites load the
real `serverGame` / `serverWorld` / `serverBot` bundles from `dist/tests/`, so
they exercise real behaviour: voxel build/mine rules, bot trench building and
stuck-state handling, CTF flag drops, spawn bounds, weapon balance, the round
lifecycle and the spawn-shield/regen/feedback layer.

## License

MIT — see [LICENSE](../../LICENSE).
