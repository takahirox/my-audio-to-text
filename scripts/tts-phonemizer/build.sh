#!/bin/sh
# Rebuild the English frontend from the source archive shipped beside it.
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
cd "$(dirname "$0")"
test "$(sha256sum espeak-ng.tar.gz | cut -d ' ' -f 1)" = e6b84b52a87b3ad72885331bd942b2adecd70c384fa4ecfbe10aae7d9afd5e21
if [ -e build ]; then
  echo 'Use a fresh directory so no objects or data from an earlier build are reused.' >&2
  exit 1
fi
mkdir -p build/native build/wasm
tar -xzf espeak-ng.tar.gz -C build/native --strip-components=1
tar -xzf espeak-ng.tar.gz -C build/wasm --strip-components=1
cd build/native
./autogen.sh
./configure --prefix=/usr --without-async --without-mbrola --without-sonic --without-pcaudiolib --disable-shared
make -j4 en
cd ../wasm
./autogen.sh
emconfigure ./configure --prefix=/usr --without-async --without-mbrola --without-sonic --without-pcaudiolib --disable-shared CFLAGS=-O3
emmake make -j4 src/libespeak-ng.la
cd emscripten
tts_emcc_dir=$(dirname "$(command -v emcc)")
python3 "$tts_emcc_dir/tools/webidl_binder.py" espeakng_glue.idl glue
# Kokoro consumes compact IPA, with spaces between words only. The upstream
# demo glue inserts spaces between every phoneme, which changes model tokens.
sed 's/phoneme_options | (phonemes_separator << 8)/phoneme_options/' \
  espeakng_glue.cpp > espeakng_glue_module.cpp
# The production Node already owns the Worker/message handler. Keep only the
# upstream methods, without installing the legacy standalone Worker protocol.
sed '/^\/\/ Make this a worker/,$d' post.js > post-module.js
em++ -O3 -I. -I.. -I../src/include/espeak-ng espeakng_glue_module.cpp \
  ../src/.libs/libespeak-ng.a --pre-js pre.js --post-js glue.js \
  --post-js post-module.js \
  --embed-file ../../native/espeak-ng-data@/usr/share/espeak-ng-data \
  --exclude-file '*/mbrola_ph/*' --exclude-file '*/phondata-manifest' \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,worker,node \
  -s EXPORTED_RUNTIME_METHODS=FS --no-entry -o ../../../phonemizer-engine.mjs
