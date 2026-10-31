# Executable extension processing graphs (#75, #81, #87, #95, #99)

[Meeting summary processors](meeting-summary-nodes.md) independently support
LFM2.5 1.2B JP and Qwen3.5 2B with committed `text: TEXT` input and complete
`summary: TEXT` snapshots for `TextToDOM.text → dom → LiveTextDisplay.dom`. Save prepares their
pinned assets; each owns a local WebGPU Worker and bounded incremental context.

[IfCondition](if-condition-node.md) is an ordinary reusable TEXT processor with
`text` input, an editable English condition and `yes` / `no` TEXT outputs. Both
outputs preserve the original input string; only the selected branch emits.
Its pinned local model is prepared through Save graph, and errors stop only that
instance with a visible status. It uses version 14 or Pipeline routing.

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
a large graph. Zoomed-out views provide an overview. **Edit at 100%** appears
beside Zoom and Fit while below 100%; it returns to the last focused Node/port
or selected wire for editing. Increasing Canvas zoom also reveals that control.
**Help** opens the detailed editing instructions on demand. Connecting to
an occupied input replaces only its incoming wire; other inputs and source
fan-out stay intact. Repeating the same connection changes nothing. Invalid
connections keep the previous wire. Drag a connected input endpoint into blank
canvas to detach only its wire, or onto a compatible input to reconnect it.
A click, cancelled drag or drop on a Node body keeps the connection. Click a wire
directly on the canvas (or focus it and press Enter/Space): the selected wire
turns yellow and shows connection details and **Disconnect** in the inspector.
Selecting alone keeps the wire. Click or tap Disconnect to remove only that edge;
it needs no hover or keyboard. The inspector action and wire hit targets keep
the same screen size at every supported zoom. With a selected wire
focused, Tab moves to Disconnect; Enter/Space activates it. Delete/Backspace on
a focused wire also removes it. Escape or clicking blank canvas clears selection
and hides Disconnect. After removal, focus returns to the scrollable canvas.
**Remove Node** in the selected node’s inspector deletes it and its edges. Select a heading to
edit display labels, templates, language/voice in the **Settings** inspector.
The inspector keeps a constant width beside the canvas, or a compact scrollable
region below it in narrow windows. Clearing selection shows a minimal empty
state without resizing the canvas. Canvas headings show only the
node type label; Settings shows the selected node's ID, including for multiple
nodes of the same type. **Clear selection**, Escape or blank canvas clears the
inspector. **Node help and ports** reveals contracts and detailed
usage only when needed. OPUS-MT directions are
separate executable Node types.

**Graph actions** contains **Validate draft**, **Load saved**, **Reset draft to
default**, **Show optional warnings** and **Recovery** when saved recovery copies exist.
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

Fresh installs and **Reset draft to default** use seven Nodes:
`ChromeTabAudio`, `SpeechToTextReazonSpeech`, `TextAccumulator`, two `TextToDOM`
processors, `DOMCombiner`, and one generic `LiveTextDisplay` labeled Text.
Audio feeds ASR. Final TEXT feeds the accumulator, whose complete history feeds
TextToDOM → DOMCombiner.first. Provisional TEXT feeds a separate TextToDOM →
DOMCombiner.second; the combined DOM feeds LiveTextDisplay. No translation is
included. Reset changes only the draft until Save; upgrades never replace a
saved graph with the new default. Existing explicit boolean translation
preferences migrate once when no graph is saved: only `enabled: true` adds the
translation branch. Missing/corrupt preferences use the minimal default; saved
graphs always take precedence, preserving custom settings and routes.

### Optional translation layout review (#152)

The only production caller of `defaultGraph({ enabled: true })` is `readGraph`'s
one-time import of `opus-mt-translation-preferences` when no graph is stored.
Fresh setup, Reset and error fallback use translation-disabled defaults. The
Graph Editor exposes concrete Nodes, with no translation preset control;
tests also call the helper to construct explicit translation graphs. Saved graph
migration uses the stored description rather than regenerating this default.

Retain the imported layout. **Original** shows all committed ASR text plus its
current preview through separate TextToDOM branches joined by DOMCombiner;
TextAccumulator retains only the committed original text. **Translation** shows one
completed original/translation pair through a direct `PairedTextToDOM` route.
Although the latest source appears in both panels, the standalone original also
keeps earlier utterances and remains current while translation waits or fails.
Removing it would lose that reading surface for users importing an existing
translation choice. Preserve those distinct reading surfaces during import.
Its panel names remain Original and Translation; each paired cell has
neutral First text/Second text accessible names including the cell text.

