// Headless beta simulation: run a full game with bots and report statistics.
// Simulates a beta game (online mode with workshop, jeeps, emplacements, logistics bots).
// Run: node scripts/beta-simulate.mjs [minutes]

import { ServerGame } from '../dist/tests/serverGame.cjs';
import { ServerBot } from '../dist/tests/serverBot.cjs';

const MINUTES = parseInt(process.argv[2] || '20', 10);
const TICK_DT = 0.05;
const TOTAL_TICKS = MINUTES * 60 * 20;

console.log(`=== BETA GAME SIMULATION (${MINUTES} min) ===`);
console.log('');

const game = new ServerGame();
// Use short rounds for faster simulation feedback
game['roundSeconds'] = (process.argv[3] ? parseInt(process.argv[3]) : 5) * 60;
game['roundPhase'] = 'live';
game['roundTimeLeft'] = game['roundSeconds'];

// Remove default bots
for (const [id, p] of [...game.players]) {
  if (p instanceof ServerBot) game.players.delete(id);
}

function addTeam(team, count, engineers, logistics, assault, support) {
  const ws = game.getWorkshops()[team].position;
  const prefix = team === 'blue' ? 'Blue' : 'Red';
  const sgn = team === 'blue' ? 1 : -1;
  let idx = 0;
  
  for (let i = 0; i < engineers; i++) {
    const bot = new ServerBot(`${prefix}-Eng${idx}`, { ...ws, x: ws.x + sgn * (2 + i), z: ws.z + sgn * (1 + i) }, team, `${prefix}Engineer${idx}`);
    bot.engineer = true; bot.role = 'assault'; bot.botBlocks = 36;
    game.players.set(bot.id, bot); idx++;
  }
  for (let i = 0; i < logistics; i++) {
    const bot = new ServerBot(`${prefix}-Log${idx}`, { ...ws, x: ws.x + sgn * (3 + i), z: ws.z + sgn * (-2 - i * 2) }, team, `${prefix}Logistic${idx}`);
    bot.logistics = true; bot.role = 'support'; bot.botBlocks = 36;
    game.players.set(bot.id, bot); idx++;
  }
  for (let i = 0; i < assault; i++) {
    const bot = new ServerBot(`${prefix}-Atk${idx}`, { ...ws, x: ws.x + sgn * (-4 - i), z: ws.z + sgn * (-3 - i * 2) }, team, `${prefix}Assault${idx}`);
    bot.engineer = false; bot.logistics = false; bot.role = 'assault'; bot.botBlocks = 36;
    game.players.set(bot.id, bot); idx++;
  }
  for (let i = 0; i < support; i++) {
    const bot = new ServerBot(`${prefix}-Sup${idx}`, { ...ws, x: ws.x + sgn * (5 + i * 2), z: ws.z + sgn * (5 + i) }, team, `${prefix}Support${idx}`);
    bot.engineer = false; bot.logistics = false; bot.role = 'support'; bot.botBlocks = 36;
    game.players.set(bot.id, bot); idx++;
  }
  return idx;
}

addTeam('blue', 12, 2, 2, 6, 2);
addTeam('red', 12, 2, 2, 6, 2);

console.log(`Matchup: 12 Blue bots vs 12 Red bots (2 eng, 2 log, 6 atk, 2 sup each)`);
console.log('');

// Stats tracking
const stats = {
  rounds: [],
  totalCaptures: { blue: 0, red: 0 },
  totalWins: { blue: 0, red: 0, draw: 0 },
};
let prevPhase = 'live';
let roundStartCaptures = { blue: 0, red: 0 };

for (let tick = 0; tick < TOTAL_TICKS; tick++) {
  game.update(TICK_DT);
  
  // Detect round endings
  if (prevPhase === 'live' && game['roundPhase'] === 'intermission') {
    const roundNum = game['roundNumber'] - 1;
    const capsBlue = game['captures'].blue - roundStartCaptures.blue;
    const capsRed = game['captures'].red - roundStartCaptures.red;
    const winner = capsBlue > capsRed ? 'blue' : capsRed > capsBlue ? 'red' : 'draw';
    stats.rounds.push({ round: roundNum, winner, captures: { blue: capsBlue, red: capsRed } });
    stats.totalWins[winner]++;
    stats.totalCaptures.blue += capsBlue;
    stats.totalCaptures.red += capsRed;
    roundStartCaptures = { blue: game['captures'].blue, red: game['captures'].red };
  }
  if (prevPhase === 'intermission' && game['roundPhase'] === 'live') {
    roundStartCaptures = { blue: game['captures'].blue, red: game['captures'].red };
  }
  prevPhase = game['roundPhase'];
  
  // Periodic report every 2.5 minutes
  const elapsed = (tick / TOTAL_TICKS) * MINUTES;
  if (elapsed % 2.5 < TICK_DT && tick > 0) {
    const r = game['roundNumber'];
    const p = game['roundPhase'];
    const t = Math.floor(game['roundTimeLeft'] / 60);
    const c = game['captures'];
    const s = game['scores'];
    const w = game['roundWins'];
    const be = [...game.emplacements.values()].filter(e => e.team === 'blue');
    const re = [...game.emplacements.values()].filter(e => e.team === 'red');
    const bj = [...game.jeeps.values()].filter(j => j.team === 'blue' && !j.wreck).length;
    const rj = [...game.jeeps.values()].filter(j => j.team === 'red' && !j.wreck).length;
    
    console.log(`[${elapsed.toFixed(1)}min] R${r} ${p==='live'?'LIVE':`INT(${t}m)`} | Caps: B${c.blue}-R${c.red} | Score: B${s.blue}-R${s.red} | Wins: B${w.blue}-R${w.red} | Emps: B${be.length}(${be.map(e=>e.kind).join(',')||'none'})-R${re.length}(${re.map(e=>e.kind).join(',')||'none'}) | Jeeps: B${bj}-R${rj}`);
  }
}

