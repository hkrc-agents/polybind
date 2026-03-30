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

# WSL2 + Windows clang++.exe: source files must be on a Windows-accessible drive
# (e.g. /mnt/d/... → D:/...). Resolve symlinks first, then convert via wslpath -m.
# Linux cmake validates the /mnt/... real path; clang++.exe receives the D:/... path.
if(CMAKE_CXX_COMPILER MATCHES "\\.exe$")
  set(_wsl_sources)
  foreach(_src IN LISTS POLYBIND_TOOL_SOURCES POLYBIND_NAPI_BRIDGE)
    if(_src STREQUAL "")
      continue()
    endif()
    # Resolve symlinks so wslpath sees the real /mnt/<drive>/... path
    file(REAL_PATH "${_src}" _real_src)
    execute_process(
      COMMAND wslpath -m "${_real_src}"
      OUTPUT_VARIABLE _wsrc
      OUTPUT_STRIP_TRAILING_WHITESPACE
      ERROR_QUIET
    )
    if(_wsrc)
      list(APPEND _wsl_sources "${_wsrc}")
    else()
      list(APPEND _wsl_sources "${_src}")
    endif()
  endforeach()
  set(_ALL_SOURCES ${_wsl_sources})
else()
  set(_ALL_SOURCES ${POLYBIND_TOOL_SOURCES} ${POLYBIND_NAPI_BRIDGE})
endif()

set(_TARGET "${PROJECT_NAME}")

# For WSL2 + Windows clang++.exe: Windows paths (D:/...) are not findable by Linux cmake,
# so mark them GENERATED to bypass the existence check. The Windows binary can still
# open D:/... paths at compile time.
add_library(${_TARGET} SHARED)
if(CMAKE_CXX_COMPILER MATCHES "\\.exe$")
  foreach(_wsrc IN LISTS _ALL_SOURCES)
    set_source_files_properties("${_wsrc}" PROPERTIES GENERATED TRUE)
    target_sources(${_TARGET} PRIVATE "${_wsrc}")
  endforeach()
else()
  target_sources(${_TARGET} PRIVATE ${_ALL_SOURCES})
endif()

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
