#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/.deps"
mkdir -p "$DEPS"

if [ ! -d "$DEPS/whisper.cpp" ]; then git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$DEPS/whisper.cpp"; fi
cmake -S "$DEPS/whisper.cpp" -B "$DEPS/whisper.cpp/build" -DWHISPER_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$DEPS/whisper.cpp/build" -j

if [ ! -d "$DEPS/llama.cpp" ]; then git clone --depth 1 https://github.com/ggml-org/llama.cpp "$DEPS/llama.cpp"; fi
cmake -S "$DEPS/llama.cpp" -B "$DEPS/llama.cpp/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$DEPS/llama.cpp/build" -j

echo "Native engines built under $DEPS. Download model files separately and keep them outside git."
