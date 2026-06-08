#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <vector>
#include <unistd.h>
#include "node.h"

extern "C" jint JNICALL
Java_io_qzz_christmas_inkoslocal_EmbeddedNodeService_startNodeWithArguments(
        JNIEnv *env,
        jobject,
        jobjectArray arguments) {
    jsize argument_count = env->GetArrayLength(arguments);
    int c_arguments_size = 0;

    const char *log_path = getenv("INKOS_NODE_LOG");
    if (log_path != nullptr && strlen(log_path) > 0) {
        FILE *log_file = fopen(log_path, "ab");
        if (log_file != nullptr) {
            dup2(fileno(log_file), STDOUT_FILENO);
            dup2(fileno(log_file), STDERR_FILENO);
            setvbuf(stdout, nullptr, _IOLBF, 0);
            setvbuf(stderr, nullptr, _IOLBF, 0);
            fprintf(stderr, "\n[inkos-node-runner] starting embedded Node\n");
            fflush(stderr);
        }
    }

    for (int i = 0; i < argument_count; i++) {
        auto argument = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *current_argument = env->GetStringUTFChars(argument, nullptr);
        c_arguments_size += strlen(current_argument) + 1;
        env->ReleaseStringUTFChars(argument, current_argument);
        env->DeleteLocalRef(argument);
    }

    char *args_buffer = static_cast<char *>(calloc(c_arguments_size, sizeof(char)));
    std::vector<char *> argv(argument_count + 1, nullptr);
    char *current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        auto argument = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *current_argument = env->GetStringUTFChars(argument, nullptr);
        strncpy(current_args_position, current_argument, strlen(current_argument));
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;
        env->ReleaseStringUTFChars(argument, current_argument);
        env->DeleteLocalRef(argument);
    }

    int node_result = node::Start(argument_count, argv.data());
    free(args_buffer);
    return jint(node_result);
}
