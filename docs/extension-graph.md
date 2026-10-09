# Executable extension processing graphs (#75, #81, #87)

Open **Graph Editor** from Live or Models. It opens a separate full-size
extension tab. The left **Nodes** palette lists every supported concrete Node;
use its buttons or the Add Node selector. Drag a heading (or focus it and use
arrow keys) to move a Node. Click an output then a compatible named input, or
drag between ports, to connect. Ports show their contract types; incompatible
inputs are disabled during connection. Escape cancels a selected port. Use the
canvas scrollbars and **Canvas zoom** to navigate a large graph. Disconnect a
link below the canvas; Remove deletes a Node and its edges. Select a heading to
edit language/voice in the right **Settings** inspector. OPUS-MT directions are
separate executable Node types.

**Validate draft** reports connection/settings errors. **Save graph** validates
and stores the draft in extension-origin localStorage. **Load saved** discards
unsaved edits; **Reset draft to default** creates a recovery draft, which still
needs Save. The status distinguishes unsaved draft, saved next-session graph
and immutable active-session graph, queried from Live. Saving during capture
never changes Nodes, Workers, languages or routes in that session. Stop/finalize
or Cancel, then Start again to use the saved graph. Opening or closing the editor
or Models does not start, stop or retarget capture. **Live window** focuses the
existing recorder; without one, it explains how to invoke the toolbar.

Saved edits refresh other open pages. If another editor saves while this page
has a dirty draft, the draft stays intact and a conflict message requires
**Load saved** before saving. Saves compare the stored graph while holding a
Web Lock, preventing a racing editor from silently overwriting a newer graph.
Finish one editor's changes at a time; copy any desired draft settings before
Load saved. Recreated windows and Chrome restarts in the same profile retain the
saved graph. Drafts remain page-local. Transcripts/audio are never persisted.
Closing/reloading Live releases capture/Workers and revokes audio URLs.

Fresh installs use current-tab audio → SpeechToText → original transcript,
with an OPUS-MT Japanese → English paired translation branch. Existing boolean
translation enablement/direction preferences migrate once, including a saved
transcription-only choice. The editor's **Draft translation** controls edit this
same graph and require Save; there is no second preferences store. Removing
OPUS-MT also removes its view and dependent translated-audio branch.
Version 1/2 descriptions migrate to version 3 using the same storage key.
Legacy focused/selected field sinks with one unambiguous final route become a
focused TEXT sink plus FinalText or TranslatedFinalText; an existing matching
adapter is reused. Selected-field picking is removed. Ambiguous/malformed routes
fail visibly; Reset and Save in Graph Editor, then reconnect the explicit text
path to recover. Outputs are never silently dropped. Page/media handles are
never saved with a graph. Media selection is still available in Live.
A corrupt/unknown-version saved graph displays an error and prevents Start
until a valid graph is saved. Reset and Save in the editor to recover. Storage
failures remain visible.

## Supported graph and ports

The version 3 description is JSON with `version`, `nodes` and `edges`. Each Node
has `id`, concrete `type`, `settings`, and `position: { x, y }`. Each edge has
`from: [nodeID, outputPort]`, `to: [nodeID, inputPort]`. No implicit routes, payload
wrappers, model registry or remote execution are added. [The schema and default](../extension/graph.js)
are shared by storage, editor and execution; [the builder](../extension/graph-runtime.js)
constructs a real `Pipeline` with exactly those named-port edges.

| Concrete type | Inputs | Outputs / implementation |
| --- | --- | --- |
| ChromeTabAudio | — | audio: captured mono 16 kHz PCM; ExtensionTabAudioNode |
| SelectedPageMediaAudio | — | audio: selected element only, normalized mono 16 kHz PCM |
| MicrophoneAudio | — | audio: explicitly permitted microphone, normalized mono 16 kHz PCM |
| FocusedInputTextOutputNode | text: TEXT (one plain string input) | append to user-focused field in the toolbar-invoked document |
| SpeechToText | audio: captured PCM | provisional/final: TRANSCRIPT; SpeechToTextNode |
| TranscriptView | provisional/final: TRANSCRIPT | original/provisional/final UI; TranscriptOutputNode |
| OpusMtJaEn | provisional/final: TRANSCRIPT | provisional/final: paired TRANSLATION; TranslationSchedulerNode with OpusMtTranslationNode |
| OpusMtEnJa | provisional/final: TRANSCRIPT | provisional/final: paired TRANSLATION; TranslationSchedulerNode with EnglishToJapaneseOpusMtTranslationNode |
| TranslationView | provisional/final: TRANSLATION | paired, ordered original/translated rows |
| FinalText | final: TRANSCRIPT | text: plain TEXT string |
| TranslatedFinalText | final: TRANSLATION | text: completed final translation only; skips pending/errors |
| Supertonic3 | text: TEXT | audio: SYNTHESIZED_AUDIO; Supertonic3TextToSpeechNode (ja/en, F1/M1) |
| Kokoro | text: TEXT | audio: SYNTHESIZED_AUDIO; KokoroTextToSpeechNode (Japanese jf_alpha / English af_heart) |
| AudioOutput | audio: SYNTHESIZED_AUDIO | separate native audio player / WAV; AudioOutputNode |

