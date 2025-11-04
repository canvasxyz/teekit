# Multi-stage build for Kettle Launcher
# Build from monorepo root to handle workspace dependencies
FROM node:20-slim AS builder

# Install system dependencies needed for building
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory to monorepo root
WORKDIR /workspace

# Copy root package files
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy workspace packages (qvl and tunnel must be built first)
COPY packages/qvl ./packages/qvl
COPY packages/tunnel ./packages/tunnel
COPY packages/kettle ./packages/kettle

# Install dependencies for all workspaces
RUN npm ci

# Build workspace dependencies first (as per root package.json build script)
WORKDIR /workspace
RUN npm --workspace packages/qvl --workspace packages/tunnel run build

# Build the kettle launcher and worker
RUN npm --workspace packages/kettle run build:worker

# Production stage
FROM node:20-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy built kettle package
COPY --from=builder /workspace/packages/kettle/services/lib ./services/lib
COPY --from=builder /workspace/packages/kettle/package.json ./
COPY --from=builder /workspace/packages/kettle/dist ./dist

# Copy built workspace dependencies with their package.json files for proper resolution
COPY --from=builder /workspace/packages/qvl/package.json ./packages/qvl/
COPY --from=builder /workspace/packages/qvl/lib ./packages/qvl/lib
COPY --from=builder /workspace/packages/tunnel/package.json ./packages/tunnel/
COPY --from=builder /workspace/packages/tunnel/lib ./packages/tunnel/lib

# Copy node_modules (workspace symlinks will be preserved)
COPY --from=builder /workspace/node_modules ./node_modules

# Ensure workspace packages are properly linked in node_modules
# npm workspaces create symlinks, so we need to recreate them
RUN mkdir -p ./node_modules/@teekit && \
    rm -rf ./node_modules/@teekit/qvl ./node_modules/@teekit/tunnel 2>/dev/null || true && \
    ln -sf ../../packages/qvl ./node_modules/@teekit/qvl && \
    ln -sf ../../packages/tunnel ./node_modules/@teekit/tunnel

# Create entrypoint script that supports multiple configuration methods
RUN echo '#!/bin/sh\n\
set -e\n\
\n\
# Method 1: Use KETTLE_MANIFEST environment variable (highest priority)\n\
if [ -n "$KETTLE_MANIFEST" ]; then\n\
    echo "Using manifest from KETTLE_MANIFEST: $KETTLE_MANIFEST"\n\
    exec node services/lib/cli.js launch "$KETTLE_MANIFEST" \\\n\
        --port "${KETTLE_PORT:-3001}" \\\n\
        --db-dir "${KETTLE_DB_DIR:-/data}" \\\n\
        ${KETTLE_VERBOSE:+--verbose}\n\
\n\
# Method 2: Use mounted manifest file\n\
elif [ -f /app/manifest.json ]; then\n\
    echo "Using manifest from /app/manifest.json"\n\
    exec node services/lib/cli.js launch /app/manifest.json \\\n\
        --port "${KETTLE_PORT:-3001}" \\\n\
        --db-dir "${KETTLE_DB_DIR:-/data}" \\\n\
        ${KETTLE_VERBOSE:+--verbose}\n\
\n\
# Method 3: Use default manifest location\n\
elif [ -f manifest.json ]; then\n\
    echo "Using manifest from manifest.json in working directory"\n\
    exec node services/lib/cli.js launch manifest.json \\\n\
        --port "${KETTLE_PORT:-3001}" \\\n\
        --db-dir "${KETTLE_DB_DIR:-/data}" \\\n\
        ${KETTLE_VERBOSE:+--verbose}\n\
\n\
else\n\
    echo "Error: No manifest configuration found"\n\
    echo "  Please provide one of:"\n\
    echo "    - KETTLE_MANIFEST environment variable (URL or file path)"\n\
    echo "    - /app/manifest.json file (mounted volume)"\n\
    echo "    - manifest.json file in working directory"\n\
    exit 1\n\
fi' > /entrypoint.sh && chmod +x /entrypoint.sh

# Create data directory for database
RUN mkdir -p /data

# Expose default port
EXPOSE 3001

# Health check (optional - adjust based on your app)
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${KETTLE_PORT:-3001}/ || exit 1

# Use entrypoint script
ENTRYPOINT ["/entrypoint.sh"]

