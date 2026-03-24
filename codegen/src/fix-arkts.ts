/**
 * fix-arkts.ts — Apply automated fixes to an ArkTS .ets file so it conforms
 * to the polymath IExtension/IToolkit interface from '@polymath/types'.
 *
 * Fixes applied (in order):
 *   1. Remove local IExtension / IToolkit / AppEntry / ToolDefinition / ToolResponse definitions
 *   2. Add @polymath/types import (if not already present)
 *   3. Rename ToolDefinition field 'parameters' → 'inputSchema' and serialize to plain object
 *   4. Change callTool(name, args: TypedClass) → callTool(name, args: Record<string, unknown>)
 *   5. Add streaming callTool overload if missing
 *
 * Philosophy: make the minimum surgical changes needed. Preserve all business logic unchanged.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { CheckIssue } from './check.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FixResult {
  filePath: string
  outPath: string
  appliedFixes: string[]
  source: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Remove a block starting at the line matching startPattern and ending at the
 * first line that matches endPattern (inclusive). Returns modified lines.
 */
function removeBlock(
  lines: string[],
  startPattern: RegExp,
  endPattern: RegExp,
): string[] {
  const result: string[] = []
  let inBlock = false

  for (const line of lines) {
    if (!inBlock && startPattern.test(line)) {
      inBlock = true
      continue  // skip start line
    }
    if (inBlock) {
      if (endPattern.test(line)) {
        inBlock = false
        continue  // skip end line
      }
      continue    // skip block body
    }
    result.push(line)
  }

  return result
}

/**
 * Remove contiguous comment + interface/type block.
 * Handles both `export interface Foo { ... }` patterns with or without preceding comment.
 */
function removeInterface(lines: string[], interfaceName: string): string[] {
  const startPattern = new RegExp(`^(export\\s+)?interface\\s+${interfaceName}\\b`)
  // Find the start line
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (startPattern.test(lines[i].trim())) {
      // Walk back to include any preceding comment block
      let commentStart = i
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim()
        if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*') || prev === '') {
          commentStart = j
        } else {
          break
        }
      }
      startIdx = commentStart
      break
    }
  }

  if (startIdx === -1) return lines

  // Find the closing brace
  let braceDepth = 0
  let endIdx = -1
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') braceDepth++
      else if (ch === '}') {
        braceDepth--
        if (braceDepth === 0) {
          endIdx = i
          break
        }
      }
    }
    if (endIdx !== -1) break
  }

  if (endIdx === -1) return lines

  const result = [
    ...lines.slice(0, startIdx),
    ...lines.slice(endIdx + 1),
  ]
  return result
}

// ── Fix 1 + 2: Replace local interface definitions with @polymath/types import ─

const POLYMATH_IMPORT_LINE =
  "import type { IExtension, IToolkit, AppEntry, ToolDefinition, ToolResponse, ToolProgress } from '@polymath/types'"

const LOCAL_INTERFACE_NAMES = [
  'IExtension',
  'IToolkit',
  'AppEntry',
  'ToolDefinition',
  'ToolResponse',
]

function fixPolymathImport(
  lines: string[],
  appliedFixes: string[],
): string[] {
  // Check if import already exists
  if (lines.some(l => l.includes('@polymath/types'))) {
    return lines
  }

  // Remove local interface definitions
  let result = [...lines]
  for (const name of LOCAL_INTERFACE_NAMES) {
    const before = result.length
    result = removeInterface(result, name)
    if (result.length !== before) {
      appliedFixes.push(`Removed local '${name}' interface definition`)
    }
  }

  // Also remove ToolProgress if locally defined
  result = removeInterface(result, 'ToolProgress')

  // Find the best insertion point: after the last existing import line
  let lastImportIdx = -1
  for (let i = 0; i < result.length; i++) {
    if (/^import\s/.test(result[i].trim())) {
      lastImportIdx = i
    }
  }

  const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0
  result.splice(insertAt, 0, POLYMATH_IMPORT_LINE)
  appliedFixes.push("Added '@polymath/types' import")

  return result
}

