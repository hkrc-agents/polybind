# polybind

Bridge any C++, ArkTS, or mixed tool into a polymath `IExtension`/`IToolkit`.

## Quick Start

```bash
bash bind.sh <source-dir> <output-dir> [--platform node|arkts|both]
```

Place your source files in `<source-dir>`. polybind detects the case automatically
and writes all output to `<output-dir>`.

---

## Case 1: C++ Only

Write your tool in C++ using the ToolRegistry pattern, or any other approach that
dispatches tool calls by name. Add a `tools.yaml` descriptor. polybind will:

1. Generate `polybind_entry.cpp` — the C interface bridge (from `tools.yaml`)
2. Generate `CMakeLists.txt` — ready to compile for Node.js or HarmonyOS
3. Generate `PolybindExtension.ts` / `PolybindExtension.ets` — polymath wrappers
4. Optionally compile via `--platform node|arkts|both`

**Source layout:**
```
my-tool/
├── tools.yaml              # descriptor (name, version, tools list, cpp_entry)
├── my_tool.cpp             # your tool implementation
└── ... (other .cpp/.h)
```

**`tools.yaml` with `cpp_entry`:**
```yaml
cpp_entry:
  includes:
    - my_tool.hpp           # headers needed by the generated bridge
  namespace: my::ns         # using namespace declaration (optional)
  server_id: polybind       # server_id used when registering tools
  init: 'register_tools("polybind")'  # initialization call

extension:
  name: my-tool
  version: "1.0.0"
  description: "Does something useful"
  so_name: my_tool          # matches 'import my_tool from libmy_tool.so'
  platforms: [node, arkts]

tools:
  - name: do_thing
    description: "Does the thing"
    input_schema:
      type: object
      properties:
        input: { type: string, description: "The input" }
      required: [input]
```

**Run:**
```bash
# Generate all files (no compile)
bash bind.sh ./my-tool/ ./out/

# Generate + compile for Node.js
bash bind.sh ./my-tool/ ./out/ --platform node

# Generate + compile for HarmonyOS
bash bind.sh ./my-tool/ ./out/ --platform arkts

# Generate + compile for both
bash bind.sh ./my-tool/ ./out/ --platform both
```

**What bind.sh does (Case 1):**
1. Generates `polybind_entry.cpp` into the source directory
2. Generates `CMakeLists.txt` into the output directory
3. Generates `PolybindExtension.ts` and `PolybindExtension.ets` wrappers
4. If `--platform` is given: runs cmake configure + build

**Register with polymath (Node.js app.yaml):**
```yaml
entries:
  - id: rag
    kind: toolbox
    type: my-tool
    extension: /path/to/out   # polybind loads PolybindExtension.js from here
```

No code changes needed — polymath CLI reads the `extension:` field automatically.

**Output files:**
- `polybind_entry.cpp` — generated C interface bridge (written into source dir)
- `manifest.yaml` — polymath extension manifest
- `manifest.ts` — TypeScript manifest import
- `PolybindExtension.ts` — Node.js IExtension wrapper
- `PolybindExtension.ets` — ArkTS IExtension wrapper
- `CMakeLists.txt` — CMake build configuration
- `build/node/` — compiled `.node` artifact (if `--platform node`)
- `build/arkts/` — compiled `.so` artifact (if `--platform arkts`)

---

## Case 2: C++ + ArkTS Mixed

You have C++ NAPI bindings (`.so`) and an ArkTS wrapper (`IExtension`/`IToolkit`).
polybind checks the ArkTS code for compliance with `@polymath/types` and applies
fixes automatically.

**Source layout:**
```
my-tool/
├── JSVMEval.ets             # ArkTS IToolkit/IExtension implementation
└── JSVMNativeBridge.cpp     # C++ NAPI bridge → builds to libentry.so
```

**Run:**
```bash
bash bind.sh ./my-tool/ ./out/
# Review fixed .ets files in ./out/
# Build HAP with DevEco Studio as usual
```

**Register with polymath (ArkTS app):**
```typescript
import { manifest } from './out/manifest.ts'
import { JSVMEval } from './out/JSVMEval.ets'
registry.registerExtension(manifest, new JSVMEval())
```