Exactly one audio source and one ASR are required. At least one output destination
is required; original and translation views are independent optional sinks.
Multiple source Nodes are rejected before capture to avoid mixing ASR state. At most one paired
translation branch is supported, connected to the same ASR provisional/final
ports as the original view. Both view ports must be connected, preserving row
indices/order. Final-text adapters must connect to the matching final source.
Every input needs exactly one producer; every processor/source needs a connected
output. Extra dangling Nodes, unknown types/settings/ports, incompatible contract
identities, duplicate IDs/edges, cycles, missing connections and inconsistent
view/OPUS direction fail validation before Save or any Worker/capture startup.
Graphs are bounded to 24 Nodes/64 edges. ASR audio and generated TTS audio have
different contract identities and cannot connect interchangeably.

## Concrete input and output targets

In Live, open **Input and output targets**. Graph Editor chooses the concrete
Node and route; Live chooses the temporary browser target. Toolbar invocation
selects the capture tab. The default remains whole-tab audio → ASR → Live with
optional paired translation; it injects nothing into the page.

For page output, connect `SpeechToText.final → FinalText.final`, then
`FinalText.text → FocusedInputTextOutputNode.text`. For translations use
`OPUS-MT.final → TranslatedFinalText.final`, then
`TranslatedFinalText.text → FocusedInputTextOutputNode.text`. TRANSCRIPT and
TRANSLATION cannot connect directly to TEXT. Adapter outputs can fan out to
other TEXT consumers, including TTS; ASR/translation still fan out to Live.
The sink knows only strings, not model identity, translation status or IDs.

Invoke the toolbar on the desired normal web page. A configured focused sink
automatically prepares that tab's top-level Chrome document using `activeTab`
and the packaged isolated page agent, before Live takes window focus. There is
no extra authorization, field picker, cross-tab selection or persistent host
grant. New Live windows open unfocused during preparation. A running graph
ignores another toolbar invocation; Stop first to change the capture/output tab.
A graph saved after invocation applies next session; if it newly adds a focused
sink, invoke the page toolbar again to prepare its document.

Focus a supported field on the toolbar tab. Each arriving string follows current
eligible focus; the agent never searches for an arbitrary input. If Live steals
window focus and the editor blurs, a previously user-focused field is retained
only while it remains valid in that same document and no other focus/click has
superseded it. No previous focus, unsupported focus, disabled/hidden/sensitive
fields, cancellation by `beforeinput`, or unsupported rich editing skips that
value with a visible explanation. Focus another supported field for subsequent
values; skipped values are never replayed. YouTube-style dynamic comments are
supported when activation creates/focuses an accessible basic contenteditable.
Closed shadow roots and restricted/cross-origin frames require Live Copy.

A missing/stale document or lost permission/transport skips or detaches only
that output. ASR, translation, TTS, Live and other branches continue. If all text
destinations are unavailable, Live explicitly reports **No text destination is
active**. Stop and invoke the page toolbar again to recover. Navigation/closure
invalidates the pinned document; it never follows another tab or injects into a
new document automatically. Tab/media capture retains its existing stop-on-tab-
navigation behavior; microphone/Live can continue with output detached.

