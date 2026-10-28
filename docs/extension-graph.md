# Executable extension processing graphs (#75, #81, #87, #95, #99)

[Meeting summary processors](meeting-summary-nodes.md) independently support
LFM2.5 1.2B JP and Qwen3.5 2B with committed `text: TEXT` input and complete
`summary: TEXT` snapshots for `LiveTextDisplay.content`. Save prepares their
pinned assets; each owns a local WebGPU Worker and bounded incremental context.

[IfCondition](if-condition-node.md) is an ordinary reusable TEXT processor with
`text` input, an editable English condition and `yes` / `no` TEXT outputs. Both
outputs preserve the original input string; only the selected branch emits.
Its pinned local model is prepared through Save graph, and errors stop only that
instance with a visible status. It does not change version 10 or Pipeline routing.

The **Simple / Graph** switch connects Live's minimal recording window and the
full-size Graph Editor tab. **Models** is a secondary link for asset preparation
and recovery. Opening these pages preserves capture and the active graph.
Simple shows Start / Stop / Cancel, actionable status and the configured
LiveTextDisplay panels. Panels keep their graph order and labels, arrange into
columns when space permits, and provide keyboard-focusable scrolling for long
text. Zero displays and audio-only graphs remain supported. **Session details**
reveals capture metadata and routine model/signal status; unknown diagnostics,
errors and saved changes for the next session remain visible. Target selection
is collapsed until expanded or required for selected-media capture. Configuration
belongs to Graph; Simple adds no model, language or summary selectors.

Open **Graph** from Live or Models. It opens a separate full-size
extension tab. **Add Node** opens a searchable palette with source/input,
processor, constant/utility and output categories. Choose a result and use
**Add selected node** or Enter. Escape closes the palette and returns focus to
Add Node. The palette stays available for adding several nodes. Drag a heading (or focus it and use
arrow keys) to move a Node. Click an output then a compatible named input, or
drag between ports, to connect. Ports show their contract types; incompatible
inputs are disabled during connection. Escape cancels a selected port. Use the
canvas scrollbars, touch scrolling, **Canvas zoom** and **Fit graph** to navigate
a large graph. **Help** opens the detailed editing instructions on demand. Connecting to
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
**Remove Node** in the selected node’s inspector deletes it and its edges. Select a heading to
edit display labels, templates, language/voice in the contextual **Settings**
inspector (below the canvas in narrow windows). Close settings or click blank
canvas to reclaim space. **Node help and ports** reveals contracts and detailed
usage only when needed. OPUS-MT directions are
separate executable Node types.

**Graph actions** contains **Validate draft**, **Load saved**, **Reset draft to
default** and **Show optional warnings**.
Optional warnings are off by default and the preference persists locally.
**Validate draft** explicitly reports blocking **Error:** diagnostics and optional
**Warning:** diagnostics, including incomplete, disconnected and unused Nodes.
Normal editing hides optional warnings. **Save graph** checks structural validity
and stores the draft in extension-origin localStorage. **Load saved** discards
unsaved edits after confirmation; **Reset draft to default** also confirms
before replacing an unsaved draft and creates a recovery draft, which still
needs Save. The status distinguishes unsaved draft, saved next-session graph
and immutable active-session graph, queried from Live. Saving during capture
never changes Nodes, Workers, languages or routes in that session. Stop/finalize
or Cancel, then Start to use the saved graph. Opening or closing the editor
or Models does not start, stop or retarget capture. **Simple** focuses the
existing recorder; without one, it explains how to invoke the toolbar.

Saved edits refresh other open pages. If another editor saves while this page
has a dirty draft, the draft stays intact and a conflict message requires
**Load saved** before saving. Saves compare the stored graph while holding a
Web Lock, preventing a racing editor from silently overwriting a newer graph.
Finish one editor's changes at a time; copy any desired draft settings before
Load saved. Recreated windows and Chrome restarts in the same profile retain the
saved graph. Drafts remain page-local. Transcripts/audio are never persisted.
Closing/reloading Live releases capture/Workers and revokes audio URLs.

