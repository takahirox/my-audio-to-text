# Current-tab transcription Chrome extension

This desktop Chromium Manifest V3 PoC starts local transcription for the tab
on which you invoke its toolbar action. It uses the same ReazonSpeech ja-en,
Silero VAD and hayamimi utterance policy as the [Node Playground speech test page](node-playground.md). There is no
recognition server, page injection, microphone capture or tab-selection picker.

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

- **Live** is the compact toolbar-opened recorder window. It shows the actual
  capture target/status, Start/Stop/Cancel, a distinctly marked provisional pair,
  ordered completed original/translation rows, **Copy final text**, and generated
  audio players/WAV downloads for configured TTS paths. Final text is also
  selectable in the full original transcript disclosure.
- **Graph Editor** opens a separate wide tab with a Node palette, scrollable and
  zoomable typed-port canvas, connections and selected-Node settings inspector.
  Draft edits require Save and apply only on the next session. Conflicting saves
  from another editor preserve the draft and require Load saved.
- **Models** opens a dedicated tab (also Chrome's Extension options page), with
  bundled ReazonSpeech/Silero labels and verified cache controls for both OPUS-MT
  directions and Supertonic 3/Kokoro voices. Opening it never downloads weights.

Navigation opens auxiliary tabs while Live continues to own the active capture.
**Live window** focuses the existing recorder without invoking capture. Closing
auxiliary tabs does not end the session. A missing optional model links from Live
to Models; explicitly prepare its direction/voice, then start a new session.
See [graph editing](extension-graph.md), [model caching](extension-model-cache.md)
and [#77 validation/screenshots](evidence/ui-77.md).

## Build and load unpacked

Requirements: Chrome 116 or later, Python 3 and Node.js/npm.

```sh
npm ci
npm run prepare:assets
npm run prepare:translation-assets
npm run prepare:tts-assets
npm run build:extension
```

Asset preparation downloads and verifies the existing pinned approximately
91 MB runtime/model distribution. Building copies the maintained Web pipeline,
nodes, core, workers, configuration, capture helpers, models and license notices
into `dist/chrome-extension/`. Translation preparation adds about 28 MB of
checksum-pinned runtime JS/MJS/WASM. TTS preparation stages about 77 MB of reviewed
runtimes/frontends plus corresponding source; OPUS-MT/TTS weights are not bundled. These
generated files are ignored by Git. Rebuild
after source changes; reload the extension in Chrome after rebuilding.

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

## Permissions and local execution

| Manifest entry | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the specific tab where the user invokes the action; needed for `getMediaStreamId({targetTabId})`. |
| `tabCapture` | Obtain that tab's audio stream, without the Web sharing picker. |
| `script-src 'self' 'wasm-unsafe-eval'` | Execute packaged scripts and the existing local WASM runtime. |
| COOP/COEP | Isolate the extension page/workers for the pinned runtime's shared WASM memory. |

No host, `tabs`, storage, microphone or offscreen permission is requested. Basic
tab IDs and lifecycle events are available without the `tabs` permission. All
scripts, translation runtimes and ASR weights are packaged locally; no remote code
is loaded. The
Models options page uses the existing extension-origin Cache Storage without adding permissions or changing the existing CSP. The toolbar
invocation grants capture authority; opening a window by itself does not grant
access to an arbitrary tab. The persistent window avoids a toolbar popup's
automatic teardown when the user returns to the meeting.

## Automated checks

```sh
npx playwright install chromium webkit
npm test
npm run test:browser
npm run prepare:assets
npm run prepare:translation-assets
npm run prepare:tts-assets
npm run build:extension
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
labels, overlays, simultaneous microphone input, Web Store publication or
cross-browser extension support. No post-merge verification is required by #61.

## Optional OPUS-MT Japanese ↔ English (#69 / #71)

Fresh installs default to the saved transcription + Japanese → English translation
graph. Earlier enablement/direction preferences migrate into it. The saved graph
persists in extension-origin localStorage across window recreation/profile restart;
transcripts are not saved. A new toolbar invocation uses the saved graph. See
[the executable visual graph editor](extension-graph.md) for editing, recovery,
validation and optional production Supertonic 3 / Kokoro audio paths.
In Graph Editor, select Japanese → English or English → Japanese in the draft,
then **Save graph**. In Models, use **Download / retry** on that direction to
explicitly download the pinned model data
(Japanese → English: 238,978,729 bytes, about 239 MB; English → Japanese:
252,634,769 bytes, about 253 MB; plus cache/write overhead). Progress, readiness,
failures and cancellation are visible. This control also retries missing,
corrupt or evicted files and reuses verified complete files. Preparation can run
while transcription remains active. Check **Include OPUS-MT** in Graph Editor,
then **Save graph**, Stop capture and **Start again**. The checkbox does not download assets;
starting with missing assets reports translation unavailable while preserving ASR.
The exclusive direction select can change during capture, but applies only to the
**next session**: live Pipeline graphs are immutable. Current/last session labels
and retained final rows keep their captured source/target direction. Model-cache
readiness/progress are shown per model in Models, independently of the active graph.
Only the selected model downloads; enabling translation never downloads either
model implicitly. The transcription-only mode works without either translation cache.

The original provisional text and translation appear together with explicit
source/output language headings and `lang` attributes. **Translating…**
means the current original has no completed translation. An **Older interim**
translation includes its own original text and never claims to match the latest
original. Each final original is also paired with its translation/status in an ordered
utterance list; the original final transcript remains available for copying.
Load/inference failures label affected translations and keep speech working.
Stop drains final speech and translations before reporting completion. **Cancel session**
or closing the
window immediately cancels pending work; transcripts are not persisted.

The outer graph explicitly connects `SpeechToTextNode.provisional/final` to
`TranslationSchedulerNode.provisional/final`, and paired outputs to the translated
sink. This session-owned adapter bridges the transcript contract to an owned
inner graph: `source.text → OpusMtTranslationNode.text → TextOutputNode.text`
for Japanese → English, or the independent `EnglishToJapaneseOpusMtTranslationNode`
for English → Japanese. Each Node owns its direction-specific Worker; no switchable
model is placed inside a Node.
The production translation node owns its module Worker, loads the existing
pinned checkpoint/runtime, and performs all inference in that Worker.
There is no shared model manager, duplicate inference or remote inference call.

Scheduling is deliberately small: one request in flight, one replaceable pending
provisional, and a FIFO of all nonempty final utterances. New provisional input
increments a version; outdated in-flight output is ignored. A final invalidates
old interim work and takes priority when the in-flight call settles. Already
running inference is allowed to finish; it cannot overwrite new/final content.
`receive()` returns immediately, so Pipeline input serialization does not hold
provisional requests behind inference. Stop rejects further provisional work,
lets ASR finalize, then drains all finals and the translation graph. Dispose
terminates its Worker and guards late output; a repeated session gets fresh nodes.
Final rows have stable arrival indices, so asynchronous results cannot reorder
original/translation pairs. Text over 1,000 characters receives an explicit per-row
error; other model errors make translation unavailable for that session. The
production OPUS tokenizer also enforces 512 tokens and caps output at 256 tokens.

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
model limitations and license details. TranslateGemma is not integrated.

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
downloads real OPUS assets under MV3 CSP, and checks original/provisional/final
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
