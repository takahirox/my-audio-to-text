# Executable extension processing graphs (#75)

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
A corrupt/unknown-version saved graph displays an error and prevents Start
until a valid graph is saved. Reset and Save in the editor to recover. Storage
failures remain visible.

## Supported graph and ports

The version 1 description is JSON with `version`, `nodes` and `edges`. Each Node
has `id`, concrete `type`, `settings`, and `position: { x, y }`. Each edge has
`from: [nodeID, outputPort]`, `to: [nodeID, inputPort]`. No implicit routes, payload
wrappers, model registry or remote execution are added. [The schema and default](../extension/graph.js)
are shared by storage, editor and execution; [the builder](../extension/graph-runtime.js)
constructs a real `Pipeline` with exactly those named-port edges.

| Concrete type | Inputs | Outputs / implementation |
| --- | --- | --- |
| ChromeTabAudio | — | audio: captured mono 16 kHz PCM; ExtensionTabAudioNode |
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

One source, one ASR and one original view are required. At most one paired
translation branch is supported, connected to the same ASR provisional/final
ports as the original view. Both view ports must be connected, preserving row
indices/order. Final-text adapters must connect to the matching final source.
Every input needs exactly one producer; every processor/source needs a connected
output. Extra dangling Nodes, unknown types/settings/ports, incompatible contract
identities, duplicate IDs/edges, cycles, missing connections and inconsistent
view/OPUS direction fail validation before Save or any Worker/capture startup.
Graphs are bounded to 24 Nodes/64 edges. ASR audio and generated TTS audio have
different contract identities and cannot connect interchangeably.

## Optional TTS paths

Connect SpeechToText.final → FinalText.final → Supertonic3.text (or Kokoro.text)
→ AudioOutput.audio. To speak translations, use OPUS-MT.final →
TranslatedFinalText.final instead. Final adapters split long text into ordered
snippets of at most 300 UTF-16 units without splitting surrogate pairs; this
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
No permission, remote script source, inference endpoint or GPU probe is added.

TranslateGemma is **not selectable**. Verifying its MV3 packaging, WebGPU and
asset terms is a documented next step, as permitted by #75.

## Validation

```sh
npm ci
npm run prepare:assets
npm run prepare:translation-assets # after ASR preparation, which replaces vendor/
npm run prepare:tts-assets
npm run build:extension
npm test
npm run test:browser -- --workers=2
npm run test:extension
EXTENSION_TTS_SMOKE=all npm run test:extension -- tests/extension/graph-tts-smoke.spec.js
```

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
