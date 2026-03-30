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

# Find .ets files, excluding Index.ets (UI-only) and the output directory.
ETS_FILES=$(find "$SRC" -name "*.ets" ! -name "Index.ets" ! -path "$OUT/*" 2>/dev/null | sort)
# Find .cpp files (any depth), excluding the output directory.
CPP_FILES=$(find "$SRC" -name "*.cpp" ! -path "$OUT/*" 2>/dev/null | sort)

HAS_ETS=false
HAS_CPP=false
[ -n "$ETS_FILES" ] && HAS_ETS=true
[ -n "$CPP_FILES" ] && HAS_CPP=true

echo "[polybind] ArkTS (.ets): $HAS_ETS  |  C++ (.cpp): $HAS_CPP"

# Detect where the C++ source files actually live (may be a subdirectory like scripts/).
# This is used for polybind_entry.cpp placement and for src/ exclusion during packaging.
CPP_SRC_DIR="$SRC"
_FIRST_CPP_GLOBAL="$(find "$SRC" -name "*.cpp" ! -name "polybind_entry.cpp" ! -path "$OUT/*" 2>/dev/null | head -1)"
if [ -n "$_FIRST_CPP_GLOBAL" ]; then
  CPP_SRC_DIR="$(dirname "$_FIRST_CPP_GLOBAL")"
fi

# Detect the project root: walk up from SRC to find the directory containing SKILL.md.
# Falls back to SRC itself when no SKILL.md is found.
PROJ_ROOT="$SRC"
_dir="$SRC"
for _level in 1 2 3; do
  if [ -f "$_dir/SKILL.md" ]; then
    PROJ_ROOT="$_dir"
    break
  fi
  _dir="$(dirname "$_dir")"
  [ "$_dir" = "/" ] && break
done

# Pre-clean: if OUT/src exists from a previous run, remove it now (before any
# build steps) so that stale .cpp copies don't contaminate cmake source lists.
if [ -f "$PROJ_ROOT/SKILL.md" ] || [ -d "$PROJ_ROOT/references" ] || [ -d "$PROJ_ROOT/assets" ] || [ "$PROJ_ROOT" != "$SRC" ]; then
  [ -d "$OUT/src" ]     && rm -rf "$OUT/src"
  [ -d "$OUT/scripts" ] && rm -rf "$OUT/scripts"
fi

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

# ── Step 2b: node_entry — copy JS/TS source to output dir ─────────────────────
# When tools.yaml declares node_entry, the PolybindExtension.js imports from
# the compiled module. Copy the source file (and any TS/JS siblings) to OUT so
# that the extension directory is self-contained.

if [ -f "$SRC/tools.yaml" ]; then
  # Extract node_entry.module value using simple text parsing (no js-yaml needed here)
  NODE_ENTRY_MODULE=$(awk '/node_entry:/,/^[^ ]/' "$SRC/tools.yaml" | grep 'module:' | head -1 | sed 's/.*module: *//' | tr -d '"'"'" | tr -d '\r')

  if [ -n "$NODE_ENTRY_MODULE" ]; then
    echo "── Step 2b: Copying node_entry source files ─────────────────────────────────"

    # Copy the entry module itself
    if [ -f "$SRC/$NODE_ENTRY_MODULE" ]; then
      cp "$SRC/$NODE_ENTRY_MODULE" "$OUT/$NODE_ENTRY_MODULE"
      echo "[polybind] ✓ copied: $NODE_ENTRY_MODULE"
    else
      echo "[polybind] Warning: node_entry.module '$NODE_ENTRY_MODULE' not found in $SRC"
    fi

    # If the entry module is TypeScript, also compile it in-place in OUT
    if echo "$NODE_ENTRY_MODULE" | grep -q '\.ts$'; then
      echo "[polybind] Compiling TypeScript: $NODE_ENTRY_MODULE"
      NPX="$(dirname "$NODE")/npx"
      if [ ! -x "$NPX" ]; then NPX="npx"; fi
      (cd "$OUT" && "$NPX" tsc --module NodeNext --moduleResolution NodeNext \
        --target ES2020 --skipLibCheck --noEmit false "$NODE_ENTRY_MODULE") \
        && echo "[polybind] ✓ TypeScript compiled: ${NODE_ENTRY_MODULE%.ts}.js" \
        || echo "[polybind] Warning: TypeScript compilation failed — ensure 'typescript' is installed."
    fi

    echo ""
  fi