For a user-composed single comparison display, connect the translator's grouped
`source → input1, text → input2 → PairedTextToDOM.dom → LiveTextDisplay.dom` directly. Keep transcript
data accessible from ASR and, where desired, an explicit `TextAccumulator`;
comparison history requires an explicit `DOMAccumulator`. No automatic output
removal, graph rewiring or change to formatter/accumulator/combiner contracts is
needed. Saved and explicitly connected standalone displays remain intact.

`tests/browser/translation-preset.spec.js` exercises both directions using the
production graph runtime, DOM processors, Live HTML/CSS and renderer in Chromium
and WebKit, with controlled capture/model RPCs and recorder/navigation startup
disabled. It verifies history versus latest-pair behavior, previews, pending and
failed translation, accessible labels, Stop and Save/reload. Screenshots show
the [Japanese → English](evidence/translation-152-ja-en.png) and
[English → Japanese](evidence/translation-152-en-ja.png) layouts with fixture
translations; this is layout validation, not real-model inference validation.
`tests/extension-graph.test.js` covers fresh defaults, legacy preference import,
reviewed saved-version migration and recovery, saved-graph precedence and
explicit multi-output Save/reload preservation in both directions.
Validation for #152: `npm test` passed all 608 tests;
`npx playwright test tests/browser/translation-preset.spec.js tests/browser/dom-display.spec.js --workers=1`
passed all 10 Chromium/WebKit checks (using `ASR_BASE_URL` with an isolated local
server because the default port was occupied). No post-merge verification is required.

### Explicit translation composition

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
views become `LiveTextDisplay` with an explicit provisional DOM branch and final → append on an inserted TextAccumulator,
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
The visible warning directs you to **Graph actions → Recovery**. Before and after
Save, open Recovery to view, copy or download the complete original JSON,
including removed routes/configurations. The version selector also exposes older
and numbered recovery copies. Copy and download retain the exact original text.
Before v10 this used `processing-graph-before-v9`; new saves use `processing-graph-before-v14`; this backup remains
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
The Issue #146 call-site audit found no current UI/runtime callers of
`TabSession.setTranslation()` or `setTranslationDirection()`; the obsolete
`withTranslation()` bulk mutation helper was called only by those dead setters
and tests. Those APIs and the unused standalone preference reader/writer were
removed. Graph Editor saves explicit Node edits through `setGraph()`.
`graphPreferences()` remains a read-only hint for session status and historical
migration. Its first-translator direction is not authoritative for graphs with
multiple or opposite-direction processors. The stored `translationDirection`
field, first-run import of `opus-mt-translation-preferences` in `readGraph()`,
graph versions and migration/recovery copies remain unchanged. Existing saved
graphs take precedence over old preferences; no preference rewrites their Nodes
or downstream routes.

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
| LiveTextDisplay | dom: DOM | clone and mount each complete inert DOM snapshot |
| TextToDOM | text: TEXT | dom: DOM; literal text snapshot with visible whitespace |
| PairedTextToDOM | input1/input2: TEXT | dom: DOM; one atomic grouped pair, provisional or committed |
| DOMAccumulator | append: DOM | dom: DOM; ordered accumulated snapshots |
| DOMCombiner | first / second: DOM | dom: DOM; latest first snapshot followed by latest second snapshot |
| TextAccumulator | append: TEXT; text: TEXT output | exact committed transcript snapshots |
| [TextSlidingWindow](text-sliding-window.md) | text: TEXT; maxChars: NUMBER (optional, default 1000) | text: TEXT; rolling bounded snapshot per text event; no Settings |
| TextWindow | text: TEXT | text: TEXT (closed batches); provisional: TEXT (optional open snapshots); length/deadline/sentence settings |
| TranslationCommit | boundary/source/text/error: TEXT | provisional/final/error: TEXT; opt-in closed-window commits |
| TextFormatter | input1…inputN: TEXT, instance-configured, individually optional | text: TEXT; at least one input must connect |
| OpusMtJaEn / OpusMtEnJa / TranslateGemmaEnJa / TranslateGemmaJaEn | text: TEXT; provisional: TEXT (optional snapshot from any producer) | source/text/error: TEXT committed family; provisionalSource/provisionalText/provisionalError: TEXT preview family; failed groups omit translated text |
| Supertonic3 / Kokoro | text: TEXT | audio: SYNTHESIZED_AUDIO; configured language/voice |
| AudioOutput | audio: SYNTHESIZED_AUDIO | native audio player / WAV |
| SpeakerOutput | audio: SYNTHESIZED_AUDIO | automatic sequential default-speaker playback (no output ports) |

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
  and optional `provisional → TextToDOM → DOMCombiner.second`; history feeds `TextToDOM → DOMCombiner.first → dom → remote.dom` on a LiveTextDisplay labeled Remote speaker.
