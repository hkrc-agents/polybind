/**
 * polybind/tool.h — The C interface all polybind tools must implement.
 *
 * Every .so/.node that polybind manages must export a symbol:
 *   PolyExtension* polymath_get_extension(void);
 *
 * polybind's NAPI bridge (src/napi_bridge.cpp) links against the tool's .o files
 * and calls this function at module init time to obtain the extension descriptor.
 */

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Describes a single tool exposed by this extension.
 * All pointers must remain valid for the lifetime of the process.
 */
typedef struct {
  const char* name;              /**< Tool name, e.g. "add" */
  const char* description;       /**< Human-readable description */
  const char* input_schema_json; /**< JSON Schema string for tool arguments */
} PolyTool;

/**
 * Result of a tool call.
 * content_json and error must remain valid until free_result is called (or
 * forever, if free_result is NULL — meaning they point to static storage).
 */
typedef struct {
  const char* content_json; /**< JSON-encoded result value. NULL on error. */
  const char* error;        /**< Error message string. NULL on success. */
} PolyResult;

/**
 * Extension descriptor. Statically allocated; must live for the process lifetime.
 */
typedef struct {
  const char*      name;       /**< Unique extension name */
  const char*      version;    /**< Semver version string */
  int              tool_count; /**< Number of entries in tools[] */
  const PolyTool*  tools;      /**< Static array of tool_count descriptors */

  /**
   * Dispatch a tool call synchronously.
   * @param name      Tool name (matches a name in tools[])
   * @param args_json JSON-encoded arguments object
   * @return          PolyResult — caller must call free_result after use
   */
  PolyResult (*call_tool)(const char* name, const char* args_json);

  /**
   * Called once when the extension is first loaded. May be NULL.
   * Use for one-time initialisation (e.g. opening handles, seeding RNG).
   */
  void (*init)(void);

  /**
   * Called when the extension is unloaded. May be NULL.
   */
  void (*destroy)(void);

  /**
   * Free memory associated with a PolyResult returned by call_tool.
   * May be NULL if call_tool always returns pointers to static storage.
   */
  void (*free_result)(PolyResult result);
} PolyExtension;

/**
 * Every polybind .so/.node must export this function.
 * Returns a pointer to a statically allocated PolyExtension.
 */
PolyExtension* polymath_get_extension(void);

#ifdef __cplusplus
}
#endif
