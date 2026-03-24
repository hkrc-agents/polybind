#!/usr/bin/env bash
# bind.sh — Convert a C++/ArkTS tool directory into a polymath-ready extension.
#
# Usage:
#   bash bind.sh <source-dir> <output-dir> [--platform node|arkts|both]
#
# Detects the case automatically:
#   Case 1 (C++ only):      compile + generate ArkTS/Node.js wrappers
#   Case 2 (C++ + ArkTS):   check/fix ArkTS interfaces, generate manifest
#   Case 3 (ArkTS only):    check/fix ArkTS interfaces, generate manifest
#
# Options:
#   --platform node    Build .node binary for Node.js  (Case 1 only)
#   --platform arkts   Build .so binary for HarmonyOS  (Case 1 only)
#   --platform both    Build both targets               (Case 1 only)
#   (omit --platform to skip compilation and only generate files)
#
# Output always includes manifest.yaml. See README.md for full details.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEGEN="$SCRIPT_DIR/codegen/dist/index.js"

# ── Check dependencies ────────────────────────────────────────────────────────

# Find a Node.js ≥ 14 (needed for ESM + modern syntax).
# Prefer nvm-managed node, then PATH node.
NODE=""
for candidate in \
    "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin/node" \
    "$(command -v node 2>/dev/null)"; do
  if [ -x "$candidate" ]; then
    ver=$("$candidate" -e "process.exit(parseInt(process.versions.node.split('.')[0]) >= 14 ? 0 : 1)" 2>/dev/null && echo "ok" || echo "")
    if [ "$ver" = "ok" ]; then NODE="$candidate"; break; fi
  fi
done
if [ -z "$NODE" ]; then
  echo "[polybind] Error: Node.js ≥ 14 not found. Install Node.js 14+ or use nvm."
  exit 1
fi

if [ ! -f "$CODEGEN" ]; then
  echo "[polybind] codegen not built. Building..."
  cd "$SCRIPT_DIR/codegen" && npm install --quiet && npm run build --quiet && cd -
  echo "[polybind] codegen built successfully."
fi

# ── Arguments ─────────────────────────────────────────────────────────────────

SRC="${1:?Usage: bind.sh <source-dir> <output-dir> [--platform node|arkts|both]}"
OUT="${2:?Usage: bind.sh <source-dir> <output-dir> [--platform node|arkts|both]}"

# Parse optional flags from remaining arguments
PLATFORM=""
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:?--platform requires node|arkts|both}"; shift 2 ;;
    *) echo "[polybind] Unknown option: $1"; exit 1 ;;
  esac
done

SRC="$(cd "$SRC" 2>/dev/null && pwd || echo "$SRC")"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

echo "[polybind] Source:  $SRC"
echo "[polybind] Output:  $OUT"

# ── Detect file types ─────────────────────────────────────────────────────────

# Find .ets files, excluding Index.ets (UI-only)
ETS_FILES=$(find "$SRC" -name "*.ets" ! -name "Index.ets" 2>/dev/null | sort)
# Find .cpp files (any depth)
CPP_FILES=$(find "$SRC" -name "*.cpp" 2>/dev/null | sort)

HAS_ETS=false
HAS_CPP=false
[ -n "$ETS_FILES" ] && HAS_ETS=true
[ -n "$CPP_FILES" ] && HAS_CPP=true

echo "[polybind] ArkTS (.ets): $HAS_ETS  |  C++ (.cpp): $HAS_CPP"

# ── Determine case ────────────────────────────────────────────────────────────

if $HAS_CPP && ! $HAS_ETS; then
  CASE=1
  echo "[polybind] Case 1: C++ only → compile + generate wrappers"
elif $HAS_CPP && $HAS_ETS; then
  CASE=2
  echo "[polybind] Case 2: C++ + ArkTS mixed → check/fix ArkTS interfaces"
else
  CASE=3
  echo "[polybind] Case 3: ArkTS only → check/fix interfaces"
fi

echo ""

# ── Step 1: Check and fix ArkTS files (cases 2 & 3) ──────────────────────────

if $HAS_ETS; then
  echo "── Step 1: Checking ArkTS interface compliance ──────────────────────────────"
  while IFS= read -r F; do
    BASENAME="$(basename "$F")"
    OUT_ETS="$OUT/$BASENAME"
    echo "[polybind] Checking $BASENAME ..."
    if "$NODE" "$CODEGEN" check "$F" --out "$OUT_ETS" --fix; then
      echo "[polybind] ✓ $BASENAME: compliant"
    else
      echo "[polybind] ✓ $BASENAME: fixes applied → $OUT_ETS"
    fi
  done <<< "$ETS_FILES"
  echo ""
fi

# ── Step 2: Generate manifest.yaml ───────────────────────────────────────────

echo "── Step 2: Generating manifest.yaml ─────────────────────────────────────────"

if [ -f "$SRC/tools.yaml" ]; then
  echo "[polybind] Found tools.yaml — generating manifest from descriptor..."
  "$NODE" "$CODEGEN" generate "$SRC/tools.yaml" --out "$OUT"