// ===== FINAL REPORT =====
console.log('');
console.log('═══════════════════════════════════════');
console.log('       BETA SIMULATION COMPLETE        ');
console.log('═══════════════════════════════════════');
console.log('');
console.log(`Duration: ${MINUTES} minutes (${TOTAL_TICKS} ticks @ 20Hz)`);
console.log(`Rounds completed: ${stats.rounds.length}`);
console.log('');

console.log('─── ROUND-BY-ROUND ───');
for (const r of stats.rounds) {
  const w = r.winner.toUpperCase() + (r.winner === 'draw' ? '' : ' WINS');
  console.log(`  Round ${r.round}: ${w.padEnd(12)} | Blue ${r.captures.blue} - Red ${r.captures.red}`);
}
console.log('');

console.log('─── TEAM SUMMARY ───');
console.log(`  Blue round wins:  ${stats.totalWins.blue}`);
console.log(`  Red round wins:   ${stats.totalWins.red}`);
console.log(`  Draws:           ${stats.totalWins.draw}`);
console.log(`  Total captures:  Blue ${stats.totalCaptures.blue} - Red ${stats.totalCaptures.red}`);
console.log('');
const mw = stats.totalCaptures.blue > stats.totalCaptures.red ? 'BLUE' : stats.totalCaptures.red > stats.totalCaptures.blue ? 'RED' : 'DRAW';
console.log(`  MATCH WINNER: ${mw} (${stats.totalCaptures.blue}:${stats.totalCaptures.red} captures)`);
console.log('');

const be = [...game.emplacements.values()].filter(e => e.team === 'blue');
const re = [...game.emplacements.values()].filter(e => e.team === 'red');
const bj = [...game.jeeps.values()].filter(j => j.team === 'blue');
const rj = [...game.jeeps.values()].filter(j => j.team === 'red');
const bAlive = [...game.players.values()].filter(p => p.team === 'blue' && p instanceof ServerBot && !p.isDead).length;
const rAlive = [...game.players.values()].filter(p => p.team === 'red' && p instanceof ServerBot && !p.isDead).length;
const bJeepAlive = bj.filter(j => !j.wreck).length;
const rJeepAlive = rj.filter(j => !j.wreck).length;

console.log('─── FINAL STATE ───');
console.log(`  Blue emplacements: ${be.length} standing (${be.map(e=>e.kind).join(', ')||'none'})`);
console.log(`  Red emplacements:  ${re.length} standing (${re.map(e=>e.kind).join(', ')||'none'})`);
console.log(`  Blue jeeps: ${bJeepAlive}/${bj.length} active`);
console.log(`  Red jeeps:  ${rJeepAlive}/${rj.length} active`);
console.log(`  Blue workshop: ${game['workshopStock'].blue}/${game['WORKSHOP_CAPACITY']}`);
console.log(`  Red workshop:  ${game['workshopStock'].red}/${game['WORKSHOP_CAPACITY']}`);
console.log(`  Blue bots alive: ${bAlive}/12`);
console.log(`  Red bots alive:  ${rAlive}/12`);
console.log('');

// Bot state breakdown
const bS = {}; const rS = {};
for (const [id, p] of game.players) {
  if (p instanceof ServerBot && !p.isDead) {
    const s = p.stateName;
    if (p.team === 'blue') bS[s] = (bS[s]||0)+1; else rS[s] = (rS[s]||0)+1;
  }
}
console.log('  Final bot states:');
console.log(`    Blue: ${JSON.stringify(bS)}`);
console.log(`    Red:  ${JSON.stringify(rS)}`);
console.log('');
console.log('═══════════════════════════════════════');