fi

# ── Detect OHOS SDK cmake.exe (shared by Case 1 and Case 2 arkts builds) ─────
# When the DevEco Studio SDK is Windows-only (cmake.exe + ninja.exe but no
# native Linux clang), we use cmake.exe with ninja.exe instead of Linux cmake.
# CMD.EXE cannot use UNC paths as CWD, so we build in a Windows-drive temp dir.
OHOS_CMAKE_EXE=""
OHOS_NINJA_EXE=""
OHOS_SDK_NATIVE_WIN=""
for _sdk_cand in \
    "/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native" \
    "/mnt/c/Users/$USER/AppData/Local/Huawei/Sdk/openharmony/native" \
    "$HOME/harmonyos/native"; do
  if [ -f "$_sdk_cand/build-tools/cmake/bin/cmake.exe" ]; then
    OHOS_CMAKE_EXE="$_sdk_cand/build-tools/cmake/bin/cmake.exe"
    OHOS_NINJA_EXE="$_sdk_cand/build-tools/cmake/bin/ninja.exe"
    OHOS_SDK_NATIVE_WIN="$(wslpath -m "$_sdk_cand")"
    echo "[polybind] Detected OHOS cmake.exe: $OHOS_CMAKE_EXE"
    break
  fi
done

# ── Step 3: Case 2 — generate C++ build configuration and compile ─────────────
# Case 2 has its own NAPI sources (no polybind bridge); generate CMakeLists.txt
# with --no-bridge so napi_bridge.cpp is excluded.

if [ "$CASE" = "2" ] && $HAS_CPP && [ -f "$SRC/tools.yaml" ] && [ -n "$PLATFORM" ]; then
  echo "── Step 3: Generating C++ build configuration (Case 2, no polybind bridge) ──"
  "$NODE" "$CODEGEN" cmake "$SRC/tools.yaml" \
    --polybind-root "$SCRIPT_DIR" \
    --no-bridge \
    --out "$OUT/CMakeLists.txt"
  echo "[polybind] ✓ CMakeLists.txt (--no-bridge)"
  echo ""

  if [ -z "$OHOS_CMAKE_EXE" ]; then
    if ! command -v cmake &>/dev/null; then
      echo "[polybind] Error: cmake not found. Install CMake ≥ 3.14 to compile."
      exit 1
    fi
    echo "[polybind] cmake: $(cmake --version | head -1)"
  fi

  build_platform_case2() {
    local plat="$1"
    local build_dir="$OUT/build/$plat"
    rm -rf "$build_dir"
    mkdir -p "$build_dir"

    if [ -n "$OHOS_CMAKE_EXE" ] && [ "$plat" = "arkts" ]; then
      # Windows-only OHOS SDK: use cmake.exe + ninja.exe.
      # CMD.EXE cannot use UNC paths (\\wsl.localhost\...) as CWD, so place the
      # intermediate build dir on a Windows-accessible local drive, then copy the
      # .so artifact to the expected output location afterwards.
      local _win_drive; _win_drive="${OHOS_CMAKE_EXE%%/harmonyos/*}"  # e.g. /mnt/d
      local _win_tmp; _win_tmp="$_win_drive/tmp/polybind_build_$$_$plat"
      rm -rf "$_win_tmp"
      mkdir -p "$_win_tmp"
      local WIN_BUILD; WIN_BUILD="$(wslpath -m "$_win_tmp")"
      local WIN_SRC; WIN_SRC="$(wslpath -w "$OUT")"
      local WIN_NINJA; WIN_NINJA="$(wslpath -m "$OHOS_NINJA_EXE")"
      echo ""
      echo "── Step 4 [$plat]: Configuring (cmake.exe + Ninja) ─────────────────────────"
      "$OHOS_CMAKE_EXE" \
          -G "Ninja" \
          -DCMAKE_MAKE_PROGRAM="$WIN_NINJA" \
          -DPOLYBIND_PLATFORM="$plat" \
          -DCMAKE_BUILD_TYPE=Release \
          "-DOHOS_SDK_NATIVE=$OHOS_SDK_NATIVE_WIN" \
          -DCMAKE_SYSTEM_NAME=Linux \
          -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
          -DCMAKE_C_COMPILER_WORKS=TRUE \
          -DCMAKE_CXX_COMPILER_WORKS=TRUE \
          -B "$WIN_BUILD" \
          -S "$WIN_SRC"
      echo ""
      echo "── Step 4 [$plat]: Building ─────────────────────────────────────────────────"
      "$OHOS_CMAKE_EXE" --build "$WIN_BUILD" --config Release
      # Copy artifact to expected location and clean up temp build dir
      find "$_win_tmp" -name "*.so" 2>/dev/null | while IFS= read -r _so; do
        cp "$_so" "$build_dir/"
        echo "[polybind]   copied: $build_dir/$(basename "$_so")"
      done
      rm -rf "$_win_tmp"
    else
      echo ""
      echo "── Step 4 [$plat]: Configuring ──────────────────────────────────────────────"
      cmake -B "$build_dir" \
            -DPOLYBIND_PLATFORM="$plat" \
            -DCMAKE_BUILD_TYPE=Release \
            "$OUT"
      echo ""
      echo "── Step 4 [$plat]: Building ─────────────────────────────────────────────────"
      cmake --build "$build_dir" --config Release
    fi

    echo ""
    echo "[polybind] ✓ Build complete → $build_dir"
    if [ "$plat" = "node" ]; then
      find "$build_dir" -name "*.node" 2>/dev/null | sed 's/^/[polybind]   artifact: /'
    else
      find "$build_dir" -name "*.so" 2>/dev/null | sed 's/^/[polybind]   artifact: /'
    fi
  }

  case "$PLATFORM" in
    node)  build_platform_case2 node ;;
    arkts) build_platform_case2 arkts ;;
    both)  build_platform_case2 node; build_platform_case2 arkts ;;
    *)
      echo "[polybind] Error: --platform must be node, arkts, or both (got: $PLATFORM)"
      exit 1
      ;;
  esac
  echo ""
