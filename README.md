# my-audio-to-text

The Chrome extension also supports [local IfCondition branching](docs/if-condition-node.md):
edit a natural-language condition and route the original TEXT to Yes or No with
a small browser-local classifier. Save prepares its verified 14 MB model.

The extension also has independent [LFM2.5 1.2B JP and Qwen3.5 2B meeting-summary
draft processors](docs/meeting-summary-nodes.md). They incrementally update a
Japanese or English note from committed TEXT, using Save-prepared local WebGPU
models. Connect `summary → TextToDOM.text → dom → LiveTextDisplay.dom`. Read the recorded accuracy
limitations before relying on generated decisions, owners or task status.

A local-first composable processing system that connects reusable input and processing capabilities into pipelines for useful derived information.

## Current implemented capabilities

Speech-to-text is the most-developed processing capability today. The Node Playground speech test page and Chrome extension provide the **first concrete pipeline**:

```text
Microphone / browser-tab / Chrome-extension tab audio
        ↓
Local ASR Core
        ↓
ReazonSpeech ja-en + Silero/hayamimi
        ↓
provisional / final transcript
```

Capture helpers normalize audio to mono 16 kHz PCM before passing it to the [Local ASR Core](docs/local-asr-core.md). ReazonSpeech ja-en, sherpa-onnx, Silero VAD and the hayamimi-inspired simulated-streaming policy are the core's current implementation. This replaceable ASR baseline is one processing capability within the product vision.

The [minimal Node/Port runtime](docs/pipeline-runtime.md) provides typed named ports, explicit connections, fan-out, asynchronous processing, graceful draining and cancellation. The Node Playground speech test page connects microphone or browser-tab source nodes to `SpeechToTextNode` and a transcript sink, with separate provisional/final ports on one ASR node. These adapters reuse the capture helpers and `LocalAsrCore`; the Chrome extension uses the same runtime and speech node with its own capture adapter and UI. Independent direction-specific OPUS-MT (Japanese → English and English → Japanese, WASM) and Japanese → English TranslateGemma 4B (WebGPU) text processors also use this runtime; their dedicated Playground pages run string source → translation node → string sink graphs. The extension also composes ASR or Text constants with optional OPUS-MT or TranslateGemma 4B (English → Japanese and Japanese → English) through the same scheduling adapter. TranslateGemma requires a 3.112 GB Save-time download, Worker WebGPU and several GB RAM/GPU memory; Google Gemma Terms and Prohibited Use Policy apply. Shared ASR, correction and translation outputs use plain `TEXT` strings for direct composition and fan-out to TTS or field output; the extension groups committed `source/text/error` and preview `provisionalSource/provisionalText/provisionalError` as separate TEXT families sharing one owned Worker. Committed `text` can feed history or TTS directly; `provisionalText` replaces a separate preview display and clears on final input, Stop and Cancel. Preview-enabled saved graphs require reviewed v14 repair with original JSON preserved. See the [contract audit](docs/port-contracts.md). The extension supports bounded incremental meeting-summary drafts; persistent history storage and broader summary/history composition remain future work, described in the [processing pipeline architecture](docs/processing-pipeline.md). Previous macOS, Moonshine, two-pass and Japanese-only ReazonSpeech experiments remain recoverable from Git history; backward compatibility with removed experiments is not required.

## Node Playground

Published URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