- `MicrophoneAudio.audio → SpeechToTextWhisper.audio`, with `final → local-accumulator.append → text → TextToDOM.text → dom → local.dom`
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

MeetingSummary and IfCondition use their production Nodes directly, including
`context.fail()`: model-load and asynchronous inference failures mark the shared
Pipeline entry failed, abort its signal and release its Worker. Their actionable
diagnostics appear once in the corresponding Live status. The Pipeline retains
the error and rejects Stop with its recorded `AggregateError` after draining
healthy paths. The session then disposes normally and retains committed output;
it does not turn that already reported error into a new whole-session failure.
Cancel interrupts loading, inference or Stop, and a restart creates fresh Nodes.
The summary backlog diagnostic is intentionally nonfatal: it rejects the
overflowing fragment, drains accepted evidence, publishes its final summary and
releases the Worker without marking that successful drain as a processor failure.

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
`TextToDOM.text → dom → LiveTextDisplay.dom` for replacement behavior. Segments end on Silero's trailing
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

`LiveTextDisplay` accepts only `dom: DOM`. Each input replaces the complete
rendered document, including empty fragments. Start clears the surface; Stop and
Cancel retain the last committed snapshot (upstream cancellation snapshots still
flow through TextToDOM). The sink never accumulates or interprets producer,
translation, pairing, layout or hover behavior.

`TextToDOM.text: TEXT → dom: DOM` constructs a new literal-text snapshot for every
input, including empty strings. It uses textContent and pre-wrap whitespace;
HTML-looking user data stays text. Its optional `className` setting adds CSS
classes to the snapshot for code-authored presentation; it defaults to empty,
including in existing v11 graphs. It owns no transcript history or source matching.
Summary and generic TextFormatter snapshots pass through this processor.

`TextAccumulator` constructs reusable transcripts upstream. `append` accepts each
exact string once, including empty strings, whitespace and equal consecutive
segments. One newline separates committed segments, including empty segments.
Every append emits the complete `text: TEXT` snapshot for any TEXT consumer.
Start clears history and emits empty text. Stop and Cancel retain committed
history without another emission. There is no provisional state in this Node.
For a replaceable tail, route the producer's provisional output through a separate
TextToDOM into DOMCombiner.second, with history DOM on first. ASR and
TranslationCommit emit a grouped empty provisional alongside each final, and clear
provisional on Stop/Cancel. Clears originate at the producer, before delayed
translation or rendering; stale identified partials/finals cannot reopen a closed
utterance. DOMCombiner only combines latest snapshots in fixed order. Keep
utterance consumers such as TTS, fields and translators connected to original
final outputs unless full snapshots are desired.

The accumulator retains one growing string and a segment count, avoiding an
item-array copy per event. JS engines may share string prefixes; this is an engine
optimization, not a memory guarantee. Reading/serializing/rendering a full snapshot
costs O(total text); consuming every growing snapshot can cost O(n²) over a session.
There is no truncation or transcript cap. Available memory, JS string limits and
browser layout time are real limits; this is not disk-backed storage. A Node test
checks 20,000 repeated 100-character commits (2,019,999 UTF-16 units) and reports
construction time separately from rendering. DOM formatters emit whole snapshots;
the sink clones and replaces the document on accepted updates. This deliberately
rebuilds the rendered snapshot, so selection inside replaced content may reset.
Long-session formatting/cloning/layout costs grow with retained history.

