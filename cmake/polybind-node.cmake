# polybind-node.cmake
#
# CMake fragment for building a polybind extension as a Node.js native addon.
# Produces a .node file loadable via `require()` / `createRequire()`.
#
# Required variables (set by caller before including this file):
#   POLYBIND_TOOL_SOURCES   - List of tool .cpp source files
#   POLYBIND_NAPI_BRIDGE    - Path to polybind's napi_bridge.cpp
#   POLYBIND_INCLUDE_DIR    - Path to polybind's include/ directory (contains polybind/tool.h)
#   POLYBIND_MODULE_NAME    - NAPI module name (no spaces; used in NAPI_MODULE macro)
#                             The .node file will be: lib${PROJECT_NAME}_node.node
#                             or ${PROJECT_NAME}.node depending on PREFIX/SUFFIX settings.
#
# Usage:
#   set(POLYBIND_ROOT /path/to/polybind)
#   set(POLYBIND_INCLUDE_DIR ${POLYBIND_ROOT}/include)
#   set(POLYBIND_NAPI_BRIDGE  ${POLYBIND_ROOT}/src/napi_bridge.cpp)
#   set(POLYBIND_MODULE_NAME  my_tools)
#   set(POLYBIND_TOOL_SOURCES src/my_tool.cpp src/my_extension.cpp)
#   include(${POLYBIND_ROOT}/cmake/polybind-node.cmake)
#   # → target: ${PROJECT_NAME}_node  → ${PROJECT_NAME}_node.node

cmake_minimum_required(VERSION 3.14)

# ── Resolve Node.js NAPI headers via node-api-headers npm package ─────────────
# node-api-headers must be installed: npm install node-api-headers
execute_process(
  COMMAND node -p "require('node-api-headers').include_dir"
  OUTPUT_VARIABLE _POLYBIND_NODE_API_INCLUDE
  OUTPUT_STRIP_TRAILING_WHITESPACE
  ERROR_QUIET
)

if(NOT _POLYBIND_NODE_API_INCLUDE OR _POLYBIND_NODE_API_INCLUDE STREQUAL "")
  # Fallback: use node's own headers
  execute_process(
    COMMAND node -e "process.stdout.write(process.execPath)"
    OUTPUT_VARIABLE _NODE_EXEC OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  get_filename_component(_NODE_BIN_DIR "${_NODE_EXEC}" DIRECTORY)
  set(_POLYBIND_NODE_API_INCLUDE "${_NODE_BIN_DIR}/../include/node")
  # Verify node_api.h exists — if not, search nvm versions
  if(NOT EXISTS "${_POLYBIND_NODE_API_INCLUDE}/node_api.h")
    file(GLOB _NVM_NODE_INCLUDES
      "$ENV{HOME}/.nvm/versions/node/*/include/node"
    )
    foreach(_candidate IN LISTS _NVM_NODE_INCLUDES)
      if(EXISTS "${_candidate}/node_api.h")
        set(_POLYBIND_NODE_API_INCLUDE "${_candidate}")
        break()
      endif()
    endforeach()
  endif()
  message(STATUS "polybind-node: using fallback Node headers at ${_POLYBIND_NODE_API_INCLUDE}")
else()
  message(STATUS "polybind-node: Node API headers at ${_POLYBIND_NODE_API_INCLUDE}")
endif()

# ── Build target ──────────────────────────────────────────────────────────────

set(_TARGET "${PROJECT_NAME}_node")

add_library(${_TARGET} SHARED
  ${POLYBIND_TOOL_SOURCES}
  ${POLYBIND_NAPI_BRIDGE}
)

# .node extension, no lib prefix
set_target_properties(${_TARGET} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_compile_definitions(${_TARGET} PRIVATE
  POLYBIND_MODULE_NAME=${POLYBIND_MODULE_NAME}
  # Node.js platform: use <node_api.h>
  # (absence of NAPI_PLATFORM_ARKTS triggers the else branch in napi_bridge.cpp)
)

target_include_directories(${_TARGET} PRIVATE
  ${POLYBIND_INCLUDE_DIR}
  ${_POLYBIND_NODE_API_INCLUDE}
)

# Node.js: do NOT link libnode — NAPI symbols are resolved at runtime by the Node binary.
# On Windows you would link node.lib, but on Linux/macOS nothing is needed.

message(STATUS "polybind-node: target '${_TARGET}' → ${_TARGET}.node")
