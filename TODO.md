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

- **Bot-only matches stalled before the first flag pickup — fixed in the bot AI (Nov 2026).** Two causes: runners paused to rally at 90m, which is exactly the MG nest's `maxRange` (a staged bot took 130 HP of hits and died without moving), and bots only sighted targets at 75m, inside the nest's reach, so a manned nest could never be answered. Runners now rally at 110–200m, builds are sighted out to 130m, and a bot inside a manned gun's reach backs out past `maxRange` while still firing instead of charging the muzzle. After the fix, the seed that produced zero pickups in 30 minutes reaches the stand at 8.2m, and a 6×15-minute 10v10 sweep produced 63 pickups and 13 captures in 5 of 6 matches (was 9/20 zero-capture, 2/20 zero-pickup over 30 minutes).
- **Flag carriers still die on the escape.** Reproduced on seeds 402–404 (15 min, 10v10, 15-min rounds): 35 pickups, 7 captures (20%), 27 carriers killed (77%), mean carry 8.4s. The gun is not the killer: killers were on-foot rifles/SMGs at 14–28m, 3–4 enemies were within 60m, and the carrier died 2–4.5s after pickup, 20–45m from the stand, with 0–0.2 teammates within 25m (the escorts that existed were 60–120m behind). Escorting only begins once the flag is already carried, and closing that gap takes longer than the carrier survives.
- **Rejected lever: pre-grab escorts (Nov 2026).** Letting an assault bot within 90m screen a teammate in `GRABFLAG` within 70m of the enemy flag, so the squad would arrive with the grab, made the game worse: 22 pickups, 3 captures (14%), one zero-capture match, and escort-state bots near a dying carrier *fell* (1.0 → 0.3–0.5 within 120m). Reverted. The escorts hovered around the runner instead of clearing the stand, and still did not close the gap before the carrier died.
- **Rejected lever: a "turn and fight" beat for carriers (Nov 2026).** `doReturn` calls `aimAndShoot`, but `moveTo` turns the body toward the waypoint every tick, so a pursuer behind the carrier never enters the 8° aim cone. The beat let a carrier stop for 1.8s (6s cooldown) when a chaser came inside 25m, long enough to snap around and land the two rifle body shots that kill a 130 HP bot. It cost captures everywhere it was tried, so it is reverted. Measured on nine seeds (402–410, 15 min, 10v10) against the baseline on those same seeds (65 pickups, 10 captures, 54 carrier deaths, carry 7.5s): **54 pickups, 8 captures, 44 deaths** with the beat gated to 45m past the stand, and **40 pickups, 10 captures, 30 deaths** when the beat also dropped panic cover while stopped. Two findings worth keeping: stopping *inside* the stand's killing ground is fatal (the ungated version on 402–404 gave 18 pickups and 2 captures against 35 and 7, carriers dying 1.8s after pickup), and walls placed during a stop stay behind as a stockade near the stand (22.8 blocks a carrier life against 2.5).
- **Kept: carriers fire over the shoulder while running (Nov 2026).** `moveTo` moves along the escape lane but points the body at the waypoint, so every shot `doReturn` took at a chaser was aimed away from it. The fix is a `faceToward(chaser)` after `moveTo`, before `aimAndShoot`: the feet stay on the lane, the body turns onto the pursuer, and the carrier fires at full sprint. Measured on 18 seeds (402–419, 15 min, 10v10) against the unmodified bot on the same seeds: **24 captures, 85 pickups, 58 carrier deaths** versus **11 captures, 94 pickups, 82 deaths** — captures doubled, deaths down 29%, pickups down 10% (a pickup is usually a failed carry, so fewer is not worse). Re-measured on 30 fresh seeds (500–529, same 15-minute 10v10 replay, built bundles differing only in that one block): **37 captures, 129 pickups, 90 carrier deaths** with the change against **19, 131, 110** without it — captures ×1.95, deaths −18%, pickups flat (so the gain is not more flag runs, it is runs that survive), and mean carry before death 5.44s against 3.94s, which is the mechanism showing up directly. It is no longer a one-seed result: seed 513 holds 41% of the with-arm captures, but dropping it leaves 22 against 12, and dropping the top three leaves 14 against 8. Pooled capture counts give p = 0.022; the per-seed sign test is weak (8 seeds up, 3 down) only because 18 of the 30 seeds produce no capture in either arm, so read it as a real but modest effect, not a solved escape problem. Side effect: carriers backpedal along the escape lane while facing the chaser, so they render running backwards while shooting.
 - **Rejected lever: generalised over-the-shoulder fire + a turn-rate cap (Nov 2026).** The carrier hole is not carrier-specific: `moveTo` re-faces the body at the walk direction after `aimAndShoot` has turned it, so every branch that moves and *then* shoots has the same problem (retreat had no return fire at all; escort, flank, camp, grab-flag and the manned-nest standoff only carried private save/restore hacks or nothing). Two variants, both measured on seeds 500–529 (15 min, 10v10) against the kept carrier arm (129 pickups, 37 captures, 90 carrier deaths): (a) `moveTo(..., faceMovement=false)` from every shooting branch plus a single capped turn model in `faceToward` (9 rad/s, replacing `aimAndShoot`'s exponential turn): **22 pickups, 5 captures, 17 carrier deaths** — an order of magnitude worse, and the trace below shows where it goes: it is not pathing and not the turn model, it is the defenders gaining fire while they reposition (see "Why the generalised faceMovement build killed flag runs"). (b) the narrow version, where only `doRetreat` returns fire with the carrier's re-aim-after-move: **107 pickups, 25 captures, 80 carrier deaths** — pickups −17%, captures −32% (per-seed 5 up, 9 down, 16 tied, sign test p ≈ 0.42), so a lever that does not pay. Both reverted; carriers stay the only branch that fires over its shoulder. Note when re-measuring: the same tree now starts workshops at 80 stock, so bots can field a 70-block nest at t=0 and the capture count drops again (43 pickups, 2 captures on 500–511 at stock 80 versus 47 and 7 at stock 50 for the same build), independent of bot AI.
 - **Rejected lever: a bot-side delay before the first emplacement (Nov 2026).** With the workshop opening at 80 stock a bot could drop a 70-block MG nest inside the opening, so the first emplacement of each round was gated on round time (`ctx.roundElapsed`, first gun per bot only; the nest price was left alone). Measured on seeds 500–529 (15 min, 10v10) against the carrier baseline on those seeds — 129 pickups, 37 captures, 90 carrier deaths, reproduced exactly by the ungated tree in the same sweep: **90 s gate 148 pickups, 35 captures, 110 carrier deaths**; **300 s gate 140 pickups, 32 captures, 106 carrier deaths**. Paired per seed, captures do not improve at either dose (90 s −0.07, 95% CI −0.60…+0.43; 300 s −0.17, CI −0.83…+0.27) and pickups and deaths are flat within noise. The gate does what it says — on seed 500 the first hardware moves from 22 s to 91 s and the first MG nest from 151 s to 250 s, and carrier deaths inside an enemy gun's reach fall from 69/90 to 47/106 at 300 s — but captures do not follow, so nests are not what ends the runs on these seeds. Reverted. This also corrects the note above: the "captures dropped at stock 80" sample (43 pickups, 2 captures on 500–511) does not reproduce at 30 seeds — the stock-80 tree without any gate lands on the baseline's 37 captures.
- **Why the generalised faceMovement build killed flag runs (Nov 2026).** The lever stays reverted, but the mechanism is now known. It is not the facing as such and not the turn cap: rebuilt in halves on seeds 500–503 (15 min, 10v10) against the baseline on those seeds (31 pickups, 8 captures, 22 carrier deaths), held facing only gives **3 / 0 / 2**, the 9 rad/s turn cap only **35 / 9 / 26**, and both **3 / 1 / 2** — the whole loss is the held facing, the turn model is neutral. Split by team, it is the **defence** that matters: with only blue holding its facing (blue 1660 shots, 947 of them from `GRABFLAG`, red 778) blue keeps **24 pickups and 18 captures**; with only red holding it, blue gets **1 pickup** while red takes 13. When both sides hold it, neither side's run survives the approach — seed 500 falls to 2 pickups against 13, carry time 137s → 2s, blue deaths 77 → 102.
  Tick by tick nothing about movement changes: 309 blue `GRABFLAG` attempts against 312, 0% blocked steps, 1% sideways steps, every tick walking 8 m/s straight at its lane waypoint — so it is not pathing, and the "closest approach 69.6m vs 7.1m" reading is a tail statistic of the run that happened to survive longest, not a wall in front of the stand. What changes is who is shooting. Runners fire 156 → 598 times from `GRABFLAG` (the feature working), and because a bot re-weights its target to 0.45 for 8s after taking damage (`lastAttackerId`), a runner that shoots becomes the priority target of every defender that can see it: red aiming ticks at a blue runner rise 54% → 75%, red shots fired at runners 280 → 414 (+48%), blue time inside 20m of the stand falls 2 → 0 bot-seconds, and the attempts that reach pickup range (<7m) fall 4 → 1 of ~310. A defender gains far more from firing while moving than a runner does — the defender does not have to arrive, so the fire is free, while the runner pays for every shot with the attention it draws. That asymmetry is the collapse, and it is why the carrier-only version (one branch, only while carrying) measured as a gain while the generalised one did not.
- **Rejected lever: arc-aware escape lanes (Nov 2026).** Each jink lane was scored by its exposure to manned enemy fans (placement facing ± arc/2, min/max range, danger squared toward the muzzle, 120-point weight) on top of terrain cover, because every carrier death the replay checked happened inside a gun's reach. The scoring works mechanically — a unit test with a cannon fanning the direct lane bent the carrier to a side lane — and changes nothing in a match: **65 pickups, 21 captures, 41 carrier deaths on seeds 402–410, identical to the 65/21/41 without it**, and carriers still die inside a gun's reach at the same rate (2/3, 4/4, 5/7, 2/10 …). The geometry says why: a nest or mortar covers 180° of the corridor the carrier has to run, and seven lanes spread over ±40m of a 250m run differ by about 9° of angle — every one of them is inside the same fan. Reverted.
- **Next carrier lever: the approach to the stand, not the escape from it.** No jink offset can leave a fan centred on the run home, so the remaining deaths start before the flag is picked up: a runner who chooses its approach angle (and waits for the nest to change hands or run dry) is out of the arc at the grab. The pickup-side decision is `GRABFLAG`'s waypoint, which today walks straight at the stand; the replay already reports the stand-zone approach, so the same seeds can measure it.
- **A seeded round can still go without a single pickup.** `node scripts/beta-simulate.mjs 15 30 1 10 401` produces 0 pickups and 0 captures in 15 live minutes (169 bot deaths, closest approach 15.9m, one bot in the stand zone), while seeds 402–404 all convert. The nest stall fix above is verified, but this seed still ends a round untouched; needs its own investigation.
- **Carrier diagnostics:** `.tools/carrier-diag.mjs <minutes> <seed,seed,...>` (untracked) replays seeded matches and reports, per carrier death, carry seconds, distance from the stand, teammates at 25/60/120m, killer equipment and distance, and whether the death was inside an enemy gun's reach. The numbers above come from it.
- **Fixed: the bench refused the MG nest at the start of a round (Nov 2026).** The team stockpile opened at 50 blocks while the nest costs 70, so the first craft a player tries was refused as 'Not enough workshop blocks for that build'. Because bots never mine, no nest could appear until a human deposited — the bench's headline build was unreachable at round start and the red price read as a broken button. The start stockpile is now 80 (the nest plus a few blocks of change), and the launch menu's 'how to build' line describes the real path (mine → E at the workshop → B at the bench → 5/6/7 to place) instead of the retired Minecraft-style right-click. `tests/emplacements.test.mjs` now crafts a nest from the untouched opening stockpile, and the wire probe passes 35/35 including craft, ghost, place, man, fire and dismantle.
- **Fixed: a single bad game tick killed the server (Nov 2026).** `server.ts` ran `game.update()` and `broadcastState()` inside a bare `setInterval` callback, so any exception thrown by a frame (bot AI, an emplacement, a serialization) escaped as an uncaught exception and ended the process — one bad frame took every match on that server down with it, which players see as the game crashing. The tick now catches, logs the first failure of each second with its stack, and keeps the round running; frames do not depend on each other, so skipping one is recoverable and losing the server is not.
- **Verification snapshot:** `npm run lint`, `npm run build`, `npm test` (305/305) and the beta probes (`PHASE=all` 31/31 botless, `PHASE=emplacements` 35/35, `PHASE=bots`) pass on `main`.
