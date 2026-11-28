// One-click local game server.
//
//   node scripts/start-local.mjs [port] [--rebuild]
//
// Wraps the steps in README "Run your own server": install dependencies the
// first time, build the client + server bundle when it is missing, print the
// addresses other players can use, then run the production server.
//
// `start-server.bat` (Windows) and `start-server.sh` (Linux/macOS) are thin
// wrappers around this file, so both platforms run exactly the same logic.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const USAGE = 'usage: start-server[.bat|.sh] [port] [--rebuild]';
let port = Number(process.env.PORT ?? 3000);
// What to quote back when the port is rejected: the argument beats PORT, so
// blaming PORT for a bad argument (or vice versa) sends people to the wrong
// place.
let portText = process.env.PORT ?? String(port);
let rebuild = false;
// One pass, two options. An unknown flag is a typo, not a reason to start a
// stale build silently.
for (const arg of process.argv.slice(2)) {
  if (arg === '--rebuild') rebuild = true;
  else if (/^\d+$/.test(arg)) {
    port = Number(arg);
    portText = arg;
  }
  else {
    console.error(`[server] unknown option "${arg}"`);
    console.error(USAGE);
    process.exit(1);
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[server] "${portText}" is not a valid port (1-65535).`);
  console.error(USAGE);
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

/** Run a build step and stop with its exit code if it fails. */
function run(command, argv, label) {
  console.log(`\n[server] ${label}...`);
  // A shell is only needed on Windows, where npm is a .cmd shim.
  const result = spawnSync(command, argv, { stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    console.error(`\n[server] ${label} failed (exit ${result.status ?? '?'}).`);
    console.error('[server] Fix the error above and run this launcher again.');
    process.exit(result.status ?? 1);
  }
}

if (!existsSync('node_modules')) {
  run(npm, ['install'], 'installing dependencies (first run, this takes a minute)');
}

const bundleMissing = !existsSync(path.join('dist', 'server.cjs')) || !existsSync(path.join('dist', 'index.html'));
if (bundleMissing || rebuild) {
  run(npm, ['run', 'build'], 'building the game (client + server)');
}

/**
 * Addresses a friend on the same network can actually open. Docker bridges,
 * VPN tunnels and host-only adapters answer on the interface too, so printing
 * them handed people an address nothing else on the LAN could reach.
 */
const VIRTUAL_ADAPTER = /^(br-|docker|veth|virbr|vmnet|vboxnet|tun|tap|utun|zt)/;
function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const entry of entries ?? []) {
      // 169.254.x.x is a self-assigned address, not one a router handed out.
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) found.push(entry.address);
    }
  }
  return found;
}

const line = '─'.repeat(58);
console.log(`\n${line}`);
console.log('  Voxel FPS server');
console.log(line);
console.log(`  This computer      http://localhost:${port}`);
for (const ip of lanAddresses()) {
  console.log(`  Same network       http://${ip}:${port}   <- friends on your Wi-Fi/LAN`);
}
console.log('');
console.log('  Playing across the internet needs a public address:');
console.log(`    - forward TCP ${port} on your router, then share http://<your-public-ip>:${port}`);
console.log('    - or use a tunnel / VPS (see DEPLOYMENT.md)');
console.log('');
console.log('  In the game: Multiplayer -> the server appears under "Servers found",');
console.log(`  or type this address into the field below the list: localhost:${port}`);
console.log(`${line}\n`);
console.log('[server] starting... (Ctrl+C to stop)\n');

const child = spawn(process.execPath, ['dist/server.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
});

// Ctrl+C on Windows does not reach the child through stdio inherit, so stop it
// ourselves and exit cleanly; any other exit keeps the server's own status so a
// crash does not look like a normal shutdown to the .bat/.sh wrapper.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
}

child.on('exit', (code) => process.exit(stopping ? 0 : (code ?? 1)));
child.on('error', (error) => {
  console.error('[server] could not start:', error.message);
  process.exit(1);
});