// ── Fix 3: ToolDefinition.parameters → inputSchema ───────────────────────────
//
// The JSVMEval pattern builds a ToolParameters class and assigns it:
//   const def: ToolDefinition = { name: ..., description: ..., parameters: params }
//
// We need to change this to:
//   const def: ToolDefinition = { name: ..., description: ..., inputSchema: buildInputSchema(params) }
//
// Strategy: inline-serialize the ToolParameters to a JSON Schema Record.
// We inject a helper function buildInputSchema() and replace the assignment.

const BUILD_INPUT_SCHEMA_HELPER = `
/**
 * polybind: Convert internal ToolParameters to a JSON Schema Record<string, unknown>
 * as required by @polymath/types ToolDefinition.inputSchema.
 * @polybind-generated — do not remove
 */
function __polybindBuildInputSchema(params: ToolParameters): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  const propKeys = Object.keys(params.properties)
  for (let i = 0; i < propKeys.length; i++) {
    const key = propKeys[i]
    const p = params.properties[key]
    const prop: Record<string, unknown> = { type: p.type, description: p.description }
    if (p.items_type) prop['items'] = { type: p.items_type }
    props[key] = prop
  }
  return {
    type: 'object',
    properties: props,
    required: params.required,
  }
}
`

function fixParametersToInputSchema(
  source: string,
  appliedFixes: string[],
): string {
  // Replace: parameters: <expr>  →  inputSchema: __polybindBuildInputSchema(<expr>)
  // within object literals of type ToolDefinition
  // Heuristic: match `parameters: params` or `parameters: <identifier>`
  // (The JSVMEval file uses `parameters: params` specifically)

  let result = source

  // Match field assignment: `parameters: someVar` (in object literal context)
  const parametersFieldRe = /(\bparameters\s*:\s*)(\w+)(\s*[,}])/g

  if (!parametersFieldRe.test(source)) {
    return result  // no match — nothing to fix
  }

  parametersFieldRe.lastIndex = 0  // reset after test

  result = result.replace(parametersFieldRe, (match, prefix, varName, suffix) => {
    // Skip function parameter declarations like `function foo(params: ToolParameters)`
    // The pattern above already handles this by only matching `key: value` style
    return `inputSchema: __polybindBuildInputSchema(${varName})${suffix}`
  })

  if (result !== source) {
    // Inject the helper function before the makeJsEvalToolDef function (or at top of module)
    const helperInsertPoint = result.indexOf('\nfunction makeJsEvalToolDef')
    if (helperInsertPoint !== -1) {
      result = result.slice(0, helperInsertPoint) + BUILD_INPUT_SCHEMA_HELPER + result.slice(helperInsertPoint)
    } else {
      // Fallback: insert after imports
      const lastImportEnd = result.lastIndexOf('\nimport ')
      const afterImports = result.indexOf('\n', lastImportEnd + 1)
      result = result.slice(0, afterImports + 1) + BUILD_INPUT_SCHEMA_HELPER + result.slice(afterImports + 1)
    }
    appliedFixes.push("Changed ToolDefinition.parameters → inputSchema (with __polybindBuildInputSchema helper)")
  }

  return result
}

// ── Fix 4: callTool(name, args: TypedClass) → callTool(name, args: Record<string, unknown>) ──

