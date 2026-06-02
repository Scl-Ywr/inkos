#!/bin/sh
set -e

DATA_DIR="${INKOS_PROJECT_ROOT:-/data}"
TEMPLATE_DIR="/app/_templates"

# Ensure data directory exists (may not exist without a mounted volume)
mkdir -p "$DATA_DIR"

# ─── First-run initialization: copy project scaffolding to persistent volume ───
if [ ! -f "$DATA_DIR/inkos.json" ]; then
  echo "[entrypoint] First run detected — initializing persistent data at $DATA_DIR"

  # Copy project config
  cp "$TEMPLATE_DIR/inkos.json" "$DATA_DIR/inkos.json"

  # Copy genres (needed by book creation)
  cp -rn "$TEMPLATE_DIR/genres" "$DATA_DIR/" 2>/dev/null || true

  # Create essential directories
  mkdir -p "$DATA_DIR/books" "$DATA_DIR/.inkos/sessions"

  echo "[entrypoint] Initialization complete"
else
  echo "[entrypoint] Persistent data found at $DATA_DIR — skipping init"
fi

# Ensure .inkos directory exists
mkdir -p "$DATA_DIR/.inkos/sessions"

# ─── Start InkOS Studio ───
exec node /app/packages/studio/dist/api/index.js
