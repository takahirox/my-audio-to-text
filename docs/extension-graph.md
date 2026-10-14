# Executable extension processing graphs (#75, #81, #87, #95, #99)

Open **Graph Editor** from Live or Models. It opens a separate full-size
extension tab. The left **Nodes** palette lists every supported concrete Node;
use its buttons or the Add Node selector. Drag a heading (or focus it and use
arrow keys) to move a Node. Click an output then a compatible named input, or
drag between ports, to connect. Ports show their contract types; incompatible
inputs are disabled during connection. Escape cancels a selected port. Use the
canvas scrollbars and **Canvas zoom** to navigate a large graph. Connecting to
an occupied input replaces only its incoming wire; other inputs and source
fan-out stay intact. Repeating the same connection changes nothing. Invalid
connections keep the previous wire. Click a wire directly on the canvas (or
focus it and press Enter/Space): the selected wire turns yellow and reveals a
nearby **Disconnect** button on the canvas. Selecting alone keeps the wire.
Click or tap Disconnect to remove only that edge; it needs no hover or keyboard.
The button and wire hit targets keep the same screen size at every supported
zoom, and the button stays within the visible canvas near the selected segment,
preferring space clear of Nodes, ports and other wires. With a selected wire
focused, Tab moves to Disconnect; Enter/Space activates it. Delete/Backspace on
a focused wire also removes it. Escape or clicking blank canvas clears selection
and hides Disconnect. After removal, focus returns to the scrollable canvas.
Remove deletes a Node and its edges. Select a heading to
edit display labels, templates, language/voice in the right **Settings** inspector. OPUS-MT directions are
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

Fresh installs and **Reset draft to default** use exactly three Nodes:
`ChromeTabAudio`, `SpeechToText`, and one generic `LiveTextDisplay` labeled Text
(language unspecified). The three named-port edges are `ChromeTabAudio.audio →
SpeechToText.audio`, `SpeechToText.provisional → LiveTextDisplay.replace`, and
`SpeechToText.final → LiveTextDisplay.append`. No translation or formatter is
included. Reset changes only the draft until Save; upgrades never replace a
saved graph with the new default. Existing explicit boolean translation
preferences migrate once when no graph is saved: only `enabled: true` adds the
translation branch. Missing/corrupt preferences use the minimal default; saved
graphs always take precedence, preserving custom settings and routes.

The editor's **Draft translation** controls edit this same graph and require
Save; there is no second preferences store. The convenience
direction control changes all configured OPUS-MT Nodes; choose concrete Node
types in the graph for independently directed branches. Removing
OPUS-MT also removes exclusively dependent formatting/display/audio branches.
Shared sinks with other connected producers remain.
Version 1–5 descriptions migrate explicitly to version 6 using the same storage
key. Legacy field sinks become focused TEXT sinks; extraction adapters reconnect
every downstream route, preserving fan-out. Version 4 paired result edges first
expand to primitive bundles. Version 5 `TranscriptView` becomes `LiveTextDisplay`
with `provisional → replace` and `final → append`. Its direction becomes display
language and the next-session direction preference. Plain `TranslationView`
becomes a generic display with `provisionalText → replace` and `text → append`.

A paired `TranslationView` becomes a generic display with the same ID/position,
plus a **Paired text formatter (compatibility)**. Every original source, status,
index, error and text wire is redirected to this formatter. It formats indexed
source/translation history into TEXT, feeding the display's `replace`. Pending
rows update in place; repeated identical sources remain distinct; errors and
cancellation remain visible. Translation direction comes from the connected
processing Node, never the display label. Generated IDs avoid collisions.
Descriptions do not persist text history; completed history within a session is
retained through Stop/Cancel and saving a draft. A fresh Start resets outputs.
Malformed/ambiguous routes, incomplete paired bundles or migration exceeding the
24-Node/64-edge bound fail visibly without overwriting the saved description.
Fix/import the desired routes or Reset and Save in Graph Editor to recover.
Page/media handles are never saved with a graph.

## Supported graph and ports

Version 6 is JSON with `version`, `nodes`, `edges`, and an optional
`translationDirection` next-session preference (used when no translator exists).
Each Node has `id`, concrete `type`, `settings`, and `position: { x, y }`.
Each edge has `from: [nodeID, outputPort]`, `to: [nodeID, inputPort]`.
[Schema/defaults](../extension/graph.js), editor, storage and the
[builder](../extension/graph-runtime.js) use the same named-port description.

| Concrete type | Inputs | Outputs / behavior |
| --- | --- | --- |
| ChromeTabAudio | — | audio: mono 16 kHz PCM |
| SelectedPageMediaAudio | — | audio: selected-element mono 16 kHz PCM |
| MicrophoneAudio | — | audio: explicitly permitted microphone PCM |
| FocusedInputTextOutputNode | text: TEXT | append verbatim to focused editable field |
| SpeechToText | audio: PCM | provisional/final: TEXT |
| LiveTextDisplay | replace / append: TEXT, individually optional | one labeled Live region; at least one input must connect |
| TextFormatter | input1–input4: TEXT, individually optional | text: TEXT; at least one input must connect |
| OpusMtJaEn / OpusMtEnJa | provisional (optional) / text: TEXT | successful provisional/text plus grouped source/status/error TEXT, finalIndex NUMBER |
| PairedTextFormatter | complete translator final bundle, optional complete preview bundle | text: TEXT containing indexed source/translation/status history; compatibility only |
| Supertonic3 / Kokoro | text: TEXT | audio: SYNTHESIZED_AUDIO; configured language/voice |
| AudioOutput | audio: SYNTHESIZED_AUDIO | native audio player / WAV |

