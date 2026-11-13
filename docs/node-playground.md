# Node Playground

The [published Web entry point](https://takahirox.github.io/my-audio-to-text/) groups all supported primary inference models by task. Each test runs just that model through the production node and/or its worker, without an extension, Graph Editor, another AI model, or saved Graph Library data. Static model weights download only after an explicit Run/Generate/Load action. Inputs and inference stay on the device.

| Task | Standalone page | Backend / requirements | First weight download |
| --- | --- | --- | --- |
| Speech recognition | [ReazonSpeech ja-en](../web/nodes/speech-to-text/) | CPU WASM + Silero VAD; microphone/tab capture; simulated provisional previews | ~91 MB including runtime |
| Speech recognition | [Whisper tiny multilingual q8](../web/nodes/whisper/) | WASM SIMD + Silero VAD; English/Japanese; final utterances | ~44 MB + VAD |
| Speech recognition | [Zipformer English streaming](../web/nodes/zipformer/) | CPU WASM; native provisional/final updates | ~45 MB |
| Speech recognition | [Parakeet TDT 0.6B v3](../web/nodes/parakeet-v3/) | WebGPU shader-f16, 128 MiB storage buffers; FP16 encoder, WASM int8 decoder; final segments | ~1.26 GB |
| Speech recognition | [Moonshine Medium Streaming English](../web/nodes/moonshine-medium/) | CPU WASM; real provisional/final updates; isolated origin | ~305 MB |
| Translation | [OPUS-MT Japanese → English](../web/nodes/opus-mt/) | WASM q8 | ~239 MB |
| Translation | [OPUS-MT English → Japanese](../web/nodes/opus-mt-en-ja/) | WASM q8 | ~253 MB |
| Translation | [TranslateGemma 4B, both directions](../web/nodes/translategemma/) | WebGPU q4; several GB of RAM/GPU memory | ~3.112 GB |
| Text AI | [Text Summary · LFM2.5 1.2B JP](../web/nodes/text-summary-lfm2/) | WebGPU shader-f16, q4f16; Japanese/English output, optional prompt | ~749 MB |
| Text AI | [Text Summary · Qwen3.5 2B](../web/nodes/text-summary-qwen35/) | WebGPU shader-f16, q4f16; Japanese/English output, optional prompt | ~1.40 GB |
| Text AI | [IfCondition · XtremeDistil](../web/nodes/if-condition/) | WASM q8 binary NLI; condition + text → Yes/No | ~14 MB |
| Speech synthesis | [Kokoro 82M](../web/nodes/kokoro/) | WASM q8; jf_alpha Japanese / af_heart English | ~93 MB + optional Japanese frontend |
| Speech synthesis | [Supertonic 3](../web/nodes/supertonic3/) | WASM; Japanese/English, F1/M1 voices | ~399 MB |
| Speech synthesis | [Qwen3-TTS 0.6B CustomVoice streaming](../web/nodes/qwen3-tts/) | WebGPU; Japanese/English, ono_anna/ryan; incremental PCM playback | ~690 MB |
| Speech synthesis | [CosyVoice3 0.5B streaming](../web/nodes/cosyvoice3/) | WebGPU; Japanese/English, LibriTTS-R 4446; incremental PCM playback | ~917 MB |

The experimental [Qwen3 transcript correction page](../web/nodes/qwen3-correction/) is preserved separately; it is not a replacement for either text-summary model. Silero VAD and the Kokoro Japanese frontend are dependencies, not separate model evaluations.

## Inputs, cancellation and timings

The four file-based ASR pages accept browser-decodable audio up to 32 MiB / two minutes. PCM WAV is the most portable format. Files are decoded/downmixed/resampled locally to mono 16 kHz, then replayed in 100 ms blocks through the selected production ASR. Stop finalizes the accepted audio prefix; Cancel terminates workers and discards pending output. Streaming models expose actual worker provisional results. Whisper and Parakeet publish final results only. ReazonSpeech retains its existing microphone/tab capture, Stop/drain and retry behavior.

Translation supports each OPUS direction independently and a direction selector for TranslateGemma. Summary pages accept text, Japanese/English output and an optional instruction, retaining the production 8,192-token budget. IfCondition accepts up to 512 condition characters / 2,048 input characters, bounded to 512 combined tokens; ambiguous decisions are errors rather than fabricated Yes/No answers.

All TTS pages offer native-rate audio and completed WAV downloads. Qwen3-TTS and CosyVoice3 connect their real `AUDIO_STREAM` output to `SpeakerOutputNode`; they play chunks before generation ends. The WAV collector is a separate sink, never a substitute for incremental playback. Generate activates audio output before model loading. If the browser suspends playback, use Enable speaker or Cancel. Playback queue failures are reported; Cancel releases the AudioContext, worker, queued PCM and object URLs. Each repeated run owns fresh resources.

Model download/loading is measured separately from inference. File ASR inference/replay time includes replay duration; streaming TTS generation time excludes the speaker's final playback drain. ReazonSpeech also shows Stop-to-final latency. Times describe the current run on this device and are not directly comparable machine-to-machine benchmarks.

## Assets, browser support and licenses

Use HTTPS or localhost with browser Cache API, Web Locks and sufficient free storage. The ASR pages enable cross-origin isolation through the existing header-only root service worker (one initial reload on static hosting); no model is loaded by opening a page. If service workers are blocked, serve with COOP `same-origin` and COEP `require-corp` headers. WASM requires a compatible current browser; heavy WebGPU models generally need desktop Chromium, hardware acceleration and several GB of free RAM/GPU memory. Unsupported GPU features, network/CORS failures, quota/eviction and model errors remain local to that test; free resources and retry or open another test. No cloud fallback exists.

`optional-model-assets.js` keeps extension workers on their existing cache-only readers. On ordinary web origins, `playground-model-assets.js` uses the same integrity-checked `ModelAssetCache` and pinned manifests, copied under `web/vendor/model-cache/`. The browser origin has its own cache; no extension storage, origin or preloaded weights are required. The loading helpers prepare only the selected asset set, with VAD/frontend dependencies when needed. Cancellation terminates the owned worker, its downloads and cache leases. Successfully verified cache files can be reused on retry.

Each page links its model/source notices. See [translation pins and terms](translation-nodes.md), [TTS and frontend licenses](tts-nodes.md), [streaming Qwen3-TTS](streaming-tts.md), [CosyVoice3](cosyvoice3-streaming.md), and [packaged notices](../web/third-party-notices.txt). TranslateGemma remains subject to [Gemma Terms](https://ai.google.dev/gemma/terms) and [Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy). Parakeet retains its CC BY attribution; Moonshine and both summary models retain their model-specific notices. Existing extension Models remains asset management only.

## Add an independent node page

1. Implement the real processor node using the existing
   [Node/Port contract](pipeline-runtime.md). A different model implementation
   belongs to a distinct node with its own test page.
2. Add `web/nodes/<node-name>/index.html` and a local `app.js` if needed. Use
   node-specific controls to provide valid inputs, connect the actual node to
   suitable sources/sinks, run it and show its outputs. Handle its lifecycle,
   resource cleanup and useful errors. Text input/output may be enough for a
   text processor; the speech page's audio controls and metrics are not required.
3. Add a normal relative link in `web/index.html`. Add a return link to `../../`
   on the test page. Shared modules/styles stay under `web/`; from the node page,
   import them with `../../` paths. Resolve worker/worklet URLs from the module
   that owns the asset, rather than the document URL.
4. Add deterministic browser coverage for navigation and the real node's input,
   output and lifecycle. Keep heavyweight model inference checks separate from
   controlled worker/permission fixtures.

No registry, generic configuration form, shared metrics layout or plugin SDK is
needed. Each page can differ according to its node's input/output needs.

## Static serving and deployment

Install dependencies and stage the web artifact:

```sh
npm ci
npm run prepare:playground-assets
npm run serve
```

Open `http://127.0.0.1:8000/`. Preparation verifies pinned JS/MJS/WASM/runtime archives and copies model manifests/notices; it does not download model weights. It includes the existing speech, translation, TTS and correction assets plus optional ASR, Zipformer and the isolated Transformers.js 4.2 summary runtime. The [Pages workflow](../.github/workflows/pages.yml) runs the same preparation and recursively uploads `web/`. Keep all worker, vendor, license and shared module paths under the web root. URLs resolve relative to their owning module and retain `/my-audio-to-text/` on GitHub Pages; no origin-root absolute paths are needed.

The [standalone model CI workflow](../.github/workflows/playground.yml) runs the focused unit, browser and packaged-extension model tests automatically with no weight downloads. `npm run test:playground` runs its browser subset locally. Normal deterministic checks use native worker fixtures (no weights), real production nodes and real incremental speaker playback:

```sh
npm test
npm run test:browser -- --workers=2
npm run build:extension
npm run test:extension
```

The model playground suite verifies all primary navigation links, no eager work, each missing model's independent lifecycle/output, cancellation during load/inference, retry after errors, provisional ASR, incremental TTS scheduling before completion and WAV download. Translation coverage exercises both TranslateGemma directions. Browser-origin asset fixtures also exercise real integrity preparation and reject corrupt/evicted weights.

Real model smoke checks are explicitly opt-in and outside default CI. Choose a subset to control download/memory cost, on a machine meeting that model's requirements:

```sh
# Small real WASM classifier (~14 MB), no mock inference:
PLAYGROUND_MODELS=if-condition npm run test:playground-real
# Heavy WebGPU generation, with desktop Chrome installed:
TRANSLATION_CHANNEL=chrome PLAYGROUND_MODELS=text-summary-lfm2,qwen3-tts npm run test:playground-real
# Optional known speech fixture; otherwise a short generated waveform checks loading/drain only:
PLAYGROUND_MODELS=whisper PLAYGROUND_AUDIO_FILE=/path/to/speech.wav npm run test:playground-real
```

`PLAYGROUND_MODELS` accepts `whisper`, `zipformer`, `parakeet-v3`, `moonshine-medium`, `text-summary-lfm2`, `text-summary-qwen35`, `if-condition`, `qwen3-tts`, `cosyvoice3`. Each selected test can run for 30 minutes and downloads its real pinned assets. No human approval gate is part of CI. Existing real speech/translation/TTS tests remain available separately. For published deterministic checks set `ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/`; local tests additionally cover the repository-prefix alias without server isolation headers.

## Required post-merge verification

**Pending for Issues #63 and #65.** Local tests do not establish deployment of the merged
revision. Keep the Issue open until the following checks are performed and the
evidence is recorded:

1. Confirm the successful Pages push/deployment run belongs to the merged commit
   SHA; record the run URL, SHA and verification time.
2. Load the canonical published entry point in a fresh browser context. Confirm
   the Node Playground list, click Speech-to-Text, and confirm its heading,
   enabled Load button and cross-origin isolation. Confirm the return link and
   direct speech-page URL work.
3. Load the fixed model and check the browser's network/runtime errors. Verify
   the nested HTML/controller, root styles/modules, isolation worker, ASR/VAD
   workers, capture worklet, notices, and `vendor/sherpa-ja-en/` JS/WASM/data
   resolve under the repository prefix. Record successful asset requests and
   model readiness from the deployed revision.

Use `ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ npm run test:browser -- --workers=2`
for published deterministic checks (the local alias test is skipped), and
`ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ ASR_TEST_VAD=1 npm run test:browser -- tests/browser/model-smoke.spec.js --project=chromium --workers=1`
for pinned model loading and silence Stop/repeat. These results supplement the
deployment SHA and published navigation/asset evidence.

For #65, also verify both translation pages and their Worker/runtime requests
under the repository prefix, recording deployed SHA and Pages run URL. Run the
opt-in real translation smokes on the deployed origin if needed and retain
pending status until completed; see [translation verification](translation-nodes.md#required-post-merge-verification).

For #71 the new canonical `/my-audio-to-text/nodes/opus-mt-en-ja/` page has a
**pending** post-merge deployed-SHA/URL/worker/model verification gate; see
[Issue #71 evidence](evidence/translation-direction-71.md).

Shared speech outputs `provisional` and `final` are `TEXT` strings, compatible
with translation, correction and TTS inputs directly. Select `final` for sinks
that commit text; no extraction adapter or metadata connection is required.
See the [contract audit](port-contracts.md) and deterministic
`tests/browser/text-contracts.spec.js` composition test.
