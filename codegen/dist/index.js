#!/usr/bin/env node
/**
 * polybind codegen — dist/index.js
 * Zero-dependency implementation. No npm install needed.
 * Compatible with Node.js ≥ 18 (ESM).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname, join, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const POLYBIND_ROOT = resolve(__dir, '../..')

// ═══════════════════════════════════════════════════════════════════════════════
// Minimal YAML serializer (write-only; no external deps)
// ═══════════════════════════════════════════════════════════════════════════════

function dumpYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj === 'boolean') return String(obj)
  if (typeof obj === 'number') return String(obj)
  if (typeof obj === 'string') {
    // Quote strings that contain special YAML chars or look ambiguous
    if (/[:#\[\]{},&*?|<>=!%@`'"\\]/.test(obj) || obj.includes('\n') ||
        /^(true|false|null|yes|no|on|off)$/i.test(obj) || /^\d/.test(obj) || obj === '') {
      return JSON.stringify(obj)
    }
    return obj
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return obj.map(item => `${pad}- ${dumpYaml(item, indent + 1).trimStart()}`).join('\n')
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null)
    if (keys.length === 0) return '{}'
    return keys.map(k => {
      const val = obj[k]
      if (typeof val === 'object' && !Array.isArray(val) && val !== null) {
        return `${pad}${k}:\n${dumpYaml(val, indent + 1)}`
      }
      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${k}: []`
        // Inline arrays of strings/numbers on one line
        if (val.every(v => typeof v === 'string' || typeof v === 'number')) {
          return `${pad}${k}: [${val.map(v => dumpYaml(v, 0)).join(', ')}]`
        }
        return `${pad}${k}:\n${dumpYaml(val, indent + 1)}`
      }
      return `${pad}${k}: ${dumpYaml(val, 0)}`
    }).join('\n')
  }
  return String(obj)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Minimal YAML parser for tools.yaml (handles the specific structure we use)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a simple YAML file into a JavaScript object.
 * Supports: scalars, quoted strings, block mappings, block sequences.
 * Handles the polybind tools.yaml format specifically.
 * Falls back to a best-effort parse for JSON Schema embedded in input_schema.
 */
function parseToolsYaml(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split('\n')
  return parseBlock(lines, 0, 0).value
}

function getIndent(line) {
  return line.length - line.trimStart().length
}

function parseScalar(raw) {
  let s = raw.trim()
  // Strip inline comment (must be preceded by whitespace) unless value is quoted
  if (!s.startsWith('"') && !s.startsWith("'")) {
    const commentIdx = s.search(/\s+#/)
    if (commentIdx !== -1) s = s.slice(0, commentIdx).trim()
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s.replace(/'/g, '"')) } catch { return s.slice(1, -1) }
  }
  // Flow sequence: [item1, item2, ...] — parse into JS array
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      // Try JSON parse first (handles ["a","b"])
      return JSON.parse(s)
    } catch {
      // Fall back: split on commas, trim each item
      const inner = s.slice(1, -1).trim()
      if (inner === '') return []
      return inner.split(',').map(item => parseScalar(item.trim()))
    }
  }
  // Multi-line / block scalar — return as-is trimmed
  return s
}

function parseBlock(lines, startIdx, baseIndent) {
  // Collect non-empty lines at this indent level
  let i = startIdx
  let result = null

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimStart()
    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue }

    const indent = getIndent(line)
    if (indent < baseIndent) break  // dedented — back to parent

    // Sequence item
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(result)) result = []
      const rest = trimmed.slice(2).trimStart()
      if (rest === '' || rest.startsWith('#')) {
        // Multi-line sequence item
        const sub = parseBlock(lines, i + 1, indent + 2)
        result.push(sub.value)
        i = sub.nextIdx
      } else if (rest.includes(':')) {
        // Inline map in sequence item: `- key: val`
        const subLines = [line.replace(/^(\s*)- /, '$1  ')]
        let j = i + 1
        while (j < lines.length) {
          const next = lines[j]
          const nextTrimmed = next.trimStart()
          if (nextTrimmed === '' || nextTrimmed.startsWith('#')) { j++; continue }
          if (getIndent(next) <= indent) break
          subLines.push(next)
          j++
        }
        const sub = parseBlock(subLines, 0, indent + 2)
        result.push(sub.value)
        i = j
      } else {
        result.push(parseScalar(rest))
        i++
      }
      continue
    }

    // Mapping entry: `key: value` or `key:`
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx > 0) {
      if (!result || Array.isArray(result)) result = result ? result : {}
      if (Array.isArray(result)) { i++; continue }  // shouldn't happen in valid YAML

      const key = trimmed.slice(0, colonIdx).trim()
      const rest = trimmed.slice(colonIdx + 1).trimStart()

      if (rest === '' || rest.startsWith('#')) {
        // Value is on following lines
        const sub = parseBlock(lines, i + 1, indent + 2)
        result[key] = sub.value
        i = sub.nextIdx
      } else if (rest.startsWith('|') || rest.startsWith('>')) {
        // Block scalar — collect subsequent lines
        let blockLines = []
        let j = i + 1
        const blockIndent = indent + 2
        while (j < lines.length) {
          if (lines[j].trimStart() === '' || getIndent(lines[j]) >= blockIndent) {
            blockLines.push(lines[j].slice(blockIndent))
            j++
          } else break
        }
        result[key] = blockLines.join('\n').trimEnd()
        i = j
      } else {
        result[key] = parseScalar(rest)
        i++
      }
      continue
    }

    i++
  }

  return { value: result, nextIdx: i }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Check — ArkTS interface compliance