Exactly one audio source and one ASR are required in this capture graph. At least
one output destination is required. No Live display is required for focused-field
or audio-only output. Multiple translators and displays are supported. Type
identity determines compatibility; generic sinks accept arbitrary TEXT producers.
Unknown settings/ports/types, duplicate IDs/edges, multiple routes into one input,
missing required connections and cycles fail before Save or Worker startup.

### Generic text displays

[The reusable TEXT Nodes](../web/text-nodes.js) are shared, Chrome-independent
Pipeline implementations. `LiveTextDisplay` owns a replace value plus an ordered list of appended items.
Replace updates the current value verbatim, including clearing with `''`. Every
append adds one new item, even when empty or equal to a previous item, and clears
the pending replace value. Append wins if both inputs arrive in a directly grouped
emission, independent of property order. A later independent replace starts a new
preview: no source matching, deduplication or model knowledge is inferred.
With append connected, Stop/Cancel discard the uncommitted preview and retain
items. A replace-only display retains its current value for copying. Start uses
fresh sink instances. The compatibility formatter clears its own preview and
retains completed history on Stop; Cancel marks pending rows canceled locally.

Live renders one region per configured sink, ordered by Node array order, with
its user-supplied label (1–120 characters) and optional language. Labels and all
values use `textContent`, never HTML. Committed DOM items with an unchanged
prefix stay attached; only new items are appended. Preview updates are separate,
so ordinary previews/appends retain committed text selection and do not force a
scroll jump. Resets and replaced/shortened histories remove stale items. Each
region has Copy text. Runtime/model, capture, target and error status remain
outside display content. The active graph
owns labels/routes throughout a session; saving a draft applies only on the next
Start. Stopped history keeps the last graph's labels until then. Output-only graphs
render no text regions and add no implicit fallback display.

### Optional bounded formatting

`TextFormatter` accepts up to four plain TEXT inputs. Its template (at most 2048
characters) supports only `{1}`–`{4}`, literal labels/newlines and doubled braces:
`{{` renders `{`, `}}` renders `}`. Other unescaped braces are invalid. For example,
`Source: {1}` followed by a literal newline and `Result: {2}` composes two values.
Absent values are empty strings; received empty strings explicitly clear values.
Input text is substituted once, never interpreted as template syntax or HTML.
There are no expressions, scripts, property access or full template engine.

Each input emission updates the latest values and emits one formatted TEXT string
immediately. `receiveInputs()` applies a directly grouped `emitOutputs()` update
once. Separate emissions/branches produce separate updates using cached latest
values; they are **not automatically correlated**, even when strings or timings
match. Use a direct grouped producer when association is required. Formatting is
optional: ASR, translation, correction, LLM or another TEXT producer can feed a
generic sink directly. Model availability only limits which production processors
are currently exposed in Graph Editor.

`PairedTextFormatter` is the narrow compatibility strategy for existing indexed
translation behavior that a latest-value template cannot reproduce. It requires
matching direct primitive outputs from one translator. It emits whole-history
TEXT replacements, so pending/error/completed row updates never append duplicates.
It is also used by the explicitly enabled bilingual configuration; Live has no
paired-row renderer.
New typed display sinks can later add their own contract, Node state and a small
renderer keyed to the sink type. They need not bind Live to producer/model types.
This iteration introduces no image/chart/video types, renderer SDK or event bus.

## Concrete input and output targets

In Live, open **Input and output targets**. Graph Editor chooses the concrete
Node and route; Live chooses the temporary browser target. Toolbar invocation
selects the capture tab. The default is whole-tab audio → ASR → one Live text
display; it injects nothing into the page.

For page output, connect `SpeechToText.final → FocusedInputTextOutputNode.text`
or `OPUS-MT.text → FocusedInputTextOutputNode.text` directly. Text can fan out to
TTS and other TEXT consumers while ASR/translation independently feed Live.
The sink knows only strings, not model identity, translation status or IDs.
Select final/completed ports for insertion; provisional ports have replacement
semantics and should feed preview consumers. See the [contract audit](port-contracts.md).

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
destinations are unavailable and no audio output exists, Live explicitly reports **No text destination is
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

Insertion preserves manual/selected content, including existing whitespace, and
appends each incoming TEXT string verbatim at the end without submitting forms.
No spaces, newlines or other delimiters are added; incoming leading/trailing
whitespace is preserved and empty strings are ignored. For example, `今日は`
followed by `いい天気ですね` produces `今日はいい天気ですね`; appending ` world`
to `Hello` produces `Hello world` because the incoming string supplies the space.
Formatting and spacing belong upstream. Text/search inputs, textareas and basic
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

Connect SpeechToText.final → Supertonic3.text (or Kokoro.text) → AudioOutput.audio.
To speak translations, connect OPUS-MT.text directly to TTS.text. These outputs
emit whole utterances; pending/error diagnostics use separate ports. The TTS
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
See [on-canvas edge removal checks (#97)](evidence/graph-97.md) for pointer/touch,
keyboard, zoom, persistence and session-isolation coverage and local results.

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
and ASR final TEXT → focused insertion concurrently with Live, without inference
mocks or remote traffic. It compares every confirmed Live utterance to appended
field text after Stop. [Recorded real-ASR evidence](evidence/graph-87-real-asr-field.json)
contains counts/runtime metadata without transcripts.

Direct live YouTube search/comments have **not** been verified by the controlled
fixtures or real-ASR smoke. Site-specific rich editors, native microphone hardware,
meeting apps, DRM and restricted external frames remain optional manual checks.
No post-merge verification is required for the locally unpacked extension.

### #101 default and append checks

[Append investigation and local validation](evidence/graph-101.md) distinguish
committed state from DOM replacement, source final-ID filtering and intentional
new-session resets, and record default/migration, selection/scroll and palette
translation checks with optional real-model limits.
