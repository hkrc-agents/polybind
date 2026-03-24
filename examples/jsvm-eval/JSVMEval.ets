// entry/src/main/ets/pages/JSVMEval.ets
//
// JSVMEval — stateless IToolkit / IExtension adapter over the JSVM C++ engine.
//
// Design (structure.md alignment):
//   • JS code uses top-level `await import('@ohos.*')` — async IIFE wrapper enables this
//   • C++ Proxy routes module calls through ArkTS dispatch bridge
//   • All async state (IO, settlement detection) lives in C++
//   • ArkTS is a thin dispatch bridge: IO completion, module loading
//   • One module-level variable only (jsvmReady); all execution state in C++
//
// Usage:
//   const ev = new JSVMEval();
//   const args = new RunJsArgs();
//   args.code = `
//     const info = await import('@ohos.deviceInfo')
//     console.log(info.deviceType())
//   `;
//   const r = await ev.callTool('js_eval', args);  // r.content === "phone"
//
//   // With hub tools:
//   args.toolList = { MathTool: 'builtin_math' };
//   args.code = `
//     const sum = await MathTool.add(3, 7)
//     console.log(sum)
//   `;
//   const r2 = await ev.callTool('js_eval', args);  // r2.content === "10"
//
// Async execution model (push model):
//   callTool() wraps user code in an async IIFE, then calls
//   C++ jsvmExecutorRunFull(script, allowImport, onComplete).
//   C++ calls onComplete(result) when the execution fully settles.
//
//   Async I/O dispatch:
//     JS __jsvmAsyncDispatch(str) → C++ calls dispatcher "__JSVM_IO_DISPATCH__|opId|str"
//     ArkTS processes asynchronously → calls libentry.jsvmResolveIO(opId, result)
//     C++ resolves JSVM Promise, checks settlement, calls onComplete if done.

import libentry from 'libentry.so';
import hilog from '@ohos.hilog';
import type { IExtension, IToolkit, AppEntry, ToolDefinition, ToolResponse, ToolProgress } from '@polymath/types'

const TAG = 'JSVMEval';

// ─── Schema types for ToolDefinition.parameters ──────────────────────────────

/** Single property entry in the JSON Schema for a tool parameter. */
export class PropDef {
  type: string = '';
  description: string = '';
  /** Non-empty when type === 'array'; describes the item element type. */
  items_type: string = '';
}

/** JSON Schema–style parameters block for a ToolDefinition. */
export class ToolParameters {
  type: string = 'object';
  properties: Record<string, PropDef> = {};
  required: string[] = [];
}

// ─── Args type for callTool('js_eval', …) ────────────────────────────────────

/**
 * Typed arguments for callTool('js_eval', args).
 */
export class RunJsArgs {
  /** JavaScript source code to execute. Supports top-level await. Required. */
  code: string = '';
  /**
   * Available tools: key = tool name, value = object_id.
   * js_eval injects each as a Proxy global: var ToolName = __createToolProxy(name, id).
   * Tool methods return Promises; use await or .then() to receive results.
   * Tools are lazily loaded on first call — unused tools are never imported.
   */
  toolList: Record<string, string> = {};
  /** Allow import() statements. Default: true. */
  allowImport: boolean = true;
  /** App session identifier, passed through to logging and future session routing. */
  appSessionId: string = '';
}

// ─── Module-level state ───────────────────────────────────────────────────────
// One variable only — all async execution state lives in C++.

let jsvmReady = false;

// ─── Init (idempotent) ────────────────────────────────────────────────────────

function ensureInit(): void {
  if (jsvmReady) return;
  const ok: boolean = libentry.initJSVM();
  if (!ok) {
    hilog.error(0x0000, TAG, 'initJSVM failed');
    return;
  }
  const dispOk: boolean = libentry.jsvmExecutorRegisterDispatcher(
    (callStr: string): string => dispatch(callStr)
  );
  jsvmReady = dispOk;
  hilog.info(0x0000, TAG, 'ensureInit: vm=%{public}s dispatcher=%{public}s',
    ok ? 'OK' : 'FAILED', dispOk ? 'OK' : 'FAILED');
}

// ─── Tool definition ──────────────────────────────────────────────────────────

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