Live places configured outputs above its compact recording panel. Start, Stop
(finalize pending work) and Cancel (discard pending work) retain their existing
lifecycle. Capture target, progress, errors and model recovery remain visible;
**Input and output targets** reveals optional target controls. The routine
translation-off and unchanged-saved-graph notices do not take space.

Live renders one region per configured sink, ordered by Node array order, with
its user-supplied label (1–120 characters) and optional language. Labels and all
values use literal DOM text, never user-supplied HTML. Unchanged snapshot identities
stay mounted during unrelated UI status updates. New snapshots replace old content.
Copy text copies rendered text with formatter style elements excluded. Labels,
aria-live output, keyboard scrolling, and clipboard status remain generic. Runtime/model,
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
freely and connect formatter.text → TextAccumulator.append → text → TextToDOM.text → dom → display.dom. Pending translation emits
nothing; failure emits source/error with no successful text and clears the old
translation in the directly connected formatter. Every completion/failure appends
one readable result; repeated utterances stay distinct. Stop drains finals,
Cancel adds no pending/canceled rows, and both retain committed accumulator text.
Use TextToDOM without an accumulator instead when only the latest value is desired. Generic
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
also translates provisional source snapshots; connect committed text directly to append-only destinations, and provisionalText to a separate preview display. TranslationCommit optionally verifies causal window commits. Distinct utterances with identical text remain distinct. A source
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

For incremental audio use [Qwen3-TTS streaming](streaming-tts.md): committed TEXT
→ Qwen3-TTS 0.6B · streaming → `AUDIO_STREAM` → Speaker · streaming. Save prepares
690 MB; desktop Worker WebGPU is required. CosyVoice3 remains unsupported, with
its blocker and required follow-up documented separately. The completed-clip
paths below retain their existing behavior and ports.

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

For automatic live speech, add **Speaker** (`SpeakerOutput`) from **Outputs**:

```text
ASR.final / Translator.text → Supertonic3.text (or Kokoro.text)
TTS.audio: SYNTHESIZED_AUDIO → SpeakerOutput.audio: SYNTHESIZED_AUDIO
```

Speaker has one `audio` input, no output ports or settings. It plays completed
mono PCM clips through the browser's default audio output in arrival order,
starting the next clip after the previous one ends. This is successive playback
of complete clips, with browser scheduling latency. **Audio player / WAV** remains
the separate manual player/download output; existing saved graphs are unchanged
and adding Speaker requires no graph-version migration.

Press **Start** in Live to enable Speaker. Toolbar invocation prepares the session
and prompts for Start instead of attempting playback without a Live user gesture.
Start creates and resumes owned Web Audio contexts before microphone permission
or model-loading awaits. If the browser suspends/rejects audio or reports an
output failure, Live shows an actionable message and **Enable speaker**. Check
the system's default audio output, then use that button to retry; accepted clips
stay queued. An unexpectedly closed audio context instead directs Cancel and
Start, because a closed browser context cannot resume. No device picker or
per-clip controls are added.

The queue includes the playing clip and accepts at most **32 clips, 120 seconds,
or 32 MiB of PCM**, whichever comes first (plus one bounded browser playback
buffer). On saturation, Live explicitly reports the number of rejected clips;
the Node stops accepting new clips for that session, while preserving accepted
audio. Stop to drain accepted audio, then Start again to reset the queue and
overflow state. There is no unbounded playback backlog or automatic replay.

**Stop** drains already accepted upstream ASR/translation/TTS work and Speaker
playback in order. If playback is blocked, Stop waits for **Enable speaker**;
**Cancel** remains available to discard the queue immediately. The existing Stop
during model loading cancels startup before any generated audio has been accepted.
**Cancel**, reload and window close stop the current source, clear queued PCM,
disconnect audio nodes and close their contexts. Each new Start owns fresh audio
state, and canceled/previous-session replies cannot start playback. Speaker uses
no audio object URLs. Manual AudioOutput retains its existing URL cleanup.

**Keep the Live window open.** Playback belongs to that session's extension UI;
closing it cancels output. Opening Graph or Models while Live stays open is
supported. Background-service-worker playback is not provided.

Focused checks using controlled audio (no model downloads):

```sh
node --test tests/speaker-output.test.js
npx playwright test tests/browser/speaker.spec.js
npx playwright test --config playwright.extension.config.js tests/extension/graph-speaker.spec.js
```

