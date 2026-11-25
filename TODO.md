# Vehicle and Workshop Roadmap

## Goal

Add playful blocky vehicles and team workshops that make the large CTF map more fun to cross and give mining and teamwork a new purpose. Capture the flag remains the main objective; vehicles and mortars must not turn matches into spawn-camping battles.

### Visual direction

- Jeeps made from chunky team-coloured blocks, with square tires, a little windshield and bouncy movement.
- Tanks with wide blocky tracks and oversized turrets.
- Mortars that look like simple homemade machines.
- Simple sounds and easily recognised silhouettes rather than realistic military models.
- Player-placed hardware should read as improvised: sandbags, welded plate, a crate with team paint.

## Initial rules and scope

These are starting choices for playtesting, not final balance numbers.

- Each team starts with one protected workshop and garage near its base, plus a small shared stockpile.
- Players and bots collect blocks and bring them to their own workshop. The team uses its shared supply to build vehicles and equipment.
- The server checks the cost and spawns a selected vehicle on a clear garage pad.
- Vehicles belong to a team; teammates can use them, but enemies cannot steal them in the first version.
- Vehicles can be damaged and destroyed; wrecks disappear after a short animation.
- Flag carriers travel on foot: players cannot pick up a flag while seated or enter a vehicle while carrying a flag. Revisit after balance testing.
- The first release targets online multiplayer. Offline bot matches and sandbox have separate logic and need their own support later.
- Players' free respawn blocks remain usable for ordinary building but cannot be deposited. Track mined, depositable blocks separately so repeated respawns cannot create unlimited workshop resources.

## Phase 1 — Workshop and resource foundation

**Goal:** Make team supply collection work before introducing moving vehicles.

- [x] Place one workshop and garage pad per team, close to its base but clear of spawn and flag areas.
- [x] Add independent shared team stockpiles, each with a starting balance and storage limit.
- [x] Track mined, depositable blocks separately from free respawn building blocks.
- [x] Let players deposit mined blocks at their own workshop.
- [x] Add a simple workshop HUD showing the stockpile and the upcoming jeep recipe; its cost is not yet set.
- [x] Protect workshops in the first version so an early attack cannot remove a team's ability to play.
- [x] Reset workshop stockpiles at the start of each round. Existing terrain persists between rounds; decide separately whether terrain should reset.
- [x] Validate deposits, team ownership and interaction distance on the server.
- [x] Validate the jeep recipe cost on the server.
- [x] Synchronize workshop state for existing players and late joiners.

**Done when:** Both teams can independently collect and deposit blocks, balances are correct for all players including late joiners, and respawning cannot generate free depositable resources.

## Phase 2 — First playable vehicle: the jeep

**Goal:** Deliver one funny-looking vehicle that is genuinely fun to drive.

- [x] Create a small team-coloured jeep from box shapes, including four square tires.
- [x] Start with one driver seat; leave passengers until driving works reliably.
- [x] Add enter/exit controls, steering, acceleration, reversing and braking with simple arcade handling.
- [x] Make the server authoritative over vehicle movement, occupancy and health; clients send inputs and display the resulting state.
- [x] Handle uneven ground, walls, trenches and other vehicles without clipping through terrain.
- [x] Check for a safe exit space and handle blocked exits.
- [x] Add vehicle health, destruction and safe cleanup when the driver dies, disconnects or becomes a spectator.
- [x] Limit active jeeps per team and prevent spawning when the garage pad is blocked.
- [x] Prevent vehicle entry and flag pickup combinations prohibited by the initial flag-carrier rules.
- [x] Keep run-over damage disabled in the first version.
- [x] Synchronize vehicle state and occupants for late joiners.

**Acceptance:** Automated server and live protocol checks pass. A human browser playtest is still needed to confirm driving feel, visuals, building, exit, destruction and synchronization between players.

## Phase 3 — Bots use the jeep

**Goal:** Make vehicles part of the battle, not just toys for humans.

- [x] Let suitable assault bots request an available jeep and drive toward an objective.
- [x] Add initial vehicle-aware steering and obstacle detection for the vehicle's wider footprint.
- [x] Make bots stop and exit near the objective, when the vehicle is badly damaged or when they are stuck.
- [x] Add recovery: reverse, try another route, then abandon the vehicle if necessary.
- [x] Keep some bots on foot for defending, building and escorting.
- [x] Give humans priority for vehicles at the garage.
- [x] Improve routing on the actual terrain until bot-only matches show drivers reaching useful objective positions without repeated abandonment.
- [ ] Human browser playtest of building, driving feel, exits, destruction and bot behaviour.

