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
export {};
