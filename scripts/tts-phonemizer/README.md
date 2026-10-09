# Corresponding source for the Kokoro English frontend (#73)

This directory contains the adapter and build/installation scripts for our
source-built eSpeak NG frontend. The Pages staging script creates a downloadable
`tts-assets/phonemizer-source.tar.gz` containing these files **and** the complete
upstream source/data archive, beside the executable modules on the same origin.
The Kokoro page links directly to that download. No request, fee or external
source-host account is needed to obtain it.

The former phonemizer 1.2.1 binary had unknown engine provenance and is no longer
staged or distributed. This replacement is built from eSpeak NG commit
`0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582`:

https://github.com/espeak-ng/espeak-ng/tree/0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582

Full source archive (includes `COPYING`, notices, native engine, data,
dictionary/phoneme source, WebIDL glue and upstream build scripts):

https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582

SHA-256: `e6b84b52a87b3ad72885331bd942b2adecd70c384fa4ecfbe10aae7d9afd5e21`.

## Rebuild and install

Extract the downloadable bundle in an empty directory. It already contains
`espeak-ng.tar.gz`; do not substitute another revision. On an x86-64 or ARM
Docker host:

```sh
docker build --platform linux/amd64 -t tts-espeak-builder .
docker run --rm --platform linux/amd64 --network none \
  --mount "type=bind,source=$PWD,target=/src" tts-espeak-builder sh build.sh
sha256sum phonemizer-engine.mjs
cat ENGINE-SHA256.txt
```

The Dockerfile pins Emscripten SDK **3.1.30** by image digest (Ubuntu 22.04).
Autoconf/Automake/Libtool produce the configure scripts; compilation itself
has no network access. Compiler source and setup instructions:
https://github.com/emscripten-core/emscripten/tree/3.1.30 and
https://github.com/emscripten-core/emsdk.

`build.sh` first compiles the English data with the native engine, then builds
the same engine for WASM. Upstream WebIDL glue is retained; the legacy standalone
Worker message handler is removed because the production Kokoro Node owns its
Worker. The demo glue's per-phoneme separator is disabled so Kokoro receives
compact IPA with word spaces, matching its English tokenizer/frontend contract.
The generated ES module embeds the WASM and compiled English data.
`phonemizer.js` is our small English-only adapter. Both are GPL-3.0-or-later;
eSpeak NG's upstream copyright/license notices remain in the source archive
and the distributed `licenses/espeak-ng.txt`.

Install by copying `phonemizer.js` and `phonemizer-engine.mjs` together to the
served `tts-assets/` directory, alongside `phonemizer-source.tar.gz`. In this
repository the engine is checked in here, and `prepare-tts-assets.py` verifies
its checksum and stages all three files together. A rebuild changes that pin
only after reviewing source changes and rerunning Kokoro real-model checks.
