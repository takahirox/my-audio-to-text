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
configured in Graph Editor. Focused output follows the toolbar tab automatically;
microphone permission is requested by Start. Selected-page media is temporarily
unavailable (see below).

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

The extension has three screens. Live uses a light reading surface; Graph Editor
and Models keep their dark appearance:

- **Live** puts graph-configured text displays and generated audio first. It
  supports zero, one or multiple independently labeled text regions, committed
  items and distinct Preview/Current value blocks. Each Display input is a
  switchable tab whose pane shows only content, without a repeated heading or
  Copy text control. Select and copy text using the browser's native commands. A compact
  recording panel retains Start/Stop and an accurate session-state pill.
  Graph-configured Button sources appear in a separate Graph Actions band when
  present. Actionable errors, graph-change warnings and model recovery remain
  visible. Only the overall session state and permission instructions appear
  alongside recording controls; routine per-Node waiting, loading, inference,
  queue and completion diagnostics are available on demand in **Session details**.
  Live has no input/output target panel or selector.
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
and [Live control validation/screenshots](evidence/live-225.md).

## Build and load unpacked

Requirements: Chrome 116 or later, Python 3 and Node.js/npm.

From a fresh checkout, run this single command in the repository root:

```sh
npm run setup:extension
```

It runs `npm ci`, `prepare:assets`, `prepare:translation-assets`,
`prepare:whisper-assets`, `prepare:tts-assets`, `prepare:zipformer-assets`,
`prepare:optional-asr-assets`, `prepare:text-summary-assets` and
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
   the toolbar. Live opens and shows **Preparing models…** while it initializes
   models on the saved graph's executable paths. Start stays disabled until
   **Ready**. Press **Start** to capture the selected tab with those warm models;
   audio played before the active indication is not transcribed.
5. Return to the meeting tab; keep the transcript window open. It shows the
   active state, provisional text and committed final text. Audio-signal and
   per-Node diagnostics are available in Session details.
6. Click **Stop** to flush capture/VAD tails and drain final decoding
   and transcript output ports (and all final translations when enabled) before
   the UI reports completion.
   Copy the final text before closing the window.

**Start** retries the selected tab and clears the previous transcript.
Stop releases used Workers and restores readiness before the next Start; Start
uses the already prepared Workers without reloading. To capture another tab, stop first, then
invoke the toolbar action on the new tab; it reuses the transcript window.
An invocation during a live session focuses its window and leaves the session
on its originally selected tab.

