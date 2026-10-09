# Browser text-to-speech Nodes (Issue #73)

The [Supertonic 3 page](../web/nodes/supertonic3/index.html) and
[Kokoro 82M page](../web/nodes/kokoro/index.html) each run a separate production
Node, dedicated inference Worker and Pipeline graph. Models/frontends execute
locally in WASM with one thread. WebGPU and cross-origin isolation are not
required. Downloads begin only after Generate; there is no remote inference
service and no network request includes text. The original #73 implementation did not change ASR/translation or extension
packaging. Issue #75 adds [verified extension graph integration](extension-graph.md)
with explicit model preparation and cache-only TTS startup, using these same
production Nodes and reviewed browser runtimes/frontends.

## Verified artifacts and language support

Verified from upstream code, model cards and repository file metadata on
2026-10-09. [Exact model files/sizes/LFS hashes](tts-artifacts.json) are recorded
separately; [runtime archive hashes and file allowlists](../scripts/prepare-tts-assets.py)
pin every staged binary. MB below means decimal MB and excludes HTTP compression.
Real browser results are recorded in [acceptance evidence](evidence/tts-73.md).
The [source-build follow-up](evidence/tts-73-espeak-source.md) records final
Kokoro checks after replacing the English frontend with the pinned-source build.

| Node | Model/checkpoint | Frontend and voices | Backend / output | On-demand model assets |
| --- | --- | --- | --- | --- |
| `Supertonic3TextToSpeechNode` | [Official Supertonic 3 archive](https://huggingface.co/supertone-oss-archive/supertonic-3/tree/aafc6e32416a594460b32413efc49d7fe4ce6d46), revision `aafc6e32416a594460b32413efc49d7fe4ce6d46` | Unicode indexer, NFKD normalization and explicit `<ja>`/`<en>` tags from [official browser helper](https://github.com/supertone-oss-archive/supertonic/blob/1e9799e964ea4c0dad7cde993b65c3c813a7b373/web/helper.js); F1 or M1 preset JSON | ONNX Runtime WASM, mono 44,100 Hz from `tts.json` | Four fp32 ONNX graphs total 398,075,273 bytes; indexer/config 285,929 bytes; selected voice about 292 KB |
| `KokoroTextToSpeechNode` | [Kokoro 82M v1.0 ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231), revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | Pinned tokenizer; English `af_heart` uses Kokoro normalization + phonemizer.js/eSpeak NG; Japanese `jf_alpha` uses Open JTalk word readings + misaki/cutlet kana-to-IPA mapping | Transformers.js `StyleTextToSpeech2Model`, q8 WASM, mono 24,000 Hz as specified in Kokoro's implementation | `model_quantized.onnx`: 92,361,116 bytes; tokenizer/config: 3,654 bytes; selected voice: 522,240 bytes |

The official Supertonic repository was archived in September 2026; its public
v3 checkpoint remains available without account/hosted-service dependencies.
It declares 31 languages including Japanese and English. This Node exposes
only those two languages and two preset voices, five denoising steps and the
upstream default 1.05 speed. Its text frontend needs no external phonemizer.

Kokoro's upstream [model card](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md)
and ONNX assets include Japanese and English voices. `kokoro-js` 1.2.1's
convenience `generate()` supports English only and `from_pretrained()` does
not forward a revision. This Node uses its documented lower-level model feeds
and style-row selection through pinned Transformers APIs instead. Model,
tokenizer and voice downloads all use the same immutable checkpoint. The
Japanese [kokoro-js-jp frontend](https://github.com/nerosui/kokoro-js-jp/tree/8eadd00e25759e5f6d067009dd02943c17048508)
supplies the verified browser/WASM bridge and pronunciation mapping. We adapt
it to run Open JTalk in the Kokoro Worker directly, eliminating its separate
Worker/client timeout and ensuring termination releases the frontend too.

Kokoro language is chosen by voice; Supertonic needs separate language and
voice settings. There is no generic model/voice registry. Inputs are short
plain strings, limited to 300 characters. Blank strings emit nothing. Kokoro
rejects over 512 phoneme tokens instead of truncating. Select the matching
language/voice; this is not automatic language detection. Unsupported settings
fail explicitly. Upstream Japanese pronunciation limitations (dictionary and
approximate IPA mapping, rather than the Python misaki stack) still apply.

## Runtime/frontends, notices and setup

`npm ci`, `npm run prepare:tts-assets`, then `npm run serve`. Open the index and
either TTS page. Runtime/model resources load on Generate, followed by audio
controls and Download WAV. Separate load and generation/drain times include
initialization and graph delivery. Click Play after generation; browsers may
require that gesture. Cancel terminates all Node resources; repeats use fresh
graphs/Workers. Cache/HTTP cache reuse avoids repeat network downloads where
the browser permits it, but does not reuse a live model across graphs.

Staging downloads these exact npm archives (no install scripts):

| Package | Staged files / size |
| --- | --- |
| `@huggingface/transformers` 3.8.1 | Standalone browser module 888,173 bytes; ORT JSEP MJS/WASM 44,484 / 21,596,019 bytes; Apache-2.0 license |
| `onnxruntime-web` 1.22.0-dev.20250409-89f8206ba4 (Transformers 3.8.1's exact dependency) | WASM ES module 48,008 bytes; MJS/WASM 20,856 / 11,133,407 bytes; auxiliary ORT bundle 398,170 bytes; MIT license |
| Source-built eSpeak NG `0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582` | WASM/English data embedded in `phonemizer-engine.mjs` (1,742,316 bytes), English-only `phonemizer.js` adapter; GPL-3.0-or-later. Complete corresponding source/data/build bundle staged alongside the modules |
| `kokoro-js-jp` 0.2.0 | Open JTalk wrapper 93,921 bytes; WASM 395,024 bytes; dictionary 1.11 gzip archive 23,643,819 bytes (about 100 MB unpacked in WASM memory); Mei voice 862,503 bytes; third-party notices |

The three npm archives, complete eSpeak source archive and rebuilt engine have
SHA-256 pins in the staging script. The Pages artifact includes `web/tts-assets/`
with the matching downloadable eSpeak source bundle (16,315,334 bytes;
77,218,463 bytes total staged assets), but no TTS weights. This
separate directory keeps the existing extension's `vendor/` packaging and
ASR preparation independent. Each page requests only its needed runtime and
frontend. URLs derive from owning module URLs, preserving `/my-audio-to-text/`.
The Pages workflow stages these assets before recursively publishing `web/`.

Full notices/terms are linked on both pages and in
[tts-notices.txt](../web/licenses/tts-notices.txt): Supertonic code MIT,
models/preset voices OpenRAIL-M (including use restrictions); Kokoro
model/code/voices and Transformers Apache-2.0; ORT MIT; Open JTalk/openjtalkjs
and dictionary Modified BSD; misaki Apache-2.0, cutlet MIT; required Mei HTS
voice CC BY 3.0 attributed to Nagoya Institute of Technology/MMDAgent.
Mei loads for frontend configuration; the output voice remains Kokoro.
The English frontend is rebuilt from the pinned eSpeak NG source above using
Emscripten 3.1.30 and the [included build/installation scripts](../scripts/tts-phonemizer/README.md).
Its engine, data and adapter retain GPL-3.0-or-later. The Kokoro page directly
links `tts-assets/phonemizer-source.tar.gz` on the same served origin: it contains
the full matching source/data archive (including upstream build scripts and
notices), our adapter/build scripts, pinned compiler Dockerfile and installation
instructions. Staging verifies source and engine checksums before publishing
them together. The untraceable phonemizer 1.2.1 npm binary is no longer used.

## Ports and lifecycle

```text
TextInputNode.text (TEXT: plain string)
  → Supertonic3TextToSpeechNode.text / KokoroTextToSpeechNode.text
  → .audio (SYNTHESIZED_AUDIO) → AudioOutputNode.audio → WAV/player
```

`SYNTHESIZED_AUDIO` is a distinct shared token, with the read-only payload
`{ samples: Float32Array, sampleRate: positive integer, channels: 1 }`. One
nonempty finite array holds the single mono channel, at the model's native
rate. There are no source IDs or provenance fields. It is incompatible with
the captured bare 16 kHz ASR PCM port. Node and sink validate the payload;
WAV encoding uses its explicit rate and clamps float samples only when
converting to signed 16-bit playback PCM. Inference never depends on playback.

Each Node loads in `start`, receives/generates in serial order and drains in
`stop`. Dispose/signal abort rejects pending requests, terminates the owning
Worker, releases WASM/model memory and discards late replies. It works during
downloads, initialization, inference and drain. Errors fail only their Node
through the existing Pipeline semantics; page cleanup always disposes the
graph and allows a fresh run. Pipeline runtime code is unchanged.

Supertonic/voice downloads use optional Cache Storage with immutable URL keys;
Kokoro model/tokenizer downloads use Transformers' browser cache. Open JTalk
and local runtime files use the browser's HTTP cache. Cache eviction triggers
a refetch. Cache quota failures fall back to uncached downloads; offline cache
misses, HTTP/CORS failures, initialization failures and Worker crashes report
errors. Retry online. Current WebAssembly SIMD is required; Japanese additionally
requires `DecompressionStream('gzip')`. Runtime initialization reports unsupported
SIMD clearly. No GPU probing is needed for either selected backend.

## Validation

```sh
npm test
npm run test:browser -- --workers=2
npm run prepare:tts-assets
TTS_SMOKE=all npm run test:browser -- tests/browser/tts-smoke.spec.js --project=chromium --workers=1 --output=.cache/tts-smoke-results
```

`TTS_SMOKE=supertonic3` or `kokoro` selects a single real-model test. No routes
or model replacements run in the smoke tests: they click each real page and
observe its actual Pipeline sink. Each generates Japanese, English and repeat
English; validates nonempty finite mono samples, expected rate, 0.25–30 s
duration, nonzero RMS and native audio decoding/playback; logs load/generation
times, browser/device/CPU and asset-only GET traffic. JSON evidence is saved
even on a reported model failure. Listening is optional.

Deterministic unit/native browser tests cover typed ports, waveform/rates/WAV,
prefix paths, explicit downloads, graphs/Workers, input validation, repeat,
Stop/sink drain, cancellation at every lifecycle stage, stale replies,
missing WASM/gzip, initialization/network/inference/transport errors and retry.
Browser fixtures replace heavy runtime boundaries, so these tests alone do
not establish real model inference. See the evidence record for actual results.

## Required post-merge verification

**Pending until performed.** Keep Issue #73 open. Record the successful Pages
deployment run URL, merged SHA and verification time. In a fresh browser on
the deployed origin, verify both index links, pages, scripts/Workers, notices
and `tts-assets/` URLs under the repository prefix. If model-fetch/CORS/COEP
behavior differs from local checks, run deployed-origin real inference and
record it. Local worktree tests cannot establish these post-merge facts.