Final adapters apply a session-local monotonic ID policy when their transcript
producer supplies IDs, dropping repeated/stale confirmed results before emitting
plain strings. Completed translations alone emit text; provisional/pending/error
values do not. Distinct utterances with identical text remain distinct. A source
without IDs delivers each plain value once; the sink does not deduplicate by text.
Pipeline serializes each sink. Its page port uses a local sequence outside TEXT
and never retries an uncertain edit. Stop drains new final deliveries, with no
replay; Cancel aborts queued work and closes ports. Each new session has fresh
adapters and delivery state, with immutable graph/document snapshots.

Insertion preserves manual/selected content and appends at the end with a space
if needed, without submitting forms. Text/search inputs, textareas and basic
contenteditable use cancelable `beforeinput`, native value setters, plain text
nodes, and `input`/`change` events. Changed targets/content during `beforeinput`
are skipped. Password/payment/authentication, read-only/disabled/hidden/inert
fields and embedded-widget rich editors are rejected conservatively. Framework
compatibility varies; use Live Copy if a page rejects synthetic input events.
No HTML is inserted or page strings executed. The extension does not submit
text to a remote service.

**Selected page media audio**: play media in the toolbar-invoked capture tab,
then click **Discover media in capture tab** and choose a labeled audio/video
entry. Only top-frame, currently playing, same-origin or `srcObject` media with
capturable audio tracks is supported. This is real `HTMLMediaElement.captureStream()`
feeding a muted Web Audio capture processor in Chrome's isolated content-script
world, then the existing mono 16 kHz resampler in Live. It never uses tabCapture
as a substitute. The original media remains audible. No script is loaded from
the page or injected into its main world; a ScriptProcessor transports bounded
PCM over an extension-only Port without weakening page/extension CSP.
Cross-origin URLs (even with CORS), DRM/mediaKeys, no audio tracks, unavailable
captureStream, restricted frames or privileged pages are explained as unsupported.
Choose **Chrome tab audio** in Graph Editor and save for a whole-tab fallback
where Chrome permits it; browser protections are never bypassed. Disappearing,
changed or encrypted media ends capture and prompts re-selection. Discovery does
not start media or inspect frames.

**Microphone audio**: save this Input Node and press **Start again** in Live.
Toolbar invocation alone does not request permission. The browser's microphone
permission is requested before model loading from that explicit Start action.
Denied/canceled permission leaves a visible error and retry. Cancel/Stop/window
closure also stops late-granted tracks; resampling uses the existing PCM helpers.
Microphone requires no capture tab and is not mixed with tab/media capture.

## Optional TTS paths

Connect SpeechToText.final → FinalText.final → Supertonic3.text (or Kokoro.text)
→ AudioOutput.audio. To speak translations, use OPUS-MT.final →
TranslatedFinalText.final instead. Final adapters emit whole utterances. The TTS
branch splits long text into ordered snippets of at most 300 UTF-16 units without splitting surrogate pairs; this
respects production TTS's input limit. Choose the language/voice matching that
text. This is not automatic language/voice detection.

Use **Models** to inspect and prepare TTS assets. Select the same voice as the
TTS Node's inspector settings, then **Download / retry** explicitly prepares
only its pinned checkpoint and that voice: Supertonic 3 approximately 399 MB;
Kokoro approximately 93 MB. Both models can be managed without adding a Node.
Cancel/retry preserves verified files. Model-page voice selection does not edit
the saved graph. Voice variants share weights; deleting a variant can make
another voice unavailable. Runtime, Japanese dictionary/voice frontend, WASM
and matching eSpeak NG source/build bundle are packaged under the existing MV3
CSP. Weights are never bundled or silently downloaded during Start/inference.
See [reviewed manifests](../extension/tts-cache.js),
[TTS terms/frontends](tts-nodes.md), and the linked notices/source in Models.

Every session creates fresh production TTS Nodes and owned Workers. A small
branch lifecycle adapter verifies assets before startup and reports missing
cache, initialization, transport and synthesis errors while leaving transcription
usable. OPUS-MT retains its original scheduler/failure isolation. Stop drains
capture, final ASR, ordered translation and TTS inputs, then output delivery;
Cancel immediately aborts and terminates Workers and discards pending audio.
Completed audio uses separate player controls (press Play) and WAV downloads;
playback never becomes another ASR input. The next session clears prior players.

All inference/text stays in local Workers. Only explicit preparation sends
asset-only GET requests to immutable reviewed model URLs. Supertonic cache-only
reads never fall back to remote fetch; Kokoro sets `allowRemoteModels = false`
and uses a reviewed custom cache. Eviction requires another explicit download.
No remote script source, inference endpoint or GPU probe is added. Page adapters
use scoped `activeTab` plus `scripting`, with no persistent host permissions.

