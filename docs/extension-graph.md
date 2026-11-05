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
all port labels and controls. Routing updates on node moves, card/port resizing,
port additions/removals, load/import/reset and graph edits. Zoom, Fit and pan
keep paths attached to their ports. Wires render behind node controls. A 16-screen-pixel hit path follows the
full continuous connection even where its visible stroke has a crossing gap.
Existing pointer/touch, keyboard selection, input-end reconnect/detach and
inspector Disconnect apply along the detours.

`extension/graph-wire-router.js` is a dependency-free visual module. It does
not change stored positions, graph edges, typed contracts or session execution.
It builds a rectilinear visibility grid from expanded card boundaries and port
escape points, and uses deterministic A* with Manhattan distance and a bend
penalty. Cards expand by 12 canvas pixels; quadratic corners have a maximum
6-pixel radius, retaining clearance from the visible bodies. Only the first and
last attachment segments may enter their own cards.

Each geometry snapshot shares visibility checks across edges; identical geometry
reuses routes across selection and zoom redraws. Pointer movement coalesces into
animation frames. During a node drag, clear routes with unchanged endpoints stay
in place; routes affected by the moving obstacle or ports recompute. Releasing
the node optimizes all paths again. ResizeObserver watches cards and ports, and
font readiness also schedules measurement. Geometry-only updates retain wire
DOM/focus. The scrollable surface includes actual card sizes and detours.

Routing is bounded to 60,000 grid intersections, 12,000 expanded search states
per edge and 100,000 per snapshot. Blocked ports, overlapping cards, a lack of
space at the top/left canvas boundary, or exhausted budgets produce an amber
dashed cubic fallback plus a visible status message. These wires remain
selectable and connected; move cards apart to recover automatic avoidance.
There is no automatic node repositioning. Wire paths are routed in stable
connection order. The router discourages reuse of the same or nearby long
segments (and unnecessary crossings) using an indexed traffic cost, creating
parallel lanes where the available layout permits. Distinct wire paths can still
cross when avoiding crossings would require an excessive detour. In that case,
the later wire has a short, persistent visual gap at the intersection, while its
hit path stays continuous. This distinguishes a crossing from a junction
without requiring hover or selection. Shared stubs near a single output port
may remain unavoidable, and nonrectilinear dashed fallbacks are not gap-marked.
At a shared hit area the uppermost wire receives pointer input; every
connection remains keyboard-focusable.

See [routing validation and screenshots](evidence/graph-204.md) for fixtures,
executed checks and build limitations.

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
