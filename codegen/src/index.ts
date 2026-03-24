#!/usr/bin/env node
/**
 * polybind CLI — index.ts
 *
 * Commands:
 *   check  <file.ets> [--out <outFile.ets>] [--fix]
 *     Check an ArkTS file for polymath interface compliance.
 *     --fix   Apply automated fixes and write to --out (or overwrite original if no --out).
 *
 *   generate  <tools.yaml> --out <outDir>
 *     Generate manifest.yaml, manifest.ts, PolybindExtension.ts, PolybindExtension.ets,
 *     and CMakeLists.txt from a tools.yaml descriptor.
 *
 *   generate-from-ets  --ets <etsSrcDir> --out <manifest.yaml>
 *     Infer and generate manifest.yaml by analyzing existing .ets files.
 *
 *   wrappers  <tools.yaml> --out <outDir>
 *     Generate only the ArkTS and Node.js wrapper files from a tools.yaml.
 *
 *   cmake  <tools.yaml> --polybind-root <dir> --out <CMakeLists.txt>
 *     Generate a CMakeLists.txt for building the C++ tools.
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readdirSync } from 'node:fs'

import { checkFile, formatCheckResult } from './check.js'
import { fixFile } from './fix-arkts.js'
import {
  parseToolsYaml,
  buildManifest,
  writeManifestYaml,
  writeManifestTs,
  writeArkTSWrapper,
  writeNodeWrapper,
  writeCMakeLists,
  generateManifestFromEts,
} from './generate.js'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Argument parsing ──────────────────────────────────────────────────────────

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
  return undefined
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

// ── Command: check ────────────────────────────────────────────────────────────

function cmdCheck(args: string[]): void {
  const filePath = args[0]
  if (!filePath) {
    console.error('Usage: polybind check <file.ets> [--out <outFile.ets>] [--fix]')
    process.exit(1)
  }

  const absPath = resolve(process.cwd(), filePath)
  const result = checkFile(absPath)

  console.log(formatCheckResult(result))

  if (hasFlag(args, '--fix') && !result.ok) {
    const outPath = getArg(args, '--out') ?? absPath
    const absOut = resolve(process.cwd(), outPath)

    const fixResult = fixFile(absPath, absOut, result.issues)

    if (fixResult.appliedFixes.length > 0) {
      console.log(`\nApplied ${fixResult.appliedFixes.length} fix(es):`)
      for (const fix of fixResult.appliedFixes) {
        console.log(`  ✓ ${fix}`)
      }
      console.log(`\nWritten to: ${absOut}`)

      // Re-run check on the fixed file
      const recheck = checkFile(absOut)
      console.log('\nRe-check after fixes:')
      console.log(formatCheckResult(recheck))
      if (!recheck.ok) {
        console.log('\nNote: Some issues require manual fixing. See above.')
      }
    } else {
      console.log('\nNo automated fixes could be applied. Manual fixes required.')
    }
  } else if (!hasFlag(args, '--fix') && !result.ok) {
    console.log('\nRun with --fix to apply automated fixes.')
  }

  process.exit(result.ok ? 0 : 1)
}

// ── Command: generate ─────────────────────────────────────────────────────────

function cmdGenerate(args: string[]): void {
  const yamlPath = args[0]
  if (!yamlPath) {
    console.error('Usage: polybind generate <tools.yaml> --out <outDir>')
    process.exit(1)
  }

  const outDir = getArg(args, '--out')
  if (!outDir) {
    console.error('Missing --out <outDir>')
    process.exit(1)
  }

  const absYaml = resolve(process.cwd(), yamlPath)
  const absOut = resolve(process.cwd(), outDir)
  mkdirSync(absOut, { recursive: true })

  const descriptor = parseToolsYaml(absYaml)
  const manifest = buildManifest(descriptor)

  writeManifestYaml(manifest, absOut)
  console.log(`✓ manifest.yaml → ${join(absOut, 'manifest.yaml')}`)

  writeManifestTs(manifest, absOut)
  console.log(`✓ manifest.ts   → ${join(absOut, 'manifest.ts')}`)

  const platforms = descriptor.extension.platforms ?? ['node', 'arkts']

  if (platforms.includes('node')) {
    writeNodeWrapper(descriptor, absOut)
    console.log(`✓ PolybindExtension.ts  → ${join(absOut, 'PolybindExtension.ts')}`)
  }

  if (platforms.includes('arkts')) {
    writeArkTSWrapper(descriptor, absOut)
    console.log(`✓ PolybindExtension.ets → ${join(absOut, 'PolybindExtension.ets')}`)
  }
}

// ── Command: cmake ────────────────────────────────────────────────────────────

function cmdCmake(args: string[]): void {
  const yamlPath = args[0]
  if (!yamlPath) {
    console.error('Usage: polybind cmake <tools.yaml> --polybind-root <dir> --out <CMakeLists.txt>')
    process.exit(1)
  }

  const polybindRoot = getArg(args, '--polybind-root') ?? resolve(__dir, '../../..')
  const outFile = getArg(args, '--out')
  if (!outFile) {
    console.error('Missing --out <CMakeLists.txt>')
    process.exit(1)
  }

  const absYaml = resolve(process.cwd(), yamlPath)
  const absPolybindRoot = resolve(process.cwd(), polybindRoot)
  const absOut = resolve(process.cwd(), outFile)

  const descriptor = parseToolsYaml(absYaml)
  const srcDir = dirname(absYaml)
  const outDir = dirname(absOut)

  mkdirSync(outDir, { recursive: true })
  writeCMakeLists(descriptor, srcDir, outDir, absPolybindRoot)
  console.log(`✓ CMakeLists.txt → ${absOut}`)
}

// ── Command: generate-from-ets ────────────────────────────────────────────────

function cmdGenerateFromEts(args: string[]): void {
  const etsSrcDir = getArg(args, '--ets')
  const outPath = getArg(args, '--out')

  if (!etsSrcDir || !outPath) {
    console.error('Usage: polybind generate-from-ets --ets <etsSrcDir> --out <manifest.yaml>')
    process.exit(1)
  }

  const absEtsDir = resolve(process.cwd(), etsSrcDir)
  const absOut = resolve(process.cwd(), outPath)

  const etsFiles = readdirSync(absEtsDir)
    .filter(f => f.endsWith('.ets') && f !== 'Index.ets')
    .map(f => join(absEtsDir, f))

  if (etsFiles.length === 0) {
    console.error(`No .ets files found in ${absEtsDir}`)
    process.exit(1)
  }

  generateManifestFromEts({ etsFiles, outPath: absOut })
  console.log(`✓ manifest.yaml → ${absOut}`)
  console.log(`  (inferred from ${etsFiles.map(f => f.split('/').pop()).join(', ')})`)
}

// ── Command: wrappers ─────────────────────────────────────────────────────────

function cmdWrappers(args: string[]): void {
  const yamlPath = args[0]
  const outDir = getArg(args, '--out')
  if (!yamlPath || !outDir) {
    console.error('Usage: polybind wrappers <tools.yaml> --out <outDir>')
    process.exit(1)
  }

  const absYaml = resolve(process.cwd(), yamlPath)
  const absOut = resolve(process.cwd(), outDir)
  mkdirSync(absOut, { recursive: true })

  const descriptor = parseToolsYaml(absYaml)
  const platforms = descriptor.extension.platforms ?? ['node', 'arkts']

  if (platforms.includes('node')) {
    writeNodeWrapper(descriptor, absOut)
    console.log(`✓ PolybindExtension.ts  → ${join(absOut, 'PolybindExtension.ts')}`)
  }

  if (platforms.includes('arkts')) {
    writeArkTSWrapper(descriptor, absOut)
    console.log(`✓ PolybindExtension.ets → ${join(absOut, 'PolybindExtension.ets')}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv

switch (command) {
  case 'check':
    cmdCheck(rest)
    break
  case 'generate':
    cmdGenerate(rest)
    break
  case 'cmake':
    cmdCmake(rest)
    break
  case 'generate-from-ets':
    cmdGenerateFromEts(rest)
    break
  case 'wrappers':
    cmdWrappers(rest)
    break
  default:
    console.log(`polybind — C++/ArkTS → polymath IExtension bridge

Commands:
  check <file.ets> [--out <file.ets>] [--fix]
      Check ArkTS file for polymath interface compliance. --fix applies automated fixes.

  generate <tools.yaml> --out <dir>
      Generate manifest.yaml, manifest.ts, PolybindExtension.ts/.ets from tools.yaml.

  generate-from-ets --ets <dir> --out <manifest.yaml>
      Infer manifest.yaml from existing .ets files (no tools.yaml needed).

  cmake <tools.yaml> --polybind-root <dir> --out <CMakeLists.txt>
      Generate CMakeLists.txt for building C++ tools with polybind bridge.

  wrappers <tools.yaml> --out <dir>
      Generate only ArkTS/Node.js wrapper files.
`)
    process.exit(0)
}
