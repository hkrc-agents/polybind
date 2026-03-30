# polybind — Design Details

## Core Insight

HarmonyOS NAPI (`libace_napi.z.so`) and Node.js NAPI both implement the same
`napi_*` C function API. One C++ source file (`src/napi_bridge.cpp`) compiles
for both platforms — only the CMake configuration differs.

---

## Three Cases

### Case 1: C++ Only

The tool author writes:
- `tools.yaml` — extension descriptor with tool names, descriptions, and JSON Schema
- Tool logic in C++ (e.g., `grep_files.cpp`) — the actual tool implementations

polybind generates everything else:
1. `polybind_entry.cpp` — implements `include/polybind/tool.h` (`PolyExtension` C struct,
   `poly_init`, `poly_call_tool`, `kTools[]`, `polymath_get_extension()`) from `tools.yaml`
2. `CMakeLists.txt` — compiles the C++ + universal NAPI bridge into `.node` and/or `.so`
3. `PolybindExtension.ts` (Node.js IExtension) and `PolybindExtension.ets` (ArkTS wrapper)
4. `manifest.yaml` / `manifest.ts` — polymath extension manifest

The tool author never touches `tool.h` directly.

### Case 2: C++ + ArkTS Mixed

The tool has C++ NAPI bindings that already produce a `.so`, plus an ArkTS wrapper
that calls into that `.so`. polybind:
1. Checks the ArkTS `IExtension`/`IToolkit` implementation against `@polymath/types`
2. Applies automated fixes (interface imports, overload signatures)
3. Generates `manifest.yaml` inferred from the .ets analysis

### Case 3: ArkTS Only

Existing ArkTS code. Same as Case 2 but no C++ involved.

---

## Interface Chain

### Case 1

```
[tool author writes]
tools.yaml  ──codegen──►  polybind_entry.cpp  (PolyExtension C struct, generated)
my_tool.cpp             ──►  tool logic (written by author)
                               │
                               ▼
                     polymath_get_extension()  →  PolyExtension
                     napi_bridge.cpp           →  NAPI listTools()/callTool()  →  JS strings
                     PolybindExtension.ts/.ets →  IExtension/IToolkit  →  polymath hub
```

### Case 2 (e.g., JSVMEval)

```
JSVMNativeBridge.cpp  →  libentry.so  →  ArkTS import 'libentry.so'
JSVMEval.ets  →  IExtension/IToolkit (fixed)  →  polymath hub
```

---

## C Interface (`include/polybind/tool.h`)

```c
typedef struct {
  const char* name;
  const char* description;
  const char* input_schema_json;  // JSON Schema as string
} PolyTool;

typedef struct {
  const char* content_json;  // NULL on error
  const char* error;         // NULL on success
} PolyResult;

typedef struct {
  const char* name;
  const char* version;
  int         tool_count;
  const PolyTool* tools;
  PolyResult  (*call_tool)(const char* name, const char* args_json);
  void        (*init)(void);      // optional, may be NULL
  void        (*destroy)(void);   // optional, may be NULL
  void        (*free_result)(PolyResult); // optional, NULL = static strings
} PolyExtension;

PolyExtension* polymath_get_extension(void);
```

---

## NAPI Bridge Design (`src/napi_bridge.cpp`)

The same source compiles for both targets. Platform is selected via CMake define:

```cpp
#if defined(NAPI_PLATFORM_ARKTS)
#  include <napi/native_api.h>   // HarmonyOS SDK
#else
#  include <node_api.h>           // Node.js NAPI headers
#endif
```

**`listTools()`** — returns a JSON array string:
```json
[{"name":"tool_name","description":"...","inputSchema":{...}}]
```

**`callTool(name, argsJson)`** — returns a JSON object string:
```json
{"content": <result>, "error": null}
// or
{"content": null, "error": "message"}
```

**Module registration**: `NAPI_MODULE(POLYBIND_MODULE_NAME, ModuleInit)` where
`POLYBIND_MODULE_NAME` is injected by CMake via `-DPOLYBIND_MODULE_NAME=<name>`.
This name must match the ArkTS static import: `import <name> from 'lib<name>.so'`.

---

## ArkTS Static Import Constraint

