# ---- Stage 1: Build ----
FROM node:22-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config first for dependency caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/studio/package.json packages/studio/

# Install dependencies (cached layer)
RUN pnpm install --no-frozen-lockfile --config.ignore-build-scripts=false

# Copy source code
COPY tsconfig.json ./
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
COPY packages/studio/ packages/studio/

# Build all packages (core → cli → studio)
RUN pnpm -r build

# ---- Stage 2: Production ----
FROM node:22-slim AS runner

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/genres ./packages/core/genres
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/studio/dist ./packages/studio/dist
COPY --from=builder /app/packages/studio/package.json ./packages/studio/
COPY --from=builder /app/packages/studio/index.html ./packages/studio/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# Copy genres
COPY genres/ ./genres/

# Save initial templates to /app/_templates (copied to /data on first boot)
RUN mkdir -p /app/_templates/genres
COPY inkos.json /app/_templates/inkos.json
COPY genres/ /app/_templates/genres/

# Copy and prepare entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Environment
ENV INKOS_STUDIO_PORT=8080
ENV INKOS_PROJECT_ROOT=/data
ENV NODE_ENV=production

EXPOSE 8080

# Fly.io prefers TCP health checks (configured in fly.toml), but keep a basic check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/v1/doctor').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
