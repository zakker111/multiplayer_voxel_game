# Voxel FPS - Multiplayer Server

## Overview

This is the server component for the Voxel FPS multiplayer game. The server handles all game logic, physics, and state management in a server-authoritative architecture.

## Features

- **Server-Authoritative**: All game logic runs on the server
- **Chunk-Based World**: Efficient 16x16 chunk system for voxel management
- **Real-Time Physics**: 20 ticks per second game loop
- **Team System**: Red vs Blue teams
- **Combat System**: Hitscan weapons with headshot/bodyshot damage
- **Building/Destruction**: Voxel manipulation with structural collapse
- **WebSocket Communication**: Real-time client-server communication

## Architecture

```
Server (Node.js + Express + WebSocket)
├── server.ts           - Entry point, HTTP + WebSocket server
├── serverGame.ts       - Game logic, player management, combat
├── serverPlayer.ts     - Player state, physics, collision
└── serverWorld.ts      - Voxel world, chunks, raycasting
```

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start the server
npm run server
```

## Configuration

Environment variables:
- `PORT` - Server port (default: 3000)
- `TICK_RATE` - Server tick rate in Hz (default: 20)

## Network Protocol

### Client → Server Messages

```typescript
{ type: 'join', team: 'red' | 'blue' }
{ type: 'playerInput', input: PlayerInput }
{ type: 'shoot', origin: Position, direction: Position }
{ type: 'useTool', tool: 'pickaxe' | 'spade', target: Position }
{ type: 'build', position: Position }
```

### Server → Client Messages

```typescript
{ type: 'playerJoined', playerId: string, state: PlayerState }
{ type: 'playerUpdated', playerId: string, state: PlayerState }
{ type: 'voxelChanged', change: VoxelChange }
{ type: 'playerDamaged', playerId: string, damage: number }
{ type: 'playerDied', playerId: string, killerId?: string }
{ type: 'hitConfirmed', targetId: string, damage: number, isHeadshot: boolean }
```

## Game Constants

```typescript
WORLD_SIZE = 150          // 150x150 voxel world
CHUNK_SIZE = 16           // 16x16 chunks
GROUND_LEVEL = 8          // Base ground height
PLAYER_SPEED = 5          // Movement speed
SPRINT_MULTIPLIER = 1.6   // Sprint speed boost
JUMP_FORCE = 8            // Jump velocity
GRAVITY = 20              // Gravity acceleration
```

## Weapons

### Rifle
- Fire rate: 0.4s
- Headshot damage: 100 (1-shot kill)
- Body damage: 34 (3-shot kill)
- Spread: 0.01

### SMG
- Fire rate: 0.1s
- Headshot damage: 100 (1-shot kill)
- Body damage: 34 (3-shot kill)
- Spread: 0.04

## Tools

### Pickaxe
- Damage: 1 per hit
- Cooldown: 0.5s
- Harvests voxels (adds to inventory)

### Spade
- Damage: 3 per hit (instant destroy)
- Cooldown: 0.3s
- Does not harvest

## Voxel Types

- `0` - Air (empty)
- `1` - Dirt
- `2` - Stone
- `3` - Grass
- `4` - Built (player-placed)

## Performance

### Optimizations

1. **Chunk-Based Rendering**: Only rebuild affected chunks
2. **Dirty Tracking**: Only send changed chunks to clients
3. **Shared Geometry**: All chunks share same BoxGeometry
4. **Deferred Rebuilds**: Batch voxel changes per frame
5. **Server-Side Physics**: Prevents cheating, ensures consistency

### Benchmarks

- Voxel destruction: ~90x faster with chunks
- Network bandwidth: Only dirty chunks transmitted
- Server tick rate: 20 Hz (50ms per tick)
- Max players: 32+ (depends on server hardware)

## Testing

### Local Testing

```bash
# Terminal 1: Start server
npm run server

# Terminal 2: Start client
npm run dev

# Open multiple browser tabs to test multiplayer
http://localhost:5173
```

### Stress Testing

Test with multiple concurrent players:
- Rapid voxel destruction
- Large-scale building
- Combat scenarios
- Network latency simulation

## Security

### Anti-Cheat Measures

1. **Server Authority**: All game logic on server
2. **Input Validation**: Validate all client inputs
3. **Rate Limiting**: Weapon cooldowns enforced server-side
4. **Movement Validation**: Check for teleportation/speed hacks
5. **Hit Validation**: Server calculates hits, not client

## Deployment

### Production Setup

```bash
# Build
npm run build

# Run with PM2 (process manager)
pm2 start dist/server/server.js --name voxel-fps-server

# Or use Docker
docker build -t voxel-fps-server .
docker run -p 3000:3000 voxel-fps-server
```

### Scaling

For multiple servers:
- Use Redis for shared state
- Load balancer for WebSocket connections
- Region-based servers for low latency

## Troubleshooting

### Port Already in Use

```bash
# Change port
PORT=3001 npm run server
```

### WebSocket Connection Failed

- Check firewall settings
- Ensure WebSocket protocol is allowed
- Verify server is running

### Performance Issues

- Reduce `TICK_RATE` environment variable
- Reduce `WORLD_SIZE` in types.ts
- Increase server resources

## Development

### Adding New Features

1. Update shared types in `src/shared/types.ts`
2. Implement server logic in appropriate file
3. Add network message handlers
4. Update client to handle new messages

### Code Structure

```
src/
├── server/
│   ├── server.ts          # Entry point
│   ├── serverGame.ts      # Game logic
│   ├── serverPlayer.ts    # Player physics
│   └── serverWorld.ts     # Voxel world
├── shared/
│   └── types.ts           # Shared types
└── game/                  # Client code (to be updated)
```

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues and questions:
- Check MULTIPLAYER_ARCHITECTURE.md for detailed documentation
- Review the code comments
- Test with multiple clients locally