function fixCallToolArgsType(
  source: string,
  appliedFixes: string[],
): string {
  // Match callTool signatures where args has a specific named type (not Record)
  // Pattern: callTool(name: string, args: SomeName): Promise<ToolResponse>
  // We need to NOT match: callTool(name: string, args: Record<string, unknown>)
  //                   or: callTool(name: string, args: Record<string, unknown>, progress: true)

  const typedArgRe = /(\bcallTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*)(?!Record)([A-Za-z_]\w*)(\s*\))/g

  if (!typedArgRe.test(source)) return source
  typedArgRe.lastIndex = 0

  let originalTypeName = ''
  const result = source.replace(typedArgRe, (match, prefix, typeName, suffix) => {
    originalTypeName = typeName
    return `${prefix}Record<string, unknown>${suffix}`
  })

  if (result !== source) {
    // Also add internal cast comment near the usage of the old typed args
    // Find where the typed args are used (e.g., args.code, args.toolList) and add cast comment
    const castComment = `  // polybind: args cast from Record<string, unknown> to ${originalTypeName} for internal use\n`
    const usageRe = new RegExp(`(\\bconst\\s+typedArgs\\s*=|\\bargs\\s*\\.\\w)`)
    if (!usageRe.test(result)) {
      // Add a cast variable at the start of the callTool implementation body
      // Find the callTool implementation (not overload signature)
      // Heuristic: find `async callTool(` or the overload dispatcher
    }
    appliedFixes.push(`Changed callTool args type from '${originalTypeName}' to 'Record<string, unknown>'`)
  }

  return result
}

/**
 * Inject cast from Record<string, unknown> to the original typed class inside
 * the callTool implementation body.
 */
