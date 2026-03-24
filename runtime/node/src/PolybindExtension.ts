/**
 * @polybind/runtime-node — Node.js runtime wrapper
 *
 * Wraps a polybind .node native addon in the polymath IExtension/IToolkit interface.
 * The .node file is loaded via createRequire() so this module works in ESM contexts.
 */

import { createRequire } from 'node:module'
import type {
  IExtension,
  IToolkit,
  AppEntry,
  ToolDefinition,
  ToolResponse,
  ToolProgress,
} from '@polymath/types'

// ── NAPI bridge interface ─────────────────────────────────────────────────────
// These are the two functions exposed by napi_bridge.cpp

interface NapiBridge {
  listTools(): string                              // JSON: [{name, description, inputSchema}, ...]
  callTool(name: string, argsJson: string): string // JSON: {content, error?}
}

// ── PolybindToolkit ───────────────────────────────────────────────────────────

class PolybindToolkit implements IToolkit {
  private _defs: ToolDefinition[] | null = null

  constructor(private readonly napi: NapiBridge) {}

  async listTools(): Promise<ToolDefinition[]> {
    if (this._defs === null) {
      this._defs = JSON.parse(this.napi.listTools()) as ToolDefinition[]
    }
    return this._defs
  }

  // Non-streaming overload
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse>
  // Streaming overload (yields single result — C++ tools are synchronous)
  callTool(
    name: string,
    args: Record<string, unknown>,
    progress: true,
  ): AsyncIterable<ToolProgress | ToolResponse>
  callTool(
    name: string,
    args: Record<string, unknown>,
    progress?: true,
  ): Promise<ToolResponse> | AsyncIterable<ToolProgress | ToolResponse> {
    if (progress) return this._stream(name, args)
    return this._call(name, args)
  }

  private async _call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const raw = this.napi.callTool(name, JSON.stringify(args))
    const parsed = JSON.parse(raw) as { content: unknown; error?: string }
    return { type: 'response', content: parsed.content as never, error: parsed.error }
  }

  private async *_stream(
    name: string,
    args: Record<string, unknown>,
  ): AsyncIterable<ToolProgress | ToolResponse> {
    yield await this._call(name, args)
  }
}

// ── PolybindExtension ─────────────────────────────────────────────────────────

/**
 * IExtension wrapper for a polybind .node native addon.
 *
 * @example
 * ```typescript
 * import { PolybindExtension } from '@polybind/runtime-node'
 * import { fileURLToPath } from 'node:url'
 * import { resolve, dirname } from 'node:path'
 *
 * const __dir = dirname(fileURLToPath(import.meta.url))
 * const ext = new PolybindExtension(resolve(__dir, '../build/my_tools.node'))
 * registry.registerExtension(manifest, ext)
 * ```
 */
export class PolybindExtension implements IExtension {
  private readonly napi: NapiBridge

  /**
   * @param nodePath Absolute path to the .node native addon file
   */
  constructor(nodePath: string) {
    // createRequire bridges ESM module context to native addon loading
    const req = createRequire(import.meta.url)
    this.napi = req(nodePath) as NapiBridge
  }

  async initAppSession(_appSessionId: string): Promise<void> {
    // Extension init() is called once at .node load time by the NAPI bridge.
    // Nothing per-session is needed for stateless C++ tools.
  }

  async destroyAppSession(_appSessionId: string): Promise<void> {
    // No per-session state to clean up.
  }

  async createObject(
    _appSessionId: string,
    _entry: AppEntry,
  ): Promise<IToolkit> {
    return new PolybindToolkit(this.napi)
  }
}