**Status:** Movement collision now uses the jeep's exact oriented 1.3×2m rectangle — the same shape bullets already raycast — instead of a circumscribed circle of radius ≈2.4m that rejected gaps the vehicle physically fits through. Bot drivers plan steering arcs with that same collision model. Across nine consecutive 10-minute bot matches there were **0 stuck abandonments** (previously every few matches had one); objective arrivals occurred in 7 of 9 runs with 1–2 per run, and the remaining exits were damage exits from enemy fire. A 20-minute run had 2 damage exits and no arrivals. A regression test drives both teams across the generated terrain and exits near the enemy objective. Automated Phase 3 acceptance is met; human browser playtesting is still pending.

**Done when:** Bot matches show bots building or taking jeeps, reaching useful positions, exiting and returning to normal CTF behaviour without indefinitely circling, blocking the garage or abandoning defence.

**Foundation (done):** vehicle numbers now live in one `VEHICLES` table per kind (cost, HP, team limit, footprint, height, boarding reach) and the server reads them through `vehicleSpec()`; snapshots carry the vehicle kind. A new vehicle is a table record plus a mesh, not a copy of the jeep path.

## Phase 4 — Blueprints and player-built emplacements

**Goal:** Let players spend team supply on static hardware they place themselves, picked from three hotkey slots, with one shared implementation instead of a copy of the jeep code per build.

**How building works (v1 design — playtest, then tune)**

- **Three blueprint slots per player**, selected with `5`, `6`, `7`. Weapons and tools stay on `1`–`4`, so nothing existing moves. Pressing the active slot again cancels.
- Selecting a slot enters **placement mode**: a ghost of that structure follows the ground under the crosshair, tinted green where the server would accept it and red where it would not. `Q` rotates in 90° steps, left click places, right click cancels. Firing is suppressed while a ghost is up.
- **The server is the only judge.** `placeEmplacement { kind, position, yaw }` is validated for flat ground, clearance from players/vehicles/other emplacements, map bounds, and the no-build rings around spawns, flags and enemy workshops. Cost is charged from the team stockpile only on success — a rejected placement costs nothing.
- The ghost tint is **advisory**: it comes from a server "can I place here?" reply for the current ghost position, so a crafted client cannot build inside a wall.
- **Blueprints are a team-shared loadout**, not a personal inventory: the workshop HUD lists the three slots with their costs, and a player who has not chosen gets a default trio (MG nest, supply crate, spotting post).
- Every emplacement is a **server entity** with team ownership, health, a per-team limit and round-reset cleanup, following the same pattern as `ServerJeep`. Nothing is client-authoritative.
- Indirect-fire and automated emplacements get a **minimum range** and a no-build ring so they cannot be dropped onto their own base or the enemy spawn.

**Emplacements**

- [x] **MG nest / sentry** — sandbagged heavy MG. 70 blocks, 300 HP, 2 per team, 180° arc, 200 rounds, manned with `F`. Uses the existing hitscan; the server picks targets. Bots build, man and fire it in Beta rounds too.
- [x] **Cannon** — direct-fire anti-vehicle gun. 90 blocks, 350 HP, 1 per team, narrow arc, 10 shells, slow reload, small splash. Needs the projectile work below.
- [x] **Mortar** — indirect fire. 80 blocks, 250 HP, 1 per team, 25–120 m range, 6 shells, arcing shell with a visible impact warning and a reload the enemy can hear.
- [x] **Supply crate** — 20 blocks, 150 HP, 3 per team, forward stockpile teammates can deposit into and draw from, so a squad does not shuttle to base every trip.
- [x] **Spotting post** — 40 blocks, 200 HP, 1 per team, a tower whose radius marks enemies on the owning team's HUD. Counts as a structure, not a seat.

**Shared work**

