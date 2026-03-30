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
export type IssueSeverity = 'error' | 'warning';
export interface CheckIssue {
    severity: IssueSeverity;
    code: string;
    message: string;
    line?: number;
    fix?: string;
}
export interface CheckResult {
    filePath: string;
    issues: CheckIssue[];
    ok: boolean;
}
export declare function checkFile(filePath: string): CheckResult;
export declare function formatCheckResult(result: CheckResult): string;
