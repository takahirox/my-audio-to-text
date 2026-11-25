# my-audio-to-text

The extension ships **no AI model weights**. All models use the same verified,
on-demand cache. Auto Save prepares saved graph dependencies; Models provides
Download/retry, progress, cancellation, inspection and deletion. Inference reads
verified cached assets locally. Prepared graphs work offline. See the
[asset lifecycle and packaging audit](docs/model-assets.md).

The Chrome extension also supports [local IfCondition branching](docs/if-condition-node.md):
edit a natural-language condition and route the original TEXT to Yes or No with
a small browser-local classifier. Auto Save prepares its verified 14 MB model.

The extension has independent [Text Processing · LFM2.5 1.2B JP and Qwen3.5 2B
nodes](docs/text-summary-nodes.md). Set a multiline **System prompt** and **Input
count (1–32)** in Settings to summarize, proofread, extract, classify or compare
texts. Connect `input1 … inputN: TEXT` and `result → Display.input1`. Inputs are
separate user data; the saved prompt defines the task, language and format.
Models use existing Auto Save-prepared local WebGPU assets. Each TEXT update runs
inference: control frequency with TextWindow, Hold or a [Live Button](docs/graph-actions.md).
Rolling history belongs to explicit Hold feedback. Verify AI results against
the source. Saved Summary graphs receive explicit repair guidance.

A local-first composable processing system that connects reusable input and processing capabilities into pipelines for useful derived information.

## Current implemented capabilities

Speech-to-text is the most-developed processing capability today. The Chrome extension composes tab/microphone capture → Moonshine streaming recognition → formatting, translation, display or focused text insertion. The standalone pages accept audio files to test each model independently.

## Desktop

The standalone [desktop app](docs/desktop.md) runs saved graphs independently
of the Chrome extension and Web Playground. Dictation is verified in
Mousepad on Debian X11. The Apple Silicon macOS package launches and the
focused editor and browser acceptance checks are still open.

## Node Playground

Published URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

For local setup: `npm ci && npm run prepare:playground-assets && npm run serve`, then open `http://127.0.0.1:8000/`. Preparation stages pinned JS/WASM, notices and manifests, without model weights. See [model requirements, source/license links, deterministic tests and opt-in heavyweight smoke checks](docs/node-playground.md).

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
PCM → Speaker, with explicit preparation and cache-only Start.
[CosyVoice3 local streaming](docs/cosyvoice3-streaming.md) uses repaired pinned
flow/HiFT exports with the same stream and Speaker contracts. English/Japanese
packaged Chrome evidence and hardware/resource limitations are recorded separately.