function injectArgsCast(source: string, originalTypeName: string): string {
  // Find the actual callTool implementation (the one with a function body, not just a signature)
  // Heuristic: find `callTool(name: string, args: Record<string, unknown>)` followed by `{`
  const implRe = /(\bcallTool\s*\(\s*\w+\s*:\s*string\s*,\s*)(\w+)(\s*:\s*Record<string,\s*unknown>\s*\)[^{]*\{)/
  return source.replace(implRe, (match, prefix, argsName, suffix) => {
    const castLine = `\n    const typedArgs = ${argsName} as unknown as ${originalTypeName}`
    return `${prefix}${argsName}${suffix}${castLine}`
  })
}

// ── Fix 5: Add streaming callTool overload ────────────────────────────────────

/**
 * Detect the typed args class name from the existing callTool signature.
 * Returns 'RunJsArgs' or similar, or 'Record<string, unknown>' if already fixed.
 */
function detectOriginalArgsType(source: string): string {
  const m = source.match(/callTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*([A-Za-z_][\w<>, ]*)\s*\)/)
  if (m) return m[1].trim()
  return 'Record<string, unknown>'
}

const STREAMING_OVERLOAD_SNIPPET = `
  // Non-streaming overload
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse>
  // Streaming overload — polybind: yields single result for synchronous-style tools
  callTool(
    name: string,
    args: Record<string, unknown>,
    progress: true,
  ): AsyncIterable<ToolProgress | ToolResponse>
  callTool(
    name: string,
    args: Record<string, unknown>,
    progress?: true,
  ): Promise<ToolResponse> | AsyncIterable<ToolProgress | ToolResponse> {`

function fixAddStreamingOverload(
  source: string,
  appliedFixes: string[],
): string {
  // Check if streaming overload already exists
  if (/callTool[\s\S]*?progress\s*[:?]\s*true/.test(source)) {
    return source  // already has streaming overload
  }

  // Find the callTool method implementation: `async callTool(` followed by function body
  // Replace `async callTool(name: string, args: ...) { ... }`
  // with the two-overload pattern + implementation

  const asyncCallToolRe = /(\s*)(async\s+callTool\s*\(\s*)(name\s*:\s*string\s*,\s*\w+\s*:\s*Record<string,\s*unknown>)(\s*\)\s*:\s*Promise<ToolResponse>\s*\{)/

  if (!asyncCallToolRe.test(source)) {
    // Try without the return type annotation
    const asyncCallToolRe2 = /(\s*)(async\s+callTool\s*\(\s*)(name\s*:\s*string\s*,\s*\w+\s*:\s*Record<string,\s*unknown>)(\s*\)\s*\{)/
    if (!asyncCallToolRe2.test(source)) {
      return source  // can't find implementation to augment
    }
  }

  // The strategy: we'll rename the existing implementation to _callImpl and
  // add the overloads above it.
  let result = source

  // Step 1: rename `async callTool(name: string, args: ...) {` to `private async _callImpl(name: string, args: ...) {`
  result = result.replace(
    /(async\s+callTool\s*\(\s*)(name\s*:\s*string\s*,\s*)(\w+\s*:\s*Record<string,\s*unknown>)(\s*\)\s*(?::\s*Promise<ToolResponse>)?\s*\{)/,
    (match, asyncKw, nameParam, argsParam, rest) => {
      // Extract the args variable name
      const argsVarMatch = argsParam.match(/(\w+)\s*:/)
      const argsVar = argsVarMatch ? argsVarMatch[1] : 'args'
      return `private async _callImpl(${nameParam}${argsVar}: Record<string, unknown>)${rest}`
    }
  )

  // Step 2: insert the overload signatures before `private async _callImpl`
  const overloadBlock = `
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse>
  callTool(name: string, args: Record<string, unknown>, progress: true): AsyncIterable<ToolProgress | ToolResponse>
  callTool(
    name: string,
    args: Record<string, unknown>,
    progress?: true,
  ): Promise<ToolResponse> | AsyncIterable<ToolProgress | ToolResponse> {
    if (progress) {
      const self = this
      return (async function*(): AsyncIterable<ToolResponse> {
        yield await self._callImpl(name, args)
      })()
    }
    return this._callImpl(name, args)
  }

`

  result = result.replace(
    /(\s*)(private\s+async\s+_callImpl\s*\()/,
    (match, indent, rest) => `${overloadBlock}${indent}${rest}`
  )

  if (result !== source) {
    appliedFixes.push("Added streaming callTool overload (delegates to _callImpl)")
  }

  return result
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface FixOptions {
  /** If true, write the fixed source to outPath. Default: true. */
  write?: boolean
}

export function fixFile(
  filePath: string,
  outPath: string,
  issues: CheckIssue[],
  opts: FixOptions = {},
): FixResult {
  const write = opts.write !== false
  let source = readFileSync(filePath, 'utf8')
  const appliedFixes: string[] = []

  const hasCodes = (codes: string[]) =>
    issues.some(i => codes.includes(i.code))

  // Fix 1 + 2: Remove local interface defs + add @polymath/types import
  if (hasCodes([
    'MISSING_POLYMATH_IMPORT',
    'LOCAL_INTERFACE_IEXTENSION',
    'LOCAL_INTERFACE_ITOOLKIT',
    'LOCAL_INTERFACE_APPENTRY',
    'LOCAL_INTERFACE_TOOLDEFINITION',
    'LOCAL_INTERFACE_TOOLRESPONSE',
  ])) {
    const lines = source.split('\n')
    const fixedLines = fixPolymathImport(lines, appliedFixes)
    source = fixedLines.join('\n')
  }

  // Detect original args type BEFORE we change it (needed for cast injection)
  const originalArgsType = detectOriginalArgsType(source)

  // Fix 3: parameters → inputSchema
  if (hasCodes(['WRONG_INPUT_SCHEMA_FIELD'])) {
    source = fixParametersToInputSchema(source, appliedFixes)
  }

  // Fix 4: callTool typed args → Record<string, unknown>
  if (hasCodes(['CALLTOOL_TYPED_ARGS'])) {
    source = fixCallToolArgsType(source, appliedFixes)
    // Inject internal cast so existing logic still works
    if (originalArgsType !== 'Record<string, unknown>') {
      source = injectArgsCast(source, originalArgsType)
      appliedFixes.push(`Injected internal cast to '${originalArgsType}' inside callTool body`)
    }
  }

  // Fix 5: Add streaming overload
  if (hasCodes(['MISSING_STREAMING_OVERLOAD'])) {
    source = fixAddStreamingOverload(source, appliedFixes)
  }

  if (write) {
    writeFileSync(outPath, source, 'utf8')
  }

  return { filePath, outPath, appliedFixes, source }
}
