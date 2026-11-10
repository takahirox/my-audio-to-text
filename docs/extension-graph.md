# Executable extension processing graphs

The Graph Library stores independent named graphs. Graph Editor saves explicit
Nodes and named-port connections to the selected library entry. Start executes complete paths to outputs. Incomplete draft branches
remain saveable and do not allocate capture, model Workers or output permissions.
The active graph is an immutable snapshot; edits take effect at the next Start.

## Graph Library (#243)

Open **Library** from Live, Graph or Models. Search names, descriptions or model
names, sort by name/recent update, and filter entries needing recovery. The single
responsive graph workspace contains the list; selecting a row opens a detail
dialog with preview, metadata and editing actions. **Back to graphs** restores
focus to the invoking row. Selection never launches a session or changes a default.
Create, rename, describe, duplicate, import or export entries without starting
inference. New graphs use the current transcription layout; portable JSON remains
the existing version-15 graph format. Models remains accessible in the header.

**Launch Settings and its Live/Web graph dropdowns have been removed (#267).**
Choose graphs where they launch:

- Left-click the extension toolbar icon to open a new Live window for the saved
  default graph and the invoking tab. Opening prepares models, but never starts
  capture or requests microphone permission. Press **Start** when ready.
- Right-click the toolbar icon for Chrome's native **Live graphs** submenu.
  **Open <graph>** creates a separate window without changing the default.
  **Default for left-click → <graph>** explicitly changes the persisted default
  without launching anything. The single action-level submenu accommodates large
  libraries and preserves Chrome's extension-management commands. Chrome's native
  keyboard context-menu access is unchanged.
- Every Live window keeps its launch graph ID and tab. Graph edits and renames
  apply at its next Start; changing the global default never changes an existing
  window. Active runs keep immutable snapshots, including Graph Actions and outputs.
  Stop, close and failures release only that window's resources. Multiple Live and
  Web microphone sessions can prepare and run together, subject to actual Chrome,
  device, permission and RAM/GPU limits.
- Only validated graphs with executable paths appear in the toolbar menu. Missing,
  invalid or deleted choices never substitute an unrelated graph. An invalid default
  selects the sole runnable graph if exactly one exists; otherwise Live shows an
  actionable error directing the user to the toolbar default submenu or Library.
  An existing window whose graph is deleted may finish its snapshot, but cannot
  Start again until that same ID is restored. Open another graph from the toolbar.

The compact **Web microphone ON/OFF** control above the workspace starts OFF
without explicit opt-in. Turning ON opens the consent dialog; **Continue to
website permission** requests the same optional access to all HTTP/HTTPS websites.
Cancel or denial leaves controls OFF. Choosing a default never enables them or
requests microphone access. Turn OFF to remove controls and cancel Web sessions;
the saved Web default remains. OFF remains available even if library storage needs
recovery. **Website access & microphone help** discloses permission patterns,
unsupported fields/pages, local processing, microphone consent and Chrome Site
access revocation. No website permissions are broadened by graph selection.

On an enabled page mic, right-click (or focus it and press **Shift+F10**) to choose
a compatible microphone-only graph as the saved default for the next recording.
Arrow keys/Home/End navigate the menu; Escape dismisses it and restores mic focus.
This page-widget menu is separate from Chrome's native toolbar menu. It filters
with the existing Web voice graph rules; Live is never substituted when the Web
default is missing or incompatible. Selecting a default during recording preserves
the active snapshot. Click the page mic to start/stop local dictation; any required
native microphone consent uses the existing one-time setup tab.

**Edit graph** opens `graph-editor.html?id=<stable-id>`. Save, Load saved, Reset,
Import and Export all concern that entry's draft. Save prepares required cached
files, including parked Nodes, after persistence. Other entries and execution
assignments remain unchanged. Closing/navigating away from a dirty editor warns
before discarding. Concurrent edits to different entries merge under Web Locks;
stale saves to the same entry are rejected and retain the draft for export or
explicit Load saved. Library name/description forms likewise preserve unsaved
input when another page changes storage. **Save details** saves the name and
description; **Edit graph** edits Nodes. Unsaved details survive filtering and
cache updates, warn before selection changes or navigation, and are retained in
per-tab sessionStorage across refresh with their original entry revision. A
stale restored draft still cannot overwrite a concurrent save. **More → Load
saved details** explicitly discards the draft after confirmation.

**More** also holds Export JSON and Delete. Delete requires confirmation, clears
any defaults pointing to that entry, and keeps at least one usable graph. A corrupt entry stays visible with an error and its original JSON available for export; import a repaired copy
as a new entry. Its original is never overwritten by an editor recovery draft.

See [toolbar launch and Library validation](evidence/toolbar-launch-267.md).

**Models & saved information** in the detail panel holds timestamps, required
models and **File cache**, distinct from Live's runtime/GPU readiness:
model-bearing graphs initially show **Unknown**, not an unconditional Ready.
**More → Check model files** inspects the selected graph's actual manifests without
starting Workers, GPU work or downloads. It reports Ready (verified cached files),
Needs preparation or Error; packaged ASR verification is left to Live and remains
Unknown here. Graphs without model files can report Ready on that basis. Model
cache notifications/focus invalidate old observations to Unknown. Models remains
the global asset inspection/recovery screen; shared weights retain their existing
asset-identity cache and are not duplicated per library graph.

The version-1 library envelope is stored atomically in one localStorage value,
`processing-graph-library-v1`: graph IDs, names, descriptions, timestamps,
per-entry revisions, graphs and `{ live, webVoice }` defaults. The legacy
`assignments.live` ID is retained as the toolbar default without changing identity;
`assignments.webVoice` remains the independent page-mic default. Defaults may be null
or dangling so deleted/invalid choices can be repaired without corrupting the library. Graph metadata
never enters the portable version-15 executable graph JSON. Mutations share the
existing `processing-graph-save` Web Lock and compare revisions; unsupported
hosts without Web Locks stay read-only.

First open migrates `processing-graph-v1` into **My saved graph** with that exact
source object and original bytes retained, and assigns its ID to Live. The legacy
key is never removed or overwritten. Fresh installs create only **Live
transcription**, with no Web voice assignment. Concurrent opens/reloads reuse the
committed envelope. Failed quota/write attempts return the same deterministic
graph/ID as a read-only fallback; a later open can commit migration. Malformed
legacy data becomes a recoverable invalid entry and blocks Live until a new valid
entry is chosen from the toolbar. Unsupported/corrupt library envelopes expose original storage
for export and fail closed. If an older page changes the legacy key after
migration, saving/Live selection stop until **Keep changed legacy graph as new
entry** preserves the changed source separately. This never changes assignments.

`readGraph`/`saveGraph` in `graph.js` are now **legacy-only** and reject stores
containing a library, so an old caller cannot silently edit a different graph.
Use `GraphLibrary.save(id, revision, graph)` for drafts, `readSelectedGraph(storage, id)`
for a particular Live window, or the explicitly named async `saveLiveGraphData` and
`readLiveGraphData` compatibility helpers for automation deliberately targeting
the current saved Live default. They never refer to the Library/editor selection.
These compatibility helpers allow incomplete saved drafts to be repaired; window
launch validation separately requires an executable path.

MV3 workers cannot access localStorage. Toolbar list/default requests use the
existing offscreen DOM host and Web Locks, sharing its serialized lifecycle with
Web dictation. A library-only request closes the inert host when finished; it
never closes a host with pending reads or active Web owners. No parallel storage
mirror can race with library saves. Commits notify the worker to refresh native
menu definitions; install/update, startup and each worker generation also refresh.
Window URLs carry an explicit graph ID, invocation tab and independent session ID.
The launch handler retains the event's tab through asynchronous library reads;
focused-field authorization is prepared before the popup takes focus. Editors
aggregate activity by session ID, so one window's idle/close notification cannot
clear another window's activity.

## Live model lifecycle (#239)

Save prepares and verifies browser-local model **files**, including parked Nodes;
it never starts inference Workers or initializes GPU models. Opening Live selects
only `executableGraph(savedGraph)` routes to output sinks and immediately
initializes every required model instance, including models behind Button/Hold
gates. Live shows **Preparing models…**, with real Node/step counts when available,
and disables Start until every instance is ready. A graph without AI becomes
Ready after ordinary executable-graph validation.

**Ready** means inference resources are initialized, rather than just cached.
Start transfers the same runtime, Workers and model instances to the session;
only then do sources, startup TEXT/NUMBER emissions, outputs, and explicit
microphone/speaker/capture gestures run. Preloading runs no inference, dummy input,
trigger, capture or output hook. Hold still gates execution. Whisper.language and
ReazonSpeech.maxDuration constants are read and validated before model loading,
and their configuration deliveries are consumed exactly once. A single constant-fed
TextFormatter can supply startup text too. A configuration
dependent on future session data cannot be ready before Start: Live reports the
Node/port and asks for a Text/Number startup constant instead of guessing a default.
Other consumers of those constants still receive ordinary session startup values.

The model lifecycle is separate from the session's recording state:

| Model state | Admission and transition |
| --- | --- |
| `preparing` | Start disabled; initialize an inert runtime from a saved snapshot. |
| `ready` | All executable models ready; Start also checks existing input/tab constraints. |
| `active` | Start owns that same runtime; saved edits wait until the session ends. |
| `error` | Start disabled; identify the failing Node and show Graph/Models recovery plus Retry models. |
| `canceled` | Stop during preparation releases resources; Retry models resumes preparation. |
| `closed` | Terminal; release all Workers/media/GPU resources and suppress late callbacks. |

Each Live window and Web microphone session owns an independent runtime, including
while its models are preparing or Ready. There is no global inference admission
lock. Starting or closing another window does not release this window's prepared
models; hardware/permission failures remain local resource errors. See
[concurrent Live/Web sessions](chrome-extension.md#web-voice-validation).

Stop drains outputs, disposes the used single-session graph, and prepares a fresh
runtime before re-enabling Start. Internal Cancel releases the old owner before
the same idle restoration. Completed display output remains visible. Each Node
keeps its own processing state and dedicated Workers; cached immutable files are
shared, and Start never creates a second copy of its ready models. Repeated
prepares/Starts coalesce. A Save during idle/preparation invalidates and tears down
the obsolete owner before preparing the new snapshot. Running sessions retain
their immutable graph until Stop/Cancel. Closing Live releases both pending and
active resources; verified Cache Storage files persist.

Live initialization is cache-only: it cannot recover missing, corrupt or evicted
optional weights by downloading. Save in Graph or use Models preparation, then
**Retry models** in Live. Unsupported hardware, memory failures, initialization
timeouts, Worker failures and observed GPU device loss invalidate readiness.
There is no automatic retry loop or model substitution. Ordinary session branch
errors remain visible while healthy paths finish. Opening Graph/Models alone
never opts into this GPU lifetime.

Developer checks: `tests/live-model-preparation.test.js` covers gated and multiple
models, parked/no-model graphs, configured ASR with translation, graph replacement,
failures, timeouts, cancellation and repeated ownership transfers.
`tests/extension/live-model-preparation.spec.js` exercises the real MV3 Live UI
with controlled Workers, including disabled Start, no remote requests, recovery
and replacement. These deterministic fixtures establish lifecycle behavior;
hardware/model inference qualification remains in the opt-in real-model suites.
For production preloading coverage, run `npm run setup:extension`, then
`python3 scripts/review-opus-mt-assets.py`,
`python3 scripts/review-text-summary-assets.py`,
`python3 scripts/review-tts-assets.py` and
`python3 scripts/prepare-reazon-ja-en-fixtures.py` to seed the pinned test assets.
`npm run test:live-model-real` checks real Whisper + OPUS-MT, a Button/Hold-gated
LFM2 summary and both Kokoro phonemizers. It verifies readiness before Start,
no pre-Start permissions/inference, Worker reuse on first use, two sessions,
Stop/reprepare and pagehide termination, with networking blocked during Live.
Each case saves its source hashes, Worker observations, outputs and host details
to `test-results`; retained validation is in
[`evidence/live-model-preparation-239.json`](evidence/live-model-preparation-239.json).

## Editor and saved graphs

Use Add Node to open a searchable list beside the toolbar button. Search or
filter by category, then click/tap a result to add it immediately near the center
of the visible canvas. Opening the list leaves every result unselected. Typing a
nonempty search highlights its first match; clearing search or changing category
clears the highlight. From no selection, Arrow Down selects the first result and
Arrow Up selects the last; further arrows navigate results. Enter adds only the
highlighted Node and does nothing with no selection. Escape or clicking outside
dismisses the list and clears selection. Adding keeps the current
zoom and pan, selects and focuses the new Node, and leaves changes unsaved until
Save. The compact toolbar shows Saved / Unsaved for the editor draft and a separate
green **Active** indicator only when this graph is running in Live, alongside Add
Node, Save, Graph actions (…) and Help (?). Hover Active for the capture tab ID;
the number does not occupy canvas space. Idle and routine active sessions have no
status row below the toolbar. At the narrowest widths, draft and Live status stack
within the same toolbar height, keeping every action available. An exceptional
warning below the toolbar wraps in full: **earlier graph; saved edits apply next
session** means Live is still running its immutable older snapshot. A saved graph
changed elsewhere warning preserves your draft; export it if needed, then choose
**Graph actions → Load saved** before saving. Both warnings remain readable when
they occur together. Select a heading for settings and help; click it again, press
Escape, or click blank canvas to clear selection. The Inspector identifies the
Node by type and Instance ID, with Remove Node beside Settings. Drag headings or use arrow
keys to move Nodes. Connect an output to a compatible input; reconnecting replaces only that input's wire. Select a wire
for details or Disconnect. Canvas navigation floats at the bottom-left: −, the
Canvas zoom chooser, +, and Fit. The chooser retains 25%, 50%, 75%, 100%, 125%,
and 150%, plus the actual custom zoom (shown to two decimal places), including
Fit scales below 25%. The − / + buttons change zoom by 10 percentage points.
Ctrl + mouse wheel and Chromium trackpad pinch zoom continuously around the
pointer: wheel up / pinch out magnifies, wheel down / pinch in reduces. Both use
the same viewport-local Ctrl+wheel handler, which prevents browser zoom only
over the canvas. Ordinary wheel / trackpad scrolling still pans; Inspector,
search, navigation controls and overlay menus keep their native behavior.
Zoom is clamped to 1%–150%, including Fit. Wheel line deltas use 16 CSS pixels
per line, page deltas use the viewport height, and single-event deltas are capped
at 10 pixels (about a 10% zoom change) to avoid large spikes. Pointer anchoring
accounts for pan and scale; native scroll bounds can limit it near an edge. Modified wheel gestures
during a node or port drag are consumed without changing zoom.
Choose 100% to resume editing with focus on the last edited port, heading or selected wire.
Scroll or swipe to pan; controls stay in place and extra bottom scroll space
lets the final ports move clear of them.
Settings, essential port names and accessibility labels remain visible.

Graph actions (…) provides Validate draft, Load saved, Reset draft to default, and
Import or Export graph JSON. Export downloads the validated current draft,
including multiline settings. Import validates before replacing the draft. Save is required
to apply an import or Reset. Save prepares the selected model assets, including
parked model Nodes; opening or loading a graph does not download weights. Models
provides preparation, retry, cache verification and license/terms information.

Portable graph JSON retains schema version 15. The Library stores metadata and
assignments separately, migrating the old `processing-graph-v1` key as above. Unsupported
Nodes, ports and versions fail explicitly. Live disables Start and links to Graph
Editor. The editor shows the error and a current default draft. Graph actions →
Saved JSON exposes the rejected original for inspection/export. Save keeps that
invalid original intact; repair and import a new Library entry instead.
Existing version-15 `Display.input` edges are deliberately converted to
`Display.input1`, with missing `settings.inputCount` initialized to 1 and
`settings.title` to an empty string. IDs, positions, other settings and unrelated
ports (including `Hold.input`) stay unchanged. Load, Import, validation and runtime
selection use the same conversion; reading leaves stored JSON untouched. Save and
Export write the canonical numbered ports. Conflicting `input`/`input1` connections
fail validation instead of replacing an edge. Removed display Node types and
older schema versions still fail explicitly. Current [example JSON](evidence/item-198.json) can be imported directly.

## Default transcription and translated history

Fresh setup and Reset create:

```text
ChromeTabAudio.audio → SpeechToTextReazonSpeech.audio
ASR.final/finalId → KeyedTextCoalesce.input1/id1
ASR.provisional/provisionalId → KeyedTextCoalesce.input2/id2
KeyedTextCoalesce.text/id → KeyedTextPair.input1/id1
KeyedTextPair.pair → KeyedPairedTextAccumulator.pair
KeyedPairedTextAccumulator.pairs → Display.input1
```

Translation is an explicit addition:

```text
ASR.final/finalId → Translator.text/id
Translator.text/id → KeyedTextPair.input2/id2
```

Original text appears immediately, with an empty right cell while translation is
pending. Final text replaces provisional text for the same ID without a blank
gap. Late translation replaces only its own row while newer utterances remain
visible. Equal strings under distinct IDs remain distinct rows. The accumulator
uses arrival order alone, with no stage or model-specific priority.

Final-only ASRs omit the provisional branch. For append-only plain text, use
`ASR.final → TextAccumulator.append → text → Display.input1`. Any complete TEXT
snapshot, including `TextSummary.summary`, can connect directly to Display.

See [portable display items](display-items.md) for contracts, exact wiring,
snapshot ownership and lifecycle, and [ID-scoped pairing](keyed-text-history.md)
for independent ID/TEXT arrival semantics.

## Port display order

Canvas rows, native keyboard tab order within each input/output column, and
Inspector **Node help and ports** show payload above its matching numeric ID.
Committed pairs precede provisional pairs, matching the default coalesce wiring:

| Node | Inputs, top to bottom | Outputs, top to bottom |
| --- | --- | --- |
| ASR | Audio, then optional configuration | final, finalId, provisional, provisionalId (previews where supported) |
| KeyedTextCoalesce | input1, id1, input2, id2 | text, id |
| KeyedTextPair | input1, id1, input2, id2 | pair |
| OPUS-MT / TranslateGemma | text, id, provisional, provisionalId, then context where supported | text, id, source, error; provisionalText, provisionalId, provisionalSource, provisionalError |

Translation source/error outputs remain in their committed or provisional family;
context is an independent auxiliary input. Duration/size limits, triggers and
other configuration inputs are not identifiers and keep their own roles.
Numbered Display and TextFormatter inputs stay in numeric order as inputs are
added/removed, including input10 and above.

Definitions declare optional `inputOrder` / `outputOrder` presentation metadata.
The view resolves it against each instance's actual ports, ignoring duplicate,
unknown and malformed entries and appending unspecified ports in declaration
order. All real ports remain present. This does not change runtime contract or
group order, queue/producer semantics, graph version 15, saved named endpoints,
node positions, or import/export. Redraw measures the rendered buttons before
routing; zoom, resizing and dynamic input changes remeasure the same endpoints.
See [Issue #237 geometry comparison and checks](evidence/graph-237.md).

## Automatic wire routing

Connections use rounded orthogonal paths around measured node cards, including
all port labels and controls. Distinct connections prefer lanes 10 canvas pixels
apart. A narrow canvas-colored outline on every wire creates a gap in any wire
passing underneath it: the continuous line is the overpass, not a junction.
These conventions work in the normal, unselected view. Stable light colors
supplement the geometry; colors can repeat and do not represent port types.
Short shared stems at a single output represent real fan-out. Beyond those
stems the router separates the outgoing connections, including backward and
Hold feedback edges. It never moves cards automatically.

`extension/graph-wire-router.js` is a dependency-free visual module. It does
not change stored positions, graph edges, typed contracts or session execution.
It builds a rectilinear visibility grid from expanded card boundaries, port
escapes and additional lane lines. Cards expand by 12 canvas pixels; quadratic
corners have a maximum 6-pixel radius, retaining clearance from visible bodies.
Only the first and last attachment segments may enter their own cards. Fan-out
turns are staggered by up to six 10-pixel steps and clamped to the available
corridor; attachment paths cannot double back over a port.

For each geometry snapshot the router first finds node-clear baselines with
Manhattan A* and a bend penalty. In stable connection-key order it reserves
accepted paths and searches for alternatives with a strong cost for prolonged
parallel overlap or close spacing. Perpendicular intersections remain possible
and use the crossing convention above. An alternative's length outside port
attachments cannot exceed 1.6 times its baseline plus 160 canvas pixels. This is
a bounded, greedy visual heuristic, not a guarantee of globally optimal lanes.

Routing updates on node moves, card/port resizing, port additions/removals,
load/import/reset and graph edits. Geometry snapshots share visibility checks;
identical geometry reuses routes across selection, zoom and pan. Pointer moves
coalesce into animation frames. During a drag, node-clear routes with unchanged
endpoints stay in place and are reserved before affected connections reroute.
Releasing the node optimizes all paths again. ResizeObserver watches cards and
ports, and font readiness schedules measurement. Geometry-only updates retain
wire DOM/focus. The scrollable surface includes card sizes and detours.

The visible stroke, background outline and transparent 16-screen-pixel hit
path have identical, continuous geometry. Crossing gaps introduce no dead hit
areas. Where broad hit targets overlap, pointer/touch selection chooses the
closest path; a subpixel tie belongs to the visible overpass. Each connection
also remains independently keyboard-focusable. Existing inspector Disconnect,
Delete/Backspace, reconnect and input-end detach gestures operate on the actual
logical connection.

Work is bounded to 60,000 grid intersections, 12,000 expanded search states per
edge, 400,000 per snapshot and 100,000 nearby-segment diagnostic comparisons.
Optional lane lines are reduced before declaring the grid too large. Baselines
are established before spending remaining search work on separation. Overlap
longer than 24 pixels with less than 7 pixels of separation (excluding the
bounded stem at the same output), or an exhausted diagnostic budget, marks
crowded wires with dots and a visible notice. If ports/cards overlap or baseline
routing exceeds its budget, an amber dashed cubic and notice preserve the
connection visibly. These degraded routes can remain ambiguous; inspect their
endpoint names with keyboard focus and move cards apart to restore room.
Normal, uncrowded routes require no selection or hover to follow. At very low
zoom, lanes and crossing gaps shrink with the canvas; Fit is an overview, and
zooming in restores their normal reading scale.

See [dense routing evidence and executed checks](evidence/graph-215.md) and the
[original obstacle-avoidance evidence](evidence/graph-204.md).

## Supported graph and ports

Port compatibility depends only on shared contract identity. `ITEM` additionally
accepts `TEXT`, `KEYED_PAIRED_TEXT` and `KEYED_PAIRED_TEXT_LIST`. No producer name,
output name, group origin or connection order restricts ordinary compatible
connections. Each input accepts one edge. Validation rejects unknown ports,
invalid settings, duplicate IDs/edges and cycles. Consumers validate their own
payloads, startup configuration and correlation.

| Nodes | Contracts and purpose |
| --- | --- |
| ChromeTabAudio, SelectedPageMediaAudio, MicrophoneAudio | Normalized mono 16 kHz PCM sources |
| SpeechToTextReazonSpeech, SpeechToTextZipformerEn, SpeechToTextMoonshineMediumEn | PCM → provisional/final TEXT and numeric IDs |
| SpeechToTextWhisper, SpeechToTextParakeetV3 | PCM → final TEXT and numeric ID |
| Text, Number | Literal TEXT and finite NUMBER constants |
| KeyedTextCoalesce | Independent id1/input1/id2/input2 → id/text; per-ID nonempty preference |
| KeyedTextPair | Same four independent inputs → pair only; complete `{ id, first, second }` |
| KeyedPairedTextAccumulator | pair → complete ordered pairs; append/replace by ID |
| Display | Configurable input1…inputN: ITEM → switchable input tabs in one Live view; title/inputCount/inputLabels Settings, no outputs or processing |
| TextAccumulator | append: TEXT → complete newline-separated TEXT history |
| TextFormatter | Configurable numbered TEXT inputs and literal multiline template → TEXT |
| TextSlidingWindow, TextWindow | Generic bounded TEXT processing; see their documentation |
| OPUS-MT and TranslateGemma in either direction | Independent committed and provisional translation families |
| TextSummaryLfm2, TextSummaryQwen35 | Complete summary: TEXT snapshots |
| IfCondition | TEXT → exactly one yes/no TEXT branch |
| FocusedInputTextOutputNode | Append TEXT to the user-focused editable field |
| Supertonic3, Kokoro | Committed TEXT → completed synthesized audio |
| Qwen3TtsStreaming, CosyVoice3Streaming | Committed TEXT → explicit audio stream events |
| AudioOutput, SpeakerOutput, StreamingSpeakerOutput | Audio player/WAV and completed/streaming playback |

## Capture, output and lifecycle

Whole-tab capture uses the toolbar-invoked tab. Microphone capture requires
Start and browser permission. `SelectedPageMediaAudio` is
temporarily unavailable because Live no longer provides an element selector; its
source reports an actionable error and suggests `ChromeTabAudio`. An on-page
selector is deferred to a separate task. Focused output still follows the
toolbar-invoked document automatically. Live shows only actionable Node errors;
normal per-Node status stays in the optional Session details disclosure. One unavailable processor
leaves independent healthy paths running. Repeated tab sources share capture;
processor state, queues and Workers remain independent. A source ending drains
its downstream paths while unrelated sources may continue.

FocusedInputTextOutputNode appends exact plain text to the user-focused editable
field on the toolbar-invoked tab. Inactive outputs do not inject scripts or open
connections. Missing focus or a detached document skips that output visibly;
transcription displays remain usable. Permissions are scoped to the selected
tab/document. It does not replay or retry ambiguous edits.

Start clears session history. Stop drains accepted work in graph order and
retains the rendered result. Internal cancellation closes delivery, terminates
owned inference and suppresses late replies while retaining the last display. A fresh Start uses
fresh state and rejects stale contexts. Display renders supplied snapshots only;
stream selection belongs to explicit processors upstream.

Each executable Display is an independent tabbed Live view. Its numbered input
ports create the tabs: a single Display with `inputCount: 3` has three alternative
views, with exactly one input visible at a time at every window width. Multiple
Display nodes remain independent outputs; the collection of nodes is never a tab
strip. A single-input Display omits tab navigation. No executable Displays retains
the empty-output message.

In Settings use **Add input** / **Remove last input** for 1–32 `ITEM` inputs
(default 1). Removing the last input deletes only its label and connected wire;
remaining ports keep their names and labels. Each input has an editable **tab
label**, stored in `settings.inputLabels` by port name, for example
`{"input1":"Transcript","input2":"Translation","input3":"Summary"}`. Labels
are optional strings up to 120 characters; blank/missing labels use `Input 1`,
`Input 2`, etc. Duplicate labels remain separate tabs because identity belongs to
`inputN`, not the label. `settings.title` names the display group for accessibility
(blank uses `Display <Node ID>`). Save applies settings changes next session.

Connect transcript history to Display.input1, translated text to Display.input2,
and TextSummary.summary to Display.input3 on **one Display**. Import the
[model-free example](examples/display-tabs.json) to try these three switchable
tabs using literal Text sources, then connect your preferred upstream processors.
Every delivery replaces only that input's complete snapshot. No inference,
accumulation, merging or coalescing happens in Display. Disconnected inputs remain
empty; a Display needs at least one executable input branch.

Tabs support pointer/touch, Left/Right arrows (wrapping), Home/End, and visible
keyboard focus. Switching affects presentation only: all graph processing and
hidden snapshots keep updating. Panels remain mounted, preserving scroll position
and near-bottom following intent through hidden updates. Unchanged snapshots retain
their DOM and text selection during unrelated input updates. Panes show only
content, without a repeated input heading, Copy text control or copy-status row.
Use native browser selection/copy. A single-input Display omits the tab strip
and retains its input label as an accessible name. Inactive panels disable live
announcements. Different inputs never appear side-by-side or stacked, including
in narrow windows. Any future composed
layout belongs upstream. Literal strings preserve whitespace and wrap; a keyed
pair/list uses an equal-width two-cell table *within its own panel*. Browser DOM
stays private to the host rendering boundary and never travels through graph ports.

Existing #212 graphs retain their `input1…inputN` connections and now show input
tabs without rewiring; missing labels use the numbered fallback. Version 15 and
legacy `Display.input` → `input1` migration are unchanged. Reading retains original
storage; Save/Export canonicalize it. Unsupported older schemas/types still use
the documented Saved JSON / Reset / Import recovery.

See [corrected Display tabs validation](evidence/display-216.md) for checks,
screenshots of actual switching, and limits. The [#212 evidence](evidence/display-212.md)
records the superseded node-tab/column presentation.

## Feature setup and validation

- [Port contracts](port-contracts.md) and [runtime lifecycle](pipeline-runtime.md)
- [Chrome extension setup and permissions](chrome-extension.md)
- [Whisper](whisper-node.md), [Zipformer](zipformer-node.md), [optional ASRs](optional-asr-nodes.md)
- [Translation](translation-nodes.md), [windowed translation](windowed-translation.md)
- [Text sliding windows](text-sliding-window.md), [text summaries](text-summary-nodes.md), [IfCondition](if-condition-node.md)
- [TTS and streaming playback](streaming-tts.md)

Run `npm test`, relevant Playwright browser/extension suites, and
`npm run build:extension` with prepared pinned assets. Controlled Worker tests
verify composition, safe rendering, persistence and lifecycle; they do not
establish real inference quality. Real-model checks and setup requirements are
documented with each feature.

## Manual Graph Actions

Add **Button** from **Sources / inputs**, edit its caption and connect its ordinary
NUMBER output to any compatible consumer. Live renders active buttons by Node ID
in Graph Actions below Start/Stop, with keyboard/touch access and bounded busy
handling.
For manual summaries, connect Button.trigger → Hold.trigger, accumulated text →
Hold.input and Hold.value → TextSummary.text. A connected trigger makes value an
ordinary emitted output; without it the original sampled feedback mode remains.
See [Graph Actions](graph-actions.md) and the [example graph](examples/manual-text-summary.json).

## Incremental summaries with Hold

Hold is available under **Constants / utilities**. Connect its readable value
to a formatter alongside TextWindow, then route the summary back to Hold.input.
Only TextWindow triggers the next update. [Importable example, limits and Stop /
Cancel behavior](text-summary-nodes.md). Ordinary event cycles remain invalid.