**Output files:**
- `manifest.yaml` — inferred from .ets analysis
- `JSVMEval.ets` — fixed ArkTS file (interface-compliant)

---

## Case 3: ArkTS Only

Existing ArkTS tool. polybind checks and fixes the `IExtension`/`IToolkit`
interface to match `@polymath/types` exactly. No C++ involved.

**Run:**
```bash
bash bind.sh ./my-arkts-tool/ ./out/
```

Same output as Case 2 (no CMakeLists.txt).

---

## What polybind fixes automatically

For Cases 2 and 3, polybind detects and fixes these interface mismatches:

| Issue | Fix applied |
|-------|-------------|
| Local `IExtension`/`IToolkit` definitions | Removed; replaced with `@polymath/types` import |
| `callTool(name, args: MyClass)` | Changed to `Record<string, unknown>` with internal cast |
| Missing streaming `callTool` overload | Added `(name, args, progress: true): AsyncIterable<...>` |
| `ToolDefinition.parameters` | Renamed to `inputSchema: Record<string, unknown>` |

Issues that require manual review are reported but not auto-fixed.

---

## `tools.yaml` Format

```yaml
# Optional — only needed for Case 1 (C++ tools)
cpp_entry:
  includes:            # headers to #include in the generated bridge
    - my_tool.hpp
  namespace: my::ns    # optional: using namespace declaration
  server_id: polybind  # server_id passed to ToolRegistry (default: "polybind")
  init: 'register_tools("polybind")'  # initialization call in poly_init()

extension:
  name: my-tool
  version: "1.0.0"
  description: "Optional description"
  so_name: my_tool          # NAPI module name; ArkTS: import my_tool from 'libmy_tool.so'
  platforms: [node, arkts]  # optional, default: both

tools:
  - name: tool_name
    description: >
      Multi-line description using YAML block scalar.
    input_schema:
      type: object
      properties:
        param1:
          type: string
          description: "Description of param1"
        param2:
          type: integer
          description: "Description of param2"
          default: 42
      required: [param1]
```

---

## Requirements & Environment Setup

### Required Tools

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 14 | ESM support required. polybind auto-detects `nvm` installs. |
| CMake | ≥ 3.14 | Only needed for Case 1 (C++ builds) |
| C++ compiler | C++17 | GCC 9+, Clang 10+, or MSVC 2019+ |
| nlohmann/json | any | Vendored in `include/vendor/nlohmann/` — no install needed |

### Node.js Build (`--platform node`)

```bash
# Install node-api-headers (required for building .node modules)
npm install -g node-api-headers

# Or as a local dev dep in your project
npm install --save-dev node-api-headers
```

polybind's cmake file (`polybind-node.cmake`) auto-detects the header path via:
```cmake
execute_process(COMMAND node -p "require('node-api-headers').include_dir" ...)
```

### HarmonyOS Build (`--platform arkts`)

Requires the HarmonyOS SDK native directory. Set via environment variable or let polybind auto-detect:

```bash
# Option 1: Set environment variable (recommended)
export OHOS_SDK_NATIVE=/path/to/DevEco/sdk/default/openharmony/native

# Option 2: Pass to cmake directly
cmake -B build -DPOLYBIND_PLATFORM=arkts -DOHOS_SDK_NATIVE=/path/to/native .
```

polybind auto-detects the SDK in these locations (checked in order):
1. `$OHOS_SDK_NATIVE` environment variable
2. `/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native` (WSL2 default)
3. `/mnt/c/Users/$USER/AppData/Local/Huawei/Sdk/openharmony/native` (Windows SDK)
4. `$HOME/harmonyos/native` (Linux install)

**WSL2 users (Windows DevEco Studio SDK):**

If your DevEco Studio is installed on Windows and you're building from WSL2, polybind handles
this automatically. The Windows OHOS SDK ships `clang.exe`/`clang++.exe` PE binaries;
WSL2's `binfmt_misc` allows running them directly from Linux.

