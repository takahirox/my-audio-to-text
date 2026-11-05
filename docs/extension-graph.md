# Executable extension processing graphs

The Graph Editor saves explicit Nodes and named-port connections for the next
Live session. Start executes complete paths to outputs. Incomplete draft branches
remain saveable and do not allocate capture, model Workers or output permissions.
The active graph is an immutable snapshot; edits take effect at the next Start.

## Editor and saved graphs

Use Add Node to search or filter by category. Select a heading for settings and
help. Drag headings or use arrow keys to move Nodes. Connect an output to a
compatible input; reconnecting replaces only that input's wire. Select a wire
for details or Disconnect. Canvas zoom and Fit graph support large graphs.
Settings, essential port names and accessibility labels remain visible.

Graph actions provides Validate draft, Load saved, Reset draft to default, and
Import or Export graph JSON. Export downloads the validated current draft,
including multiline settings. Import validates before replacing the draft. Save is required
to apply an import or Reset. Save prepares the selected model assets, including
parked model Nodes; opening or loading a graph does not download weights. Models
provides preparation, retry, cache verification and license/terms information.

Storage uses `processing-graph-v1`; the current schema version is 15. Unsupported
Nodes, ports and versions fail explicitly. Live disables Start and links to Graph
Editor. The editor shows the error and a current default draft. Graph actions →
Saved JSON exposes the rejected original for inspection before Save replaces it.
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
ASR.finalId/final → KeyedTextCoalesce.id1/input1
ASR.provisionalId/provisional → KeyedTextCoalesce.id2/input2
KeyedTextCoalesce.id/text → KeyedTextPair.id1/input1
KeyedTextPair.pair → KeyedPairedTextAccumulator.pair
KeyedPairedTextAccumulator.pairs → Display.input1
```

Translation is an explicit addition:

```text
ASR.finalId/final → Translator.id/text
Translator.id/text → KeyedTextPair.id2/input2
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
| Display | Configurable input1…inputN: ITEM → independent Live columns in one tab; title/inputCount Settings, no outputs or processing |
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

Whole-tab capture uses the toolbar-invoked tab. Selected media and microphone
sources require their explicit Live controls and permission. Capture targets and
model failures stay visible in session diagnostics. One unavailable processor
leaves independent healthy paths running. Repeated tab sources share capture;
processor state, queues and Workers remain independent. A source ending drains
its downstream paths while unrelated sources may continue.

FocusedInputTextOutputNode appends exact plain text to the user-focused editable
field on the toolbar-invoked tab. Inactive outputs do not inject scripts or open
connections. Missing focus or a detached document skips that output visibly;
transcription displays remain usable. Permissions are scoped to the selected
tab/document. It does not replay or retry ambiguous edits.

Start clears session history. Stop drains accepted work in graph order and
retains the rendered result. Cancel closes delivery, terminates owned inference
and suppresses late replies while retaining the last display. A fresh Start uses
fresh state and rejects stale contexts. Display renders supplied snapshots only;
stream selection belongs to explicit processors upstream.

Each executable Display is one Live tab, ordered by its position in the graph's
Node array and identified by its Node ID. Settings.title supplies the visible tab
label (duplicate titles are allowed); empty titles use `Display <Node ID>`. A
single Display shows its panes without tabs. No executable Displays retains the
empty-output message.

In Settings use **Add input** / **Remove last input** for 1–32 `ITEM` inputs
(default 1). Removing the last input explicitly deletes only its connected wire;
remaining ports keep their names. Each pane has a stable `Input 1`, `Input 2`, …
heading. Disconnected panes stay empty; a Display needs at least one executable
input branch. Save applies title/count changes on the next session.

For example, title Display A `Main` and add a second input. Connect transcript
history to A.input1 and translated history to A.input2. Title Display B `Summary`
and connect TextSummary.summary to B.input1. Main shows two columns; Summary shows
one full-width pane. Import the [model-free example](examples/display-tabs.json)
to try this layout with three literal Text sources, then connect your preferred
upstream processors. Every delivery replaces only that input's complete snapshot.
No inference, accumulation or coalescing happens in Display.

Tabs support pointer/touch, Left/Right arrows (wrapping), Home/End, and visible
keyboard focus. Switching tabs only changes presentation: all graph processing
and hidden snapshots keep updating. Panes remain mounted, preserving each pane's
scroll position and near-bottom following intent through hidden updates. Each has
Copy text; inactive tabs disable live announcements. Columns wrap/stack to fit
narrow windows. Literal strings preserve whitespace and wrap; a keyed pair/list
uses an equal-width two-cell table *within its own pane*. Browser DOM stays
private to the host rendering boundary and never travels through graph ports.

See [Display tabs validation](evidence/display-212.md) for checks and limitations.

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

## Incremental summaries with Hold

Hold is available under **Constants / utilities**. Connect its readable value
to a formatter alongside TextWindow, then route the summary back to Hold.input.
Only TextWindow triggers the next update. [Importable example, limits and Stop /
Cancel behavior](text-summary-nodes.md). Ordinary event cycles remain invalid.
