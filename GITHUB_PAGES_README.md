# Voxel FPS CTF - GitHub Pages Deployment Guide

## Quick Start

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Enable GitHub Pages
1. Go to your repository on GitHub
2. Click **Settings** → **Pages**
3. Under **Build and deployment**:
   - Source: **GitHub Actions**
4. The workflow will automatically deploy

### 3. Access Your Game
After deployment completes (2-5 minutes), access at:
```
https://YOUR_USERNAME.github.io/YOUR_REPO/
```

## What Works on GitHub Pages

✅ **Single Player Mode**
- Full 3D rendering with Three.js
- Red vs Blue bases with flags
- Random obstacles and terrain
- Menu system with team selection
- Score HUD display

⚠️ **Limitations**
- No multiplayer (WebSocket server required)
- No AI bots (client-side only)
- Game runs in single-player mode automatically

## Files Modified for GitHub Pages

1. **vite.config.ts** - Set `base: './'` for relative paths
2. **src/game/networkClient.ts** - Auto-detects github.io and enables single-player mode
3. **.github/workflows/deploy.yml** - GitHub Actions deployment workflow

## Troubleshooting

### Build Fails
```bash
npm install
npm run build
```
Check for TypeScript errors.

### Page Shows Blank
- Ensure `base: './'` is set in vite.config.ts
- Check browser console for errors
- Verify all assets loaded (check Network tab)

### Want Multiplayer?
Deploy the full game with server to:
- Railway.app
- Render.com
- VPS with Docker
- See DEPLOYMENT.md for details

## Local Testing
```bash
npm install
npm run dev
# Open http://localhost:3000
```

To test GitHub Pages behavior locally, modify networkClient.ts to force single player:
```typescript
this.isSinglePlayer = true;
```