polybind detects `clang.exe` and configures CMake accordingly:
- Converts `/mnt/d/harmonyos/...` sysroot path to `D:/harmonyos/...` for the Windows binary
- Passes the sysroot via `CMAKE_SYSROOT` (CMake handles quoting, important for paths with spaces)
- Sets `-target aarch64-linux-ohos` and `-D__MUSL__` automatically

No manual configuration needed — just ensure DevEco Studio is installed on Windows and the SDK
native directory is accessible from WSL2 under `/mnt/`.

**Verify your setup:**
```bash
# Check the cross-compiler is accessible
ls "/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native/llvm/bin/clang++.exe"

# Check sysroot headers exist
ls "/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native/sysroot/usr/include/napi/native_api.h"

# Run a test build
bash bind.sh ./examples/hello/ ./out/ --platform arkts
```

### Setting Up the codegen CLI

On first run, `bind.sh` automatically builds the codegen tool. Or build manually:

```bash
cd codegen
npm install
npm run build   # outputs to dist/index.js
```

---

## Examples

### Example 1: agentic-rag (Case 1 — C++ Only)

`agentic-rag` is a filesystem search extension with three tools: `grep_files`,
`read_file`, and `read_file_char`. It is implemented in C++ using a `ToolRegistry`
dispatcher and wrapped for polymath using polybind.

**Source: `agentic_rag/tools/tools.yaml`** (The only additional file required)
```yaml
cpp_entry:
  includes:
    - filter_filesystem_tools.hpp
    - tool_registry.hpp
  namespace: aip::mcp
  server_id: polybind
  init: 'register_filesystem_tools("polybind")'

extension:
  name: agentic-rag
  version: "1.0.0"
  description: "Agentic RAG filesystem tools: keyword search and file reading with character-level context"
  so_name: agentic_rag
  platforms: [node, arkts]

tools:
  - name: grep_files
    description: >
      Search for keywords in files with ranked preview output.
      Supports AND/OR keyword groups, character-level context windows,
      and token-limited output. Returns ranked file previews with OFFSET
      values usable by read_file_char.
    input_schema:
      type: object
      properties:
        keywords:
          type: array
          description: >
            Keyword groups for AND/OR search.
            Format: [["k1", "k2"], ["k3"]] means (k1 OR k2) AND k3.
          items:
            type: array
            items: { type: string }
        context_chars: { type: integer, default: 100 }
        max_tokens:    { type: integer, default: 800 }
        max_results:   { type: integer, default: 20 }

  - name: read_file
    description: Read file content by line range.
    input_schema:
      type: object
      properties:
        path:       { type: string }
        start_line: { type: integer, default: 1 }
        end_line:   { type: integer, default: -1 }
      required: [path]

  - name: read_file_char
    description: >
      Read file content around a specific character offset.
      Use OFFSET values from grep_files output to jump to relevant sections.
    input_schema:
      type: object
      properties:
        path:          { type: string }
        start_char:    { type: integer, default: 0 }
        context_chars: { type: integer, default: 300 }
        original_query: { type: string }
      required: [path]
```

**Run bind.sh:**
```bash
# Generate all files + compile for arkts and Node.js
bash bind.sh ./agentic_rag/tools/ ./agentic_rag/out/ --platform both
```

**What bind.sh generates:**
```
agentic_rag/tools/polybind_entry.cpp   ← generated C bridge (in source dir)
agentic_rag/out/
├── manifest.yaml
├── manifest.ts
├── PolybindExtension.ts               ← Node.js IExtension wrapper
├── PolybindExtension.ets              ← ArkTS IExtension wrapper
├── CMakeLists.txt
└── build/node/agentic_rag_node.node   ← compiled artifact (with --platform node)
```

**Use in a polymath app.yaml:**
```yaml
entries:
  - id: main
    kind: agent
    type: agents-react
    model: openai/gpt-4o

  - id: rag
    kind: toolbox
    type: agentic-rag
    extension: /path/to/agentic_rag/out
```

No additional bootstrap code required — polymath CLI loads the extension automatically.

---

### Example 2: JSVMEval (Case 2 — C++ + ArkTS Mixed)

See `examples/jsvm-eval/` for the full output of running polybind on the
JSVMEval C++/ArkTS mixed tool.