TranslateGemma is **not selectable**. Verifying its MV3 packaging, WebGPU and
asset terms is a documented next step, as permitted by #75.

## Validation

```sh
npm run setup:extension
npm test
npm run test:browser -- --workers=2
npm run test:extension
EXTENSION_TTS_SMOKE=all npm run test:extension -- tests/extension/graph-tts-smoke.spec.js
```

Setup prepares the assets in the required order and builds `dist/chrome-extension/`.
For source changes with assets already prepared, use `npm run build:extension`.
See [build, load and reload instructions](chrome-extension.md#build-and-load-unpacked).

Use `EXTENSION_TTS_SMOKE=Supertonic3` or `Kokoro` for one model. Tests download
weights only through the explicit preparation button. The TTS smoke runs the
saved description, Pipeline, production TTS Workers/runtimes/frontends and
native WAV decoding/playback under the real extension CSP; its ASR/capture input
is a fixture so it establishes TTS integration, not speech-recognition accuracy.
It generates Japanese, English and repeat English, checks finite nonzero mono
audio at native rates, drain/disposal and asset-only traffic. JSON records host,
browser, timings and waveform metrics. Separate existing OPUS smokes exercise
native tab capture, real ASR and both real OPUS-MT directions with offline repeat.

Schema/composition tests check actual production port identities. MV3 fixture
checks cover edit/move/connect/disconnect, migration/defaults, invalid graphs,
recovery, active/saved distinction, transcription-only, Chrome profile restart,
cache/preparation errors, repeats, TTS cancellation/failure, audio playback and
privacy. Heavy runtime/model boundaries are explicitly simulated in fixture
checks. [Recorded evidence](evidence/graph-75.md) distinguishes those from real
inference. `scripts/review-tts-assets.py` is an optional maintainer review that
explicitly downloads/checks #73's pinned bytes/LFS hashes and regenerates the
extension's bounded 1 MiB chunk hashes; build/install never runs it.

No post-merge deployment verification is required for this unpacked extension.
No website/Chrome Web Store publication is part of this change.

### #87 source and destination checks

[Local validation results and limitations](evidence/graph-87.md) separate fixture
coverage from real ASR inference and report shared WebKit cleanup timeouts.

`tests/extension/targets.spec.js` runs the packaged MV3 graph with native toolbar
invocation, tab/media capture, DOM editing, and Chrome microphone permission
(the device is Chromium's fake microphone). ASR/translation inference is fixture
code. Focus tests use **headed Chromium** with Playwright focus emulation disabled
and Live in a separate popup, asserting real browser-window deactivation. On
Linux run under a display or `xvfb-run -a npm run test:extension`.

These checks cover automatic same-tab preparation, no target, changing focus,
text/search/textarea/basic contenteditable, dynamic comment activation, editors
that blur on window deactivation, replacement/disconnection, sensitive/hidden/
disabled fields, frames, `beforeinput` cancellation, native controlled-input
setters, ordered once-only finals, translated output with concurrent Live,
navigation/closure, native activeTab denial, controlled connection/permission
loss, Stop, Cancel and retry. Unit checks cover version 1/2 migration/recovery
and TEXT fan-out. The two-tone media test still proves selected-element audio
isolation; cross-origin, audio-less and deterministic protected-media cases
remain fixtures, not external DRM verification.

Run the separate real speech/field smoke after building:

```sh
EXTENSION_TARGET_SMOKE=1 npm run test:extension -- tests/extension/targets-real-smoke.spec.js
```

This uses the committed checksum-pinned English speech WAV, native tabCapture,
the real bundled ReazonSpeech/Silero workers, automatic same-tab preparation,
and FinalText → focused TEXT insertion concurrently with Live, without inference
mocks or remote traffic. It compares every confirmed Live utterance to appended
field text after Stop. [Recorded real-ASR evidence](evidence/graph-87-real-asr-field.json)
contains counts/runtime metadata without transcripts.

Direct live YouTube search/comments have **not** been verified by the controlled
fixtures or real-ASR smoke. Site-specific rich editors, native microphone hardware,
meeting apps, DRM and restricted external frames remain optional manual checks.
No post-merge verification is required for the locally unpacked extension.
