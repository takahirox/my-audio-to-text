# Model assets and weight-free packaging (#323)

Every model uses **Not downloaded → Downloading → Ready (cached and verified)**
with recoverable Error/retry, progress, cancellation, cache inspection and deletion.
Opening Models checks only; installation and background startup never download
models. Auto Save persists the graph before preparing its required assets,
including parked processors under the existing policy. Opening a graph only
inspects files. Live's owning Workers verify executable dependencies before Start;
no inference path downloads missing weights or uploads audio/text.

| Node / role | Required independently cached entries |
| --- | --- |
| ReazonSpeech ja-en | ReazonSpeech epoch-35 int8 (77,101,541 bytes), Silero VAD (643,854 bytes) |
| Whisper tiny | Whisper multilingual q8 (43,615,928 bytes), the same Silero VAD |
| Zipformer English | Epoch-99 int8 transducer and tokens (45,202,074 bytes); no Silero |
| Kokoro Japanese | Kokoro weights/selected voice plus OpenJTalk HTS frontend voice (862,503 bytes) |
| Kokoro English | Kokoro weights/selected voice; no Japanese frontend voice |
| Other processors | Existing direction/model/voice-specific pinned manifests; no new dependencies |
| Model-free graph | None |

The separate ASR/VAD Workers retain their previous recognition configurations,
segmentation, provisional/final events, Stop/drain, cancellation and session
isolation. ReazonSpeech/VAD/Zipformer load only their verified cached bytes into
private Emscripten MEMFS; no `.data` image is fetched. Whisper uses a cache-only
Transformers custom cache at the same immutable model revision. Native inference
keeps its own model memory. The Playground's explicit Load/Generate action uses
the same verification on its own origin and can prepare missing assets there.

Web Locks serialize preparation/deletion by asset identity across tabs. Runtime
Workers also retain shared per-file leases through warm idle, so deletion of a
shared voice/model cannot race startup or lazy runtime reads. Delete acquires all
exclusive file leases before modifying storage and reports “in use” if any are
owned. Close the Live tab or release/cancel its session, then retry. Independent
Silero and ASR entries have disjoint files; deleting one never deletes the other.
TTS voices reuse canonical shared weight URLs; deletion explains that other
cached voices can require preparation again. Eviction cannot be prevented, but
missing/corrupt bytes never count as Ready. Prepared caches work offline; a fresh
offline profile receives missing-asset guidance. Model-free graphs remain usable.

## Package audit

`scripts/build-extension.py` copies only the paths and SHA-256 hashes in
`scripts/extension-runtime-assets.json`, source modules, manifests and notices.
It does not copy vendor or TTS directories wholesale. It rejects model file
extensions and automatic preload invocations in the completed artifact and writes
`dist/chrome-extension/asset-inventory.json` with every path, size, SHA-256 and
`modelWeights: 0`. Stale developer models in generated directories are excluded.
The synthetic `cache-demo` files are test-only and excluded too.

The audit covers ReazonSpeech, Silero, Whisper, Zipformer, optional ASR, both
translation directions, TranslateGemma, classifier/summary families and all TTS
runtimes. The OpenJTalk HTS voice was a hidden statistical model and is now cached
only for Japanese Kokoro. The dictionary, eSpeak rule tables and matching GPL
source archive are linguistic/code resources, not learned weights; these remain
pinned and packaged, along with all required notices. WASM runtime identity is
preserved, with pretrained tensors located outside the engines.

The 6.9 MB `scripts/sherpa-runtime.tar.gz` contains exactly seven JS/WASM files
for the existing sherpa 1.13.2 ASR/VAD and online runtimes, with **no preload data**.
The helper `sherpa-runtime.py` verifies its SHA-256 and exact member inventory
before staging, without network or model caches. `review-sherpa-runtime.py`
reproduces the package deterministically from the original checksum-pinned
upstream release archives; it is a maintainer tool, never part of setup/build.
TTS preparation fetches the OpenJTalk runtime/dictionary individually, avoiding
the npm archive's voice. Other runtime downloads retain existing source pins.

ASR model identities and original full SHA-256 pins remain under `scripts/`.
`review-local-asr-assets.py` explicitly downloads and checks those full hashes
before reproducing the committed streaming 1 MiB hash manifests. Silero is the
same `9e2449…bb1fd6` binary used in the former preload, served from a commit-pinned CORS-enabled Hugging Face mirror (the upstream
GitHub release does not allow browser CORS) and always hash-verified. Its canonical cache identity uses
the full digest. Runtime and model licenses remain under `web/licenses/` and
`web/third-party-notices.txt`; model cards link them.

## Validation

```sh
npm run setup:extension                 # no model checkpoint downloads
npm test
npx playwright test --config playwright.extension.config.js tests/extension/model-cache.spec.js tests/extension/graph-models.spec.js tests/extension/local-asr-preparation.spec.js
# Explicit developer-only inputs for real offline inference:
python3 scripts/review-local-asr-assets.py
python3 scripts/prepare-reazon-ja-en-fixtures.py
LOCAL_ASR_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/local-asr-assets.spec.js
```

The new smokes exercise production inference Workers and pinned models, with
loopback serving only the verified download source and speech fixtures replacing
capture hardware. Network is disabled before inference. They cover absent and
corrupt assets, exact dependency downloads, repeat/Stop, expected output types,
shared active-use deletion protection and subsequent deletion after release.
The deterministic lifecycle suite additionally covers cancellation, interrupted
streams, quota errors, eviction, simultaneous tabs and preparation after Save.
