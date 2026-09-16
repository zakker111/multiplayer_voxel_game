#!/usr/bin/env node

/**
 * Voxel FPS - Server Startup Script
 * 
 * This script starts the game server for multiplayer gameplay.
 * 
 * Usage:
 *   node start-server.js
 *   or
 *   npm run server (if you add this script to package.json)
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { ServerGame } from './server/serverGame.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`\n🎮 Voxel FPS Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Client URL: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Create game instance
const game = new ServerGame();

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('👤 Client connected');
  
  const playerId = game.addPlayer(ws);
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      game.handleMessage(playerId, message);
    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('👋 Client disconnected');
    game.removePlayer(playerId);
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// Game loop - 20 ticks per second
const TICK_RATE = 20;
const TICK_INTERVAL = 1000 / TICK_RATE;

setInterval(() => {
  game.update(TICK_INTERVAL / 1000);
  game.broadcastState();
}, TICK_INTERVAL);

console.log(`⚙️  Game server started with tick rate: ${TICK_RATE}Hz`);
console.log(`🎯 Waiting for players to connect...\n`);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