// ═══════════════════════════════════════════════════════════════════════════════

function checkFile(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const lines = source.split('\n')
  const issues = []

  function findLine(pattern) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) return i + 1
    }
    return undefined
  }
  function has(pattern) { return lines.some(l => pattern.test(l)) }

  // 1. @polymath/types import
  if (!has(/@polymath\/types/)) {
    issues.push({
      severity: 'error', code: 'MISSING_POLYMATH_IMPORT',
      message: "File does not import from '@polymath/types'.",
      fix: "Add: import type { IExtension, IToolkit, AppEntry, ToolDefinition, ToolResponse, ToolProgress } from '@polymath/types'",
    })
  }

  // 2. Local interface definitions that should come from @polymath/types
  for (const name of ['IExtension', 'IToolkit', 'AppEntry', 'ToolDefinition', 'ToolResponse']) {
    const line = findLine(new RegExp(`^export\\s+interface\\s+${name}\\b`))
    if (line !== undefined) {
      issues.push({
        severity: 'error', code: `LOCAL_INTERFACE_${name.toUpperCase()}`,
        message: `Local 'export interface ${name}' found. Should be imported from '@polymath/types'.`,
        line,
        fix: `Remove local ${name} definition and import from '@polymath/types'.`,
      })
    }
  }

  // 3. IExtension implementation
  if (!has(/implements\s+IExtension\b/)) {
    issues.push({
      severity: 'error', code: 'MISSING_IEXTENSION_IMPL',
      message: "No class implementing IExtension found.",
      fix: "Add: export class MyExtension implements IExtension { initAppSession(); createObject() }",
    })
  } else {
    if (!has(/initAppSession\s*\(/)) {
      issues.push({ severity: 'error', code: 'MISSING_INIT_APP_SESSION',
        message: "IExtension missing initAppSession().",
        fix: "Add: async initAppSession(appSessionId: string): Promise<void> { ... }" })
    }
    if (!has(/createObject\s*\(/)) {
      issues.push({ severity: 'error', code: 'MISSING_CREATE_OBJECT',
        message: "IExtension missing createObject().",
        fix: "Add: async createObject(appSessionId: string, entry: AppEntry): Promise<IToolkit> { ... }" })
    }
  }

  // 4. IToolkit implementation
  if (!has(/implements\s+IToolkit\b/)) {
    issues.push({
      severity: 'error', code: 'MISSING_ITOOLKIT_IMPL',
      message: "No class implementing IToolkit found.",
    })
  } else {
    if (!has(/listTools\s*\(\s*\)/)) {
      issues.push({ severity: 'error', code: 'MISSING_LIST_TOOLS',
        message: "IToolkit missing listTools().",
        fix: "Add: async listTools(): Promise<ToolDefinition[]> { ... }" })
    }
  }

  // 5. callTool signatures
  if (!has(/callTool\s*\(/)) {
    issues.push({ severity: 'error', code: 'MISSING_CALL_TOOL', message: "No callTool() found." })
  } else {
    // Check for typed args (wrong pattern)
    const callToolLines = lines.filter(l => /callTool\s*\(/.test(l))
    const hasTypedArgs = callToolLines.some(l => {
      const m = l.match(/callTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*([\w<>, ]+)/)
      return m && !m[1].trimStart().startsWith('Record')
    })
    if (hasTypedArgs) {
      const typedArgsLine = callToolLines.find(l => {
        const m = l.match(/callTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*([\w<>, ]+)/)
        return m && !m[1].trimStart().startsWith('Record')
      })
      issues.push({
        severity: 'error', code: 'CALLTOOL_TYPED_ARGS',
        message: "callTool() uses a specific typed class for args instead of Record<string, unknown>.",
        line: typedArgsLine ? lines.indexOf(typedArgsLine) + 1 : undefined,
        fix: "Change to: callTool(name: string, args: Record<string, unknown>). Cast internally.",
      })
    }
    // Check for streaming overload
    const hasStreaming = has(/callTool[\s\S]*?progress\s*[:?]\s*true/) ||
                         source.includes(', progress: true)')
    if (!hasStreaming) {
      issues.push({
        severity: 'error', code: 'MISSING_STREAMING_OVERLOAD',
        message: "callTool() missing streaming overload: (name, args, progress: true): AsyncIterable<...>",
        line: findLine(/callTool\s*\(/),
        fix: "Add overload: callTool(name: string, args: Record<string, unknown>, progress: true): AsyncIterable<ToolProgress | ToolResponse>",
      })
    }
  }

  // 6. ToolDefinition.inputSchema vs .parameters
  const hasParametersField = lines.some(l =>
    /^\s+parameters\s*:/.test(l) || /[,{]\s*parameters\s*:/.test(l)
  )
  if (hasParametersField) {
    issues.push({
      severity: 'error', code: 'WRONG_INPUT_SCHEMA_FIELD',
      message: "ToolDefinition uses 'parameters' field but @polymath/types requires 'inputSchema: Record<string, unknown>'.",
      line: findLine(/parameters\s*:/),
      fix: "Rename 'parameters' to 'inputSchema' and change type to Record<string, unknown>.",
    })
  }

  return { filePath, issues, ok: issues.filter(i => i.severity === 'error').length === 0 }
}

function formatCheckResult(result) {
  if (result.ok) return `✓ ${result.filePath}: All interface checks passed`
  const errors = result.issues.filter(i => i.severity === 'error')
  const warnings = result.issues.filter(i => i.severity === 'warning')
  let out = `✗ ${result.filePath}: ${errors.length} error(s), ${warnings.length} warning(s)\n`
  for (const issue of result.issues) {
    const loc = issue.line !== undefined ? `:${issue.line}` : ''
    const icon = issue.severity === 'error' ? '  ✗' : '  ⚠'
    out += `${icon} [${issue.code}]${loc}: ${issue.message}\n`
    if (issue.fix) out += `    → Fix: ${issue.fix}\n`
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fix — automated ArkTS patches
// ═══════════════════════════════════════════════════════════════════════════════

const POLYMATH_IMPORT_LINE =
  "import type { IExtension, IToolkit, AppEntry, ToolDefinition, ToolResponse, ToolProgress } from '@polymath/types'"

const LOCAL_INTERFACE_NAMES = ['IExtension', 'IToolkit', 'AppEntry', 'ToolDefinition', 'ToolResponse', 'ToolProgress']

/** Remove interface block from source string. Returns modified string. */
function removeInterface(source, interfaceName) {
  const lines = source.split('\n')
  // Find the interface declaration line
  const pattern = new RegExp(`^(export\\s+)?interface\\s+${interfaceName}\\b`)
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].trim())) {
      // Walk back to include preceding comment lines
      let commentStart = i
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim()
        if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*') || prev === '') {
          commentStart = j
        } else break
      }
      startIdx = commentStart
      break
    }
  }
  if (startIdx === -1) return source

  // Find closing brace
  let braceDepth = 0
  let endIdx = -1
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') braceDepth++
      else if (ch === '}') { braceDepth--; if (braceDepth === 0) { endIdx = i; break } }
    }
    if (endIdx !== -1) break
  }
  if (endIdx === -1) return source
  return [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)].join('\n')
}

