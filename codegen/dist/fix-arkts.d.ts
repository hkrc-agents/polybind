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
import { CheckIssue } from './check.js';
export interface FixResult {
    filePath: string;
    outPath: string;
    appliedFixes: string[];
    source: string;
}
export interface FixOptions {
    /** If true, write the fixed source to outPath. Default: true. */
    write?: boolean;
}
export declare function fixFile(filePath: string, outPath: string, issues: CheckIssue[], opts?: FixOptions): FixResult;