function makeJsEvalToolDef(): ToolDefinition {
  const codeProp = new PropDef();
  codeProp.type = 'string';
  codeProp.description =
    'JavaScript source code to execute. ' +
    'Supports top-level await and import()/@ohos.*/@kit.* module access. ' +
    'Output via console.log — all console output is captured and returned as result.';

  const allowProp = new PropDef();
  allowProp.type = 'boolean';
  allowProp.description =
    'Allow import() statements (default: true). Set false to block all dynamic imports.';

  const toolListProp = new PropDef();
  toolListProp.type = 'object';
  toolListProp.description =
    'Available tools: {toolName: objectId}. Each tool is injected as an async Proxy global. ' +
    'Use await ToolName.method(args) in JS code. Unused tools are never loaded.';

  const sessionProp = new PropDef();
  sessionProp.type = 'string';
  sessionProp.description = 'App session identifier for routing and logging.';

  const params = new ToolParameters();
  params.properties['code'] = codeProp;
  params.properties['allowImport'] = allowProp;
  params.properties['toolList'] = toolListProp;
  params.properties['appSessionId'] = sessionProp;
  params.required = ['code'];

  const def: ToolDefinition = {
    name: 'js_eval',
    description:
      'Execute JavaScript in the JSVM engine with transparent access to @ohos.*/@kit.* system APIs.\n' +
      'Supports top-level await — no async wrapper needed.\n' +
      '\n' +
      'Example (system module):\n' +
      '  const info = await import(\'@ohos.deviceInfo\')\n' +
      '  console.log(info.deviceType())\n' +
      '\n' +
      'Example (hub tool, pass toolList: {MathTool: "id"}):\n' +
      '  const result = await MathTool.add(3, 7)\n' +
      '  console.log(result)',
    inputSchema: __polybindBuildInputSchema(params)
  };
  return def;
}

const JS_EVAL_TOOL_DEF: ToolDefinition = makeJsEvalToolDef();

// ─── Dispatch — unified C++ → ArkTS message handler ─────────────────────────
//
// Called from C++ for ALL message types:
//  • "__JSVM_MODULE_PREFETCH__|specifier" → start background module load
//  • "__JSVM_IO_DISPATCH__|opId|..."      → launch async I/O

function dispatch(callStr: string): string {
  // ── Module prefetch ──────────────────────────────────────────────────────
  if (callStr.startsWith('__JSVM_MODULE_PREFETCH__|')) {
    const specifier = callStr.substring('__JSVM_MODULE_PREFETCH__|'.length);
    prefetchModuleAsync(specifier);
    return '';
  }

  // ── Async I/O dispatch ───────────────────────────────────────────────────
  if (callStr.startsWith('__JSVM_IO_DISPATCH__|')) {
    const p1 = callStr.indexOf('|');
    const p2 = callStr.indexOf('|', p1 + 1);
    const opId  = parseInt(callStr.substring(p1 + 1, p2));
    const ioStr = callStr.substring(p2 + 1);
    launchAsyncIO(opId, ioStr);
    return '';
  }

  return '"ERROR:unknown_dispatch:' + callStr.substring(0, 40) + '"';
}

// ─── Async I/O helpers ────────────────────────────────────────────────────────

function launchAsyncIO(opId: number, callStr: string): void {
  doAsyncIO(opId, callStr)
    .then((): void => {})
    .catch((_e: Error): void => {
      libentry.jsvmResolveIO(opId, 'ERROR:async_io_internal_failure');
    });
}

/**
 * Route an async I/O request to the appropriate handler.
 * callStr format: "MODULE|moduleName|method|argsJson"
 * After resolving, C++ jsvmResolveIO checks settlement and calls onComplete if done.
 */
async function doAsyncIO(opId: number, callStr: string): Promise<void> {
  const sep1 = callStr.indexOf('|');
  const category = sep1 >= 0 ? callStr.substring(0, sep1) : callStr;
  const rest     = sep1 >= 0 ? callStr.substring(sep1 + 1) : '';

  try {
    let result = '';

    if (category === 'MODULE') {
      const sep2 = rest.indexOf('|');
      const sep3 = rest.indexOf('|', sep2 + 1);
      const moduleName = sep2 >= 0 ? rest.substring(0, sep2) : rest;
      const method     = (sep2 >= 0 && sep3 >= 0) ? rest.substring(sep2 + 1, sep3) : '';
      const argsJson   = sep3 >= 0 ? rest.substring(sep3 + 1) : '[]';

      result = await callDynamicModule(moduleName, method, argsJson);
    } else if (category === 'TOOL') {
      // format: TOOL|toolName|objectId|method|argsJson
      const sep2 = rest.indexOf('|');
      const sep3 = rest.indexOf('|', sep2 + 1);
      const sep4 = rest.indexOf('|', sep3 + 1);
      const toolName = sep2 >= 0 ? rest.substring(0, sep2) : rest;
      const objectId = (sep2 >= 0 && sep3 >= 0) ? rest.substring(sep2 + 1, sep3) : '';
      const method   = (sep3 >= 0 && sep4 >= 0) ? rest.substring(sep3 + 1, sep4) : '';
      const argsJson = sep4 >= 0 ? rest.substring(sep4 + 1) : '[]';

      result = await callToolMethod(toolName, objectId, method, argsJson);
    } else {
      result = 'ERROR:unknown_io_category:' + category;
    }

    libentry.jsvmResolveIO(opId, result);
  } catch (e) {
    libentry.jsvmResolveIO(opId, 'ERROR:' + (e as Error).message);
  }
}