The browser checks exercise native Web Audio in Chromium and WebKit. Packaged
MV3 checks use production graph routing/TTS Workers with controlled synthesis
fixtures, including both TTS types, autoplay/output failure recovery, overflow,
Stop, Cancel, repeat Start and Live close. See [#164 validation evidence](evidence/graph-164.md)
for packaging and physical-device/model validation limits.

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
through TextToDOM → DOMCombiner.second, and final through TextAccumulator.append → TextToDOM → DOMCombiner.first. Connect combined DOM to LiveTextDisplay.dom. Remove an
unused Number/Text configuration source when replacing the old ASR, or leave it
parked. ReazonSpeech, Whisper and Zipformer can coexist with independent settings. Existing TEXT sinks and
translation Nodes use the same contracts.

Adding Zipformer needs no extra migration beyond the current version 14 graph.
Unrelated ASR nodes, IDs, settings, routes and positions stay intact; earlier
versions use the migration rules above. The minimal ReazonSpeech default remains. See [model pins, fixed 12-second segments,
Stop/drain, setup and limitations](zipformer-node.md).

## Optional Parakeet v3 and Moonshine Medium Streaming

Search Add Node for Parakeet or Moonshine. These independent concrete Nodes use
the same normalized audio sources and final TEXT fan-out as existing ASRs.
Parakeet exposes final only; Moonshine exposes demonstrated native provisional
and final. Both can coexist without changing the default graph.
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
Pending emits nothing; Stop drains committed work. Final acceptance, Stop and Cancel explicitly clear the preview family. Parked Nodes remain saved and are
prepared on Save but run only on a complete source-to-sink path. Multiple
independent model Nodes own separate Workers and require memory for each.

Graph v14 requires reviewed repair for saved provisional-enabled routes; committed-only routes retain their behavior. Save prepares one shared **3.112 GB** checkpoint for both directions;
preparation failures do not undo storage. Allow 7 GB free storage and several GB
RAM/GPU memory; Worker WebGPU and a usable adapter are required. Missing/evicted
weights need Save or Models recovery before starting. No runtime downloads,
cloud API or automatic fallback. Read Google Gemma Terms and Prohibited Use
Policy in Help / Models before preparation or use; a public ONNX conversion
does not waive upstream terms. See [full setup and attribution](translation-nodes.md#translategemma-in-the-extension-124)
and [#124 validation](evidence/translation-124.md).

## Windowed and revisable translation (#128)

The model-independent **TextWindow** and opt-in **TranslationCommit** processors
use ordinary TEXT ports, require no weights, and use graph version 14. See
[connections, limits, lifecycle and measured comparison](windowed-translation.md).
Defaults and existing per-segment translator paths remain unchanged.

### DOM formatters and display ownership

The shared `DOM` identity lives alongside TEXT/NUMBER in `web/port-contracts.js`.
Its value is an actual HTML Node, text node or DocumentFragment, constructed on
the extension page’s main thread. Snapshots are immutable after emission; the sink
validates and deep-clones each delivery, preserving the producer’s nodes and safe
fan-out to multiple displays. The Live renderer clones again before mounting so
stored session snapshots remain independent of a mounted document.

This is a small inert formatting contract, not an arbitrary HTML interface.
`cloneDOM` permits standard formatting/table elements and code-authored style
nodes, with a bounded set of presentation/accessibility attributes. It rejects
scripts, embedded documents, custom elements, resource elements, event/URL
attributes and resource-loading CSS. Producers use createElement/textContent;
user strings never enter HTML or CSS parsers. CSS belongs to trusted formatter
code. No HTML-string port, generic component system or Worker DOM serialization
is supported. Inference remains in existing Workers using TEXT RPCs.

```text
ASR.final → TextAccumulator.append → TextToDOM.text → DOMCombiner.first
ASR.provisional → TextToDOM.text → DOMCombiner.second
DOMCombiner.dom → LiveTextDisplay.dom
MeetingSummary.summary → TextToDOM.text → dom → LiveTextDisplay.dom

OpusMtJaEn.source → PairedTextToDOM.input1
OpusMtJaEn.text   → PairedTextToDOM.input2
PairedTextToDOM.dom → LiveTextDisplay.dom
```

PairedTextToDOM formats each atomic result, provisional or committed, into a fresh
DOM snapshot containing **only that pair**. A direct formatter → display connection shows the
latest pair, replacing the previous one. The formatter keeps no history and never
caches independent inputs for later matching. Exact input strings, including
whitespace, duplicates and empty results, stay literal. Input1 renders on the left and input2 on the right. An atomic group
with input1 but no input2 leaves the right cell empty, without reusing a previous
value. Input2 alone emits nothing. The formatter has no error port or error UI.
Translation failures retain the source in the left cell; specific errors remain
visible in the existing translation status/observer diagnostics (preparation,
load, inference, malformed/empty output, Worker communication and utterance limits).
One headerless table row contains both cells, so unequal text heights stay aligned. Cells have accessible
First text/Second text labels; formatter-owned CSS highlights both cells of just the
hovered/focused pair, and both cells are keyboard focusable.

For a growing comparison transcript, explicitly insert DOMAccumulator:

```text
Translation.source → PairedTextToDOM.input1
Translation.text → PairedTextToDOM.input2
PairedTextToDOM.dom → DOMAccumulator.append
DOMAccumulator.dom → LiveTextDisplay.dom
```

DOMAccumulator is a generic processor with only `append: DOM` and `dom: DOM`.
Each delivery appends a validated deep clone and emits an independent complete
snapshot, preserving order and duplicates. It does not interpret translations,
merge tables or add headings. Paired snapshots retain their side-by-side layout
and separate hover/focus highlights without repeated headers. Inputs, retained
history and fan-out consumers own separate trees. Start emits empty history; Stop
drains accepted work and retains committed history; Cancel freezes history and
rejects stale deliveries. History is session-local, uncapped and not persisted;
growing snapshots consume memory and rendering time. LiveTextDisplay continues
to replace its content for every delivery in either graph.

To show live English ASR below committed bilingual history in **one** Live region,
add DOMCombiner and TextToDOM in Graph Editor. Set this TextToDOM's `className`
to `paired-text-tail` in its Node settings:

```text
MicrophoneAudio.audio → SpeechToTextZipformerEn.audio
SpeechToTextZipformerEn.final → OpusMtEnJa.text
OpusMtEnJa.source → PairedTextToDOM.input1
OpusMtEnJa.text → PairedTextToDOM.input2
PairedTextToDOM.dom → DOMAccumulator.append
DOMAccumulator.dom → DOMCombiner.first
SpeechToTextZipformerEn.provisional → TextToDOM.text
TextToDOM.dom → DOMCombiner.second
DOMCombiner.dom → LiveTextDisplay.dom
```

The Live stylesheet places `paired-text-tail` in the left half with the same
inset as a paired left cell and italic text to distinguish the changing tail.
The right half stays empty, and an empty tail occupies no space. No label or
status panel is added. The class is an explicit presentation choice for this
composition: standalone TextToDOM snapshots remain full-width plain text.
DOMCombiner, DOMAccumulator and LiveTextDisplay do not interpret the class.

DOMCombiner retains only the latest snapshot on each input and emits a complete
snapshot in fixed first → second order whenever either input changes. An empty
fragment clears only that input. It validates and deep-clones incoming and
outgoing trees, including inert CSS; it has no source IDs, history, translation
rules or modes. Start emits an empty snapshot and clears both inputs. Stop drains
accepted input; Stop/Cancel retain the latest display and reject late deliveries.
DOM processors run on the page main thread; native DOM never crosses Workers.
DOMCombiner needs no migration or automatic insertion; the paired input rename
follows the reviewed v12 conversion below.

ASRs with provisional/final outputs finalize atomically: empty provisional TEXT
and final TEXT belong to the same emission, with preview clearing before final
consumers run. TextAccumulator appends the final once; translators schedule only
the committed input when both channels connect. Duplicate worker finals do not
clear a newer preview. Delayed translation completion cannot clear later speech.
The provisional branch renders literal English only and never appends to history.
While final English awaits translation, it intentionally has no separate pending
row. There is no pending-row tracking or speculative translation in this recipe.
Final-only ASRs keep their existing output contracts.

Every DOM-based Live region follows new content only when its own scroll container
is within 24 px of the bottom before replacement. Scrolling up keeps the current
offset (clamped if content becomes shorter); manually returning to the bottom
resumes following. Layout and wrapping changes also follow while reading the
bottom. Regions behave independently. Browser scroll anchoring is disabled;
updates use immediate scrolling without moving focus or starting animations.

Direct PairedTextToDOM → LiveTextDisplay graphs show only the latest pair (#140).
The v12 port migration preserves this direct DOM route and never inserts an
accumulator automatically. The optional translation example produced by
`defaultGraph({ enabled: true })` also uses latest-pair behavior. Add the explicit
accumulator in Graph Editor only when history is wanted.

Compatible TEXT wiring remains saveable, including incomplete drafts and alternate
producers with different output names. At runtime the paired consumer requires
both input1/input2 routes to belong to the same direct producer's explicit group,
even when a particular emission omits input2. Independent emissions or mismatched producers fail the consumer
without joining values by equality or timing. The scheduler marks actual preview
results using internal `emitOutputs(values, { provisional: true })` provenance;
PairedTextToDOM formats those deliveries identically to committed pairs. For paired
previews, wire provisionalSource → input1 and provisionalText → input2 on a separate
PairedTextToDOM → LiveTextDisplay replacement branch. Empty cleanup groups render
blank cells; the producer owns cleanup timing. Keep committed source/text on their
own formatter branch and add DOMAccumulator there only when history is desired.
Inactive branches are excluded from execution. For bounded retranslation, a plain
translator.provisionalText → TextToDOM preview branch also works; optional TranslationCommit → TextAccumulator → TextToDOM
keeps causal window checks on committed results. Plain TextFormatter remains available for independent
latest values; it does not claim correlation.

### Graph v11 display migration and recovery

Version 11 intentionally removes content: TEXT. Old saved graphs cannot run until
reviewed and saved. Valid v10 TEXT display routes open an unsaved conversion draft
with one collision-safe TextToDOM per connected display. Original Node IDs,
settings, positions, unrelated branches and text fan-out remain intact. There is
no alternate TEXT display mode. Disconnected displays remain drafts. Invalid or
ambiguous conversions require explicit repair/reset; storage stays untouched.

Versions 1–9 first follow their earlier migrations and then the reviewed DOM
and append-only conversions described below. Legacy display-only replacement
branches become explicit DOM snapshots; no runtime legacy-display flag remains.

On reviewed Save or Reset-and-Save, the exact original JSON is backed up under
`processing-graph-before-v14` for current saves (v11 used
`processing-graph-before-v11`). Older backups remain available. Conflicting copies
get suffixes -2, -3, etc.; identical originals reuse their copy. Backup failures
leave the original saved graph untouched. Graph Editor exposes original JSON both
before and after Save for recovery/export.

### Graph v12 paired input migration and recovery

Version 12 changes only PairedTextToDOM's named inputs and presentation. Saved
v11 graphs containing this formatter cannot run until the Graph Editor review
draft is saved. The draft renames incoming source → input1 and text → input2.
Any former edge into its error input is explicitly listed as removed in the
review message; that removal happens only in the draft. Translator error outputs
and unrelated error fan-out remain intact. Use existing translation diagnostics
for failures. No new error UI or replacement error port is inserted.

Nodes, IDs, settings, positions, unrelated routes, DOM history and preview wiring
stay unchanged. V11 graphs without paired formatters upgrade without a review;
earlier versions still follow their existing reviewed conversions and receive
the same paired-port repair where applicable. Invalid conversions have no runnable
draft: export the original and repair it, or Reset and Save. A current-version
graph with obsolete ports is rejected rather than silently repaired.

Reading a paired graph never overwrites it. Reviewed Save or Reset-and-Save keeps
the exact original JSON under `processing-graph-before-v12`, with numbered copies
on collisions; older recovery keys remain accessible in the editor. A failed
backup write leaves the saved original untouched. Export that recovery copy to
restore old error routes in a compatible version or deliberately reconnect them
to an existing appropriate TEXT consumer.

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

## Issue #146 validation

`npm test` passes all 606 tests. The new
[`graph-model-failures.test.js`](../tests/graph-model-failures.test.js) exercises
both summary processors and IfCondition through the actual graph Pipeline and
session: load, inference and Stop failures; recorded failure/abort state; Worker
cleanup; retained commits; independent field/display/opposite-direction
translation paths; Cancel during load/inference/Stop and restart; no viable
startup path; and the intentionally nonfatal summary overflow diagnostic.

Chromium MV3 checks passed 65 distinct tests (72 executions, including a rerun
of the seven updated IfCondition checks):

```sh
npm run test:extension -- tests/extension/graph-model-failures.spec.js tests/extension/graph-if-condition.spec.js tests/extension/graph-meeting-summary.spec.js tests/extension/graph.spec.js
# 26 passed
npm run test:extension -- tests/extension/graph-if-condition.spec.js tests/extension/graph-concurrent.spec.js tests/extension/primitive-composition.spec.js tests/extension/windowed-translation.spec.js tests/extension/translation.spec.js
# 46 passed
```

These checks used a source-only fixture package: the extension directory,
manifest and `build-extension.py`'s shared source list, with the tests' existing
deterministic model/runtime fixtures. `npm run build:extension` was blocked by
missing local model assets (`Missing local models. Run npm run prepare:assets
first.`). A complete production asset build and real-model smokes were not run;
fixture results do not establish model accuracy. `git diff --check` passed.

### Graph v13 append-only migration and recovery

TextAccumulator exposes only append: TEXT → text: TEXT. Graphs through v12 with
preview edges require review before execution. Display-only routes receive an
unsaved draft with collision-safe TextToDOM and DOMCombiner branches. Existing
accumulators, formatters, display IDs, settings, positions and unrelated routes
remain intact, including multiple display outputs and explicit DOM compositions.
ASR and TranslationCommit clear their own provisional outputs on final and at
session end. Independent and preview-only streams remain independent snapshots:
an unrelated append no longer clears them, and Stop/Cancel clear them only when
their producer emits a clear. The migration warning explains this lifecycle
change; review the sources and reconnect deliberately before Save. A disconnected
append draft is retained and may be completed later without hidden behavior.

Shared TextToDOM inputs and arbitrary accumulated TEXT consumers cannot be
converted without changing their values. These routes remain blocked with a
manual-repair explanation and the complete original JSON in Recovery; no edge
is silently removed. Recompose display previews separately, and keep ordinary
TEXT consumers on the intended committed history, before importing/saving.
Current Save (including Reset-and-Save) first preserves the exact original under
processing-graph-before-v14, with numbered collision copies. Existing
processing-graph-before-v* backups are never overwritten. Failed backup writes
leave the original in place. Valid append-only v12 graphs upgrade without
changing nodes or edges; explicit current DOM compositions are unchanged.

### Graph v14 translation output migration (#163)

Both TranslateGemma directions and both OPUS-MT directions use one scheduler and one
Worker per Node for committed and provisional requests. Committed text input emits
grouped source/text/error; provisional input emits grouped
provisionalSource/provisionalText/provisionalError. A failure omits translated text
within its own family and reports diagnostics. Committed input wins grouped input,
drains FIFO before pending previews, invalidates stale previews, and immediately emits
an empty preview family. Stop also clears previews; Cancel publishes the same empty
cleanup family before disposal. Direct text-to-history/field/TTS is committed-only.

Wire provisionalText → a separate TextToDOM.text → LiveTextDisplay.dom. Its empty values
clear that branch. Use a separate TextFormatter if preview formatting is needed; never
append its output to history. Generic display/composition Nodes have no
translator-specific rules. PairedTextToDOM accepts both families on separate
branches and requires an atomic group from one producer for each pair. DOMCombiner
can combine committed DOM history with a replacement preview branch.
TranslationCommit checks causal closed-window results only and rejects unclosed
results; preview routing bypasses it. Its existing provisional output supplies only
empty boundary/final clears for compatibility.

Older graphs with provisional connected to any of the four translators, or with any
TranslationCommit Node, require review before execution, including inactive drafts. The
recovery draft retains all existing Nodes, settings and routes. The warning identifies
affected translators and the new output ports; deliberately reconnect preview consumers
and clearing paths before Save. The v13 append-only accumulator migration still applies
to older preview routes; graphs saved at v13 also receive this v14 translation review.
When both reviews apply, the warning describes both changes in one repair draft.
No mixed route is silently reinterpreted. V13 graphs
without provisional translator input or TranslationCommit upgrade unchanged. Earlier
reviewed DOM migrations still apply. Save preserves the exact original string under
processing-graph-before-v14, numbered on collision; older recovery copies remain
accessible through Graph actions → Recovery, Copy JSON and Download JSON.
