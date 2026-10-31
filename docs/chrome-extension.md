# Current-tab transcription Chrome extension

This desktop Chromium Manifest V3 PoC starts local transcription for the tab
on which you invoke its toolbar action. It uses the same ReazonSpeech ja-en,
Silero VAD and hayamimi utterance policy as the [Node Playground speech test page](node-playground.md). There is no
recognition server. Graph Editor also offers local multilingual Whisper tiny for
English or Text-driven Japanese recognition; see [Whisper setup and testing](whisper-node.md). For incremental English previews,
choose [Streaming Zipformer English ASR](zipformer-node.md), or opt into the independent
[Parakeet v3 and Moonshine Medium Streaming Nodes](optional-asr-nodes.md). The default whole-tab
graph needs no page injection or
media picker. Optional microphone, selected media and page-field outputs are
configured in Graph Editor and explicitly targeted in Live.

The extension uses the shared Node/Port runtime:

```text
ExtensionTab (chrome.tabCapture) → ExtensionTabAudioNode.audio
  → SpeechToTextNode.audio
    ├─ provisional → TranscriptOutputNode.provisional
    └─ final       → TranscriptOutputNode.final
```

The small extension audio adapter reuses the Web capture lifecycle and mono
16 kHz PCM contract. `TabSession` targets the invoked tab and renders the UI;
the shared speech node owns the existing ASR core and workers.

The extension keeps its own toolbar/transcript UI and packaging; it is not a Node Playground page.

The extension has three screens with a consistent dark appearance:

- **Live** puts graph-configured text displays and generated audio first. It
  supports zero, one or multiple independently labeled text regions, committed
  items, distinct Preview/Current value blocks and **Copy text**. A compact
  recording panel retains Start/Stop/Cancel, capture target, errors, progress and
  model recovery. Optional input/output targeting is collapsed until requested.
- **Graph Editor** opens a separate wide tab dominated by the typed-port canvas.
  **Add Node** opens search and categories; node settings appear only on
  selection. Zoom and Fit graph stay visible, Save is primary, and Graph actions
  groups load/reset/validation and optional warnings. Saving prepares required optional
  model weights with progress, cancellation and retry. Detailed help
  opens on demand. Drafts apply next session; external changes retain drafts and
  require Load saved before saving. Load/reset confirm before discarding edits.
