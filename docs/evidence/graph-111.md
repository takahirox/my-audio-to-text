# Issue #111 — truthful Whisper outputs and graph migration

Whisper now declares exactly `final: TEXT` in both the graph schema and concrete
runtime Node. Palette-created Nodes, canvas sockets and inspector help expose
only that output. New provisional connections fail named-port validation.
ReazonSpeech retains both outputs and its default provisional → replace /
final → append wiring. The translation preset uses the chosen ASR's declared
outputs. Whisper examples use final → append; final remains a valid TEXT source
for deliberately chosen replace, completed translation and other TEXT inputs.

Graph version 8 explicitly migrates version 7, removing only outgoing Whisper
provisional edges without redirecting them. Tests compare complete descriptions
to verify preservation of IDs, positions, settings, final routes, custom routes
and translator provisional routes. Graphs without dead edges only change version.
When removal disconnects required inputs or the ASR's only output, loading names
the affected routes and preserves the original stored JSON. Graph Editor opens
an unsaved repair draft, and only an explicitly repaired, valid Save persists it.

Validation performed in the assigned worktree:

| Check | Result |
| --- | --- |
| `npm test` | 307 passed, zero skips |
| Pinned asset preparation and `npm run build:extension` | Passed; packaged ReazonSpeech/Silero, translation runtime, Whisper tiny q8 and TTS assets |
| `npm run test:extension -- tests/extension/graph-whisper.spec.js tests/extension/graph.spec.js tests/extension/live-text.spec.js tests/extension/graph-interactions.spec.js` | 50 passed initially; one new help assertion expected uppercase TEXT instead of the contract's displayed lowercase text. Corrected the assertion and reran that test successfully: all 51 selected cases pass. |
| `WHISPER_SMOKE=1 npm run test:extension -- tests/extension/graph-whisper.spec.js tests/extension/graph-whisper-smoke.spec.js --grep 'palette and help\|real packaged Whisper'` | 2 passed: corrected palette/help test and opt-in real-model smoke; zero skips |
| `git diff --check` | Passed |

The selected packaged regressions cover editor gestures, load/save/reload,
earlier migrations, safe version 7 migration, non-destructive repair, generic
TEXT fan-out, translation, TTS routing and Whisper model loading, Stop/drain,
Cancel, errors and repeated sessions. Deterministic cases replace inference/VAD
with fixtures and do not establish recognition accuracy.

The optional real smoke used pinned English and Japanese WAVs, production
Whisper/ONNX/Silero and final → LiveTextDisplay.append under the packaged MV3 CSP.
It completed English → Japanese → English, checked expected output scripts and
an English fixture keyword, verified resource release and recorded zero HTTP
requests and page errors. Capture hardware alone was replaced with fixture PCM.
Observed output and timings are in [whisper-111.json](whisper-111.json); this is
smoke evidence, not a WER/CER or general quality evaluation.

The full browser/extension suites and unrelated optional model smokes were not
run. No post-merge verification is required by this Issue.