Tab navigation, closing the captured tab, or Chrome ending its stream finalizes
the session. Stop during model preparation cancels before capture; use Retry models
to prepare again. Closing/reloading
the Live page/window or navigating away releases media and workers immediately,
without waiting for pending summarization or translation. Close Live to abandon
a session; there is no built-in Cancel recording control. Internal
`TabSession.cancel()` and `Pipeline.cancel()` still handle teardown and errors. Transcripts are held only in that window's
memory.
Preparation failures keep Start disabled and show per-Node errors. Recover missing
files through Graph Save or Models, check browser/GPU support and free memory,
then press **Retry models** in Live. See the [model lifecycle](extension-graph.md#live-model-lifecycle-239).
Session errors release failed resources and leave recovery available. If Chrome's
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
[execution and permission policy](extension-graph.md). Graph Editor owns source
and output choices; Live shows actionable errors without target controls. Connect `SpeechToTextReazonSpeech.final → FocusedInputTextOutputNode.text`
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
may require selecting and copying Live's displayed text with browser commands.

Manual/selected text and existing whitespace are preserved. Incoming TEXT strings
append verbatim in order, including leading/trailing whitespace. No spaces,
newlines or other delimiters are added and no forms are submitted. Empty strings
are ignored; formatting and spacing belong upstream. Upstream final adapters
suppress repeated/stale IDs within the session and emit only confirmed
original/completed translations. The string input itself
needs no IDs. Sensitive/hidden/disabled fields and authentication/payment forms
are skipped, as are canceled `beforeinput` edits; an actionable error explains the
skip while other branches continue. Routine insertion counts and successful
connections appear only in Session details. Page navigation, closure or permission loss
detaches the sink. Stop and invoke the page toolbar again to recover; a running
session never retargets when another tab's action is invoked. Page targets are
not persisted. Unsupported saved field/display ports require Reset or Import of a current graph and an explicit Save.

**Temporary selected-media limitation:** `SelectedPageMediaAudio` cannot capture
until a replacement selection workflow exists. Live no longer offers discovery
or element selection. Start reports an error naming the source and suggesting
`ChromeTabAudio` in Graph Editor; it never guesses an element or silently captures
whole-tab audio. Independent complete graph branches continue. Selection on the
target Web page is explicitly deferred to a separate task. Saved graph topology
is preserved.

For microphone save **Microphone audio**
and press Start to request browser permission; denied/canceled permission is
visible and late-granted tracks are released after cancellation.
See [target policies, named ports and browser limitations](extension-graph.md).

## Opt-in Web voice typing (#247)

In **Graph Library → Launch Settings**, explicitly turn **Web Page Microphone**
**ON**. Graph selection lives on the existing field-attached microphone: left-click
starts the default and right-click opens a small menu of compatible saved graphs.
Focus the mic and press Shift+F10 (or the context-menu key/Alt+Down) for the same
keyboard menu; arrows/Home/End navigate, Enter selects, Escape dismisses.
Selection only saves the default: it never starts recording, loads models or
requests microphone permission. The original editable target and caret survive
menu use. There is no Web graph dropdown in Launch Settings.
The preference defaults OFF on installation/upgrade, even with an existing
`assignments.webVoice`. It is a separately validated versioned boolean in
`chrome.storage.local`; graph JSON remains version 15. Assignment never grants
consent and the Live assignment is never used as a fallback.

The single default Web microphone graph ID is stored as
`web-microphone-default-v1` in `chrome.storage.local`. A compatible legacy
`assignments.webVoice` migrates on first use. One compatible graph is selected
automatically; with multiple candidates and no valid saved default, left-click
asks for explicit selection. Deletion/incompatibility clears an invalid default
and automatically falls back only if exactly one candidate remains. A saved
choice survives browser restarts and updates all page controls. Library changes
refresh eligibility; a running session retains its validated graph snapshot.
Preparing/Recording/Stopping controls cannot switch or start a second graph.
With zero compatible graphs no page mic appears; existing settings explain the
required path. Enabling remains an independent explicit opt-in.

Turning ON explains and requests optional HTTP/HTTPS host access through Chrome.
Denial leaves the feature OFF. Browser/internal pages, the Chrome Web Store,
frames and sensitive editors remain unsupported. Chrome can further restrict
site access in extension settings; restore the requested access and toggle ON
again to recover. OFF unregisters dynamic scripts, removes controls and aborts
recording without committing pending output. Previously granted optional hosts
remain in Chrome's extension settings until removed there; they cause no scripts
or models to load while OFF.

Focus a visible writable **text/search input, textarea, or basic contenteditable**
and click its small mic. The isolated floating widget preserves the original
field/selection and does not change the host control's layout. Focus alone never
records. Idle, Preparing, Recording, Stopping and Error have accessible labels;
click again to Stop, or cancel while Preparing. An active control remains visible
when focus changes, and output continues only to the original field. Stop drains
accepted final TEXT once, in order; Cancel, OFF, navigation, field removal and
permission/device loss abort and suppress late replies. Send/Submit and browser
editing remain manual. No audio or transcript is persisted or transmitted.

The circular in-page control uses locally bundled Material Symbols Outlined SVGs:
Mic when idle, Stop while recording, an activity spinner while preparing/stopping,
and Error for recovery. Spinner motion respects reduced-motion settings; light,
dark and forced-color treatments preserve distinct icon shapes and accessible
labels. The widget first looks for free space 6 px outside the field, then searches
slightly farther out in crowded rows. It clamps the control and compact status to
the viewport and keeps Stop visible when the recording field scrolls away.
Completely occupied viewports can still require a best-effort placement.
[Icon source, pinned revision and license](../extension/icons/material-symbols/README.md)
and [Chrome UI validation](evidence/web-voice-249.md).

A single **nonvisible extension-owned offscreen document** hosts Web dictation.
Each page document gets an independent existing `TabSession`, graph snapshot,
Workers, Web Audio and microphone stream. There is no visible recording window,
tab or popup in the already-authorized path, and no inference in the Content
Script or service worker. The same page mic shows Preparing, Recording,
Stopping/Idle or an actionable Error; its fixed target and caret remain bound
when focus moves or the field scrolls away.

Chrome's offscreen `USER_MEDIA` reason does **not** provide a first-use permission
UI. Our Chromium probe returned `NotAllowedError: Permission dismissed` for
`prompt`, succeeded for an existing grant without user activation, and rejected
a denied grant. When permission is `prompt`, the explicit field click opens a
clearly labeled **one-time microphone permission setup tab**. Its Allow microphone
button invokes native `getUserMedia`, immediately stops the test stream and
returns to the original page; the setup page never loads models or transcribes.
Dictation then proceeds offscreen. Later clicks skip setup while permission
remains granted. Denial shows Chrome/OS/device recovery instructions beside the
original field. Closing setup, canceling from the page or navigating aborts only
that request. A revoked grant can require setup again; a blocked grant needs
Chrome microphone settings changed before retry. The old recording window is
never a fallback.

Chrome permits one offscreen document per profile and exposes only `runtime`
extension APIs there ([Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)).
The service worker serializes document creation/closing, multiplexes independently
owned sessions, checks current Web opt-in and website permissions, and relays each
output connection to its authenticated original tab/document. The offscreen host
uses native localStorage for the existing Library, with no graph schema changes.
A generation nonce, session tokens, exact extension sender URLs, field capability
and edit sequences reject stale or forged messages. Last-session cleanup closes
the offscreen document; peer sessions keep their own tracks/Workers. A disconnected
coordinator cancels capture, with heartbeat acknowledgments as a backup. A restarted
worker closes any previous offscreen owner before accepting a new generation;
sessions never silently resume. Live retains its existing visible UI and lifetime.

See [Chrome feasibility, implementation and validation evidence for #263](evidence/web-voice-263.md)
for the native permission probe, real WASM inference, concurrent-session checks
and the limits of headless permission/GPU testing.

The assigned graph is snapshotted at session start. Only **one executable
FocusedInputTextOutputNode and its complete typed ancestors** run; optional Live,
speaker or other output branches are omitted, not initialized. Any executable
ChromeTabAudio/SelectedPageMediaAudio path makes a graph incompatible. The
eligible field path starts at MicrophoneAudio, passes through an existing ASR's
`final`, and may use TextFormatter, TextWindow, OPUS-MT, TranslateGemma or
IfCondition or the existing text-summary Nodes. Number configuration and Text→ASR language / translation context configuration are allowed.
Provisional/diagnostic output paths, startup text, multiple field sinks, cumulative
snapshot processors and trigger/sampled paths are rejected with reasons. This
conservative subset prevents startup/repeated snapshot edits and unrelated side
effects; it does not change general Graph/Live semantics or schema/ports.

Model preparation uses #239's actual runtime initialization with verified local
cached/package assets. Missing files/GPU support fail visibly with Models/Graph
recovery, before microphone capture, without downloading while recording.
Live windows and Web microphone sessions run independently, including overlapping
preparation, Ready/idle, recording and Stop. Each graph execution owns its own
Pipeline, Nodes, model Workers, audio streams, output connection and cancellation;
closing or failing one owner does not stop another. Live keeps its model preloading
and re-prepares its own resources after Stop. There is no global inference lock,
queue or application-imposed runtime count limit. Available RAM/GPU memory, browser
microphone permissions and OS/device limits can still cause real resource errors;
parallel inference speed or unlimited capacity is not guaranteed. Shared pinned
asset caches retain their verification and file-operation locks, separate from
runtime ownership.

If microphone startup fails, only that session reports the browser/device error:
allow access in Chrome and OS privacy settings for a permission failure, connect
or enable an input for a missing device, or check the device connection and OS
input settings when another audio stream cannot be opened. Retry that session
after resolving the cause. Its graph/model assignment is retained; peers are
never stopped automatically to make room.

Web microphones on different tabs/documents can record simultaneously. Within one
document the existing single widget owns one fixed field/session; duplicate Start
cannot replace it or insert twice. Stop, Cancel, navigation, target removal and
closing its setup tab affect that document only. Web voice OFF or website-permission removal
cancels all Web sessions and leaves Live running. Live selection and the Web microphone default remain
separate, and Library edits affect future sessions only. No graph schema changes
are required. This concurrency behavior supersedes #247's earlier exclusion.

The page bridge uses Chrome's isolated world and extension-only ports, exact
sender URL, tab/top-frame/document identity, a random per-field session capability
and monotonic edit sequence. It accepts no page-world messages and does not scan
other inputs. Native inputs replace the saved selection using the native value
setter plus cancelable `beforeinput`/`input` events; basic contenteditable uses a
saved Range. Unexpected edits, cancellation or field removal fail rather than
retrying an ambiguous write. Native setters do not reliably integrate with browser
undo stacks. Rich editors, Shadow DOM and cross-origin/same-origin subframes are
unsupported; custom handlers can reject or rewrite input. This is not universal
website/editor compatibility. The supported fixture coverage is documented below.

### Web voice validation

```sh
npm test
npx playwright test --config playwright.extension.config.js tests/extension/web-voice.spec.js tests/extension/offscreen-feasibility.spec.js
npm run prepare:assets
WEB_VOICE_REAL=1 npx playwright test --config playwright.extension.config.js tests/extension/web-voice.spec.js -g 'already granted|Live and Web overlap'
```

The regular suite uses a real unpacked MV3 extension with production source and
manifest, native host access/injection, gUM, worklets, production Nodes and Pipeline,
replacing only inference Worker replies. It inspects the actual offscreen CDP
target without opening it as a tab. Coverage includes explicit first setup,
subsequent invisible capture, denial, setup cancellation/close, default OFF and
consent synchronization, sensitive fields, fixed-target/caret insertion, exactly-once
finals, no submit, multiple Web owners in one document, overlapping Live/Web
preparation and capture, independent teardown, late-event rejection, model/cache
and device errors, permission removal, navigation/target removal, back-forward
cache, native service-worker stop/restart, offscreen loss and extension reload.

The feasibility probe uses a disposable minimal extension and fresh offscreen
context for each native permission state. It verifies AudioWorklet, isolated
Worker/shared-memory WASM and records WebGPU adapter availability. Real-model
mode assembles the current source with the pinned ReazonSpeech/Silero bundle from
`prepare:assets`, without requiring unrelated optional model packages. It runs
actual CPU/WASM inference on `ordinary-english.wav` supplied by Chrome's fake
microphone device. It compares final events with text inserted in native input
and textarea, and runs concurrent Live/Web sessions. Current results and source
hashes are in [#263 evidence](evidence/web-voice-263.md); earlier evidence remains
historical.

Native permission-bubble buttons are outside this automated suite. Website grants
use a disposable installation/upgrade fixture, restored to the production
optional-only manifest before feature tests. Microphone decisions use native
`Browser.setPermission`; the setup page still calls actual gUM from its button.
No physical microphone, native bubble-button automation or real GPU-model run is
claimed. To manually check a fresh profile, save a compatible graph, opt in, click a
page mic and then Allow microphone on the setup page. Allow Chrome's native
request, confirm return to the original field, speak and Stop from the same mic.
The next recording should start without any setup or recording tab/window. Deny
or revoke permission and confirm a useful error and released microphone.

## Permissions and local execution

| Manifest entry | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the specific tab where the user invokes the action; needed for `getMediaStreamId({targetTabId})`. |
| `scripting` | Inject toolbar-authorized focused output, or dynamically register the Web voice adapter only after explicit enablement and optional host grant. |
| `storage` | Persist and synchronize the separate Web voice enablement preference. |
| `offscreen` | Host independent Web dictation sessions in one nonvisible DOM document (`USER_MEDIA`, `WORKERS`, `LOCAL_STORAGE`). |
| Optional `http://*/*`, `https://*/*` | Requested only on Web voice opt-in, for top-frame mic controls. No required/global content script. |
| `tabCapture` | Obtain that tab's audio stream, without the Web sharing picker. |
| `script-src 'self' 'wasm-unsafe-eval'` | Execute packaged scripts and the existing local WASM runtime. |
| COOP/COEP | Isolate the extension page/workers for the pinned runtime's shared WASM memory. |

No required host or `tabs` permission is requested. The `offscreen` permission
adds a nonvisible extension runtime without broader website access. Optional hosts
are requested only for Web voice opt-in. Microphone uses native getUserMedia after
explicit Start or a field mic click; initial Web permission uses the setup button. Basic
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
labels, Web Store publication or
cross-browser extension support. No post-merge verification is required by #61.

### Simplified Live checks (#227)

1. Start a graph with ChromeTabAudio, then a microphone graph. Verify the toolbar
   tab is used automatically and microphone permission still requires Start.
   No target panel, discovery button or media selector should exist.
2. Connect a summary, translation, condition, Hold or speech path. Waiting,
   loading, generation, completion and queue messages should be absent from the
   main flow and from live announcements. Open **Session details** to inspect
   diagnostics; close it to return to reading. Graph Actions, Display input tabs
   and generated audio players remain usable at desktop and narrow widths.
3. Cause a missing model, failed operation or denied permission. Verify one
   actionable error per Node appears in the alert (with Models recovery for
   optional models). Start a fresh healthy session: old errors must disappear.
4. Connect SelectedPageMediaAudio to an output. Start remains available and
   reports the temporary selection limitation with a ChromeTabAudio suggestion.
   Add an independent text/capture path: that branch must still work. Nothing
   should select an element, inject a picker or silently switch capture modes.
   For focused output, invoke the toolbar on a normal page with a supported field
   focused; successful connection/insertion counts belong in Session details,
   while unavailable output/permission errors remain visible.

## Optional OPUS-MT Japanese ↔ English (#69 / #71)

Fresh installs default to a minimal transcription graph. Translation is an
explicit graph addition. New/reset graphs use the current transcription path; translation is added explicitly in Graph Editor.

The original ASR preview remains available while committed translations are queued.
Translation publishes completed results only; no provisional translation or pending
history rows are produced. Session details contains loading/readiness diagnostics;
actionable failures also appear in Live’s error alert. A failure
can be displayed through the primitive `error` output while successful `text` sinks
receive nothing. Stop drains final speech and translations. Closing the Live
window discards pending work, releases Workers and ignores late completions.
Completed display items remain until the next Start; transcripts are not persisted.

For either direction, wire ASR.final → OPUS-MT.text. Connect its source/text/error
directly to TextFormatter.input1/input2/input3, then formatter.text →
TextAccumulator.append. For example, use `English: {1}` and `Japanese: {2}{3}`
on separate template lines. Every result appends once, including repeated phrases.
A direct group clears omitted formatter inputs, so failure cannot reuse an older
translation. Independent branches have no implied pairing. Plain successful text
also connects directly to display, field and TTS sinks. See
[formatter controls and saved-graph recovery](extension-graph.md).

The session-owned scheduler accepts plain committed strings into one FIFO and an
owned inner graph: source.text → direction-specific OpusMtTranslationNode.text →
TextOutputNode.text. It runs one inference at a time and keeps request identity
internal; it never compares equal source strings to join results. Empty/whitespace
utterances produce an empty translation without inference, preserving order.
Text over 1,000 characters produces a per-utterance error; model errors make
translation unavailable for that session while ASR continues. The tokenizer also
enforces 512 tokens and caps output at 256 tokens. Each Node owns its module Worker,
pinned runtime/checkpoint and cache-only loading; no remote inference or shared
model manager is involved. Graceful Stop drains all queued results; closing Live
uses internal cancellation to terminate inference immediately. Fresh sessions use
fresh Nodes.

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

Connect complete TEXT snapshots directly to `Display.input1`. For continuous source/translation history, use [portable keyed pairs](display-items.md). Unsupported saved Nodes/ports require Reset or Import and an explicit Save.