ArkTS requires the `.so` module path to be a **static string literal**:

```typescript
import mylib from 'libmylib.so'   // ✓ static — works
import(soPath)                     // ✗ dynamic — not supported by ArkTS compiler
```

This means one generated `.ets` wrapper per extension (not a generic loader).
Codegen stamps `so_name` from `tools.yaml` into the import line at generation time.

---

## CMake Build Fragments

### `cmake/polybind-node.cmake` (Node.js)

- Uses `node-api-headers` for NAPI include path
- Output: `${PROJECT_NAME}_node.node`
- Sets `PREFIX ""` and `SUFFIX ".node"` on the shared library

### `cmake/polybind-arkts.cmake` (HarmonyOS)

- Uses `${OHOS_SDK_NATIVE}/sysroot/usr/include` for NAPI headers
- Links `libace_napi.z.so`
- Defines `NAPI_PLATFORM_ARKTS=1` for the platform switch in `napi_bridge.cpp`
- Output: `lib${PROJECT_NAME}.so`

---

## Runtime Wrappers

### Node.js (`runtime/node/src/PolybindExtension.ts`)

- Loads the `.node` binary via `createRequire(import.meta.url)(nodePath)`
- `PolybindToolkit.listTools()` — calls `napi.listTools()`, JSON-parses result
- `PolybindToolkit.callTool()` — both overloads (sync + async generator for streaming)
- `PolybindExtension` implements `IExtension` from `@polymath/types`

### ArkTS Template (`runtime/arkts/src/PolybindExtension.ets.tmpl`)

Stamped per extension with `{{SO_NAME}}`, `{{EXTENSION_NAME}}`, `{{EXTENSION_VERSION}}`.
Contains the same `IExtension`/`IToolkit` pattern as the Node.js wrapper.

---

## codegen Pipeline

### `codegen/dist/index.js`

Zero-dependency ESM JavaScript (no npm install needed). Commands:

| Command | Purpose |
|---------|---------|
| `check <file.ets> [--fix] [--out]` | Detect and fix ArkTS interface issues |
| `generate <tools.yaml> --out <dir>` | Generate all artifacts from descriptor |
| `generate-from-ets --ets <dir> --out <manifest.yaml>` | Infer manifest from .ets |
| `cmake <tools.yaml> --polybind-root <dir> --out <CMakeLists.txt>` | Generate CMake config |
| `wrappers <tools.yaml> --out <dir>` | Generate only wrapper files |

### Check Categories

| Code | Description |
|------|-------------|
| `MISSING_POLYMATH_IMPORT` | No `import from '@polymath/types'` |
| `LOCAL_INTERFACE_*` | Local copy of an interface that should be imported |
| `CALLTOOL_TYPED_ARGS` | `callTool(name, args: SpecificClass)` instead of `Record<string, unknown>` |
| `MISSING_STREAMING_OVERLOAD` | No `callTool(..., progress: true): AsyncIterable<...>` overload |
| `WRONG_INPUT_SCHEMA_FIELD` | `ToolDefinition.parameters` instead of `inputSchema` |
| `MISSING_IEXTENSION_IMPL` | No class implementing `IExtension` |
| `MISSING_ITOOLKIT_IMPL` | No class implementing `IToolkit` |

### Fix Strategy

Fixes are applied as targeted text patches preserving all business logic:

1. **Import fix**: Replace/add `import type { ... } from '@polymath/types'`
2. **Remove local interfaces**: Delete `export interface IExtension/IToolkit/...` blocks
3. **`parameters` → `inputSchema`**: Rename field, inject `__polybindBuildInputSchema()` helper
4. **Typed args**: Replace `callTool(name, args: SomeClass)` with `Record<string, unknown>`,
   insert `const typedArgs = args as unknown as SomeClass` at top of implementation body
5. **Streaming overload**: Rename implementation to `private async _callImpl()`,
   insert two overload declarations + dispatch implementation above it

---

## JSVMEval Compliance Fixes (Case 2 Reference)

JSVMEval's local types differ from `@polymath/types`:

