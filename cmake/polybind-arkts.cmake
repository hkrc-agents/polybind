# polybind-arkts.cmake
#
# CMake fragment for building a polybind extension as a HarmonyOS .so (NAPI module).
# Produces libXXX.so loadable via ArkTS: `import XXX from 'libXXX.so'`
#
# Required variables (same as polybind-node.cmake):
#   POLYBIND_TOOL_SOURCES
#   POLYBIND_NAPI_BRIDGE
#   POLYBIND_INCLUDE_DIR
#   POLYBIND_MODULE_NAME      ← must match the 'XXX' in `import XXX from 'libXXX.so'`
#
# Required environment / toolchain:
#   OHOS_SDK_NATIVE           - HarmonyOS SDK native path, e.g.
#                               /path/to/DevEco/sdk/default/openharmony/native
#                               Set via the HarmonyOS CMake toolchain file, or manually.
#
# Usage:
#   set(POLYBIND_ROOT /path/to/polybind)
#   set(POLYBIND_INCLUDE_DIR ${POLYBIND_ROOT}/include)
#   set(POLYBIND_NAPI_BRIDGE  ${POLYBIND_ROOT}/src/napi_bridge.cpp)
#   set(POLYBIND_MODULE_NAME  my_tools)
#   set(POLYBIND_TOOL_SOURCES src/my_tool.cpp src/my_extension.cpp)
#   include(${POLYBIND_ROOT}/cmake/polybind-arkts.cmake)
#   # → target: ${PROJECT_NAME}  → lib${PROJECT_NAME}.so

cmake_minimum_required(VERSION 3.14)

# ── Resolve HarmonyOS NAPI headers ────────────────────────────────────────────
if(NOT DEFINED OHOS_SDK_NATIVE OR OHOS_SDK_NATIVE STREQUAL "")
  # Try to detect from environment
  if(DEFINED ENV{OHOS_SDK_NATIVE})
    set(OHOS_SDK_NATIVE "$ENV{OHOS_SDK_NATIVE}")
  else()
    # Auto-detect: look for DevEco Studio SDK in common WSL/Linux locations
    foreach(_candidate
      "/mnt/d/harmonyos/DevEco Studio/sdk/default/openharmony/native"
      "/mnt/c/Users/$ENV{USER}/AppData/Local/Huawei/Sdk/openharmony/native"
      "$ENV{HOME}/harmonyos/native"
    )
      if(EXISTS "${_candidate}/sysroot/usr/include/napi/native_api.h")
        set(OHOS_SDK_NATIVE "${_candidate}")
        message(STATUS "polybind-arkts: auto-detected OHOS_SDK_NATIVE at ${OHOS_SDK_NATIVE}")
        break()
      endif()
    endforeach()
  endif()
  if(NOT DEFINED OHOS_SDK_NATIVE OR OHOS_SDK_NATIVE STREQUAL "")
    message(WARNING "polybind-arkts: OHOS_SDK_NATIVE not set. "
      "Set it to your HarmonyOS SDK native directory, e.g.: "
      "cmake -DOHOS_SDK_NATIVE=/path/to/sdk/native ...")
  endif()
endif()

# ── Auto-detect OHOS cross-compiler ───────────────────────────────────────────
if(NOT DEFINED CMAKE_C_COMPILER OR CMAKE_C_COMPILER STREQUAL "")
  set(_OHOS_LLVM_BIN "${OHOS_SDK_NATIVE}/llvm/bin")
  if(EXISTS "${_OHOS_LLVM_BIN}/aarch64-unknown-linux-ohos-clang")
    set(CMAKE_C_COMPILER   "${_OHOS_LLVM_BIN}/aarch64-unknown-linux-ohos-clang"   CACHE STRING "" FORCE)
    set(CMAKE_CXX_COMPILER "${_OHOS_LLVM_BIN}/aarch64-unknown-linux-ohos-clang++" CACHE STRING "" FORCE)
    message(STATUS "polybind-arkts: using OHOS cross-compiler: ${CMAKE_CXX_COMPILER}")
  else()
    message(STATUS "polybind-arkts: OHOS clang++ not found at ${_OHOS_LLVM_BIN}, using system compiler")
  endif()
endif()

set(_OHOS_NAPI_INCLUDE "${OHOS_SDK_NATIVE}/sysroot/usr/include")
message(STATUS "polybind-arkts: HarmonyOS NAPI headers at ${_OHOS_NAPI_INCLUDE}")

# ── C++ standard ──────────────────────────────────────────────────────────────
# OHOS libc++ requires C++17 for std::filesystem (otherwise it's in std::__fs::filesystem)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Build target ──────────────────────────────────────────────────────────────

set(_TARGET "${PROJECT_NAME}")

add_library(${_TARGET} SHARED
  ${POLYBIND_TOOL_SOURCES}
  ${POLYBIND_NAPI_BRIDGE}
)

target_compile_definitions(${_TARGET} PRIVATE
  POLYBIND_MODULE_NAME=${POLYBIND_MODULE_NAME}
  NAPI_PLATFORM_ARKTS=1    # triggers #include <napi/native_api.h> in napi_bridge.cpp
)

target_include_directories(${_TARGET} PRIVATE
  ${POLYBIND_INCLUDE_DIR}
  ${POLYBIND_INCLUDE_DIR}/vendor
  ${_OHOS_NAPI_INCLUDE}
)

# HarmonyOS NAPI library — resolved at device runtime but must be declared for linking
target_link_libraries(${_TARGET} PUBLIC libace_napi.z.so)

message(STATUS "polybind-arkts: target '${_TARGET}' → lib${_TARGET}.so")