- [x] Put every emplacement kind in one data table (cost, HP, team limit, footprint, arc, ammo, range) the way `VEHICLES` now works for vehicles.
- [x] Server-side placement: ground/clearance/bounds checks, enemy-base ring, per-team limits and cost charged only on success (`placeEmplacement`), with tests. The ghost preview and the server validity reply ship with it.
- [x] Projectiles for cannon and mortar: server-stepped shells with travel time, collision against terrain, players and vehicles, and blast damage reusing `damageVoxel`.
- [x] Manning: `F` on an emplacement with the same occupancy and safe-exit rules as a jeep seat.
- [x] Bot awareness: emplacements are obstacles for pathing and valid targets for `ENGAGE`; a manned nest must not be walked into.
- [x] Blueprint HUD and ghost meshes per kind, with the validity tint driven by the server reply.
- [x] Round reset clears emplacements and refunds nothing, matching vehicles.
- [x] Automated coverage: placement validation (charged exactly once, rejected placements free), per-team limits, arc/ammo/range, round cleanup, and a `PHASE=emplacements` probe pass over the real protocol.

**Done when:** A player picks one of three blueprint slots, places each emplacement kind with the ghost, is charged exactly once, sees it survive, fire or supply as designed, watches it be destroyed, and finds it gone after a round reset — while a bot match still plays the objective and a nest or crate cannot camp a spawn.

## Phase 5 — Team logistics and passengers

**Goal:** Make the workshop a shared team activity.

- [x] Let engineer or logistics bots gather and deposit resources under the same server rules as humans.
- [x] Ammo economy: every gun reloads from a pouch, magazines are bought at the team bench with workshop blocks (3 per rifle magazine, 2 per SMG, six-magazine cap), and bots buy theirs from the same stock while leaving a build floor. Bots and humans both run dry when a team stops mining.
- [x] Add a jeep passenger seat for bots and humans.
- [ ] Make bots collect resources when supplies are low and request a jeep when it helps an attack, without wasting the entire team stockpile.
- [ ] Show useful feedback such as low supplies, build progress and vehicle or emplacement availability.
- [ ] Decide how teams recover from repeated vehicle losses without forcing repetitive mining.

**Done when:** A mostly bot-filled team can keep the workshop supplied and use vehicles while still playing the objective.

## Phase 6 — Tank and anti-vehicle balance

**Goal:** Add a slower, tougher vehicle with clear counters.

- [ ] Build a chunky, slow tank with a rotating block turret, as a `VEHICLES` record plus its own mesh.
- [ ] Add a server-controlled cannon, limited fire rate and visible projectile or shot effect, reusing the projectile work from Phase 4.
- [ ] Make tanks cost more than jeeps and limit their numbers.
- [ ] Give infantry a practical anti-vehicle counter, such as a workshop-built weapon, before tanks can dominate matches.
- [ ] Protect spawn areas and garage exits from long-range tank camping.

**Done when:** Tanks support attacks, infantry can counter them, and neither team can lock down the other's spawn.

## Phase 7 — Balance, polish and release

- [ ] Run real multiplayer browser playtests with humans and bots on both teams.
- [ ] Measure vehicle and emplacement builds, deposits, time spent stuck, captures and deaths, not just whether they appear.
- [ ] Tune costs, health, speeds, supply rates, ammo and limits against the existing on-foot game.
- [ ] Test network interruptions, late joins, occupancy, griefing, round transitions and server performance with the full bot roster.
- [ ] Add sounds, workshop guidance and clear HUD prompts (including the three blueprint slots).
- [ ] Decide whether to bring the new systems to offline bot matches and sandbox.

**Parked until the above is balanced:** barricade kits, repair tools, supply carts, per-team workshop upgrades and blueprints unlocked by play. Add them only after nests, cannons and mortars prove fun.

## First milestone

Complete **Phases 1–3**: two workshops, one blocky jeep and bots that can drive it. Playtest this complete slice before investing in tanks and mortars.

## Next milestone

Complete **Phase 4**: three blueprint slots, five emplacement kinds and the ghost placement flow, with the shared table and projectile work that the tank then reuses. Playtest one emplacement of each kind before Phase 6 begins.

## Known issues (November 2026 verification)

- **Bot-only matches can stall before the first flag pickup.** In a paired 20-seed sweep of full 30-minute 10v10 matches, 9 seeds produced zero captures and 2 seeds produced no pickups at all. The same pattern occurs on the pre-blueprint-AI baseline, so this is a break-through/balance problem, not a metric bug. Reproduce with `node scripts/beta-simulate.mjs 30 30 1 10 101`; fix before tuning vehicles against bot matches.
- **Verification snapshot:** `npm run lint`, `npm run build`, `npm test` (260/260) and `npm run smoke` (against `dist/server.cjs`) all pass on `main`.