| Aspect | JSVMEval (before) | `@polymath/types` | Fix |
|--------|------------------|-------------------|-----|
| Type imports | Local `interface IExtension`, `IToolkit`, etc. | Import from package | Remove local, add import |
| `callTool` args | `args: RunJsArgs` (typed class) | `args: Record<string, unknown>` | Relax + internal cast |
| `callTool` streaming | Missing | Required | Add overload + `_callImpl` rename |
| `ToolDefinition.parameters` | `parameters: ToolParameters` | `inputSchema: Record<string, unknown>` | Rename + helper fn |

---

## manifest.yaml Generation

### From `tools.yaml` (Case 1)

Direct mapping: `extension.name` → manifest `name`, tools array → type schema.

### Inferred from `.ets` (Cases 2 & 3)

Heuristics applied to each `.ets` file:
- Looks for `class \w+Extension implements IExtension` to determine extension name
- Converts `PascalCaseExtension` to `kebab-case` (e.g., `JSVMEvalExtension` → `jsvm-eval`)
- Detects `.so` imports to determine `platforms` array
- Scans `listTools()` return bodies for `name: '...'` patterns to list tools

---

## Thread Safety

`PolyResult` uses static char buffers (acceptable for polymath's sequential
per-session tool dispatch). For parallel mode, use `thread_local` or heap-allocated
strings and implement `free_result`.

---

## Repository Layout

```
polybind/
├── README.md                       # Usage guide (3 cases + quickstart)
├── structure.md                    # This file — design details
├── bind.sh                         # Entry point: bash bind.sh <src> <out>
│
├── include/polybind/tool.h         # C interface (Case 1)
├── src/napi_bridge.cpp             # Universal NAPI bridge (both platforms)
│
├── cmake/
│   ├── polybind-node.cmake         # .node build (Node.js)
│   └── polybind-arkts.cmake        # .so build (HarmonyOS)
│
├── runtime/
│   ├── node/src/PolybindExtension.ts    # IExtension/IToolkit for Node.js
│   └── arkts/src/PolybindExtension.ets.tmpl  # Template, stamped per extension
│
├── codegen/
│   ├── dist/index.js               # Zero-dependency CLI (Node.js ≥ 12)
│   └── src/                        # TypeScript source (reference)
│       ├── index.ts
│       ├── check.ts
│       ├── fix-arkts.ts
│       └── generate.ts
│
└── examples/
    └── jsvm-eval/
        ├── manifest.yaml           # Generated manifest
        └── JSVMEval.ets            # Fixed ArkTS file (reference output)
```

---

## `bind.sh` Execution Flow
```text 
bind.sh --platform node|arkts|both
    │
    ├── Step 2: 生成 manifest.yaml
    ├── Step 3: 生成 polybind_entry.cpp + CMakeLists.txt   ← 准备编译材料
    ├── Step 4: 生成 PolybindExtension.ts/.ets
    │
    └── Step 5: 编译（仅当 --platform 有值时执行）
            │
            ├── cmake -B build/node  -DPOLYBIND_PLATFORM=node  .  → configure
            ├── cmake --build build/node                           → 编译
            │       └── g++/clang++ 编译所有 .cpp + napi_bridge.cpp
            │           链接 → agentic_rag_node.node
            │
            ├── cmake -B build/arkts -DPOLYBIND_PLATFORM=arkts .  → configure
            └── cmake --build build/arkts                          → 编译
                    └── clang.exe -target aarch64-linux-ohos 编译所有 .cpp + napi_bridge.cpp
                        链接 libace_napi.z.so → libagentic_rag.so
```
```
bind.sh <src> <out>
    │
    ├── detect Node.js ≥ 14 (prefers nvm)
    ├── find .ets files (exclude Index.ets)
    ├── find .cpp files
    │
    ├─[has .ets]── Step 1: for each .ets file:
    │               └── node check <file> --fix --out <out/file>
    │                   (report issues, apply fixes, re-check)
    │
    ├── Step 2: generate manifest.yaml
    │   ├─[tools.yaml]── node generate tools.yaml --out <out>
    │   └─[no tools.yaml]── node generate-from-ets --ets <out> --out <out/manifest.yaml>
    │
    └─[Case 1]── Step 3: node cmake tools.yaml --out <out/CMakeLists.txt>
                 Step 4: node wrappers tools.yaml --out <out>
```
