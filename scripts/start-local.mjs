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

const args = process.argv.slice(2);
const portArg = args.find((arg) => arg.startsWith('--port='))?.split('=')[1]
  ?? args.find((arg) => /^\d+$/.test(arg));
const port = Number(portArg ?? process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[server] "${portArg ?? port}" is not a valid port (1-65535).`);
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isWindows = process.platform === 'win32';

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
if (bundleMissing || args.includes('--rebuild')) {
  run(npm, ['run', 'build'], 'building the game (client + server)');
}

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
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
console.log('  In the game: Multiplayer -> Choose Server -> Servers found,');
console.log(`  or type ws://<address>:${port} into the Custom Server field.`);
console.log(`${line}\n`);
console.log('[server] starting... (Ctrl+C to stop)\n');

const child = spawn(process.execPath, ['dist/server.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error('[server] could not start:', error.message);
  process.exit(1);
});

// Ctrl+C on Windows does not reach the child through stdio inherit.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