else
  echo "[polybind] No tools.yaml found — inferring manifest from .ets files..."
  "$NODE" "$CODEGEN" generate-from-ets --ets "$OUT" --out "$OUT/manifest.yaml"
  echo "[polybind] ✓ manifest.yaml (inferred)"
fi
echo ""

# ── Step 3: Case 1 — generate C++ build files and wrappers ───────────────────

if [ "$CASE" = "1" ]; then
  echo "── Step 3: Generating C++ build configuration ───────────────────────────────"

  if [ -f "$SRC/tools.yaml" ]; then
    # Generate polybind_entry.cpp into the SOURCE directory so CMake picks it up.
    "$NODE" "$CODEGEN" entry-cpp "$SRC/tools.yaml" \
      --out "$SRC/polybind_entry.cpp"
    echo "[polybind] ✓ polybind_entry.cpp → $SRC/polybind_entry.cpp"

    "$NODE" "$CODEGEN" cmake "$SRC/tools.yaml" \
      --polybind-root "$SCRIPT_DIR" \
      --out "$OUT/CMakeLists.txt"
    echo "[polybind] ✓ CMakeLists.txt"
  else
    echo "[polybind] Warning: no tools.yaml — CMakeLists.txt not generated."
    echo "[polybind]   Create tools.yaml in $SRC and re-run bind.sh."
  fi

  if [ -f "$SRC/tools.yaml" ]; then
    echo ""
    echo "── Step 4: Generating ArkTS/Node.js wrappers ───────────────────────────────"
    "$NODE" "$CODEGEN" wrappers "$SRC/tools.yaml" --out "$OUT"
  fi
  echo ""

  # ── Step 5: Compile (only if --platform was given) ─────────────────────────

  if [ -n "$PLATFORM" ]; then
    if ! command -v cmake &>/dev/null; then
      echo "[polybind] Error: cmake not found. Install CMake ≥ 3.14 to compile."
      exit 1
    fi

    cmake_version=$(cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    echo "[polybind] cmake: $(cmake --version | head -1)"

    build_platform() {
      local plat="$1"
      local build_dir="$OUT/build/$plat"
      # Clean stale cmake cache to avoid inheriting settings from previous runs
      rm -rf "$build_dir"
      echo ""
      echo "── Step 5 [$plat]: Configuring ──────────────────────────────────────────────"
      cmake -B "$build_dir" \
            -DPOLYBIND_PLATFORM="$plat" \
            -DCMAKE_BUILD_TYPE=Release \
            "$OUT"
      echo ""
      echo "── Step 5 [$plat]: Building ─────────────────────────────────────────────────"
      cmake --build "$build_dir" --config Release
      echo ""
      echo "[polybind] ✓ Build complete → $build_dir"
      # Report the produced artifact
      if [ "$plat" = "node" ]; then
        find "$build_dir" -name "*.node" 2>/dev/null | sed 's/^/[polybind]   artifact: /'
      else
        find "$build_dir" -name "*.so" 2>/dev/null | sed 's/^/[polybind]   artifact: /'
      fi
    }

    case "$PLATFORM" in
      node)  build_platform node ;;
      arkts) build_platform arkts ;;
      both)  build_platform node; build_platform arkts ;;
      *)
        echo "[polybind] Error: --platform must be node, arkts, or both (got: $PLATFORM)"
        exit 1
        ;;
    esac
    echo ""
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo "── Done ─────────────────────────────────────────────────────────────────────"
echo "[polybind] Output files in $OUT:"
ls "$OUT" | sed 's/^/    /'
echo ""

if [ "$CASE" = "1" ]; then
  if [ -z "$PLATFORM" ]; then
    echo "[polybind] To compile, re-run with --platform:"
    echo "    bash bind.sh $SRC $OUT --platform node    # build .node (Node.js)"
    echo "    bash bind.sh $SRC $OUT --platform arkts   # build .so  (HarmonyOS)"
    echo "    bash bind.sh $SRC $OUT --platform both    # build both"
    echo ""
  fi
  echo "[polybind] Use in polymath app.yaml:"
  echo "    - id: my-tool"
  echo "      kind: toolbox"
  echo "      type: <extension-name>"
  echo "      extension: $OUT"
  echo ""
  echo "[polybind] No code changes needed — polymath CLI loads the extension automatically."
fi

if [ "$CASE" = "2" ] || [ "$CASE" = "3" ]; then
  echo "[polybind] Next steps:"
  echo "    1. Review the fixed .ets files in $OUT"
  echo "    2. Build the HAP/module with DevEco Studio"
  echo "    3. Register with polymath:"
  echo "       import { manifest } from '$OUT/manifest.ts'"
  echo "       import { JSVMEvalExtension } from '$OUT/JSVMEval.ets'"
  echo "       registry.registerExtension(manifest, new JSVMEvalExtension(hub))"
fi