// ─── Dynamic module loading ───────────────────────────────────────────────────

function prefetchModuleAsync(specifier: string): void {
  loadDynModule(specifier)
    .then((): void => {
      hilog.info(0x0000, TAG, 'prefetch done: %{public}s', specifier);
    })
    .catch((_e: Error): void => {
      hilog.info(0x0000, TAG, 'prefetch skipped (not loadable): %{public}s', specifier);
    });
}

async function loadDynModule(specifier: string): Promise<Object> {
  // ArkTS import() is cached internally by the runtime — no explicit cache needed.
  return await import(specifier) as Object;
}

async function callDynamicModule(
  specifier: string,
  method: string,
  argsJson: string
): Promise<string> {
  try {
    const mod   = await loadDynModule(specifier);
    const expts = mod as Record<string, Object>;
    let target = expts[method];

    // Fallback to default export (@ohos.* modules often use module.exports.default)
    if ((target === undefined || target === null) && expts['default'] !== undefined) {
      const def = expts['default'] as Record<string, Object>;
      if (def !== null && typeof def === 'object') {
        target = def[method];
      }
    }

    if (target === undefined || target === null) {
      return 'ERROR:no_export:' + method + '@' + specifier;
    }

    if (typeof target !== 'function') {
      const s = JSON.stringify(target);
      return (typeof s === 'string') ? s : 'null';
    }

    const parsedArgs: Object[] = JSON.parse(argsJson) as Object[];
    let raw: Object;
    switch (parsedArgs.length) {
      case 0:  raw = (target as () => Object)(); break;
      case 1:  raw = (target as (a: Object) => Object)(parsedArgs[0]); break;
      case 2:  raw = (target as (a: Object, b: Object) => Object)
                       (parsedArgs[0], parsedArgs[1]); break;
      case 3:  raw = (target as (a: Object, b: Object, c: Object) => Object)
                       (parsedArgs[0], parsedArgs[1], parsedArgs[2]); break;
      default: raw = (target as (a: Object, b: Object, c: Object, d: Object) => Object)
                       (parsedArgs[0], parsedArgs[1], parsedArgs[2], parsedArgs[3]);
    }

    const rawRec = raw as Record<string, Object>;
    const resolved: Object =
      (rawRec !== null && typeof rawRec['then'] === 'function')
        ? await (raw as Promise<Object>)
        : raw;

    const serialised = JSON.stringify(resolved);
    return (typeof serialised === 'string') ? serialised : 'null';
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    hilog.warn(0x0000, TAG, 'callDynamicModule %{public}s.%{public}s: %{public}s',
      specifier, method, msg);
    return 'ERROR:dyn:' + msg;
  }
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────
//
// Lazy-loaded cache: populated on first call to each tool.
// In a polymath hub this would be replaced by a per-session IToolkit registry.

const toolMethodCache: Map<string, Record<string, (a: string) => string>> = new Map();

/**
 * Lazy-load and call an ArkTS hub tool method.
 * toolName: e.g. 'MathTool'  → loads './tools/MathTool' and calls getMathToolMethods()
 * _objectId: reserved for future per-instance IToolkit routing
 * argsJson: JSON array string, e.g. '[3,7]'
 */
async function callToolMethod(
  toolName: string, _objectId: string, method: string, argsJson: string
): Promise<string> {
  if (!toolMethodCache.has(toolName)) {
    try {
      const mod = await loadDynModule('./tools/' + toolName) as Record<string, Object>;
      const getterName = 'get' + toolName + 'Methods';
      const getter = mod[getterName];
      if (typeof getter === 'function') {
        toolMethodCache.set(toolName,
          (getter as () => Record<string, (a: string) => string>)());
      }
    } catch (_e) { /* tool file not found; fall through to ERROR below */ }
  }
  const methods = toolMethodCache.get(toolName);
  if (!methods) return 'ERROR:tool_not_found:' + toolName;
  const fn = methods[method];
  if (typeof fn !== 'function') return 'ERROR:no_method:' + method + '@' + toolName;
  return fn(argsJson);
}

// ─── Script wrapper ───────────────────────────────────────────────────────────

// Console capture polyfill: redirects console.log/warn/error to globalThis.__logs[].
const CONSOLE_POLYFILL =
  'globalThis.__logs=[];\n' +
  'var console={\n' +
  'log:function(){var a=Array.prototype.slice.call(arguments);' +
    'globalThis.__logs.push(a.map(function(x){' +
    'return typeof x===\'object\'&&x!==null?JSON.stringify(x):String(x);}).join(\' \'));},\n' +
  'warn:function(){var a=Array.prototype.slice.call(arguments);' +
    'globalThis.__logs.push(\'[WARN] \'+a.map(function(x){' +
    'return typeof x===\'object\'&&x!==null?JSON.stringify(x):String(x);}).join(\' \'));},\n' +
  'error:function(){var a=Array.prototype.slice.call(arguments);' +
    'globalThis.__logs.push(\'[ERROR] \'+a.map(function(x){' +
    'return typeof x===\'object\'&&x!==null?JSON.stringify(x):String(x);}).join(\' \'));}};\n';

/**
 * Build a JS preamble that assigns each tool in toolList as a Proxy global.
 * e.g. toolList = {MathTool: 'id1'} → "var MathTool = __createToolProxy('MathTool','id1');\n"
 */
function buildToolPreamble(toolList: Record<string, string>): string {
  const names = Object.keys(toolList);
  let p = '';
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    p += 'var ' + name + ' = __createToolProxy(' +
         JSON.stringify(name) + ',' + JSON.stringify(toolList[name]) + ');\n';
  }
  return p;
}

