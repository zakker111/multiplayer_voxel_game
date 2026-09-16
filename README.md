# 🎮 Voxel FPS - Capture The Flag

A high-performance, full-stack 3D voxel-based first-person shooter featuring Red vs Blue Capture the Flag gameplay, destructible environments, tactical AI bots, and real-time multiplayer. Built with React 18, Three.js, TypeScript, and Vite.

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-5.7+-blue.svg)
![React](https://img.shields.io/badge/react-18-cyan.svg)
![Three.js](https://img.shields.io/badge/three.js-0.186-black.svg)

---

## ✨ Features

- **🚩 Capture The Flag (CTF)**: Full CTF objective loop across an expanded 320-meter arena with designated base flags (±95m), rear spawn zones (±120m to ±145m), pickup, drop, return timers, carrier HUD tracking, and victory scoring.
- **🌐 Multiplayer Server & Team Lobby**: Choose between the integrated official server (`ws://` on port 3000) or custom external servers (`ws://` / `wss://`), enter custom callsigns, and select your team affiliation (Blue or Red) with real-time state synchronization.
- **🤖 Tactical AI Bots**: Autonomous bots with decision-making state machines for flag capture, base defense, tactical escort, weapon fire, and anti-clipping voxel barricade building.
- **🧱 Destructible Voxel World**: Procedural 3D voxel terrain generated in Three.js. Gunfire blasts away blocks (3 hits per voxel), spade digs trenches, and pickaxe harvests blocks.
- **🏗️ Block Placement / Fortification**: Harvest blocks to build barricades, bridges, and sniper towers in real-time with comprehensive entity intersection and de-penetration protection.
- **🔫 WW2 Arsenal & Iron Sights**:
  - **M1 Garand Rifle**: High-precision semi-automatic with 3D iron sight aiming and authentic recoil.
  - **Thompson SMG**: Fast-firing close-quarters automatic with bullet spread and muzzle flash.
  - **Trench Spade**: Rapid excavation and close-quarters melee.
  - **Pickaxe**: Heavy block harvesting.
- **🎯 Responsive Hit Markers**: Red crosshair hit flashes and audio cues on confirmed enemy hits.
- **🎥 AI Spectator Mode & Accessibility**: One-click spectator camera (`P`) smoothly orbits dynamic battle action and flag carriers. Drag-to-look and arrow-key steering allow instant previewing in browser iframes and AI evaluation environments without mandatory pointer lock.
- **🔊 Spatial 3D Web Audio**: Procedural synthesized audio effects (gunshots, distant bullet whizzing, headshot kills, hit markers, and footsteps) using the Web Audio API without heavy external audio assets.
- **🤖 AI Agent Ready**: Detailed architectural specification in `AGENTS.md` for AI coding agents and automated evaluation harnesses.

---

## 🕹️ Controls Reference

| Action | Control | Notes |
| :--- | :--- | :--- |
| **Move** | `W`, `A`, `S`, `D` | Smooth acceleration & ground collision |
| **Look / Aim** | `Mouse Move` | Click canvas to lock aim; or drag / use Arrow Keys |
| **Alternative Aim** | `↑`, `↓`, `←`, `→` | Keyboard camera steering (ideal for previewing/AI agents) |
| **Fire / Mine** | `Left Click` | Shoots active weapon or swings tool |
| **Iron Sights / Build** | `Right Click` | Toggles ADS iron sights or places voxel block |
| **Weapons / Tools** | `1`, `2`, `3`, `4` | 1: Rifle, 2: SMG, 3: Spade, 4: Pickaxe (or Mouse Wheel) |
| **Reload** | `R` | Reloads magazine with realistic animation |
| **Jump** | `Space` | Jump over obstacles and climb terrain |
| **Sprint** | `Shift` | High-speed dash |
| **Crouch** | `C` or `Ctrl` | Lowers profile and tightens weapon spread |
| **Spectator View** | `P` | Toggles cinematic AI battle tracking camera |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm installed

### 1. Clone & Install
```bash
git clone https://github.com/your-username/voxel-fps.git
cd voxel-fps
npm install
```

### 2. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Build & Verify for Production
```bash
# Type check & lint
npm run lint

# Compile client and server bundles
npm run build

# Start production server
npm start
```

---

## 🌐 Playing and Hosting Over the Internet

The game features an integrated full-stack architecture where **a single Node.js process serves both the web frontend and the authoritative WebSocket game server** on port 3000.

### 1. Instant Play via Cloud or Web Preview
When hosted on any HTTPS domain (e.g. Google Cloud Run, Render, Railway, or your own domain):
- The client automatically detects `window.location.protocol` and connects securely using `wss://yourdomain.com`.
- **Match Invite Links**: Open the **Multiplayer** menu in-game and click **"Copy Link"** (or append `?mode=online&team=red`). Send this link to any friend anywhere in the world on Discord, WhatsApp, or email; clicking it immediately connects them to your live server on the opposite team!

### 2. Local Network (LAN / Wi-Fi)
To play with family or friends on the same Wi-Fi network:
1. Start the server on your computer:
   ```bash
   npm run dev
   ```
2. Find your local IP address (`ipconfig` on Windows, or `ifconfig` / `ip a` on Mac/Linux, e.g. `192.168.1.50`).
3. Have your friends visit `http://192.168.1.50:3000` in their browsers.

---

## 🖥️ Server Setup & Internet Deployment Guide

Here are 5 proven methods to expose or deploy your Voxel FPS server to the public Internet:

### Method 1: Cloudflare Tunnel (⭐ Easiest Free Internet Exposure - No Port Forwarding)
You can expose your local server directly to the public internet securely without opening router ports:
1. Install [Cloudflare Tunnel (`cloudflared`)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):
   ```bash
   # On macOS
   brew install cloudflared

   # On Linux
   sudo apt install cloudflared
   ```
2. Start the game server:
   ```bash
   npm run build && npm start
   ```
3. In a second terminal, launch the quick tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
4. Cloudflare will give you a public `https://<random-subdomain>.trycloudflare.com` URL. Share this URL with anyone on the internet to play!

---

### Method 2: Docker & Docker Compose (Container Deployment)
The repository includes a production multi-stage `Dockerfile` and `docker-compose.yml`:
```bash
# Clone the repository
git clone https://github.com/your-username/voxel-fps.git
cd voxel-fps

# Build and start in detached mode
docker compose up -d

# Check server logs
docker compose logs -f
```
Your server will be running on port 3000 ready for public access or reverse proxying.

---

### Method 3: 1-Click Cloud Deployment (Render / Railway / Fly.io / Cloud Run)

#### Railway:
1. Fork or push this repository to your GitHub.
2. Log into [railway.app](https://railway.app) and select **"New Project" → "Deploy from GitHub repo"**.
3. Railway automatically detects the Node.js project. Under Settings, set `PORT` to `3000` and generate a public domain (`.up.railway.app`).
4. Done! Both the web client and WebSocket server will run live on the assigned HTTPS domain.

#### Render:
1. Go to [render.com](https://render.com) and create a **New Web Service**.
2. Select your repository.
3. Build Command: `npm install && npm run build`
4. Start Command: `npm start`
5. Click **Create Web Service**. Render provides an automatic free `https://<app>.onrender.com` with full WebSocket support.

---

### Method 4: Dedicated Linux VPS (Ubuntu 22.04 + Nginx + PM2 + SSL)

For low-latency community servers on DigitalOcean, Linode, AWS EC2, or Hetzner:

#### Step 1: Install Node.js 20 & PM2
```bash
sudo apt update && sudo apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

#### Step 2: Clone and Build
```bash
cd /var/www
sudo git clone https://github.com/your-username/voxel-fps.git
cd voxel-fps
sudo npm ci
sudo npm run build
```

#### Step 3: Run with PM2 Process Manager
```bash
pm2 start dist/server.cjs --name "voxel-fps"
pm2 save
pm2 startup
```

#### Step 4: Configure Nginx with WebSocket Upgrade
Create `/etc/nginx/sites-available/voxel-fps`:
```nginx
server {
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```
Enable the site and obtain a free Let's Encrypt SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/voxel-fps /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

### Method 5: GitHub Pages Client + External Dedicated Server
If you prefer hosting the client statically on GitHub Pages (`https://username.github.io/voxel-fps`):
1. The included `.github/workflows/deploy-pages.yml` automatically builds and publishes the client to GitHub Pages upon pushing to `main`.
2. When players open your GitHub Pages site, they click **Multiplayer** → **Custom Server** and enter your remote WebSocket server address (e.g. `wss://my-game-server.up.railway.app` or `wss://your-domain.com`).

---

## 📁 Project Architecture

```
├── .github/
│   └── workflows/
│       ├── ci.yml           # Automated GitHub Actions test, lint, and build verification
│       └── deploy-pages.yml # Automated GitHub Pages client deployment
├── Dockerfile               # Multi-stage production container build
├── docker-compose.yml       # 1-command Docker service definition
├── src/
│   ├── game/
│   │   ├── game.ts          # Client game loop, Three.js scene, hit detection, AI bot state machine & spectator
│   │   ├── player.ts        # Player physics, 9-point voxel collision, camera controls, weapon sway
│   │   ├── world.ts         # Procedural voxel world, raycasting, block placement & destruction
│   │   ├── sounds.ts        # Web Audio API procedural sound synthesizer (3D spatial audio)
│   │   └── networkClient.ts # WebSocket client with keepalive heartbeat & multi-server support
│   ├── server/
│   │   ├── serverGame.ts    # Authoritative server game loop (CTF match state, ticks, broadcasts)
│   │   ├── serverPlayer.ts  # Server player representation and state
│   │   └── serverWorld.ts   # Server voxel storage and synchronization
│   ├── shared/
│   │   └── types.ts         # Shared network protocols, game states, and event schemas
│   ├── App.tsx              # React UI HUD, start menu, multiplayer lobby, ammo counters, hitmarker
│   └── main.tsx             # React entry point
├── server.ts                # Unified Express + Vite development & WebSocket production server
├── index.html               # Main HTML entry with responsive meta tags
├── package.json             # NPM configuration and build scripts
└── vite.config.ts           # Vite + Tailwind CSS configuration
```

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).