Fresh installs and **Reset draft to default** use exactly four Nodes:
`ChromeTabAudio`, `SpeechToTextReazonSpeech`, `TextAccumulator`, and one generic `LiveTextDisplay` labeled Text
(language unspecified). The three named-port edges are `ChromeTabAudio.audio →
SpeechToTextReazonSpeech.audio`, `SpeechToTextReazonSpeech.provisional → TextAccumulator.preview`, and
`SpeechToTextReazonSpeech.final → TextAccumulator.append`, and `TextAccumulator.text → LiveTextDisplay.content`. No translation or formatter is
included. Reset changes only the draft until Save; upgrades never replace a
saved graph with the new default. Existing explicit boolean translation
preferences migrate once when no graph is saved: only `enabled: true` adds the
translation branch. Missing/corrupt preferences use the minimal default; saved
graphs always take precedence, preserving custom settings and routes.

Add concrete OPUS-MT Nodes and wire each branch directly; directions are independent.
Save never switches translator types, rewrites routes or removes parked Nodes.
After a successful valid **Save graph**, the editor automatically prepares optional
OPUS-MT and TTS weights selected by every saved model-bearing Node, including
parked/unconnected Nodes. Duplicate equivalent Nodes share one preparation;
Supertonic language settings share weights, while each distinct TTS voice is prepared.
Existing packaged ASR assets need no runtime preparation. Optional Parakeet v3
and Moonshine Medium Streaming weights follow saved-node preparation, including
parked Nodes; [download/memory guidance](optional-asr-nodes.md) is available in
**Model requirements and terms** before Save. Per-model status and byte progress
appear in **Saved graph model weights** below the graph, with **Cancel preparation**, **Retry preparation** and
**Check cache**. **Ready · Cached and verified** requires the complete pinned set.
Preparation opens on Save or a new failure and can be collapsed. Models keeps
file/size diagnostics and storage management in disclosures; download/retry,
errors and model license links remain directly available.
Graph storage finishes first; download errors do not undo Save. Validation or
storage failure starts no preparation. Editing or loading a graph alone does not
download weights. A newer Save cancels the previous preparation and uses its saved
snapshot. A Save in another editor cancels obsolete preparation in this page,
without starting downloads on load or discarding dirty drafts. Closing the editor
cancels preparation; Save again or use **Models** for
recovery, diagnostics, voice-specific retry and deletion. No capture, inference or
Workers start during Save. Runtime inference remains cache-only.

The translation migration introduced in v9 handles versions 1–8 before v10 display migration, using the same storage key. Legacy
field sinks become focused TEXT sinks, extraction adapters preserve downstream
fan-out, and `SpeechToText` becomes `SpeechToTextReazonSpeech`. Legacy transcript
views become `LiveTextDisplay` with provisional → preview and final → append on an inserted TextAccumulator,
retaining display IDs/positions and deriving labels/language from old settings.
Existing generic formatters acquire `inputCount: 4`, preserving every old reference.

Legacy `TranslationView` / `PairedTextFormatter` configurations transition to
ordinary `TextFormatter` with three inputs and language labels in its template.
Direct finalSource/text/finalError wires map to source/text/error → input1/2/3.
All supported fan-out, unrelated routes, labels, positions and stored literal
content survive. Provisional translation, public statuses/indices, and indexed
whole-history pending/error updates are removed. Every affected route and behavior
change appears in a migration report. A single formatter → display.replace route
becomes append so each committed result appears once. Shared or other destinations
keep their routes for explicit review of the new latest-result TEXT semantics.

These behavior changes require a **reviewed migration**: the old saved graph stays
untouched and cannot run; Graph Editor opens a converted **unsaved repair draft**.
Review the report and reconnect unsupported routes deliberately, then Save.
Before and after Save, expand **Original saved graph (migration recovery copy)**
to copy the complete original JSON, including removed routes/configurations.
Before v10 this used `processing-graph-before-v9`; new saves use `processing-graph-before-v10`; this backup remains
across page reloads and later ordinary saves. To reattempt recovery, export this
copy and import it in a compatible version or restore it to the graph storage key.
Reset changes only the draft and still requires Save. Transcripts/history were
never persisted in graph JSON; current-session committed output survives Stop/Cancel
and draft saving, while a fresh Start begins empty. There is no Node/edge count cap.
Malformed/ambiguous older routes fail visibly without overwriting the saved graph.

