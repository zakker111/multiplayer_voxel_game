import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { ServerGame } from './serverGame';

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from dist directory
app.use(express.static(path.join(__dirname, '../dist')));

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Create game instance
const game = new ServerGame();

// Handle WebSocket connections
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');
  
  const playerId = game.addPlayer(ws);
  
  ws.on('message', (data: string) => {
    try {
      const message = JSON.parse(data.toString());
      game.handleMessage(playerId, message);
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    game.removePlayer(playerId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Game loop - 20 ticks per second
const TICK_RATE = 20;
const TICK_INTERVAL = 1000 / TICK_RATE;

setInterval(() => {
  game.update(TICK_INTERVAL / 1000);
  game.broadcastState();
}, TICK_INTERVAL);

console.log(`Game server started with tick rate: ${TICK_RATE}Hz`);