- **Models** opens a dedicated tab (also Chrome's Extension options page), with
  bundled ReazonSpeech/Silero labels and verified cache controls for both OPUS-MT
  directions, TranslateGemma 4B (English ↔ Japanese) and Supertonic 3/Kokoro voices. Opening it never downloads weights.

Navigation opens auxiliary tabs while Live continues to own the active capture.
**Live window** focuses the existing recorder without invoking capture. Closing
auxiliary tabs does not end the session. A missing optional model links from Live
to Models for direction/voice-specific recovery; retry preparation, then start a new session.
See [graph editing](extension-graph.md), [model caching](extension-model-cache.md)
and [#109 validation/screenshots](evidence/ui-109.md).

## Build and load unpacked

Requirements: Chrome 116 or later, Python 3 and Node.js/npm.

From a fresh checkout, run this single command in the repository root:

```sh
npm run setup:extension
```

It runs `npm ci`, `prepare:assets`, `prepare:translation-assets`,
`prepare:whisper-assets`, `prepare:tts-assets`, `prepare:zipformer-assets`,
`prepare:optional-asr-assets`, `prepare:meeting-summary-assets` and
`build:extension` in that order, stopping at the first
failure. ASR preparation recreates `web/vendor/`, so translation preparation
must follow it. The individual npm scripts remain available.

Asset preparation needs network access on a fresh checkout: it downloads and
verifies the pinned ASR models and runtimes, staging an approximately
91 MB ReazonSpeech/Silero distribution, 44 MB Whisper weights and
58 MB English online Zipformer distribution. Building copies the maintained Web pipeline,
nodes, core, workers, configuration, capture helpers, models and license notices
into `dist/chrome-extension/`. Translation preparation adds about 28 MB of
checksum-pinned runtime JS/MJS/WASM. TTS preparation stages about 77 MB of reviewed
runtimes/frontends plus corresponding source. Optional ASR preparation adds about
41 MB of pinned runtimes, with the CSP adaptation and licenses described in
[optional ASR setup](optional-asr-nodes.md); the 1.26 GB / 305 MB weights stay out of the bundle. Optional OPUS-MT / TranslateGemma translation and
TTS and optional Parakeet/Moonshine ASR **weights** are prepared after a successful **Save graph** for saved processor
Nodes, or through **Download / retry** in Models; setup does not download or bundle them. These generated files are
ignored by Git.

Once assets are prepared, use the quick packaging command after source changes:

```sh
npm run build:extension
```

After rebuilding, open `chrome://extensions` and click **Reload** on the
extension's card. This reloads the unpacked `dist/chrome-extension` directory;
loading it again is unnecessary.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select **`dist/chrome-extension`** (the directory
   containing the generated root `manifest.json`).
3. Pin **Local current-tab transcription** in Chrome's Extensions menu.
4. Open a normal meeting/video/audio tab and click **Transcribe this tab** in
   the toolbar. A transcript window opens, loads the models, and starts capturing
   the tab you invoked. Loading time is excluded from capture; audio played
   before the active indication is not transcribed.
5. Return to the meeting tab; keep the transcript window open. It shows the
   active state, audio-signal status, provisional text and committed final text.
6. Click **Stop / finalize** to flush capture/VAD tails and drain final decoding
   and transcript output ports (and all final translations when enabled) before
   the UI reports completion.
   Copy the final text before closing the window.

**Start again** retries the selected tab and clears the previous transcript.
Each session loads fresh workers. To capture another tab, stop first, then
invoke the toolbar action on the new tab; it reuses the transcript window.
An invocation during a live session focuses its window and leaves the session
on its originally selected tab.

Tab navigation, closing the captured tab, or Chrome ending its stream finalizes
the session. Stop during model loading cancels before capture. Closing/reloading
the transcript window or unloading the extension releases media and workers,
discarding pending inference. Transcripts are held only in that window's memory.
Errors release capture and workers and leave retry available. If Chrome's
temporary tab grant has expired (for example after navigating to another origin),
invoke the toolbar action again on that tab. Chrome-internal pages and other
restricted tabs cannot be captured. A silent or muted tab may still expose a
valid audio track; the UI shows **No audio signal yet** until nonzero PCM arrives.

Chrome normally suppresses a captured tab's local playback. The extension
connects the captured source to the audio destination once to restore audible
playback; the separate ASR processor output remains muted. Only the captured
input is mixed to mono and resampled to 16 kHz using the Web helpers. Restored
playback is never an additional ASR input. See Chrome's
[tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
and [capture in a new extension window](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture#record_audio_and_video_in_a_new_tab).

## Optional page and microphone workflows

Save a graph with whole-tab, selected-media and/or microphone Inputs and
one or more outputs. Multiple independent ASRs and displays run concurrently;
parked or unfinished Nodes remain saved but inactive. See the
[execution and permission policy](extension-graph.md#stored-drafts-and-concurrent-execution). Live shows **Input and output targets** and separate target
status/errors. Connect `SpeechToTextReazonSpeech.final → FocusedInputTextOutputNode.text`
or `OPUS-MT.text → FocusedInputTextOutputNode.text` directly. These plain TEXT
strings can fan out to TTS and other consumers. For final-only output, select
ASR `final` or translation `text`. Bilingual formatting uses grouped primitive
source/text/error outputs; pending/errors never reach successful translation text sinks.

Invoke the toolbar on the desired normal page. Configured focused output is
prepared automatically on that same top-level document using `activeTab`, before
Live takes window focus. Focus a supported text/search input, textarea or basic
contenteditable to receive subsequent text. No additional output authorization,
field picker or cross-tab destination is supported. If Live temporarily steals
window focus, a valid prior user-focused field is retained until superseded;
no field is guessed when there was no valid focus. Dynamic YouTube-style comment
activation is covered by a controlled fixture; live YouTube compatibility has
not been manually verified. Complex editors, shadow roots and restricted frames
may require Live Copy.

Manual/selected text and existing whitespace are preserved. Incoming TEXT strings
append verbatim in order, including leading/trailing whitespace. No spaces,
newlines or other delimiters are added and no forms are submitted. Empty strings
are ignored; formatting and spacing belong upstream. Upstream final adapters
suppress repeated/stale IDs within the session and emit only confirmed
original/completed translations. The string input itself
needs no IDs. Sensitive/hidden/disabled fields and authentication/payment forms
are skipped, as are canceled `beforeinput` edits; a visible status explains the
skip while other branches continue. Page navigation, closure or permission loss
detaches the sink. Stop and invoke the page toolbar again to recover; a running
session never retargets when another tab's action is invoked. Page targets are
not persisted. Version 1/2 saved field graphs migrate through typed adapters or
show a Reset-and-Save recovery error. Selected media selection remains supported.
Stop drains new finals without replay; Cancel/closing Live discards queued work.

For selected media, play audio/video, discover in Live, then choose a labeled
entry. Its `captureStream()` supplies that element's audio separately, never a
mixed tabCapture stream. Currently playing same-origin/stream-backed top-frame
media is supported. Cross-origin/protected/DRM, restricted frames, missing audio
tracks and unavailable capture APIs show a whole-tab fallback explanation.
The extension does not bypass browser content protections. Save **Chrome tab
audio** for fallback where permitted. For microphone save **Microphone audio**
and press Start to request browser permission; denied/canceled permission is
visible and late-granted tracks are released after cancellation.
See [target policies, named ports and browser limitations](extension-graph.md).

## Permissions and local execution

| Manifest entry | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the specific tab where the user invokes the action; needed for `getMediaStreamId({targetTabId})`. |
| `scripting` | Inject the packaged isolated adapter only into a user-authorized top-frame document after toolbar invocation for configured focused output, or explicit media discovery in Live. No persistent host permissions. |
| `tabCapture` | Obtain that tab's audio stream, without the Web sharing picker. |
| `script-src 'self' 'wasm-unsafe-eval'` | Execute packaged scripts and the existing local WASM runtime. |
| COOP/COEP | Isolate the extension page/workers for the pinned runtime's shared WASM memory. |

No host, `tabs`, storage or offscreen permission is requested. Microphone uses
the browser getUserMedia permission flow only after explicit Start. Basic
tab IDs and lifecycle events are available without the `tabs` permission. All
scripts, translation runtimes and ASR weights are packaged locally; no remote code
is loaded. The
Models options page uses the existing extension-origin Cache Storage without adding permissions or changing the existing CSP. The toolbar
invocation grants capture authority; opening a window by itself does not grant
access to an arbitrary tab. The persistent window avoids a toolbar popup's
automatic teardown when the user returns to the meeting.

## Automated checks

```sh
npm run setup:extension
npx playwright install chromium webkit
npm test
npm run test:browser
npm run test:extension
```

The extension tests launch isolated Chrome-for-Testing profiles, load the actual
unpacked manifest via the browser DevTools `Extensions.loadUnpacked` API, and
exercise the extension page under its real CSP. This test-only debugger flag
and profile do not change installed Chrome or the extension's permissions.
The suite includes controlled API streams with real stereo Web Audio and
AudioWorklet/fallback processing, the production ASR core with deterministic
recognition workers, the actual shared pipeline graph, lifecycle/error/resource
checks, delayed transcript delivery and disposal, and real pinned
ReazonSpeech/Silero initialization and pipeline silence finalization under MV3 CSP.
The real-toolbar test uses `Extensions.triggerAction` on a generated audio tab
with native tab capture; deterministic decoding isolates capture behavior from
speech accuracy. A native permission check verifies that opening the extension
page without invoking its action cannot capture an arbitrary tab. Unit tests
also verify normalized PCM at 16/44.1/48 kHz,
playback routing, Stop/repeat, and stale-session rejection.
See the [Issue #61 validation evidence](evidence/extension-pipeline-61.md).

An optional manual speech check can use Google Meet, YouTube or another tab:
confirm audible playback, evolving provisional text, final text after Stop,
and cleanup after closing the tab/window. This PoC does not include participant
labels, overlays, Web Store publication or
cross-browser extension support. No post-merge verification is required by #61.

## Optional OPUS-MT Japanese ↔ English (#69 / #71)

Fresh installs default to a minimal transcription graph. Translation is an
explicit graph addition. Earlier enablement/direction preferences migrate once
when no graph is saved. The saved graph
persists in extension-origin localStorage across window recreation/profile restart;
transcripts are not saved. A new toolbar invocation uses the saved graph. See
[the executable visual graph editor](extension-graph.md) for editing, recovery,
validation and optional production Supertonic 3 / Kokoro audio paths.
In Graph Editor, add the concrete OPUS-MT direction from **Add Node →
Processors** and connect it to your desired display/output. Add **Text formatter** for source/translation labels and multiline composition.
Use its Settings to add/remove numbered inputs and edit the template. **Save graph**
stores valid drafts first, then prepares only the directions and voices required
by saved Nodes, including parked Nodes. No global direction switch changes other
branches. Japanese → English weights total 238,978,729 bytes (about 239 MB);
English → Japanese weights total 252,634,769 bytes (about 253 MB), plus cache/write
overhead. Graph Editor shows per-model verified readiness, byte progress, errors,
cancellation and retry below the graph. Download failures leave saved graphs intact.
**Models** retains diagnostics, retry and delete controls for missing, corrupt or
evicted files. Preparation reuses verified complete files and may run while
transcription remains active; Start/inference never downloads missing weights.
Saved graph changes apply to the **next session**: live Pipeline graphs are
immutable. Current/last session labels and retained final rows keep their captured
source/target direction. The transcription-only mode needs neither translation cache.

The original ASR preview remains available while committed translations are queued.
Translation publishes completed results only; no provisional translation or pending
history rows are produced. Runtime status shows loading/readiness/failure. A failure
can be displayed through the primitive `error` output while successful `text` sinks
receive nothing. Stop drains final speech and translations. Cancel or closing the
window discards pending work, releases Workers and ignores late completions.
Completed display items remain until the next Start; transcripts are not persisted.

For either direction, wire ASR.final → OPUS-MT.text. Connect its source/text/error
directly to TextFormatter.input1/input2/input3, then formatter.text →
TextAccumulator.append. For example, use `English: {1}` and `Japanese: {2}{3}`
on separate template lines. Every result appends once, including repeated phrases.
A direct group clears omitted formatter inputs, so failure cannot reuse an older
translation. Independent branches have no implied pairing. Plain successful text
also connects directly to display, field and TTS sinks. See
[formatter controls and migration recovery](extension-graph.md#optional-bounded-formatting).

The session-owned scheduler accepts plain committed strings into one FIFO and an
owned inner graph: source.text → direction-specific OpusMtTranslationNode.text →
TextOutputNode.text. It runs one inference at a time and keeps request identity
internal; it never compares equal source strings to join results. Empty/whitespace
utterances produce an empty translation without inference, preserving order.
Text over 1,000 characters produces a per-utterance error; model errors make
translation unavailable for that session while ASR continues. The tokenizer also
enforces 512 tokens and caps output at 256 tokens. Each Node owns its module Worker,
pinned runtime/checkpoint and cache-only loading; no remote inference or shared
model manager is involved. Graceful Stop drains all queued results; Cancel
terminates inference immediately. Fresh sessions use fresh Nodes.

`extension/opus-mt-assets.json` reviews all seven model files at immutable
revision `05470cd69b62aa32e3ee64ccfd41279789ee4b1e` with exact sizes and 1 MiB
chunk SHA-256 hashes. `scripts/review-opus-mt-assets.py` reproduces this manifest
via an explicit maintainer download; it is never invoked by build/install.
`extension/opus-mt-en-ja-assets.json` separately pins `Kadonox/opus-tatoeba-en-ja-onnx` at
`225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e` with exact sizes, whole-file and chunk
hashes. `python3 scripts/review-opus-mt-en-ja-assets.py` explicitly verifies its
remote metadata and downloaded bytes. The immutable cache keys cannot overlap
with Japanese → English assets.
Preparation uses the #67 streaming validator and Web Locks. Cache Storage is
owned by the extension origin even though keys are pinned HTTPS URLs. Opening
or enabling translation never fetches remote assets. The Worker verifies cache
readiness again, uses a custom cache with only reviewed canonical keys, and sets
`env.allowRemoteModels = false`: missing assets cannot trigger a download during
inference. Local optional-file lookups may return 404. Cached assets are reused
across windows/Chrome profile restarts subject to eviction. Offline execution
requires the complete cache plus packaged runtimes; the Playground's origin cache
is separate. Persistence is best effort, not a retention guarantee.

Preparation GETs immutable `huggingface.co` model paths and follows the host's
HTTPS asset-delivery redirects. Their CORS responses permit extension-page fetch
under COEP; no host permissions, remote-script CSP allowances or new capture
permissions are added. Runtime JS/MJS/WASM execute only from `chrome-extension:`.
Input text is sent only to the owned local Worker. OPUS-MT / Helsinki-NLP and ONNX
Community attribution and CC BY 4.0, plus English → Japanese base Apache 2.0
terms and Kadonox attribution, are shown next to the download control; see
[translation nodes](translation-nodes.md) for the pinned runtime archive hashes,
model limitations and license details. TranslateGemma 4B is also available as concrete English → Japanese / Japanese → English Nodes; see the TranslateGemma section below.

### Translation checks

`npm test` includes deterministic port wiring, coalescing, stale-result suppression,
final priority/order, load/inference failure isolation, cancellation, repeats and
UI statuses. `npm run test:extension` additionally exercises the real MV3 page,
cache API and production OPUS Worker with small asset/model-runtime fixtures,
preparation failures/retry and offline Chrome profile restart. These fixtures do
not establish real model inference.

Opt-in real-model smoke (no inference, ASR or capture mocks):

```sh
python3 scripts/prepare-reazon-ja-en-fixtures.py
EXTENSION_OPUS_SMOKE=1 npm run test:extension -- tests/extension/translation-smoke.spec.js
EXTENSION_OPUS_SMOKE=en-ja npm run test:extension -- tests/extension/translation-smoke.spec.js
```

This launches an isolated Chrome-for-Testing profile, triggers the actual toolbar
action on a tab playing checksum-pinned upstream Japanese or English WAV audio, explicitly
downloads real OPUS assets under MV3 CSP, and checks original ASR previews and committed translation
translations in the selected direction through production ASR and translation.
The English → Japanese smoke uses the committed [ordinary-English synthetic
speech fixture](../tests/fixtures/ordinary-english.md) and asserts meanings on
the actual final rows; the Japanese smoke uses the pinned upstream speech fixture. It recreates the recorder window
and repeats offline using cached
bytes and records browser capabilities, paired output, requests and errors in
`extension-opus-evidence.json`. Set `EXTENSION_HEADED=1` for headed testing.
When opted in, fixture/network/device/model errors fail visibly; the default
suite labels this large-download smoke opt-in. See [Issue #69 evidence](evidence/extension-translation-69.md)
for the original execution result, and [Issue #71 evidence](evidence/translation-direction-71.md)
for both-direction checks and real English → Japanese execution. The production
page smoke checks ordinary English meanings (greeting, meeting time, report,
station and deadline, including ASR uppercase forms); Japanese characters alone
do not establish translation. The English → Japanese Worker recases uppercase
English for inference; the copyable original and paired source stay unchanged.
No post-merge verification is required for the
unpacked extension; Web Store distribution is separate future work.

## TranslateGemma 4B English → Japanese

Add **TranslateGemma 4B English → Japanese** in Graph Editor. Connect
`ChromeTabAudio → English ASR.final → TranslateGemma.text`; connect its completed
`text` to `TextAccumulator.append`, a focused field or Japanese TTS. For a
controlled text test, connect `Text.value → TranslateGemma.text → TextAccumulator.append`.
For bilingual display, connect `source/text/error` directly to a `TextFormatter`
and then Live. Japanese → English is a separate Node using the same weights.
No preset or global language/model switch is added.

Before Save/use, read the linked Gemma Terms and Prohibited Use Policy in
**Help / Models**. Save prepares **3.112 GB** of optional weights only when the
graph contains either Gemma Node, including parked Nodes; both directions reuse
one verified cache. Allow **7 GB free storage**, several GB free RAM/GPU memory
and supported **Worker WebGPU**. Each active Node owns a separate GPU session.
Save remains successful if preparation fails; use Cancel/retry or Models for
recovery. Recording never fetches weights. GPU/adapter/memory failures are visible;
there is no CPU, OPUS-MT or remote fallback. The public ONNX conversion remains
subject to Google's upstream terms. See [runtime, provenance, terms and real-test
commands](translation-nodes.md#translategemma-in-the-extension-124) and
[#124 validation evidence](evidence/translation-124.md). No translation-quality
superiority to OPUS-MT is assumed.

Live displays accept only `dom: DOM`. Route complete TEXT snapshots through `TextToDOM.text → dom → LiveTextDisplay.dom`. For history, accumulate final TEXT with TextAccumulator and compose provisional TEXT through separate TextToDOM and DOMCombiner branches. For paired translation, explicitly wire `translator.source → PairedTextToDOM.input1` and `translator.text → PairedTextToDOM.input2`, then dom to the display for the latest pair only. An unconnected side stays empty; either input update emits both latest values. An atomic group clears omitted siblings within that group only; specific translation errors stay in translation diagnostics. For optional comparison history, insert DOMAccumulator between formatter and display. Graph v12 requires review and Save for old paired ports: source/text become input1/input2, and any former formatter error route is explicitly removed in the draft. Saved TEXT display graphs also require reviewed conversion; exact originals remain recoverable. See [DOM contracts and recovery](extension-graph.md#dom-formatters-and-display-ownership).
