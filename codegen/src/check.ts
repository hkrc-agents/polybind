/**
 * check.ts — Analyze an ArkTS .ets file for polymath IExtension/IToolkit compliance.
 *
 * Checks (in order of severity):
 *   1. Imports @polymath/types for IExtension, IToolkit, AppEntry, ToolDefinition, ToolResponse
 *   2. Exports a class implementing IExtension with initAppSession() + createObject()
 *   3. Has a class implementing IToolkit with listTools()
 *   4. callTool has non-streaming overload: (name, args: Record<string, unknown>): Promise<ToolResponse>
 *   5. callTool has streaming overload:     (name, args, true): AsyncIterable<...>
 *   6. ToolDefinition uses 'inputSchema' not 'parameters'
 *
 * Returns an array of CheckIssue objects. Empty array means fully compliant.
 */

import { readFileSync } from 'node:fs'

// ── Types ─────────────────────────────────────────────────────────────────────

export type IssueSeverity = 'error' | 'warning'

export interface CheckIssue {
  severity: IssueSeverity
  code: string        // e.g. 'MISSING_POLYMATH_IMPORT'
  message: string
  line?: number       // 1-based line number, if determinable
  fix?: string        // Human-readable description of the fix
}

export interface CheckResult {
  filePath: string
  issues: CheckIssue[]
  ok: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findLine(lines: string[], pattern: RegExp): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1
  }
  return undefined
}

function hasPattern(lines: string[], pattern: RegExp): boolean {
  return lines.some(l => pattern.test(l))
}

// ── Checks ────────────────────────────────────────────────────────────────────

/**
 * Check 1: @polymath/types import
 * Looks for: import type { ... } from '@polymath/types'
 * or:        import { ... } from '@polymath/types'
 */
function checkPolymathImport(lines: string[], issues: CheckIssue[]): void {
  const hasImport = hasPattern(lines, /@polymath\/types/)
  if (!hasImport) {
    issues.push({
      severity: 'error',
      code: 'MISSING_POLYMATH_IMPORT',
      message: "File does not import from '@polymath/types'. Local interface definitions must be replaced.",
      fix: "Add: import type { IExtension, IToolkit, AppEntry, ToolDefinition, ToolResponse, ToolProgress } from '@polymath/types'",
    })
  }
}

/**
 * Check 2: Local IExtension/IToolkit/AppEntry/ToolDefinition/ToolResponse definitions
 * These should be removed once @polymath/types is imported.
 */
function checkLocalInterfaceDefinitions(lines: string[], issues: CheckIssue[]): void {
  const localInterfaces = [
    { name: 'IExtension',     pattern: /^export\s+interface\s+IExtension\b/ },
    { name: 'IToolkit',       pattern: /^export\s+interface\s+IToolkit\b/ },
    { name: 'AppEntry',       pattern: /^export\s+interface\s+AppEntry\b/ },
    { name: 'ToolDefinition', pattern: /^export\s+interface\s+ToolDefinition\b/ },
    { name: 'ToolResponse',   pattern: /^export\s+interface\s+ToolResponse\b/ },
  ]

  for (const { name, pattern } of localInterfaces) {
    const line = findLine(lines, pattern)
    if (line !== undefined) {
      issues.push({
        severity: 'error',
        code: `LOCAL_INTERFACE_${name.toUpperCase()}`,
        message: `Local 'export interface ${name}' found. Should be imported from '@polymath/types' instead.`,
        line,
        fix: `Remove the local ${name} definition and import it from '@polymath/types'.`,
      })
    }
  }
}

/**
 * Check 3: IExtension implementation
 * Looks for a class that implements IExtension.
 */
