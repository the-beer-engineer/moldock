#!/bin/bash
# Build MolDock Agent distributable
# Produces:
#   1. A single .mjs file (runs with: node moldock-agent.mjs)
#   2. A standalone binary if bun is available (runs directly: ./moldock-agent)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

mkdir -p "$BUILD_DIR"

echo "=== MolDock Agent Build ==="
echo ""

# Step 1: Bundle TypeScript into single ESM file (zero deps, runs with node 20+)
echo "[1/3] Bundling TypeScript → single .mjs file..."
cd "$PROJECT_DIR"
npx esbuild src/agentClient.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --outfile="$BUILD_DIR/moldock-agent.mjs"

BUNDLE_SIZE=$(du -h "$BUILD_DIR/moldock-agent.mjs" | cut -f1)
echo "  build/moldock-agent.mjs ($BUNDLE_SIZE)"
echo "  Run with: node build/moldock-agent.mjs --server URL"
echo ""

# Step 2: Try to build standalone binary with bun (if available)
if command -v bun &>/dev/null; then
  echo "[2/3] Building standalone binary with bun..."

  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
  esac

  BINARY_NAME="moldock-agent-${PLATFORM}-${ARCH}"

  bun build src/agentClient.ts \
    --compile \
    --target=bun \
    --outfile "$BUILD_DIR/$BINARY_NAME"

  BIN_SIZE=$(du -h "$BUILD_DIR/$BINARY_NAME" | cut -f1)
  echo "  build/$BINARY_NAME ($BIN_SIZE)"
  echo ""
else
  echo "[2/3] Skipped standalone binary (bun not installed)"
  echo "  Install bun for single-file executables: curl -fsSL https://bun.sh/install | bash"
  echo ""
fi

# Step 3: Create launcher scripts for convenience
echo "[3/3] Creating launcher scripts..."

# Unix launcher
cat > "$BUILD_DIR/moldock-agent" << 'LAUNCHER'
#!/bin/bash
# MolDock Remote Agent — launcher script
# Requires Node.js 20+ (https://nodejs.org)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/moldock-agent.mjs" "$@"
LAUNCHER
chmod +x "$BUILD_DIR/moldock-agent"

# Windows launcher
cat > "$BUILD_DIR/moldock-agent.cmd" << 'LAUNCHER'
@echo off
:: MolDock Remote Agent — Windows launcher
:: Requires Node.js 20+ (https://nodejs.org)
node "%~dp0moldock-agent.mjs" %*
LAUNCHER

echo ""
echo "=== Build Complete ==="
echo ""
echo "  Distributable files in build/:"
echo "    moldock-agent.mjs    — single-file agent (node 20+)"
echo "    moldock-agent        — Unix launcher script"
echo "    moldock-agent.cmd    — Windows launcher script"
echo ""
echo "  Usage:"
echo "    ./build/moldock-agent --server https://moldock.example.com"
echo "    node build/moldock-agent.mjs --server http://localhost:3456"