A minimal [Chrome extension PoC](docs/chrome-extension.md) opens Live for the
toolbar's current tab without the sharing picker. Live initializes executable
graph models before showing Ready; press Start to begin transcription with warm
models. It reuses the Web
ASR core and audio helpers, restores audible tab playback, and shows transcripts
in a compact Live window. The [Graph Library](docs/extension-graph.md#graph-library-243) stores named, independent
graphs in a responsive workspace. Left-click the toolbar icon for its saved Live
default; right-click for Chrome's native graph launcher and default submenu.
Each launch opens an independent window, with capture beginning only on Start.
The toolbar right-click **Microphone** submenu includes a default-OFF **Enable** checkbox
and **Icon position → Auto / Left / Right**. Turning ON requests Chrome’s
optional website access, with a native prompt only if needed; denial leaves it OFF. Choose its graph from the in-page mic's right-click
menu (also Shift+F10); choosing a graph starts dictation immediately and saves it
as the default for later mic clicks. The page mic
requests the current website’s native microphone permission and captures there;
mono PCM stays local and feeds the existing extension graph. No setup tab opens.
HTTPS (or localhost) and a website policy allowing microphone capture are required.
Live and Web microphone sessions can prepare and record independently, using
the same or different saved graphs. Stopping or closing one leaves the other
running; actual browser/device and memory limits can still cause session errors.
Open a library entry in Graph Editor; Auto Save updates that entry only. Graph Editor and Models tabs provide executable graph editing and verified optional model preparation without
interrupting capture. Optional local TranslateGemma and PLaMo translation pairs committed
Japanese transcripts with English or English transcripts with Japanese using
explicit translator Nodes and KeyedTextPair history. PLaMo appears as **Translation**
with the **PLaMo 3 Translate 2B** subtitle and supports 53 languages via optional
TEXT language ports. Its unconnected/auto target follows the official GGUF
Japanese ↔ English switch; specify a target for other input languages. A concrete
source requires a concrete target. Connect target `en` for fixed English output.
Optional `context: TEXT` supplies native PFML3 reference information; context-only updates never translate.
See [PLaMo translation](docs/plamo-translation.md) for supported codes and examples. Saved
graph edits apply on the next session, after preparation of required model caches;
transcripts remain window-local. See its
guide for building/loading the unpacked extension,
permissions, lifecycle behavior and automated tests.

From a fresh checkout, build the unpacked extension with one command:

```sh
npm run setup:extension
```

Setup installs npm dependencies and prepares pinned, weight-free runtimes, then
produces `dist/chrome-extension/` without downloading model weights. Every model's
**weights** prepare after **Auto Save** for saved processor Nodes; Models provides
**Download** or **Retry**, diagnostics and deletion. Open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked** and select `dist/chrome-extension`. With assets already
prepared, run `npm run build:extension` after source changes, then click
**Reload** on the extension's card. See the [extension guide](docs/chrome-extension.md)
for requirements and usage.

The [Pages workflow](.github/workflows/pages.yml) installs pinned npm dependencies and prepares every Playground model runtime/manifest and deploys the entire `web/` tree (the index, nested node pages and shared assets) automatically on pushes to `main`. A maintainer can manually dispatch it on the exact reviewed PR branch permitted by the `github-pages` environment, retaining existing protections. Inference runs in the browser; speech loading needs about 91 MB of model/runtime assets and no ASR server. Translation weights download explicitly on Run (3.112 GB for TranslateGemma or 1.81 GB for PLaMo); text stays local.

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

Future inputs may include files, Web/article text and platform-specific sources alongside today's microphone and tab audio. Configurable text processing already supports summary and extraction prompts. Future processing capabilities may include storage and visualization; these remain architectural examples.

See the [architecture guide](docs/processing-pipeline.md) for conceptual nodes, typed ports and examples that distinguish existing behavior from future composition.

## Near-term direction

- Continue improving the reusable speech-to-text capability, including Japanese recognition, latency and browser usability.
- Evaluate useful pipelines, including speech-to-text → translation, committed transcript → incremental summary, and two-input text comparison, against representative inputs.
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
- Additional desktop environments and mobile hosts that reuse appropriate processing contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, the [test and CI principles](docs/development-flow.md#test-and-ci-principles) for validation scope and cost, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.

Live contains recording controls, graph-defined actions, Display tabs and actionable
errors. Graph Editor owns source/output connections; routine Node diagnostics are
available in Session details. There is no target panel. Microphone permission
is requested by Start; focused-field output follows the toolbar tab automatically.

`KeyedTextPair` has four independent NUMBER/TEXT inputs and exactly one output:
`pair: KEYED_PAIRED_TEXT`, an immutable `{ id, first, second }`. Each side keeps
its own ID and values; missing sides are empty strings. KeyedTextCoalesce selects
nonempty input1, otherwise input2, per ID. ID-only changes never replay completed
text. The accumulator appends new IDs and replaces existing IDs in arrival order,
emitting complete portable history. Display safely renders each whole TEXT,
pair or pair-list snapshot without accumulating history. Any TEXT processor,
including text summaries, connects directly to Display.input1.

See [contracts and wiring](docs/display-items.md), the
[importable graph](docs/examples/bilingual-history.json), and the
[executable fixture](tests/fixtures/item-graph.js). Legacy `Display.input` edges
convert to `input1` on Load/Import; Auto Save writes the numbered form. Other removed
display Nodes and ports are unsupported. Graph Editor reports them visibly and
keeps the original available for export. Repair it and import as a new Library
entry; saving a recovery draft cannot overwrite an invalid original. Each Live region follows updates
when reading near the bottom and preserves scroll position when reading above it.


## Streaming speech recognition

Exactly two local ASR Nodes are supported: **Moonshine Medium Streaming English**
(245M, 305 MB) and **Moonshine Small Streaming Japanese** (123M, 122 MB).
Both emit native provisional/final text on CPU WASM. The default/reset graph uses
Japanese Small. Choose English Medium explicitly for English speech. Japanese
Small is newly integrated; its quality on personal dictation needs evaluation.

```
npm run setup:extension
npm test
npm run test:playground
```

See [Moonshine assets, lifecycle, licensing and real inference checks](docs/optional-asr-nodes.md)
and [standalone pages](docs/node-playground.md). Unsupported saved graph types
must be recreated/reset; no automatic model substitution is performed.

Personalized ASR remains an important future capability/node within this system. It should learn from corrections to improve personal vocabulary, pronunciation, recurring mistakes and quiet speech, eventually including very quiet speech. Success requires improvement on held-out real audio without unacceptable regression; personalization is not implemented today.