The published entry point lists available processor nodes. Select [Speech-to-Text (ReazonSpeech ja-en)](https://takahirox.github.io/my-audio-to-text/nodes/speech-to-text/) to open its individual test page. It runs the actual `SpeechToTextNode` through the Node/Port pipeline, with microphone or browser-tab sources and a transcript sink. The model and processing policy are fixed; there is no model comparison selector. The index also lists separate OPUS-MT Japanese → English / English → Japanese and TranslateGemma 4B Japanese → English pages, each running its production node in an owned Worker. See [pinned models, setup, terms and real-model tests](docs/translation-nodes.md) and the [page convention and how to add another node](docs/node-playground.md).

The optional [Qwen3 transcript correction Node](docs/correction-node.md) runs
text-only candidates in a dedicated local WebGPU Worker, with a separate
original branch and explicit bypass. Its [Playground page](web/nodes/qwen3-correction/index.html)
compares original and candidate text. Run `npm run prepare:correction-assets`;
Generate downloads about 579 MB unless cached. This is an evaluation processor,
not acoustic verification or a guaranteed quality improvement. See
[real Japanese/English safety and error results](docs/evidence/correction-78.md).

Independent [Supertonic 3](web/nodes/supertonic3/index.html) and
[Kokoro 82M](web/nodes/kokoro/index.html) text-to-speech Nodes also run through
the Pipeline, with Japanese/English input and playable mono audio at each
model's native rate. Each has its own WASM Worker and page with Generate,
Cancel and WAV download. Run `npm run prepare:tts-assets` for local setup;
model downloads start on Generate. See [TTS pins, terms and testing](docs/tts-nodes.md)
and [real inference evidence](docs/evidence/tts-73.md). The extension also offers
[Qwen3-TTS local streaming](docs/streaming-tts.md): committed text → incremental
PCM → Speaker · streaming, with explicit preparation and cache-only Start.
[CosyVoice3 local streaming](docs/cosyvoice3-streaming.md) uses repaired pinned
flow/HiFT exports with the same stream and Speaker contracts. English/Japanese
packaged Chrome evidence and hardware/resource limitations are recorded separately.

The retained hayamimi-inspired path uses 0.8-second pre-roll, provisional recognition about every 0.5 seconds of active speech, a 0.35-second trailing-silence endpoint, and a 6-second default maximum audio segment including pre-roll. The extension's reusable Number source can configure a 1–12 second cap, including decimals, through optional SpeechToTextReazonSpeech.maxDuration before session startup; saved edits apply next session. Continuous speech splits without audio gaps. This is an audio cap, not final-result latency: mid-sentence cuts may reduce accuracy. See [configuration and validation limits](docs/extension-graph.md#maximum-speech-segment-duration). Stop finalizes active speech. Silero VAD and ASR run in separate workers; inference is serialized, superseded previews are coalesced, and pending audio is bounded at 30 seconds. ReazonSpeech uses the evidence-based one-thread default from [Issue #38](docs/evidence/reazon-38.md).

Microphone or browser-tab audio feeds normalized PCM into the documented [local ASR core boundary](docs/local-asr-core.md); capture/resampling stays outside recognition orchestration. For tab audio, use a desktop Chromium browser and choose a tab with “Share tab audio” enabled in the browser sharing picker.

See [setup, testing, and limitations](docs/asr-manual-testing.md). Automated Chromium/WebKit checks cover list navigation, loading, provisional/final output, Stop, Cancel, repeat, worker isolation, and stale-result rejection. The [Issue #45 validation record](docs/evidence/reazon-45.md) records the baseline checks; [Issue #59 validation](docs/evidence/playground-pipeline-59.md) covers the pipeline migration; [Issue #63 validation](docs/evidence/node-playground-63.md) covers the node list and nested speech page, with required post-merge Pages verification pending. The [Issue #65 validation record](docs/evidence/translation-65.md) records deterministic translation checks and real OPUS-MT/TranslateGemma browser inference, with post-merge Pages verification pending. The [historical acceptance record](docs/asr-acceptance.md) and [experiment evidence](docs/evidence/) preserve completed comparisons and publication observations; they are not instructions for the current baseline.

A minimal [Chrome extension PoC](docs/chrome-extension.md) starts current-tab
transcription from the toolbar without the sharing picker. It reuses the Web
ASR core and audio helpers, restores audible tab playback, and shows transcripts
in a compact Live window. Separate Graph Editor and Models tabs provide
executable graph editing and verified optional model preparation without
interrupting capture. Optional local OPUS-MT pairs committed
Japanese transcripts with English or English transcripts with Japanese using
independent direction-specific Nodes and editable TextFormatter templates. Saved
graph edits apply on the next session, after preparation of required model caches;
transcripts remain window-local. See its
guide for building/loading the unpacked extension,
permissions, lifecycle behavior and automated tests.

From a fresh checkout, build the unpacked extension with one command:

```sh
npm run setup:extension
```

The extension Graph Editor exposes **ReazonSpeech ja-en ASR**, **Whisper tiny
(multilingual) ASR**, **Streaming Zipformer English ASR**, and a reusable **Text**
constant. Whisper defaults to English; connect `Text.value → SpeechToTextWhisper.language` with `ja` for
Japanese. Whisper exposes only `final: TEXT`; connect it to
`TextAccumulator.append → text → TextToDOM.text → dom → LiveTextDisplay.dom` for completed segments. The default stays
ChromeTabAudio → ReazonSpeech, with separate committed history and provisional
TextToDOM branches combined by DOMCombiner → LiveTextDisplay. See [Whisper pins, setup,
usage and real-model validation](docs/whisper-node.md). For real incremental English
previews, opt into [English online Zipformer](docs/zipformer-node.md): connect
`final → TextAccumulator.append → TextToDOM → DOMCombiner.first` and
`provisional → TextToDOM → DOMCombiner.second`, then `DOMCombiner.dom → LiveTextDisplay.dom`.

The extension also offers independent **Parakeet TDT 0.6B v3** (WebGPU, final
TEXT only) and **Moonshine Medium Streaming English 245M** (CPU WASM, real
provisional/final TEXT) Nodes. Save prepares their optional verified weights
(1.26 GB / 305 MB). Budget substantial memory, especially for both together.
See [setup, exact pins, licensing, limits and real-model tests](docs/optional-asr-nodes.md)
and [packaged/native inference evidence](docs/evidence/optional-asr-121.md).

Setup installs npm dependencies, downloads/verifies ReazonSpeech, Whisper and
English Zipformer ASR models and prepares translation/TTS/meeting-summary runtimes, then produces `dist/chrome-extension/`. Optional
translation/TTS, meeting-summary and optional ASR **weights** prepare after **Save graph** for saved processor Nodes;
Models provides **Download / retry**, diagnostics and deletion. Open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked** and select `dist/chrome-extension`. With assets already
prepared, run `npm run build:extension` after source changes, then click
**Reload** on the extension's card. See the [extension guide](docs/chrome-extension.md)
for requirements and usage.

The [Pages workflow](.github/workflows/pages.yml) prepares the pinned ReazonSpeech ja-en/Silero assets and translation runtimes and deploys the entire `web/` tree (the index, nested node pages and shared assets) automatically on pushes to `main`. A maintainer can manually dispatch it on the exact reviewed PR branch permitted by the `github-pages` environment, retaining existing protections. Inference runs in the browser; speech loading needs about 91 MB of model/runtime assets and no ASR server. Translation weights download explicitly on Run (about 239 MB for OPUS-MT ja-en, 253 MB for OPUS-MT en-ja and 3.112 GB for TranslateGemma); text stays local.

For setup, select **Settings → Pages → Build and deployment → Source → GitHub Actions**. The workflow uses the `github-pages` environment and built-in `GITHUB_TOKEN`.

### Completed static-placeholder validation (#17)

[Issue #17](https://github.com/takahirox/my-audio-to-text/issues/17) is completed. Its static-placeholder validation is separate from ASR acceptance: Pixel 7a / Chrome displaying placeholder text does not establish model loading, microphone capture, or recognition for Issue #18. The table below preserves the verified placeholder results; publishing the ASR branch supersedes the placeholder content without invalidating that historical evidence.

Validation evidence recorded on October 2, 2026 (JST; evidence timestamps use UTC):

| Issue #17 acceptance check | Result and evidence |
| --- | --- |
| Initial Pages workflow on `main` | **Passed.** [Run 36886759434](https://github.com/takahirox/my-audio-to-text/actions/runs/36886759434), event `push`, succeeded at `2026-10-01T15:45:54Z` for commit `d3a600c76c8dc0bb11d91e440073ecec2e227bbb`. |
| Canonical public URL over HTTPS | **Passed.** HTTP 200 with normal TLS certificate verification. The initial check was at `2026-10-01T15:53:40Z`; [post-merge evidence](docs/evidence/pages-redeployment.md) confirms revision 2 at the same URL. |
| Published placeholder in a desktop browser | **Passed.** Chrome `154.0.8037.58` on macOS rendered the initial page at `2026-10-01T15:55:59Z` ([historical screenshot](docs/evidence/pages-desktop-initial.png)). A fresh isolated headless desktop check also rendered revision 2 ([evidence and screenshot](docs/evidence/pages-redeployment.md)). Neither check claims physical-mobile validation. |
| Actual mobile browser | **Passed — user-reported physical-device check.** Pixel 7a with Chrome rendered `my-audio-to-text` and `The Web playground is deployed. Placeholder revision 2.` at the canonical URL. The report was recorded at `2026-10-01T22:01:26.247000+00:00` (UTC; October 2, 2026 JST). Browser version was not supplied. See [mobile evidence](docs/evidence/pages-redeployment.md#actual-mobile-browser). |
| Subsequent reviewed change and automatic redeployment | **Passed.** PR #19 merged as `28f0badabb1834a1a8fe15dc248aaeebbb393412`. Automatic [push run 36931736950](https://github.com/takahirox/my-audio-to-text/actions/runs/36931736950) succeeded. The canonical URL rendered `The Web playground is deployed. Placeholder revision 2.`; see [the recorded browser check](docs/evidence/pages-redeployment.md). |


[PR #19](https://github.com/takahirox/my-audio-to-text/pull/19) supplied the reviewed placeholder revision; [PR #22](https://github.com/takahirox/my-audio-to-text/pull/22) recorded its successful automatic redeployment, desktop screenshot, and user-reported physical-mobile result. The [redeployment evidence](docs/evidence/pages-redeployment.md) and [original partial PR description](docs/evidence/pages-validation-pr.md) retain those historical checks.

## Vision

Following [Issue #7: Product vision](https://github.com/takahirox/my-audio-to-text/issues/7), build small reusable capabilities that compose into local processing pipelines:

```text
Input/source nodes
        ↓
reusable local processing nodes
        ↓
composable pipelines
        ↓
outputs / derived information
```

Future inputs may include files, Web/article text and platform-specific sources alongside today's microphone and tab audio. Future processing capabilities may include summarization, topic extraction/analysis, storage and visualization. These are architectural examples, not implemented features.

Personalized ASR remains an important future capability/node within this system. It should learn from corrections to improve personal vocabulary, pronunciation, recurring mistakes and quiet speech, eventually including whisper speech. Success requires improvement on held-out real audio without unacceptable regression; personalization is not implemented today.

See the [architecture guide](docs/processing-pipeline.md) for conceptual nodes, typed ports and examples that distinguish existing behavior from future composition.

## Near-term direction

- Continue improving the reusable speech-to-text capability, including Japanese recognition, latency and browser usability.
- Prove a small number of real processors and useful pipelines. Candidates include speech-to-text → translation, committed transcript → incremental summary, or article/text → summary; each needs its own implementation Issue.
- Extend the minimal Node/port contract only when a concrete next processor requires it, using the existing audio-source and Local ASR Core boundaries as a foundation.
- Develop personalized ASR data, correction and evaluation work as an independently evolving capability.

## Deferred work

A graphical node editor, plugin marketplace and general workflow framework are not current implementation priorities. A universal plugin SDK, workflow language or distributed/cross-platform runtime is neither implemented nor required now. Consider broader orchestration or a generic node UI only after real processors and pipelines demonstrate a need.

## Design principles

- Prefer execution and storage on the user's device where practical, without requiring a central processing server.
- Give each node one coherent responsibility: format current inputs, intentionally accumulate history, combine latest inputs, or render supplied output. Choose independently executable, configurable and replaceable boundaries; multiple ports, legitimate state and internal implementation details do not require separate nodes.
- Make behavior explicit in ports, node contracts and graph wiring. A direct formatter → display connection replaces the current snapshot; history requires an explicit accumulator and combining streams requires an explicit composition step. Do not silently insert behavior for a convenient sample workflow.
- Compose through small typed contracts independently of upstream/downstream node type, model identity, display destination or incidental edge order. Keep intrinsic validation, such as grouped-input correlation, local to the consumer; see [port contracts](docs/port-contracts.md).
- Separate processing, state, formatting and presentation. Scroll-follow belongs to the rendering surface; input data and derived markup belong upstream. Keep implicit history and translation/preview-specific state out of unrelated nodes, and avoid translation-specific modes or presentation-specific output-node types in generic sinks.
- Allow streaming updates, committed events and accumulated/long-form processing to coexist. Each processor's public contract defines how it consumes its inputs; provisional/realtime and final outputs do not inherently require separate nodes.
- Keep models, implementations and runtimes replaceable across Web, browser extensions, desktop and mobile. Share useful contracts and behavior without requiring identical runtimes.
- Preserve source data and original transcripts separately from derived or corrected output; derived output should not silently overwrite its source. Persistent source/history storage remains future work.
- Measure accuracy, latency, memory, CPU/GPU usage, battery impact, long-session behavior and personalization improvement where relevant.
- Prefer the smallest transparent composition that meets the Issue. Reuse existing nodes/contracts; add a minimal independently useful unit only when needed. Avoid speculative configuration, frameworks and future-proofing.

See [Live text composition examples](docs/processing-pipeline.md#graph-driven-live-text-99)
and the [architecture review prompts](docs/review-guidelines.md#node-architecture).

### UI/UX

1. **Keep it simple.** Show only necessary information and actions; avoid unnecessary UI elements.
2. **Show, don't tell.** Prefer layout, spacing and visual hierarchy over explanatory labels or prose to communicate structure.
3. **Intuitive and predictable.** Keep appearance and behavior consistent with user expectations; don't interrupt the user's work.

“Show, don't tell” must not remove necessary control labels, accessible names,
error messages or other information needed to use the interface.

## Follow-up work

Separate issues should define and implement:

- A concrete next processor and its useful pipeline, then any additional composition contract it needs.
- Additional sources such as files or Web/article text when a real use case requires them.
- Transcript/history storage and accumulated processing for summaries or topic analysis/visualization.
- Personalized ASR data, feedback and held-out evaluation.
- Platform-specific implementations across Web, extensions, desktop and mobile that reuse appropriate processing contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, the [test and CI principles](docs/development-flow.md#test-and-ci-principles) for validation scope and cost, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.

The extension Live window renders graph-configured `LiveTextDisplay` sinks with
custom labels. Fresh setup and Reset default to Chrome tab audio → SpeechToText →
one display: provisional text replaces only the preview, and each final appends
a committed item. Translation remains an explicit graph addition. Configurable
`TextFormatter` Nodes compose primitive TEXT with editable multiline templates.
Older paired views open a reviewed migration draft and keep a recovery copy;
`PairedTextToDOM` formats one atomic grouped pair, provisional or committed.
Direct display connections show only the latest pair. Its generic TEXT inputs are
`input1` (left) and `input2` (right); connect translator.source/text explicitly to those ports. For paired
previews, use a separate formatter wired to provisionalSource/provisionalText
and a replacement display; keep committed history on its own branch. Missing input2
leaves a blank cell, while specific errors remain in translation diagnostics.
Saved paired source/text/error wiring requires a v12 review draft and Save,
with exact original JSON retained for recovery. For optional comparison
history, explicitly connect `PairedTextToDOM.dom → DOMAccumulator.append → dom →
LiveTextDisplay.dom`. To include live ASR beneath that history in one display,
connect history to `DOMCombiner.first`, ASR provisional → `TextToDOM` to
`DOMCombiner.second`, and `DOMCombiner.dom` to the display. Final ASR clears its
preview immediately; final English awaiting translation has no pending row.
Set that preview TextToDOM's `className` to `paired-text-tail` to align its italic
text with the original column, leaving the translation side empty.
Each Live region follows incoming DOM while you are reading near the bottom;
scrolling up keeps your position until you return to the bottom.
Formatting, accumulation, combination and display remain separate processors.
See [Live display and migration semantics](docs/extension-graph.md).