function checkIExtensionClass(lines: string[], issues: CheckIssue[]): void {
  const hasExtensionClass = hasPattern(lines, /implements\s+IExtension\b/)
  if (!hasExtensionClass) {
    issues.push({
      severity: 'error',
      code: 'MISSING_IEXTENSION_IMPL',
      message: "No class implementing IExtension found. Need: export class MyExtension implements IExtension { ... }",
      fix: "Add a class implementing IExtension with initAppSession() and createObject() methods.",
    })
    return
  }

  const hasInitAppSession = hasPattern(lines, /initAppSession\s*\(/)
  if (!hasInitAppSession) {
    issues.push({
      severity: 'error',
      code: 'MISSING_INIT_APP_SESSION',
      message: "IExtension implementation missing initAppSession() method.",
      fix: "Add: async initAppSession(appSessionId: string): Promise<void> { ... }",
    })
  }

  const hasCreateObject = hasPattern(lines, /createObject\s*\(/)
  if (!hasCreateObject) {
    issues.push({
      severity: 'error',
      code: 'MISSING_CREATE_OBJECT',
      message: "IExtension implementation missing createObject() method.",
      fix: "Add: async createObject(appSessionId: string, entry: AppEntry): Promise<IToolkit> { ... }",
    })
  }
}

/**
 * Check 4: IToolkit implementation
 * Looks for a class that implements IToolkit.
 */
function checkIToolkitClass(lines: string[], issues: CheckIssue[]): void {
  const hasToolkitClass = hasPattern(lines, /implements\s+IToolkit\b/)
  if (!hasToolkitClass) {
    issues.push({
      severity: 'error',
      code: 'MISSING_ITOOLKIT_IMPL',
      message: "No class implementing IToolkit found.",
      fix: "Add a class implementing IToolkit with listTools() and callTool() methods.",
    })
    return
  }

  const hasListTools = hasPattern(lines, /listTools\s*\(\s*\)/)
  if (!hasListTools) {
    issues.push({
      severity: 'error',
      code: 'MISSING_LIST_TOOLS',
      message: "IToolkit implementation missing listTools() method.",
      fix: "Add: async listTools(): Promise<ToolDefinition[]> { ... }",
    })
  }
}

/**
 * Check 5: callTool signatures
 * Non-streaming: callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse>
 * Streaming:     callTool(name: string, args: Record<string, unknown>, progress: true): AsyncIterable<...>
 */
function checkCallToolSignatures(lines: string[], issues: CheckIssue[]): void {
  const hasCallTool = hasPattern(lines, /callTool\s*\(/)
  if (!hasCallTool) {
    issues.push({
      severity: 'error',
      code: 'MISSING_CALL_TOOL',
      message: "No callTool() method found in IToolkit implementation.",
      fix: "Add callTool() with both non-streaming and streaming overloads.",
    })
    return
  }

  // Check for typed args (wrong: RunJsArgs or other named type)
  // Correct: Record<string, unknown>
  const callToolLines = lines.filter(l => /callTool\s*\(/.test(l))
  const hasTypedArgs = callToolLines.some(l =>
    /callTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*(?!Record)/.test(l)
  )
  if (hasTypedArgs) {
    const line = findLine(lines,
      /callTool\s*\(\s*\w+\s*:\s*string\s*,\s*\w+\s*:\s*(?!Record)/
    )
    issues.push({
      severity: 'error',
      code: 'CALLTOOL_TYPED_ARGS',
      message: "callTool() uses a specific typed class for args instead of Record<string, unknown>.",
      line,
      fix: "Change callTool(name: string, args: YourClass) to callTool(name: string, args: Record<string, unknown>). Cast internally if needed.",
    })
  }

  // Check for streaming overload
  const hasStreamingOverload = hasPattern(lines,
    /callTool\s*\([\s\S]*?progress\s*:\s*true/
  ) || hasPattern(lines,
    /callTool\s*\([\s\S]*?,\s*true\s*\)/
  )
  if (!hasStreamingOverload) {
    const line = findLine(lines, /callTool\s*\(/)
    issues.push({
      severity: 'error',
      code: 'MISSING_STREAMING_OVERLOAD',
      message: "callTool() missing streaming overload: (name, args, progress: true): AsyncIterable<ToolProgress | ToolResponse>",
      line,
      fix: "Add overload: callTool(name: string, args: Record<string, unknown>, progress: true): AsyncIterable<ToolProgress | ToolResponse>",
    })
  }
}

/**
 * Check 6: ToolDefinition.inputSchema vs .parameters
 * @polymath/types uses 'inputSchema', not 'parameters'.
 */
function checkInputSchema(lines: string[], issues: CheckIssue[]): void {
  // Look for 'parameters:' being assigned in ToolDefinition object literals
  // (excluding function parameters which are legitimate use)
  const hasParametersField = lines.some((l, idx) => {
    // Match 'parameters:' that looks like an object field assignment (not a function param)
    // Heuristic: the line contains 'parameters:' and is not a TypeScript function signature
    return /^\s+parameters\s*:/.test(l) ||
           /[,{]\s*parameters\s*:/.test(l)
  })

  if (hasParametersField) {
    const line = findLine(lines, /parameters\s*:/)
    issues.push({
      severity: 'error',
      code: 'WRONG_INPUT_SCHEMA_FIELD',
      message: "ToolDefinition uses 'parameters' field but @polymath/types requires 'inputSchema: Record<string, unknown>'.",
      line,
      fix: "Rename 'parameters' to 'inputSchema' and change its type to Record<string, unknown> (plain JSON Schema object).",
    })
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function checkFile(filePath: string): CheckResult {
  const source = readFileSync(filePath, 'utf8')
  const lines = source.split('\n')
  const issues: CheckIssue[] = []

  checkPolymathImport(lines, issues)
  checkLocalInterfaceDefinitions(lines, issues)
  checkIExtensionClass(lines, issues)
  checkIToolkitClass(lines, issues)
  checkCallToolSignatures(lines, issues)
  checkInputSchema(lines, issues)

  return {
    filePath,
    issues,
    ok: issues.filter(i => i.severity === 'error').length === 0,
  }
}

export function formatCheckResult(result: CheckResult): string {
  if (result.ok) {
    return `✓ ${result.filePath}: All interface checks passed`
  }

  const errors = result.issues.filter(i => i.severity === 'error')
  const warnings = result.issues.filter(i => i.severity === 'warning')

  let out = `✗ ${result.filePath}: ${errors.length} error(s), ${warnings.length} warning(s)\n`
  for (const issue of result.issues) {
    const loc = issue.line !== undefined ? `:${issue.line}` : ''
    const icon = issue.severity === 'error' ? '  ✗' : '  ⚠'
    out += `${icon} [${issue.code}]${loc}: ${issue.message}\n`
    if (issue.fix) {
      out += `    → Fix: ${issue.fix}\n`
    }
  }
  return out
}
