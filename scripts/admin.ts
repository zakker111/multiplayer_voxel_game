/**
 * Admin CLI — kick / ban / unban / list players on a running game server.
 *
 * Usage:
 *   node dist/admin.cjs <command> [args] [--url http://host:port] [--token SECRET]
 *
 * Commands:
 *   status                         Server info + connected players
 *   players                        List connected players (id, name, team, ip)
 *   kick  <playerId|name> [reason] Kick a player off the server
 *   ban   <ip|name> [reason]       Ban an IP or name (also kicks current session)
 *   unban <ip|name>                Remove a ban
 *   bans                           List active bans
 *
 * Examples:
 *   npm run admin -- players
 *   npm run admin -- ban 203.0.113.42 "building griefing"
 *   npm run admin -- kick "Rex" "afk farming"
 *
 * The CLI talks to the server's HTTP admin API (/api/admin/*). Protect it by
 * setting ADMIN_TOKEN on the server and passing --token (or ADMIN_TOKEN env).
 */

interface Argv {
  url: string;
  token: string;
  command: string;
  args: string[];
}

function parseArgv(argv: string[]): Argv {
  const out: Argv = {
    url: process.env.SERVER_URL || 'http://localhost:3000',
    token: process.env.ADMIN_TOKEN || '',
    command: '',
    args: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) { out.url = argv[++i]; continue; }
    if (a === '--token' && argv[i + 1]) { out.token = argv[++i]; continue; }
    if (!out.command) { out.command = a; continue; }
    out.args.push(a);
  }
  return out;
}

async function api(cfg: Argv, path: string, body?: unknown): Promise<any> {
  const res = await fetch(cfg.url.replace(/\/$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${json.error || text}`);
  }
  return json;
}

function printPlayers(players: any[]): void {
  if (!players.length) { console.log('No human players connected.'); return; }
  console.log(`${'ID'.padEnd(28)} ${'NAME'.padEnd(16)} ${'TEAM'.padEnd(6)} ${'IP'.padEnd(16)} HP  STATE`);
  for (const p of players) {
    const state = p.isSpectating ? 'spectating' : p.isDead ? 'dead' : 'alive';
    console.log(`${String(p.id).padEnd(28)} ${String(p.name).padEnd(16)} ${String(p.team).padEnd(6)} ${String(p.ip).padEnd(16)} ${String(p.hp).padEnd(3)} ${state}`);
  }
}

function printBans(bans: any[]): void {
  if (!bans.length) { console.log('No active bans.'); return; }
  console.log(`${'KIND'.padEnd(6)} ${'VALUE'.padEnd(20)} ${'REASON'.padEnd(30)} EXPIRES`);
  for (const b of bans) {
    const exp = b.expiresAt ? new Date(b.expiresAt).toISOString() : 'permanent';
    console.log(`${b.kind.padEnd(6)} ${b.value.padEnd(20)} ${b.reason.padEnd(30)} ${exp}`);
  }
}

async function main(): Promise<void> {
  const cfg = parseArgv(process.argv.slice(2));
  if (!cfg.command || cfg.command === 'help' || cfg.command === '--help') {
    console.log(`Voxel FPS admin CLI — talk to a running game server.

Usage: node dist/admin.cjs <command> [args] [--url URL] [--token SECRET]

Commands:
  status                     Server info + player count
  players                    List connected players
  kick <playerId|name> [..]  Kick a player (optionally with reason)
  ban <ip|name> [reason]     Ban an IP or player name (kicks live session too)
  unban <ip|name>            Remove a ban
  bans                       List active bans

Env: SERVER_URL (default http://localhost:3000), ADMIN_TOKEN, BAN_FILE (server-side)`);
    return;
  }

  switch (cfg.command) {
    case 'status': {
      const s = await api(cfg, '/api/admin/status');
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case 'players': {
      const s = await api(cfg, '/api/admin/players');
      printPlayers(s.players ?? []);
      break;
    }
    case 'kick': {
      const target = cfg.args[0];
      if (!target) throw new Error('kick requires <playerId or name>');
      const reason = cfg.args.slice(1).join(' ') || 'kicked via CLI';
      const r = await api(cfg, '/api/admin/kick', { target, reason });
      console.log(`✅ Kicked: ${JSON.stringify(r.kicked)}`);
      break;
    }
    case 'ban': {
      const value = cfg.args[0];
      if (!value) throw new Error('ban requires <ip or name>');
      const reason = cfg.args.slice(1).join(' ') || 'banned via CLI';
      const kind = /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':') ? 'ip' : 'name';
      const r = await api(cfg, '/api/admin/ban', { kind, value, reason });
      console.log(`✅ Banned ${kind}=${value} (${r.bansTotal} total). Kicked sessions: ${JSON.stringify(r.kicked ?? [])}`);
      break;
    }
    case 'unban': {
      const value = cfg.args[0];
      if (!value) throw new Error('unban requires <ip or name>');
      const kind = /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':') ? 'ip' : 'name';
      const r = await api(cfg, '/api/admin/unban', { kind, value });
      console.log(r.removed ? `✅ Unbanned ${kind}=${value}` : `⚠️ No ban found for ${kind}=${value}`);
      break;
    }
    case 'bans': {
      const r = await api(cfg, '/api/admin/bans');
      printBans(r.bans ?? []);
      break;
    }
    default:
      throw new Error(`Unknown command "${cfg.command}". Run with no args for help.`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
