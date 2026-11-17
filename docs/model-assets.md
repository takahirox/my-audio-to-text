# Model assets and weight-free packaging (#323)

Every model uses **Not downloaded → Downloading → Ready (cached and verified)**
with recoverable Error/retry, progress, cancellation, cache inspection and deletion.
Opening Models checks only; installation and background startup never download
models. Auto Save persists the graph before preparing its required assets,
including parked processors under the existing policy. Opening a graph in the
editor only inspects files. Opening Live automatically prepares missing or invalid
assets for executable paths, then its owning Workers verify and initialize the
runtimes before Start becomes available. Failures offer **Retry models** inside
Live. Inference workers read verified cache files without downloading weights;
audio/text stays local.

| Node / role | Independently cached assets |
| --- | --- |
| English ASR | Moonshine Medium Streaming English, 304,690,919 bytes |
| Japanese ASR | Moonshine Small Streaming Japanese, 121,803,780 bytes |
| Kokoro Japanese | Kokoro weights/selected voice plus OpenJTalk frontend voice (862,503 bytes) |
| Kokoro English | Kokoro weights/selected voice |
| Other processors | Existing direction/model/voice-specific pinned manifests |
| Model-free graph | None |

Web Locks serialize preparation/deletion by asset identity. Runtime Workers
retain shared per-file leases while warm, so deletion cannot race lazy reads.
Close or cancel consumers before deleting in-use files. Voices reuse canonical
shared weight URLs; deletion may require preparing another voice again.
Evicted or corrupt files never count as Ready.

## Package audit

`scripts/build-extension.py` copies only the paths and SHA-256 hashes in
`scripts/extension-runtime-assets.json`, source modules, manifests and notices.
It does not copy vendor or TTS directories wholesale. It rejects model file
extensions and automatic preload invocations in the completed artifact and writes
`dist/chrome-extension/asset-inventory.json` with every path, size, SHA-256 and
`modelWeights: 0`. Stale developer models in generated directories are excluded.
The synthetic `cache-demo` files are test-only and excluded too.

## Validation

The new smokes exercise production inference Workers and pinned models, with
loopback serving only the verified download source and speech fixtures replacing
capture hardware. Network is disabled before inference. They cover absent and
corrupt assets, exact dependency downloads, repeat/Stop, expected output types,
shared active-use deletion protection and subsequent deletion after release.
The deterministic lifecycle suite additionally covers cancellation, interrupted
streams, quota errors, eviction, simultaneous tabs and preparation after Save.


Speech recognition uses only language-specific [Moonshine streaming Nodes](optional-asr-nodes.md). The new default graph is Japanese Small; English examples select English Medium explicitly.
