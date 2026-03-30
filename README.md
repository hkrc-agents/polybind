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

## Environment Setup

根据你的目标平台，按以下步骤配置环境。只需配置你实际要用的平台。

---

### Step 1 — 安装 Node.js（所有平台必须）

polybind 的代码生成工具（codegen）运行在 Node.js 上，所有平台都需要。

```bash
# 推荐：通过 nvm 安装（自动管理版本）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc        # 或重新打开终端

nvm install 18          # 安装 Node.js 18 LTS
nvm use 18

# 验证
node --version          # 应输出 v18.x.x
```

> **最低要求：** Node.js ≥ 14。Node.js 18 LTS 为推荐版本。

---

### Step 2 — 配置 `--platform node` 编译环境

> 跳过此步骤如果只编译 HarmonyOS（`--platform arkts`）。

需要安装：CMake ≥ 3.14 和 C++17 编译器。

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y cmake build-essential   # GCC 9+ 和 CMake

# 验证
cmake --version     # 应输出 cmake version 3.x.x
g++ --version       # 应输出 g++ (GCC) 9.x 或更高
```

Node.js NAPI 头文件由 polybind 自动检测（优先 `node-api-headers` 包，
fallback 到 nvm 目录），无需手动安装。

---

### Step 3 — 配置 `--platform arkts` 编译环境（HarmonyOS）

> 跳过此步骤如果只编译 Node.js（`--platform node`）。

#### 3.1 安装 DevEco Studio（Windows）

从华为官网下载并安装 **DevEco Studio 5.0.5 或更高版本**：
https://developer.huawei.com/consumer/cn/deveco-studio/

安装后，DevEco Studio 会自动下载 OpenHarmony SDK。SDK 的 native 目录通常位于：

```
C:\Users\<你的用户名>\AppData\Local\Huawei\Sdk\openharmony\<版本号>\native\
```

或者，如果你在安装时选择了自定义路径（例如 `D:\harmonyos`）：

```
D:\harmonyos\DevEco Studio\sdk\default\openharmony\native\
```

> **SDK 版本要求：** OpenHarmony API 12+（DevEco Studio 5.0.5+ 默认包含）。
> SDK 中包含 Clang 15.0.4 和 cmake 3.22，无需单独安装。

#### 3.2 开启 WSL2（Windows）

polybind 在 WSL2（Linux 子系统）中运行 `bash bind.sh`。

```powershell
# 在 Windows PowerShell（管理员）中执行：
wsl --install           # 安装 WSL2 + Ubuntu（Windows 10 2004+ / Windows 11）
# 重启电脑后生效
```

已有 WSL1 的用户升级到 WSL2：
```powershell
wsl --set-default-version 2
wsl --set-version Ubuntu 2
```

#### 3.3 在 WSL2 中验证 SDK 可访问

打开 WSL2 终端，确认 Windows 盘已挂载且 SDK 可见：

```bash
# 确认 Windows 盘挂载正常（以 D 盘为例）
ls /mnt/d/

# 验证 DevEco Studio SDK 路径（根据你的实际安装路径修改）
SDK="/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native"
# 或 AppData 路径：
# SDK="/mnt/c/Users/<用户名>/AppData/Local/Huawei/Sdk/openharmony/<版本>/native"

ls "$SDK/build-tools/cmake/bin/cmake.exe"   # 应存在
ls "$SDK/llvm/bin/clang++.exe"              # 应存在
ls "$SDK/sysroot/usr/include/napi/native_api.h"  # 应存在
```

#### 3.4 验证 `.exe` 文件可在 WSL2 中执行

WSL2 通过 `binfmt_misc` 机制直接运行 Windows `.exe` 文件：

```bash
# 检查 binfmt_misc 是否已启用
ls /proc/sys/fs/binfmt_misc/WSLInterop    # 存在即为已启用

# 如果不存在，手动启用：
echo ':WSLInterop:M::MZ::/init:PF' | sudo tee /proc/sys/fs/binfmt_misc/register
```

> 通常不需要手动操作，WSL2 默认已启用。

#### 3.5 完整验证

```bash
SDK="/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native"

"$SDK/build-tools/cmake/bin/cmake.exe" --version
# 期望输出：cmake version 3.22.x

"$SDK/llvm/bin/clang++.exe" --version
# 期望输出：clang version 15.0.4  Target: aarch64-unknown-linux-ohos
```

两条命令都有输出，说明环境配置正确。

---

### Step 4 — 运行第一次构建

环境准备完成后，在 WSL2 终端中运行：

```bash
# 克隆 polybind
git clone <polybind-repo> ~/polybind

# 第一次运行时 bind.sh 会自动构建 codegen（约 10 秒）
bash ~/polybind/bind.sh ./my-tool/ ./out/ --platform both
```

`--platform both` 会同时编译 Node.js（`.node`）和 HarmonyOS（`.so`）两个产物。
如果只需要其中一个，使用 `--platform node` 或 `--platform arkts`。

---

### 依赖版本速查

| 组件 | 版本 | 说明 |
|------|------|------|
| Node.js | ≥ 14（推荐 18 LTS） | 运行 codegen |
| CMake | ≥ 3.14 | `--platform node` 编译（系统安装） |
| GCC | ≥ 9（C++17） | `--platform node` 编译 |
| DevEco Studio | 5.0.5+ | `--platform arkts`，自带 cmake 3.22 + Clang 15 |
| WSL2 | 任意版本 | `--platform arkts` 在 Windows 上构建 |
| js-yaml | ^4.1.0 | codegen 运行时依赖，自动安装 |
| nlohmann/json | — | 已内置于 `include/vendor/`，无需安装 |

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
