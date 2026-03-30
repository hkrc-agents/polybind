/**
 * generate.ts — Generate polymath extension artifacts from a tools.yaml descriptor
 * or from analysis of existing ArkTS files.
 *
 * Outputs:
 *   manifest.yaml               — polymath extension manifest
 *   manifest.ts                 — TypeScript import of manifest for registerExtension()
 *   PolybindExtension.js        — Node.js IExtension wrapper (case 1 only, self-contained ESM)
 *   PolybindExtension.ets       — ArkTS IExtension wrapper (case 1 only, stamped from template)
 *
 * For case 2 (mixed) and case 3 (ArkTS only), manifest files are still generated,
 * but the wrappers are the fixed .ets files (not a new generated wrapper).
 */
export interface ToolsYamlConfigProperty {
    type: string;
    description?: string;
    default?: unknown;
    env_var?: string;
}
export interface ToolsYaml {
    extension: {
        name: string;
        version: string;
        description?: string;
        so_name?: string;
        node_entry?: {
            module: string;
            export: string;
        };
        platforms?: string[];
        config?: {
            properties?: Record<string, ToolsYamlConfigProperty>;
            required?: string[];
            additionalProperties?: boolean;
        };
    };
    tools: Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
    }>;
}
export interface ManifestTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
export interface ManifestTypeEntry {
    kind: string;
    type: string;
    description?: string;
    platforms?: string[];
    schema?: Record<string, unknown>;
    tools?: ManifestTool[];
}
export interface ManifestFile {
    name: string;
    version: string;
    description?: string;
    types: ManifestTypeEntry[];
}
export declare function parseToolsYaml(yamlPath: string): ToolsYaml;
export declare function buildManifest(descriptor: ToolsYaml): ManifestFile;
export declare function writeManifestYaml(manifest: ManifestFile, outDir: string): void;
export declare function writeManifestTs(manifest: ManifestFile, outDir: string): void;
export declare function writeArkTSWrapper(descriptor: ToolsYaml, outDir: string): void;
export declare function writeNodeWrapper(descriptor: ToolsYaml, outDir: string): void;
export declare function writeNodeWrapperDts(descriptor: ToolsYaml, outDir: string): void;
export declare function writeArkTSNodeStub(descriptor: ToolsYaml, outDir: string): void;
export declare function writeCMakeLists(descriptor: ToolsYaml, srcDir: string, outDir: string, polybindRoot: string, noBridge?: boolean): void;
export interface EtsManifestOptions {
    etsFiles: string[];
    outPath: string;
    extensionName?: string;
    version?: string;
}
export declare function generateManifestFromEts(opts: EtsManifestOptions): void;
