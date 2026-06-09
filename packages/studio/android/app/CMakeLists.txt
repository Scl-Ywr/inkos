cmake_minimum_required(VERSION 3.22.1)

project(inkos_node_runner)

include_directories(libnode/include/node)

add_library(node_runner SHARED src/main/cpp/native-lib.cpp)

add_library(libnode SHARED IMPORTED)
set_target_properties(
    libnode
    PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI}/libnode.so
)

find_library(log-lib log)

target_link_libraries(node_runner libnode ${log-lib})