/**
 * Wrap user code in an async IIFE so top-level `await` is valid.
 * Injects CONSOLE_POLYFILL and tool Proxy preamble before user code.
 * console.log/warn/error output is captured; result is __logs.join('\n').
 */
function wrapScript(code: string, toolList: Record<string, string>): string {
  const body = CONSOLE_POLYFILL + buildToolPreamble(toolList) + code + '\nreturn \'__JSVM_CONSOLE_MODE__\';';
  return '(async function(){\ntry{\n' + body + '\n}catch(__e){return \'ERROR:\'+String(__e);}\n})()';
}

// ─── JSVMEval — zero-state IToolkit ──────────────────────────────────────────

/**
 * JSVMEval implements IToolkit as a stateless adapter over the JSVM C++ engine.
 *
 * Exposes a single "js_eval" tool that executes JavaScript with transparent
 * access to any @ohos.X/@kit.X module via async IIFE + Proxy bridge.
 *
 * No instance or static state — all execution state is in C++.
 */
export class JSVMEval implements IToolkit {
  constructor() {
    ensureInit();
  }

  get isReady(): boolean {
    return jsvmReady;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [JS_EVAL_TOOL_DEF];
  }


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

  private async _callImpl(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
    const typedArgs = args as unknown as RunJsArgs
    hilog.info(0x0000, TAG, 'callTool: %{public}s', name);

    if (name !== 'js_eval') {
      const msg = 'Unknown tool: "' + name + '". Supported: js_eval';
      hilog.warn(0x0000, TAG, '%{public}s', msg);
      return { type: 'response', content: '', error: msg };
    }

    if (!args.code) {
      return { type: 'response', content: '', error: '"code" must not be empty' };
    }

    hilog.info(0x0000, TAG,
      'js_eval: session=%{public}s tools=%{public}d allowImport=%{public}s',
      args.appSessionId || '(none)',
      Object.keys(args.toolList).length,
      args.allowImport ? 'true' : 'false');

    const script = wrapScript(args.code, args.toolList);

    const result = await new Promise<string>((resolve: (v: string) => void): void => {
      libentry.jsvmExecutorRunFull(script, args.allowImport, (r: string): void => {
        resolve(r);
      });
    });

    hilog.info(0x0000, TAG, 'result (first 80): %{public}s', result.substring(0, 80));

    if (result.startsWith('ERROR:')) {
      return { type: 'response', content: result, error: result };
    }
    return { type: 'response', content: result };
  }
}

// ─── JSVMEvalExtension — IExtension wrapper ───────────────────────────────────

/**
 * Polymath IExtension entry point for JSVMEval.
 * The hub calls initAppSession() once per session, then createObject() per
 * app.yaml entry to create isolated IToolkit instances.
 */
export class JSVMEvalExtension implements IExtension {
  async initAppSession(_appSessionId: string): Promise<void> {
    ensureInit();
  }

  async createObject(_appSessionId: string, _entry: AppEntry): Promise<IToolkit> {
    return new JSVMEval();
  }
}