fi

# ── Step 3: Case 1 — generate C++ build files and wrappers ───────────────────

if [ "$CASE" = "1" ]; then
  echo "── Step 3: Generating C++ build configuration ───────────────────────────────"

  if [ -f "$SRC/tools.yaml" ]; then
    # CPP_SRC_DIR is already computed globally above.
    # polybind_entry.cpp goes into CPP_SRC_DIR so that bare #include "header.hpp"
    # directives resolve correctly (compiler searches the file's own directory).

    # Generate polybind_entry.cpp into the C++ SOURCE directory.
    "$NODE" "$CODEGEN" entry-cpp "$SRC/tools.yaml" \
      --out "$CPP_SRC_DIR/polybind_entry.cpp"
    echo "[polybind] ✓ polybind_entry.cpp → $CPP_SRC_DIR/polybind_entry.cpp"

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
    if [ -z "$OHOS_CMAKE_EXE" ] && ! command -v cmake &>/dev/null; then
      echo "[polybind] Error: cmake not found. Install CMake ≥ 3.14 to compile."
      exit 1
    fi
    if [ -z "$OHOS_CMAKE_EXE" ]; then
      echo "[polybind] cmake: $(cmake --version | head -1)"
    fi

    build_platform() {
      local plat="$1"
      local build_dir="$OUT/build/$plat"
      rm -rf "$build_dir"
      mkdir -p "$build_dir"

      if [ -n "$OHOS_CMAKE_EXE" ] && [ "$plat" = "arkts" ]; then
        # Windows-only OHOS SDK: use cmake.exe + ninja.exe.
        # Build in a Windows-drive temp dir (CMD.EXE can't use UNC as CWD).
        local _win_drive; _win_drive="${OHOS_CMAKE_EXE%%/harmonyos/*}"
        local _win_tmp; _win_tmp="$_win_drive/tmp/polybind_build_$$_$plat"
        rm -rf "$_win_tmp"
        mkdir -p "$_win_tmp"
        local WIN_BUILD; WIN_BUILD="$(wslpath -m "$_win_tmp")"
        local WIN_SRC; WIN_SRC="$(wslpath -w "$OUT")"
        local WIN_NINJA; WIN_NINJA="$(wslpath -m "$OHOS_NINJA_EXE")"
        echo ""
        echo "── Step 5 [$plat]: Configuring (cmake.exe + Ninja) ─────────────────────────"
        "$OHOS_CMAKE_EXE" \
            -G "Ninja" \
            -DCMAKE_MAKE_PROGRAM="$WIN_NINJA" \
            -DPOLYBIND_PLATFORM="$plat" \
            -DCMAKE_BUILD_TYPE=Release \
            "-DOHOS_SDK_NATIVE=$OHOS_SDK_NATIVE_WIN" \
            -DCMAKE_SYSTEM_NAME=Linux \
            -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
            -DCMAKE_C_COMPILER_WORKS=TRUE \
            -DCMAKE_CXX_COMPILER_WORKS=TRUE \
            -B "$WIN_BUILD" \
            -S "$WIN_SRC"
        echo ""
        echo "── Step 5 [$plat]: Building ─────────────────────────────────────────────────"
        "$OHOS_CMAKE_EXE" --build "$WIN_BUILD" --config Release
        find "$_win_tmp" -name "*.so" 2>/dev/null | while IFS= read -r _so; do
          cp "$_so" "$build_dir/"
          echo "[polybind]   copied: $build_dir/$(basename "$_so")"
        done
        rm -rf "$_win_tmp"
      else
        echo ""
        echo "── Step 5 [$plat]: Configuring ──────────────────────────────────────────────"
        cmake -B "$build_dir" \
              -DPOLYBIND_PLATFORM="$plat" \
              -DCMAKE_BUILD_TYPE=Release \
              "$OUT"
        echo ""
        echo "── Step 5 [$plat]: Building ─────────────────────────────────────────────────"
        cmake --build "$build_dir" --config Release
      fi

      echo ""
      echo "[polybind] ✓ Build complete → $build_dir"
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

# ── Step: Populate skill package (all cases) ──────────────────────────────────
#
# All cases — if a SKILL.md or skill-related dirs exist in PROJ_ROOT, produce:
#   OUT/src/            ← all non-C++ / non-build project content
#   OUT/src/scripts/    ← compiled artifacts (.node / .so) copied from build/
#
# When no skill content is detected, this step is a no-op.

_has_skill=0
[ -f "$PROJ_ROOT/SKILL.md" ]     && _has_skill=1
[ -d "$PROJ_ROOT/references" ]   && _has_skill=1
[ -d "$PROJ_ROOT/assets" ]       && _has_skill=1
[ "$PROJ_ROOT" != "$SRC" ]       && _has_skill=1

if [ "$_has_skill" = "1" ]; then
  echo "── Packaging skill content → src/ ───────────────────────────────────────────"
  mkdir -p "$OUT/src"

  # Copy top-level .md files from PROJ_ROOT (SKILL.md etc.)
  for _md in "$PROJ_ROOT"/*.md; do
    [ -f "$_md" ] || continue
    cp "$_md" "$OUT/src/"
    echo "[polybind] ✓ src/$(basename "$_md")"
  done

  # Copy every subdirectory from PROJ_ROOT except:
  #   • the C++ source directory (already compiled)
  #   • .git / build / node_modules
  #   • the output directory itself (avoid recursion)
  for _subdir in "$PROJ_ROOT"/*/; do
    [ -d "$_subdir" ] || continue
    _name="$(basename "${_subdir%/}")"
    _abs_sub="$(cd "$_subdir" 2>/dev/null && pwd)"
    _abs_cpp="$(cd "$CPP_SRC_DIR" 2>/dev/null && pwd)"
    [ "$_abs_sub" = "$OUT" ] && continue
    [ "$_abs_sub" = "$_abs_cpp" ] && continue
    case "$_name" in
      .git|build|node_modules) continue ;;
    esac
    cp -r "$_subdir" "$OUT/src/$_name"
    echo "[polybind] ✓ src/$_name/"
  done
  echo ""

  # ── Populate OUT/src/scripts/ with compiled artifacts ───────────────────────
  if [ -d "$OUT/build" ]; then
    _artifacts=$(find "$OUT/build" \( -name "*.node" -o -name "*.so" \) 2>/dev/null)
    if [ -n "$_artifacts" ]; then
      echo "── Staging compiled artifacts → src/scripts/ ────────────────────────────────"
      mkdir -p "$OUT/src/scripts"
      echo "$_artifacts" | while IFS= read -r _f; do
        cp "$_f" "$OUT/src/scripts/"
        echo "[polybind] ✓ src/scripts/$(basename "$_f")"
      done
      echo ""
    fi
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
