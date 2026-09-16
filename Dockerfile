# Multi-stage Docker build for Voxel FPS (Vite + Express + WebSocket)
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code and build config
COPY . .

# Build Vite client and esbuild server into dist/
RUN npm run build

# Production runner stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy built artifacts and package manifest
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install production dependencies only
RUN npm ci --only=production

# Expose game HTTP & WebSocket port
EXPOSE 3000

# Start server
CMD ["node", "dist/server.cjs"]