const BUILD_INPUT_SCHEMA_HELPER = `
/**
 * polybind: Convert internal ToolParameters to JSON Schema Record<string, unknown>
 * as required by @polymath/types ToolDefinition.inputSchema.
 * @polybind-generated — do not remove
 */
function __polybindBuildInputSchema(params) {
  const props = {}
  const keys = Object.keys(params.properties)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const p = params.properties[key]
    const prop = { type: p.type, description: p.description }
    if (p.items_type) prop['items'] = { type: p.items_type }
    props[key] = prop
  }
  return { type: 'object', properties: props, required: params.required }
}
`

function fixFile(filePath, outPath, issues) {
  let source = readFileSync(filePath, 'utf8')
  const applied = []
  const hasCodes = (...codes) => issues.some(i => codes.includes(i.code))

  // Fix 1+2: Remove local interfaces + add @polymath/types import
  if (hasCodes('MISSING_POLYMATH_IMPORT',
    'LOCAL_INTERFACE_IEXTENSION', 'LOCAL_INTERFACE_ITOOLKIT',
    'LOCAL_INTERFACE_APPENTRY', 'LOCAL_INTERFACE_TOOLDEFINITION', 'LOCAL_INTERFACE_TOOLRESPONSE')) {
    if (!source.includes('@polymath/types')) {
      for (const name of LOCAL_INTERFACE_NAMES) {
        const before = source.length
        source = removeInterface(source, name)
        if (source.length !== before) applied.push(`Removed local '${name}' definition`)
      }
      // Insert import after last existing import line
      const lines = source.split('\n')
      let lastImportIdx = -1
      for (let i = 0; i < lines.length; i++) {
        if (/^import\s/.test(lines[i].trim())) lastImportIdx = i
      }
      const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0
      lines.splice(insertAt, 0, POLYMATH_IMPORT_LINE)
      source = lines.join('\n')
      applied.push("Added '@polymath/types' import")
    }
  }

  // Fix 3: parameters → inputSchema
  if (hasCodes('WRONG_INPUT_SCHEMA_FIELD')) {
    const parametersRe = /(\bparameters\s*:\s*)(\w+)(\s*[,}\n])/g
    if (parametersRe.test(source)) {
      parametersRe.lastIndex = 0
      source = source.replace(parametersRe, (match, prefix, varName, suffix) =>
        `inputSchema: __polybindBuildInputSchema(${varName})${suffix}`
      )
      // Inject helper before makeJsEvalToolDef (or after imports)
      const helperInsert = source.indexOf('\nfunction makeJsEvalToolDef')
      if (helperInsert !== -1) {
        source = source.slice(0, helperInsert) + BUILD_INPUT_SCHEMA_HELPER + source.slice(helperInsert)
      }
      applied.push("Changed ToolDefinition.parameters → inputSchema (added __polybindBuildInputSchema helper)")
    }
  }

  // Detect original args type for later cast
  const argsTypeMatch = source.match(/callTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*([A-Za-z_][\w<>, ]*)\s*\)/)
  const originalArgsType = argsTypeMatch ? argsTypeMatch[1].trim() : null

  // Fix 4: callTool typed args → Record<string, unknown>
  if (hasCodes('CALLTOOL_TYPED_ARGS') && originalArgsType && originalArgsType !== 'Record<string, unknown>') {
    const typedArgRe = new RegExp(
      `(\\bcallTool\\s*\\(\\s*\\w+\\s*:\\s*string\\s*,\\s*)(\\w+)(\\s*:\\s*)${originalArgsType.replace('<', '\\<').replace('>', '\\>')}(\\s*\\))`,
      'g'
    )
    source = source.replace(typedArgRe, (m, pre, argName, colon, post) =>
      `${pre}${argName}${colon}Record<string, unknown>${post}`
    )
    // Inject cast at top of implementation body
    source = source.replace(
      /(async\s+callTool\s*\([^)]*Record<string,\s*unknown>[^)]*\)\s*(?::\s*Promise<ToolResponse>)?\s*\{)/,
      (m) => `${m}\n    const typedArgs = args as unknown as ${originalArgsType}`
    )
    // Also replace `args.` usages after the cast point — change to typedArgs.
    // This is complex to do safely, so we document the change and let developer review
    applied.push(`Changed callTool args type from '${originalArgsType}' to Record<string, unknown> (internal cast inserted)`)
  }

  // Fix 5: Add streaming overload
  if (hasCodes('MISSING_STREAMING_OVERLOAD')) {
    // Check if still missing after above fixes
    const stillMissing = !source.includes(', progress: true)') &&
                         !source.includes('progress?: true')
    if (stillMissing) {
      // Find the async callTool implementation and rename it to _callImpl, then add overloads
      source = source.replace(
        /(async\s+callTool\s*\(\s*)(name\s*:\s*string\s*,\s*)(\w+\s*:\s*Record<string,\s*unknown>)(\s*\))/,
        (m, asyncKw, nameParam, argsParam, close) => {
          const argsVarMatch = argsParam.match(/(\w+)\s*:/)
          const argsVar = argsVarMatch ? argsVarMatch[1] : 'args'
          return `private async _callImpl(${nameParam}${argsVar}: Record<string, unknown>${close}`
        }
      )
      const overloads = `
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse>
  callTool(name: string, args: Record<string, unknown>, progress: true): AsyncIterable<ToolProgress | ToolResponse>
  callTool(
    name: string,
    args: Record<string, unknown>,
    progress?: true,
  ): Promise<ToolResponse> | AsyncIterable<ToolProgress | ToolResponse> {
    if (progress) {
      const self = this
      return (async function*() { yield await self._callImpl(name, args) })()
    }
    return this._callImpl(name, args)
  }

`
      source = source.replace(/([ \t]*)(private\s+async\s+_callImpl\s*\()/, (m, indent, rest) =>
        `${overloads}${indent}${rest}`
      )
      applied.push("Added streaming callTool overload (renamed implementation to _callImpl)")
    }
  }

  writeFileSync(outPath, source, 'utf8')
  return { filePath, outPath, appliedFixes: applied, source }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Generate — manifest.yaml + wrappers
// ═══════════════════════════════════════════════════════════════════════════════

function buildManifest(descriptor) {
  const cfg = descriptor.extension.config
  const schemaProperties = cfg?.properties ?? {}
  const schema = {
    type: 'object',
    properties: schemaProperties,
    ...(cfg?.required?.length ? { required: cfg.required } : {}),
    additionalProperties: cfg?.additionalProperties ?? false,
  }
  const tools = (descriptor.tools ?? []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
  return {
    name: descriptor.extension.name,
    version: descriptor.extension.version,
    description: descriptor.extension.description,
    types: [{
      kind: 'toolkit',
      type: descriptor.extension.name,
      description: descriptor.extension.description,
      platforms: descriptor.extension.platforms,
      schema,
      tools,
    }],
  }
}

function writeManifestYaml(manifest, outDir) {
  const clean = JSON.parse(JSON.stringify(manifest))  // remove undefineds
  writeFileSync(join(outDir, 'manifest.yaml'), dumpYaml(clean) + '\n', 'utf8')
}

function writeManifestTs(manifest, outDir) {
  const ts = `// GENERATED by polybind-codegen — do not edit manually.
// import type { ExtensionManifestFile } from '@polymath/types'
export const manifest = ${JSON.stringify(manifest, null, 2)}
`
  writeFileSync(join(outDir, 'manifest.ts'), ts, 'utf8')
}

function writeArkTSWrapper(descriptor, outDir) {
  const tmplPath = join(POLYBIND_ROOT, 'runtime/arkts/src/PolybindExtension.ets.tmpl')
  let tmpl = readFileSync(tmplPath, 'utf8')
  const soName = descriptor.extension.so_name
  tmpl = tmpl.replaceAll('{{SO_NAME}}', soName)
  tmpl = tmpl.replaceAll('{{EXTENSION_NAME}}', descriptor.extension.name)
  tmpl = tmpl.replaceAll('{{EXTENSION_VERSION}}', descriptor.extension.version)
  writeFileSync(join(outDir, 'PolybindExtension.ets'), tmpl, 'utf8')
}

function writeNodeWrapper(descriptor, outDir) {
  const soName = descriptor.extension.so_name
  const ts = `// GENERATED by polybind-codegen — do not edit manually.
// Node.js IExtension wrapper for: ${descriptor.extension.name}
import { PolybindExtension as _Ext } from '@polybind/runtime-node'
import { manifest } from './manifest.js'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const nodePath = resolve(__dir, '../build/${soName}_node.node')
export const extension = new _Ext(nodePath)
export { manifest }
`
  writeFileSync(join(outDir, 'PolybindExtension.ts'), ts, 'utf8')
}

function writeCMakeLists(descriptor, srcDir, outFile, polybindRoot) {
  const soName = descriptor.extension.so_name
  const outDir = dirname(outFile)
  // Use paths relative to CMakeLists.txt so the project is portable
  const relSrc = relative(outDir, srcDir).replace(/\\/g, '/')
  const relPolybind = relative(outDir, polybindRoot).replace(/\\/g, '/')
  let sources = []
  try {
    sources = readdirSync(srcDir).filter(f => f.endsWith('.cpp'))
      .map(f => `  \${CMAKE_CURRENT_SOURCE_DIR}/${relSrc}/${f}`)
  } catch { sources = ['  # Add your .cpp sources here'] }

  const cmake = `# GENERATED by polybind-codegen
cmake_minimum_required(VERSION 3.14)

# ── ArkTS: detect OHOS cross-compiler BEFORE project() ───────────────────────
if(POLYBIND_PLATFORM STREQUAL "arkts")
  if(NOT DEFINED OHOS_SDK_NATIVE OR OHOS_SDK_NATIVE STREQUAL "")
    if(DEFINED ENV{OHOS_SDK_NATIVE})
      set(OHOS_SDK_NATIVE "$ENV{OHOS_SDK_NATIVE}")
    else()
      foreach(_cand
        "/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native"
        "/mnt/c/Users/$ENV{USER}/AppData/Local/Huawei/Sdk/openharmony/native"
        "$ENV{HOME}/harmonyos/native"
      )
        if(EXISTS "\${_cand}/llvm/bin/clang" OR EXISTS "\${_cand}/llvm/bin/clang.exe")
          set(OHOS_SDK_NATIVE "\${_cand}")
          break()
        endif()
      endforeach()
    endif()
  endif()
  if(DEFINED OHOS_SDK_NATIVE AND NOT OHOS_SDK_NATIVE STREQUAL "")
    if(EXISTS "\${OHOS_SDK_NATIVE}/llvm/bin/clang")
      # Native Linux cross-compiler
      set(CMAKE_C_COMPILER   "\${OHOS_SDK_NATIVE}/llvm/bin/clang"   CACHE STRING "" FORCE)
      set(CMAKE_CXX_COMPILER "\${OHOS_SDK_NATIVE}/llvm/bin/clang++" CACHE STRING "" FORCE)
      set(CMAKE_C_COMPILER_TARGET   "aarch64-linux-ohos" CACHE STRING "" FORCE)
      set(CMAKE_CXX_COMPILER_TARGET "aarch64-linux-ohos" CACHE STRING "" FORCE)
      set(CMAKE_SYSROOT "\${OHOS_SDK_NATIVE}/sysroot" CACHE STRING "" FORCE)
      set(CMAKE_C_FLAGS_INIT   "-D__MUSL__")
      set(CMAKE_CXX_FLAGS_INIT "-D__MUSL__")
    elseif(EXISTS "\${OHOS_SDK_NATIVE}/llvm/bin/clang.exe")
      string(REGEX MATCH "^/mnt/([a-zA-Z])" _DRIVE_MATCH "\${OHOS_SDK_NATIVE}")
      string(TOUPPER "\${CMAKE_MATCH_1}" _DRIVE_LETTER)
      string(REGEX REPLACE "^/mnt/[a-zA-Z]" "" _REST "\${OHOS_SDK_NATIVE}")
      set(_WIN_SDK_NATIVE "\${_DRIVE_LETTER}:\${_REST}")
      set(CMAKE_SYSROOT "\${_WIN_SDK_NATIVE}/sysroot" CACHE STRING "" FORCE)
      set(CMAKE_C_COMPILER   "\${OHOS_SDK_NATIVE}/llvm/bin/clang.exe"   CACHE STRING "" FORCE)
      set(CMAKE_CXX_COMPILER "\${OHOS_SDK_NATIVE}/llvm/bin/clang++.exe" CACHE STRING "" FORCE)
      set(CMAKE_C_COMPILER_TARGET   "aarch64-linux-ohos" CACHE STRING "" FORCE)
      set(CMAKE_CXX_COMPILER_TARGET "aarch64-linux-ohos" CACHE STRING "" FORCE)
      set(CMAKE_C_FLAGS_INIT   "-D__MUSL__")
      set(CMAKE_CXX_FLAGS_INIT "-D__MUSL__")
    endif()
  endif()
endif()

project(${soName})

set(POLYBIND_ROOT "\${CMAKE_CURRENT_SOURCE_DIR}/${relPolybind}")
set(POLYBIND_INCLUDE_DIR \${POLYBIND_ROOT}/include)
set(POLYBIND_NAPI_BRIDGE  \${POLYBIND_ROOT}/src/napi_bridge.cpp)
set(POLYBIND_MODULE_NAME  ${soName})

set(POLYBIND_TOOL_SOURCES
${sources.join('\n')}
)

# cmake -B build -DPOLYBIND_PLATFORM=node   .  →  ${soName}_node.node
# cmake -B build -DPOLYBIND_PLATFORM=arkts  .  →  lib${soName}.so
if(POLYBIND_PLATFORM STREQUAL "arkts")
  include(\${POLYBIND_ROOT}/cmake/polybind-arkts.cmake)
else()
  include(\${POLYBIND_ROOT}/cmake/polybind-node.cmake)
endif()
${(descriptor.cmake_extra || '').trim() ? '\n' + descriptor.cmake_extra.trim() + '\n' : ''}
`
  writeFileSync(outFile, cmake, 'utf8')
}

function generateManifestFromEts(etsFiles, outPath) {
  let inferredName = 'unknown-extension'
  let inferredVersion = '0.1.0'

  for (const f of etsFiles) {
    const source = readFileSync(f, 'utf8')
    const classMatch = source.match(/class\s+(\w+)\s+implements\s+IExtension/)
    if (classMatch) {
      const className = classMatch[1].replace(/Extension$/, '')
      inferredName = className
        .replace(/([A-Z])/g, (m, p1, offset) => (offset > 0 ? '-' : '') + p1.toLowerCase())
        .replace(/^-/, '')
        .toLowerCase()
    }
  }

  const manifest = {
    name: inferredName,
    version: inferredVersion,
    types: [{
      kind: 'toolkit',
      type: inferredName,
      platforms: ['arkts'],
      schema: { type: 'object', properties: {}, additionalProperties: false },
    }],
  }

  const clean = JSON.parse(JSON.stringify(manifest))
  writeFileSync(outPath, dumpYaml(clean) + '\n', 'utf8')
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI commands
// ═══════════════════════════════════════════════════════════════════════════════

function getArg(args, flag) {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
  return undefined
}

function cmdCheck(args) {
  const filePath = args[0]
  if (!filePath) { console.error('Usage: polybind check <file.ets> [--out <file.ets>] [--fix]'); process.exit(1) }
  const absPath = resolve(process.cwd(), filePath)
  const result = checkFile(absPath)
  console.log(formatCheckResult(result))

  if (args.includes('--fix') && !result.ok) {
    const outPath = getArg(args, '--out') || absPath
    const absOut = resolve(process.cwd(), outPath)
    const fixResult = fixFile(absPath, absOut, result.issues)
    if (fixResult.appliedFixes.length > 0) {
      console.log(`\nApplied ${fixResult.appliedFixes.length} fix(es):`)
      for (const fix of fixResult.appliedFixes) console.log(`  ✓ ${fix}`)
      console.log(`\nWritten to: ${absOut}`)
      const recheck = checkFile(absOut)
      console.log('\nRe-check after fixes:')
      console.log(formatCheckResult(recheck))
    } else {
      console.log('\nNo automated fixes could be applied. Manual fixes required.')
    }
  }
  process.exit(result.ok ? 0 : 1)
}

function cmdGenerate(args) {
  const yamlPath = args[0]
  const outDir = getArg(args, '--out')
  if (!yamlPath || !outDir) { console.error('Usage: polybind generate <tools.yaml> --out <dir>'); process.exit(1) }
  const absYaml = resolve(process.cwd(), yamlPath)
  const absOut = resolve(process.cwd(), outDir)
  mkdirSync(absOut, { recursive: true })

  const descriptor = parseToolsYaml(absYaml)
  const manifest = buildManifest(descriptor)
  writeManifestYaml(manifest, absOut)
  console.log(`✓ manifest.yaml  → ${join(absOut, 'manifest.yaml')}`)
  writeManifestTs(manifest, absOut)
  console.log(`✓ manifest.ts    → ${join(absOut, 'manifest.ts')}`)

  const platforms = descriptor.extension.platforms || ['node', 'arkts']
  if (platforms.includes('node')) {
    writeNodeWrapper(descriptor, absOut)
    console.log(`✓ PolybindExtension.ts  → ${join(absOut, 'PolybindExtension.ts')}`)
  }
  if (platforms.includes('arkts')) {
    writeArkTSWrapper(descriptor, absOut)
    console.log(`✓ PolybindExtension.ets → ${join(absOut, 'PolybindExtension.ets')}`)
  }
}

function cmdCmake(args) {
  const yamlPath = args[0]
  const polybindRoot = getArg(args, '--polybind-root') || POLYBIND_ROOT
  const outFile = getArg(args, '--out')
  if (!yamlPath || !outFile) { console.error('Usage: polybind cmake <tools.yaml> --polybind-root <dir> --out <CMakeLists.txt>'); process.exit(1) }
  const absYaml = resolve(process.cwd(), yamlPath)
  const absPolybindRoot = resolve(process.cwd(), polybindRoot)
  const absOut = resolve(process.cwd(), outFile)
  mkdirSync(dirname(absOut), { recursive: true })
  const descriptor = parseToolsYaml(absYaml)
  writeCMakeLists(descriptor, dirname(absYaml), absOut, absPolybindRoot)
  console.log(`✓ CMakeLists.txt → ${absOut}`)
}

function cmdGenerateFromEts(args) {
  const etsSrcDir = getArg(args, '--ets')
  const outPath = getArg(args, '--out')
  if (!etsSrcDir || !outPath) { console.error('Usage: polybind generate-from-ets --ets <dir> --out <manifest.yaml>'); process.exit(1) }
  const absEtsDir = resolve(process.cwd(), etsSrcDir)
  const absOut = resolve(process.cwd(), outPath)
  const etsFiles = readdirSync(absEtsDir)
    .filter(f => f.endsWith('.ets') && f !== 'Index.ets')
    .map(f => join(absEtsDir, f))
  if (etsFiles.length === 0) { console.error(`No .ets files in ${absEtsDir}`); process.exit(1) }
  generateManifestFromEts(etsFiles, absOut)
  console.log(`✓ manifest.yaml → ${absOut}`)
  console.log(`  (inferred from ${etsFiles.map(f => basename(f)).join(', ')})`)
}

function cmdWrappers(args) {
  const yamlPath = args[0]
  const outDir = getArg(args, '--out')
  if (!yamlPath || !outDir) { console.error('Usage: polybind wrappers <tools.yaml> --out <dir>'); process.exit(1) }
  const absYaml = resolve(process.cwd(), yamlPath)
  const absOut = resolve(process.cwd(), outDir)
  mkdirSync(absOut, { recursive: true })
  const descriptor = parseToolsYaml(absYaml)
  const platforms = descriptor.extension.platforms || ['node', 'arkts']
  if (platforms.includes('node')) { writeNodeWrapper(descriptor, absOut); console.log(`✓ PolybindExtension.ts`) }
  if (platforms.includes('arkts')) { writeArkTSWrapper(descriptor, absOut); console.log(`✓ PolybindExtension.ets`) }
}

// ── Command: entry-cpp ────────────────────────────────────────────────────────
// Generates polybind_entry.cpp from tools.yaml.
// The file bridges polybind's C interface (polymath_get_extension) to the
// project's ToolRegistry. Tool metadata (names, descriptions, schemas) is
// taken directly from tools.yaml so the user never duplicates it manually.

function generateEntryCpp(descriptor) {
  const ext = descriptor.extension
  const entry = descriptor.cpp_entry || {}
  const includes = entry.includes || []
  const ns = entry.namespace || ''
  const serverId = entry.server_id || 'polybind'
  const initCall = entry.init || `/* TODO: register your tools here with server_id="${serverId}" */`

  // Build #include lines
  const systemIncludes = [
    '#include "polybind/tool.h"',
    '#include <nlohmann/json.hpp>',
    '#include <map>',
    '#include <string>',
  ].join('\n')
  const projectIncludes = includes.map(h => `#include "${h}"`).join('\n')

  // Build kTools[] entries from tools.yaml
  const toolEntries = (descriptor.tools || []).map(t => {
    const schema = JSON.stringify(t.input_schema || { type: 'object', properties: {} }, null, 2)
    // Escape backslashes and quotes for use inside a raw string if needed
    return `    {\n        ${JSON.stringify(t.name)},\n        ${JSON.stringify(t.description)},\n        R"JSON(${schema})JSON"\n    }`
  }).join(',\n')

  const usingNs = ns ? `using namespace ${ns};` : ''

  return `// GENERATED by polybind-codegen — do not edit manually.
// Source: tools.yaml → bind.sh entry-cpp
// Re-run bind.sh to regenerate after editing tools.yaml.

${systemIncludes}
${projectIncludes}

using json = nlohmann::json;
${usingNs}

// ── Server ID used for ToolRegistry ──────────────────────────────────────────

static constexpr const char* kServerId = ${JSON.stringify(serverId)};

// ── JSON args → map<string, string> ──────────────────────────────────────────
// ToolRegistry handlers expect string values. Arrays/objects are serialised
// back to JSON strings so existing preprocessors (normalize_keywords_input etc.)
// can parse them unchanged.

static std::map<std::string, std::string> json_to_str_map(const json& j) {
    std::map<std::string, std::string> result;
    if (!j.is_object()) return result;
    for (auto& [key, val] : j.items()) {
        if (val.is_string())         result[key] = val.get<std::string>();
        else if (val.is_number_integer()) result[key] = std::to_string(val.get<long long>());
        else if (val.is_number_float())   result[key] = std::to_string(val.get<double>());
        else if (val.is_boolean())        result[key] = val.get<bool>() ? "true" : "false";
        else                              result[key] = val.dump(); // array / object → JSON string
    }
    return result;
}

// ── Static result buffers ─────────────────────────────────────────────────────

static std::string g_result_content;
static std::string g_result_error;

// ── PolyExtension callbacks ───────────────────────────────────────────────────

static void poly_init(void) {
    ${initCall};
}

static PolyResult poly_call_tool(const char* name, const char* args_json) {
    PolyResult res{};
    std::map<std::string, std::string> args;
    try {
        auto j = json::parse(args_json ? args_json : "{}");
        args = json_to_str_map(j);
    } catch (const std::exception& e) {
        g_result_error = std::string("JSON parse error: ") + e.what();
        res.content_json = nullptr; res.error = g_result_error.c_str(); return res;
    }
    try {
        std::string output = ToolRegistry::instance().execute(kServerId, name, args);
        g_result_content = json(output).dump();
        g_result_error.clear();
        res.content_json = g_result_content.c_str(); res.error = nullptr;
    } catch (const std::exception& e) {
        g_result_error = e.what();
        res.content_json = nullptr; res.error = g_result_error.c_str();
    }
    return res;
}

// ── Tool descriptors (generated from tools.yaml) ──────────────────────────────

static const PolyTool kTools[] = {
${toolEntries}
};

// ── PolyExtension definition ──────────────────────────────────────────────────

static const PolyExtension kExtension = {
    /* name        */ ${JSON.stringify(ext.name)},
    /* version     */ ${JSON.stringify(ext.version)},
    /* tool_count  */ ${(descriptor.tools || []).length},
    /* tools       */ kTools,
    /* call_tool   */ poly_call_tool,
    /* init        */ poly_init,
    /* destroy     */ nullptr,
    /* free_result */ nullptr,
};

// ── Entry point ───────────────────────────────────────────────────────────────

extern "C" PolyExtension* polymath_get_extension(void) {
    return const_cast<PolyExtension*>(&kExtension);
}
`
}

function cmdEntryCpp(args) {
  const yamlPath = args[0]
  const outFile = getArg(args, '--out')
  if (!yamlPath || !outFile) {
    console.error('Usage: polybind entry-cpp <tools.yaml> --out <polybind_entry.cpp>')
    process.exit(1)
  }
  const absYaml = resolve(process.cwd(), yamlPath)
  const absOut = resolve(process.cwd(), outFile)
  mkdirSync(dirname(absOut), { recursive: true })
  const descriptor = parseToolsYaml(absYaml)
  const cpp = generateEntryCpp(descriptor)
  writeFileSync(absOut, cpp, 'utf8')
  console.log(`✓ polybind_entry.cpp → ${absOut}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [,, command, ...rest] = process.argv
switch (command) {
  case 'check':            cmdCheck(rest); break
  case 'generate':         cmdGenerate(rest); break
  case 'cmake':            cmdCmake(rest); break
  case 'generate-from-ets': cmdGenerateFromEts(rest); break
  case 'wrappers':         cmdWrappers(rest); break
  case 'entry-cpp':        cmdEntryCpp(rest); break
  default:
    console.log(`polybind — C++/ArkTS → polymath IExtension bridge

Commands:
  check <file.ets> [--out <file.ets>] [--fix]
  generate <tools.yaml> --out <dir>
  generate-from-ets --ets <dir> --out <manifest.yaml>
  cmake <tools.yaml> --polybind-root <dir> --out <CMakeLists.txt>
  wrappers <tools.yaml> --out <dir>
  entry-cpp <tools.yaml> --out <polybind_entry.cpp>
`)
}
