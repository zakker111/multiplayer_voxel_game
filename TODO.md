# Vehicle and Workshop Roadmap

## Goal

Add playful blocky vehicles and team workshops that make the large CTF map more fun to cross and give mining and teamwork a new purpose. Capture the flag remains the main objective; vehicles and mortars must not turn matches into spawn-camping battles.

### Visual direction

- Jeeps made from chunky team-coloured blocks, with square tires, a little windshield and bouncy movement.
- Tanks with wide blocky tracks and oversized turrets.
- Mortars that look like simple homemade machines.
- Simple sounds and easily recognised silhouettes rather than realistic military models.

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

## Phase 4 — Team logistics and passengers

**Goal:** Make the workshop a shared team activity.

- [x] Let engineer or logistics bots gather and deposit resources under the same server rules as humans.
- [ ] Add a jeep passenger seat for bots and humans.
- [ ] Make bots collect resources when supplies are low and request a jeep when it helps an attack, without wasting the entire team stockpile.
- [ ] Show useful feedback such as low supplies, build progress and vehicle availability.
- [ ] Decide how teams recover from repeated vehicle losses without forcing repetitive mining.

**Done when:** A mostly bot-filled team can keep the workshop supplied and use vehicles while still playing the objective.

## Phase 5 — Tank and anti-vehicle balance

**Goal:** Add a slower, tougher vehicle with clear counters.

- [ ] Build a chunky, slow tank with a rotating block turret.
- [ ] Add a server-controlled cannon, limited fire rate and visible projectile or shot effect.
- [ ] Make tanks cost more than jeeps and limit their numbers.
- [ ] Give infantry a practical anti-vehicle counter, such as a workshop-built weapon, before tanks can dominate matches.
- [ ] Protect spawn areas and garage exits from long-range tank camping.

**Done when:** Tanks support attacks, infantry can counter them, and neither team can lock down the other's spawn.

## Phase 6 — Mortars and other workshop equipment

**Goal:** Add tactical support without overwhelming the map.

- [ ] Add a simple stationary mortar built at the workshop and deployed at a suitable location.
- [ ] Give it limited range, slow reload, visible warning and capped ammunition.
- [ ] Let an assigned bot use it against useful targets and stop when the situation changes.
- [ ] Protect spawn areas from bombardment and control terrain destruction to avoid erasing bases or overwhelming the server.
- [ ] Consider other workshop items only after the mortar is balanced, such as barricade kits, repair tools or supply carts.

**Done when:** Mortars help break a defensive position without making spawning, defending or approaching the flag unfair.

## Phase 7 — Balance, polish and release

- [ ] Run real multiplayer browser playtests with humans and bots on both teams.
- [ ] Measure vehicle builds, deposits, time spent stuck, captures and deaths, not just whether vehicles appear.
- [ ] Tune costs, health, speeds, supply rates and limits against the existing on-foot game.
- [ ] Test network interruptions, late joins, occupancy, griefing, round transitions and server performance with the full bot roster.
- [ ] Add sounds, workshop guidance and clear HUD prompts.
- [ ] Decide whether to bring the new systems to offline bot matches and sandbox.

## First milestone

Complete **Phases 1–3**: two workshops, one blocky jeep and bots that can drive it. Playtest this complete slice before investing in tanks and mortars.