Version 7 Whisper graphs remove only outgoing `Whisper.provisional` edges,
which never produced events; no edge is redirected to final. All other nodes,
routes, settings and positions are preserved. Destinations left without an input
remain in the saved draft, inactive until reconnected. No edge is redirected;
choose the desired TEXT semantics explicitly (for committed Whisper text,
`final → append`). Structurally malformed migration results still fail visibly.
See [Whisper migration](whisper-node.md#saved-graph-migration).
Page/media handles are never saved with a graph.

## Supported graph and ports

Version 10 is JSON with `version`, `nodes`, `edges`, and an optional
`translationDirection` legacy preference, preserved for stored-graph compatibility.
Processor types and settings choose the actual models; this field never schedules weights.
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
| Text | — | value: TEXT; editable literal string, including empty |
| SpeechToTextParakeetV3 | audio: PCM | final: TEXT only |
| SpeechToTextMoonshineMediumEn | audio: PCM | provisional: TEXT; final: TEXT |
| SpeechToTextWhisper | audio: PCM; language: TEXT (optional startup en/ja, defaults to en) | final: TEXT only |
| Number | — | value: NUMBER; editable finite constant |
| SpeechToTextReazonSpeech | audio: PCM; maxDuration: NUMBER (optional, seconds) | provisional/final: TEXT |
| LiveTextDisplay | content: TEXT | render each complete snapshot verbatim |
| TextAccumulator | append / preview: TEXT, individually optional; text: TEXT output | full committed transcript plus ephemeral tail |
| TextWindow | text: TEXT | text: TEXT (closed batches); provisional: TEXT (optional open snapshots); length/deadline/sentence settings |
| TranslationCommit | boundary/source/text/error: TEXT | provisional/final/error: TEXT; opt-in closed-window commits |
| TextFormatter | input1…inputN: TEXT, instance-configured, individually optional | text: TEXT; at least one input must connect |
| OpusMtJaEn / OpusMtEnJa / TranslateGemmaEnJa / TranslateGemmaJaEn | text: TEXT; provisional: TEXT (optional snapshot from any producer) | source/text/error: TEXT, grouped results; no text on failure |
| Supertonic3 / Kokoro | text: TEXT | audio: SYNTHESIZED_AUDIO; configured language/voice |
| AudioOutput | audio: SYNTHESIZED_AUDIO | native audio player / WAV |

Multiple audio sources, same-type or different ASRs, translators, processors and
sinks can run independently. A source may fan out to several compatible ASRs;
constant TEXT → translation/formatter/TTS paths need no audio or ASR. Unknown
settings/ports/types, duplicate IDs/edges, incompatible contracts, multiple routes
into one input and cycles remain blocking errors. Correlation is checked by the
consumer when values arrive, rather than by inspecting producers.
A missing required input, unconnected producer or absence of outputs is a draft
warning, never a Save blocker. Positions accept finite nonnegative coordinates
without the old 4000-pixel ceiling; Node and edge count caps are removed. The
existing 64-character safe ID syntax and per-Node configuration/data bounds
remain part of the stored format and concrete Port/runtime contracts.

### Stored drafts and concurrent execution

Start snapshots the saved description. A Node is ready when its required inputs
have ready producers; input-consuming Nodes also need at least one available
input. Generic formatters need at least one connected TEXT input. Only ready
ancestors of ready output sinks participate. Edges from incomplete branches into
optional inputs remain saved and inactive. No edge is redirected or merged.
Inactive sources/models/processors create no Workers, downloads, permission
requests or media capture. A draft with no executable path saves and reloads;
Start explains that it needs a complete source-to-output path before any resources
are allocated. Malformed settings/wiring remain errors even in parked Nodes.
Consumer-specific startup values are validated at delivery, before the consumer
loads its model. A connected but inactive configuration producer leaves that
consumer waiting with an explicit status, rather than silently using its default.

For two independent transcript displays, connect:

- `ChromeTabAudio.audio → SpeechToTextZipformerEn.audio`, with `final → remote-accumulator.append`
  and optional `provisional → remote-accumulator.preview`, then `text → remote.content` on a LiveTextDisplay labeled Remote speaker.
- `MicrophoneAudio.audio → SpeechToTextWhisper.audio`, with `final → local-accumulator.append → text → local.content`
  on another LiveTextDisplay labeled Local speaker. ReazonSpeech is another option.

Each active ASR loads its configured model before processing audio. An ASR waiting
for a connected startup value buffers at most 30 seconds while capture runs. Microphone
permission is requested directly by the explicit Live Start gesture only when an
active path uses it. Toolbar invocation asks the user to press Start in that case.
Multiple microphone Nodes share one permission grant with separately owned cloned
tracks. Repeated ChromeTabAudio Nodes share one normalized tab capture because
Chrome permits one capture per tab; subscribers and ASRs retain independent routes.
All tab Sources currently target the toolbar-invoked tab; selected-media sources
retain individually selected handles.

Source-end closes/drains/disposes Nodes without another live source ancestor.
Consumers shared with a live path remain open; when all captures end, the session
finalizes. Tab navigation/closure ends tab/media captures and detaches field sinks,
while microphone paths continue. Stop drains every participating path in dependency
order. Cancel invalidates queued emissions and releases all models/captures,
including partial loading and late permission grants; repeat starts fresh. Capture
signals and model progress/errors include Node IDs. Every Node failure is reported
locally and leaves independent viable paths running, regardless of Node types or
neighbors. Stop drains healthy Nodes and reports failures. Failed startup leaves
peer paths usable; when no output path survives, Start releases the graph.

Tab audio may already contain the local speaker, and microphones may pick up
speaker playback. Independent displays do not promise speaker separation or echo
removal. Each active model costs additional CPU/memory and may increase latency;
existing bounded ASR queues still fail visibly on overload. See the reproducible
[concurrent validation and measurements](evidence/graph-115.md).

### Whisper and reusable Text constants

To transcribe English, remove the ReazonSpeech Node and add **Whisper tiny
(multilingual) ASR**. Connect the audio source to `audio` and
`final → TextAccumulator.append` only. Additional ASRs may use independent
sources or share compatible source fan-out. Any existing final TEXT consumer (TextFormatter, OPUS-MT, focused field,
or TTS) can receive Whisper finals with its existing port. The default/reset
graph continues to use ReazonSpeech ja-en. Remove any old maxDuration edge and
unused Number Node on replacement; Whisper has a fixed 6-second cap.

Whisper uses an actual packaged multilingual tiny q8 checkpoint, CPU WASM and
Silero. Its unconnected language is **English (`en`)**. To choose Japanese, add
**Text**, select its heading, enter exactly `ja` in value and connect
`Text.value → SpeechToTextWhisper.language`. This release supports `en` and `ja`;
other codes, whitespace, uppercase and empty language values fail before model
loading. ReazonSpeech has no language port. Whisper is multilingual, not `.en`.

Text is a general constant with a free-form literal string, including empty
text, markup characters, newlines and emoji. Ordinary TEXT consumers receive it
once at their session start. It can supply formatter inputs or a display without
ASR-specific behavior. Any compatible TEXT producer may configure Whisper; the
consumer waits for its first value before model loading. Invalid values fail on
delivery and late updates fail visibly. Saved edits apply next session.

Whisper produces **completed segments only**, without provisional recognition.
Its only output is `final: TEXT`. You may deliberately connect final to
`LiveTextDisplay.content` for replacement behavior. Segments end on Silero's trailing
silence or a fixed 6-second audio cap; continuous speech splits at the next
sample without repeating pre-roll. Stop drains queued finals and active speech;
Cancel discards pending results and terminates Workers. Pending audio is bounded
at 30 seconds; overflow fails visibly and stops capture. Mid-sentence cuts and
small-model limitations can reduce quality; the audio cap is not output latency.
See [model pins, setup and smoke tests](whisper-node.md).

### Maximum speech segment duration

Unconnected `SpeechToTextReazonSpeech.maxDuration` uses **6 seconds**. Add **Number**, select
its heading, edit `value` in Settings, and connect `Number.value →
SpeechToTextReazonSpeech.maxDuration`. The default audio and provisional→replace / final→append
wires stay in place. Save to use the configuration at the next Start.

Number is a generic numeric source with the shared `NUMBER` contract: its value
must be finite, and it has no ASR units. SpeechToTextReazonSpeech requires **1–12 seconds**,
inclusive, and accepts decimals. Zero, negatives, nonfinite, empty/nonnumeric and
out-of-range duration settings fail visibly; an explicitly invalid connection
never falls back to 6 or clamps. The lower bound keeps the existing 0.8-second
pre-roll within a segment; the upper bound preserves the existing model policy
and 30-second pending-audio budget. Seconds round down to whole 16 kHz samples
(at most one sample below the entered duration).

Any NUMBER producer may supply this setting through ordinary port delivery. The
ASR waits for its first value before loading; while waiting it buffers at most
30 seconds of PCM. Missing configuration on Stop or overflow fails visibly;
there is no default fallback. The value freezes once loading begins, and later
updates fail rather than silently changing a session. A connected but inactive
configuration source also waits instead of silently selecting the default.
Consumer value constraints are checked at runtime, so finite constants and
unfinished drafts remain saveable. Saving edits affects only the next session.


VAD's usual trailing-silence endpoint or the sample cap, whichever comes first,
finalizes a segment. The cap counts the **whole audio segment**, including
pre-roll and any short pauses/trailing silence. Continuous speech resumes at the
next sample in a new segment, without repeated pre-roll. Stop drains all segments
and the capture/VAD tail; Cancel discards pending work and releases both workers.
ReazonSpeech ja-en is simulated streaming: finals queue behind any inference in
progress, and slow devices can still hit backlog protection. This cap is **not a
final-result latency SLA**. Mid-sentence cuts lose linguistic/acoustic context
and can reduce accuracy, particularly with shorter caps; no new model or text
stitching is introduced.

### Generic text displays

[The reusable TEXT Nodes](../web/text-nodes.js) are shared, Chrome-independent
Pipeline implementations. `LiveTextDisplay` has only `content: TEXT`; each
snapshot replaces its content verbatim, including `''`. Stop/Cancel retain the
latest value; Start clears it. It never infers producer identity or accumulates.
MeetingSummary.summary, Text.value and complete TextFormatter.text snapshots can
connect directly to this same port.

`TextAccumulator` constructs reusable transcripts upstream. `append` accepts each
exact string once, including empty strings, whitespace and equal consecutive
segments. One newline separates committed segments, including empty segments.
`preview` replaces the uncommitted tail; `''` clears it. A nonempty tail is
separated from committed segments by one newline. Append clears preview; grouped
append + preview gives append precedence regardless of property order. Independent
emissions preserve delivery order; a later preview starts a new tail. Every
accepted delivery emits the entire current `text: TEXT` snapshot, usable by any
TEXT consumer. Stop emits committed text when removing a nonempty preview.
Cancel aborts outstanding work, then the accumulator emits its committed snapshot
through ordinary routes. Direct displays, formatters and independent sinks all
observe the same cleanup; aborted model and side-effect Nodes cannot resume work. Fresh sessions start empty. No persistence or model
assets are involved. Keep utterance consumers such as TTS, fields and translators
connected to the original final outputs unless full snapshots are desired.

The accumulator retains one growing string and a segment count, avoiding an
item-array copy per event. JS engines may share string prefixes; this is an engine
optimization, not a memory guarantee. Reading/serializing/rendering a full snapshot
costs O(total text); consuming every growing snapshot can cost O(n²) over a session.
There is no truncation or transcript cap. Available memory, JS string limits and
browser layout time are real limits; this is not disk-backed storage. A Node test
checks 20,000 repeated 100-character commits (2,019,999 UTF-16 units) and reports
construction time separately from rendering. Live keeps bounded 4,096-code-unit
text nodes, edits only the changed suffix and uses a scrollable region, avoiding
item-array reconciliation and whole-DOM reconstruction. Prefix comparison and
browser text layout still scale with transcript size.

Live places configured outputs above its compact recording panel. Start, Stop
(finalize pending work) and Cancel (discard pending work) retain their existing
lifecycle. Capture target, progress, errors and model recovery remain visible;
**Input and output targets** reveals optional target controls. The routine
translation-off and unchanged-saved-graph notices do not take space.

Live renders one region per configured sink, ordered by Node array order, with
its user-supplied label (1–120 characters) and optional language. Labels and all
values use literal DOM text, never HTML. Unchanged text prefixes stay attached;
ordinary tail updates preserve selection in that prefix and reader scroll.
Arbitrary replacements and shorter snapshots remove stale suffixes. Copy text
copies exactly the latest snapshot. Old row borders and the separate dashed
Preview block are replaced by a single plain text surface with newline boundaries;
preview is now content constructed by the upstream accumulator. Runtime/model,
capture, target and error status remain
outside display content. The active graph
owns labels/routes throughout a session; saving a draft applies only on the next
Start. Stopped history keeps the last graph's labels until then. Output-only graphs
render no text regions and add no implicit fallback display.

### Optional bounded formatting

Select a `TextFormatter` heading and use **Add input** / **Remove last input**
in Settings. Each instance starts with four TEXT inputs and can grow beyond four.
Names stay `input1`, `input2`, …; removing deletes only the last port and its wire.
Other ports/wires and other instances remain unchanged. References to removed
inputs remain in the editable template and produce an actionable validation error;
Save cannot overwrite the last valid graph until the template is fixed or the
input restored. Added inputs begin absent/empty at the next session.

The multiline template (at most 2048 characters) accepts `{1}`, `{2}`, … up to
the configured count, including multi-digit references. Literal labels, spaces,
newlines and separators are preserved. `{{` renders `{` and `}}` renders `}`.
Unknown references, zero/leading-zero indices, expressions and unmatched braces
are invalid. For example, use `English: {1}` followed by a literal newline and
`Japanese: {2}`. Incoming strings are data, substituted once, never recursively
interpreted as template syntax, code or HTML. Absent inputs substitute empty
strings; an incoming empty string explicitly clears that value. No output is
emitted until an input arrives.

Ordinary input updates emit immediately using latest values. An explicit direct
`emitOutputs()` group produces one output and replaces only that producer's
connected inputs together, clearing omitted siblings. Other producers' values
remain unchanged. Independent streams and separate `emit()` calls are not
correlated, even with equal strings or matching timing. Group provenance stays
local to the delivery context, never travels as a structured port value across
processors. Template/input edits apply at the next session; they emit nothing
into an active graph and reset latest-value state on fresh Start.

For committed bilingual display, wire ASR.final → OpusMtEnJa.text (or OpusMtJaEn),
then source/text → input1/input2 and optionally error → input3. Set the template
freely and connect formatter.text → TextAccumulator.append → text → display.content. Pending translation emits
nothing; failure emits source/error with no successful text and clears the old
translation in the directly connected formatter. Every completion/failure appends
one readable result; repeated utterances stay distinct. Stop drains finals,
Cancel adds no pending/canceled rows, and both retain committed accumulator text.
Use display.content directly instead when only the latest value is desired. Generic
formatting owns no history and has no model/language-specific rules.
`PairedTextFormatter` is migration-only terminology, absent from palette/runtime.

## Concrete input and output targets

In Live, open **Input and output targets**. Graph Editor chooses the concrete
Node and route; Live chooses the temporary browser target. Toolbar invocation
selects the capture tab. The default is whole-tab audio → ASR → one Live text
display; it injects nothing into the page.

For page output, connect `SpeechToTextReazonSpeech.final → FocusedInputTextOutputNode.text`
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
plain strings. By default, completed translations alone emit text; pending/error
values do not. The opt-in [windowed translation path](windowed-translation.md)
also translates provisional source snapshots; route its results through
TranslationCommit and connect only final to append-only destinations. Distinct utterances with identical text remain distinct. A source
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

Connect SpeechToTextReazonSpeech.final → Supertonic3.text (or Kokoro.text) → AudioOutput.audio.
To speak translations, connect OPUS-MT.text directly to TTS.text. These outputs
emit whole utterances; pending/error diagnostics use separate ports. The TTS
branch splits long text into ordered snippets of at most 300 UTF-16 units without splitting surrogate pairs; this
respects production TTS's input limit. Choose the language/voice matching that
text. This is not automatic language/voice detection.

Saving a TTS Node prepares its pinned checkpoint and selected voice automatically.
Use **Models** to inspect, retry or delete assets, selecting the same voice as the
TTS Node's inspector settings. Optional weight sizes: Supertonic 3 approximately 399 MB;
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

TranslateGemma is now selectable in both directions with the same primitive TEXT
contracts; see the #124 section below for MV3 packaging, WebGPU, assets and terms.

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
weights after Save or through Models recovery controls. The TTS smoke runs the
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

## English streaming ASR

`SpeechToTextZipformerEn` (**Streaming Zipformer English ASR**) is an opt-in
processor with only `audio: MONO_16KHZ_PCM` input and real online
`provisional: TEXT` / `final: TEXT` outputs. Search for Zipformer or English in
Add Node. Replace the ASR, reconnect the audio source, then connect provisional
to `TextAccumulator.preview` and final to `TextAccumulator.append`, then text to `LiveTextDisplay.content`. Remove an
unused Number/Text configuration source when replacing the old ASR, or leave it
parked. ReazonSpeech, Whisper and Zipformer can coexist with independent settings. Existing TEXT sinks and
translation Nodes use the same contracts.

Adding Zipformer needs no extra migration beyond the current version 10 graph.
Unrelated ASR nodes, IDs, settings, routes and positions stay intact; earlier
versions use the migration rules above. The minimal ReazonSpeech default remains. See [model pins, fixed 12-second segments,
Stop/drain, setup and limitations](zipformer-node.md).

## Optional Parakeet v3 and Moonshine Medium Streaming

Search Add Node for Parakeet or Moonshine. These independent concrete Nodes use
the same normalized audio sources and final TEXT fan-out as existing ASRs.
Parakeet exposes final only; Moonshine exposes demonstrated native provisional
and final. Both can coexist without changing Graph v10 or the default graph.
Save prepares the saved Nodes' checksum-pinned optional weights, including parked
Nodes. See [model-specific setup, GPU/memory limits, endpointing and lifecycle](optional-asr-nodes.md)
and [real packaged/concurrent/native validation](evidence/optional-asr-121.md).

### TranslateGemma 4B processors (#124)

Add **TranslateGemma 4B English → Japanese** or **Japanese → English** in the
Processors palette. Both use the existing `text: TEXT` input and grouped
`source/text/error: TEXT` outputs; connect them just like OPUS-MT. English ASR
final or a Text constant can feed English → Japanese. Direct text fan-out to
TextAccumulator.append, a focused field and Japanese TTS works without display changes.
For bilingual history, connect source/text/error to three TextFormatter inputs.
Pending/Cancel emit nothing; Stop drains. Parked Nodes remain saved and are
prepared on Save but run only on a complete source-to-sink path. Multiple
independent model Nodes own separate Workers and require memory for each.

Graph version stays **9** and existing defaults/saved routes/migrations remain
unchanged. Save prepares one shared **3.112 GB** checkpoint for both directions;
preparation failures do not undo storage. Allow 7 GB free storage and several GB
RAM/GPU memory; Worker WebGPU and a usable adapter are required. Missing/evicted
weights need Save or Models recovery before starting. No runtime downloads,
cloud API or automatic fallback. Read Google Gemma Terms and Prohibited Use
Policy in Help / Models before preparation or use; a public ONNX conversion
does not waive upstream terms. See [full setup and attribution](translation-nodes.md#translategemma-in-the-extension-124)
and [#124 validation](evidence/translation-124.md).

## Windowed and revisable translation (#128)

The model-independent **TextWindow** and opt-in **TranslationCommit** processors
use ordinary TEXT ports, require no weights, and retain graph version 10. See
[connections, limits, lifecycle and measured comparison](windowed-translation.md).
Defaults and existing per-segment translator paths remain unchanged.

### Graph v10 display migration and recovery

Saved v9 graphs (including earlier migrations) retain all original Node IDs,
positions, labels, language settings, disconnected drafts and non-display routes.
Each display with an append connection gets one collision-safe TextAccumulator;
append routes go to append and replace routes go to preview, even when they come
from different producers. Its text output goes to content. Replace-only displays,
including meeting summaries, connect directly to content; no accumulator is added.
Existing formatter fan-out continues to emit individual results to other consumers.
Versions 1–8 first follow their existing migration/review rules, then this migration.

Migrated accumulators carry `legacyDisplay: true` metadata. If all saved append
sources are inactive drafts, the executable graph has only preview input, so that
accumulator retains its latest snapshot on Stop/Cancel, matching the old
replace-only display. The draft routes remain saved. Completing an append branch
restores normal committed/preview lifecycle behavior on the next session. Newly
added accumulators always clear uncommitted previews on Stop/Cancel.

Before writing v10, the exact original JSON is retained at
`processing-graph-before-v10`. Earlier `processing-graph-before-v9` data is retained.
If a v10 recovery key already holds different data, additional copies use suffixes
`-2`, `-3`, etc.; identical originals reuse their backup. Backup failure leaves the
saved original untouched. Recovery copies are available in Graph Editor. No
post-merge-only verification is required for this change.

## Simple / Graph UI verification (#136)

Packaged MV3 layout fixtures exercise 0, 1, 2 and 4 graph-generated displays at
390px and 1440px, long-text keyboard scrolling, audio-only playback/download
controls, explicit microphone consent, required media selection, unknown
diagnostics, model recovery and saved-versus-active output labels. Existing
regressions cover native capture, navigation without session interruption,
contextual settings, keyboard/touch graph editing, cross-tab draft conflicts,
migration copies and independent processing paths. The graph schema, port
contracts, model preparation lifecycle and extension permissions are unchanged.

Inspected screenshots: Simple with [zero](evidence/ui-136-simple-0-390.png),
[one](evidence/ui-136-simple-1-390.png),
[four narrow](evidence/ui-136-simple-4-390.png) and
[four wide](evidence/ui-136-simple-4-1440.png) displays;
[audio-only](evidence/ui-136-audio-390.png);
[narrow Graph](evidence/ui-136-graph-390.png),
[wide Graph](evidence/ui-136-graph-1440.png) and
[Models](evidence/ui-136-models-390.png).
These contain deterministic fixture text/audio and asset responses, not user
recordings or evidence of production inference accuracy. Regenerate them with:

```sh
UPDATE_UI_SCREENSHOTS=1 npm run test:extension -- tests/extension/simple-layout.spec.js
```

`npm ci`, all asset preparation scripts in `setup:extension`, and
`npm run build:extension` passed. `npm test` passed all 540 tests without skips.
The Chromium/WebKit layout suite passed all 12 tests:

```sh
npm run test:browser -- tests/browser/extension-layout.spec.js --workers=1
```

The host's port 8000 was occupied, so this run served the same local `web/`
directory on port 8136 with `ASR_BASE_URL=http://127.0.0.1:8136`. An initial
WebKit launch attempt preceded completion of the browser installation; all
12 checks passed once both pinned browser runtimes were installed.

The complete packaged MV3 run (`npm run test:extension`) recorded 183 passes,
16 opt-in skips and one outdated navigation-label test failure. That test still
looked for “Graph Editor” after the link became “Graph”; its selector was fixed.
After the final Models card cleanup and build, all 39 affected checks passed:

```sh
UPDATE_UI_SCREENSHOTS=1 npm run test:extension -- tests/extension/simple-layout.spec.js tests/extension/translation.spec.js
# 27 passed, including cancel-download focus restoration and final screenshots
npm run test:extension -- tests/extension/graph.spec.js
# 12 passed, including the corrected navigation-label test
```

The 16 skips are opt-in real-model inference/resource smokes (ASR, translation,
TTS, meeting summary, IfCondition and real-ASR focused output). They were not
run for this layout change. Native tab capture, fake-device microphone consent,
real bundled ReazonSpeech/Silero initialization and fixture inference/lifecycle
checks did run. No model accuracy or external-site compatibility claim is made.
`git diff --check` passed.

No post-merge-only verification is required.
