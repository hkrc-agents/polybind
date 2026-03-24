/**
 * polybind/src/napi_bridge.cpp
 *
 * Universal NAPI bridge — compiles unchanged for both HarmonyOS and Node.js.
 * The only platform difference is in CMake configuration (include paths and
 * link libraries), not in this source file.
 *
 * Exposes two functions to the JS/ArkTS side:
 *   listTools()                     → JSON string: [{name, description, inputSchema}, ...]
 *   callTool(name, argsJson)        → JSON string: {content, error?}
 *
 * The NAPI module name is injected at compile time via:
 *   -DPOLYBIND_MODULE_NAME=<name>
 * This name must match the ArkTS static import: import X from 'libX.so'
 *
 * Platform headers:
 *   HarmonyOS: <napi/native_api.h>  (via ${OHOS_SDK_NATIVE}/sysroot/usr/include)
 *   Node.js:   <node_api.h>         (via node-api-headers)
 * Both headers expose the same napi_* API.
 */

// Include the correct header based on platform
#if defined(NAPI_PLATFORM_ARKTS)
#  include <napi/native_api.h>
#else
#  include <node_api.h>
#endif

#include "polybind/tool.h"

#include <string>
#include <cstring>
#include <cstddef>

// ── Module-level singleton ────────────────────────────────────────────────────

static PolyExtension* g_ext = nullptr;

// ── JSON helpers ──────────────────────────────────────────────────────────────

/**
 * JSON-escape a C string and wrap it in double quotes.
 * Handles: \, ", \n, \r, \t, and other control characters.
 */
static std::string jsonEscape(const char* s) {
  std::string r;
  r.reserve(strlen(s) + 2);
  r += '"';
  for (; *s; ++s) {
    switch (*s) {
      case '"':  r += "\\\""; break;
      case '\\': r += "\\\\"; break;
      case '\n': r += "\\n";  break;
      case '\r': r += "\\r";  break;
      case '\t': r += "\\t";  break;
      default:
        if ((unsigned char)*s < 0x20) {
          // control character — emit \uXXXX
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)*s);
          r += buf;
        } else {
          r += *s;
        }
        break;
    }
  }
  r += '"';
  return r;
}

// ── NAPI string extraction helper ─────────────────────────────────────────────

static std::string napiGetString(napi_env env, napi_value val) {
  size_t len = 0;
  napi_get_value_string_utf8(env, val, nullptr, 0, &len);
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, val, &s[0], len + 1, &len);
  return s;
}

// ── listTools ─────────────────────────────────────────────────────────────────
//
// Returns a JSON string:
//   [{"name":"...","description":"...","inputSchema":{...}}, ...]
//
// inputSchema is already a JSON string in PolyTool.input_schema_json,
// so it is embedded verbatim (not re-escaped).

static napi_value ListTools(napi_env env, napi_callback_info /*info*/) {
  std::string json;
  json.reserve(512);
  json += '[';

  for (int i = 0; i < g_ext->tool_count; ++i) {
    if (i > 0) json += ',';
    const PolyTool& t = g_ext->tools[i];
    json += "{\"name\":";
    json += jsonEscape(t.name);
    json += ",\"description\":";
    json += jsonEscape(t.description);
    json += ",\"inputSchema\":";
    json += t.input_schema_json;   // already valid JSON
    json += '}';
  }

  json += ']';

  napi_value result;
  napi_create_string_utf8(env, json.c_str(), json.size(), &result);
  return result;
}

// ── callTool ──────────────────────────────────────────────────────────────────
//
// JS signature: callTool(name: string, argsJson: string): string
// Returns a JSON string: {"content":<json-value>} or {"content":null,"error":"..."}

static napi_value CallTool(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 2) {
    napi_throw_error(env, nullptr, "callTool requires 2 arguments: name, argsJson");
    return nullptr;
  }

  std::string name = napiGetString(env, argv[0]);
  std::string argsJson = napiGetString(env, argv[1]);

  PolyResult res = g_ext->call_tool(name.c_str(), argsJson.c_str());

  std::string out;
  out.reserve(128);
  if (res.error != nullptr) {
    out += "{\"content\":null,\"error\":";
    out += jsonEscape(res.error);
    out += '}';
  } else {
    out += "{\"content\":";
    out += (res.content_json != nullptr ? res.content_json : "null");
    out += '}';
  }

  if (g_ext->free_result != nullptr) {
    g_ext->free_result(res);
  }

  napi_value result;
  napi_create_string_utf8(env, out.c_str(), out.size(), &result);
  return result;
}

// ── Module init ───────────────────────────────────────────────────────────────

static napi_value ModuleInit(napi_env env, napi_value exports) {
  g_ext = polymath_get_extension();
  if (g_ext == nullptr) {
    napi_throw_error(env, nullptr, "polymath_get_extension() returned NULL");
    return exports;
  }

  if (g_ext->init != nullptr) {
    g_ext->init();
  }

  napi_property_descriptor props[] = {
    {
      "listTools", nullptr, ListTools,
      nullptr, nullptr, nullptr, napi_default, nullptr
    },
    {
      "callTool", nullptr, CallTool,
      nullptr, nullptr, nullptr, napi_default, nullptr
    },
  };

  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

// POLYBIND_MODULE_NAME is injected at compile time via -DPOLYBIND_MODULE_NAME=<name>
// This macro call must use a token, not a string literal.
NAPI_MODULE(POLYBIND_MODULE_NAME, ModuleInit)
