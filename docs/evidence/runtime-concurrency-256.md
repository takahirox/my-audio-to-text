# Independent runtime sessions (#256)

Validated on 2026-11-10. This supersedes #247's global inference exclusion and
multi-tab busy expectations. No graph schema, saved assignment or model cache
format changed.

## Ownership review and implementation

- Removed `runtime-lease.js`, `ensureRuntime`, the `acquireRuntime` injection and
  all Live/Web inference admission wiring. Live retains actual model preloading,
  Ready resources, explicit Start and preparation of its next graph after Stop.
- Each `TabSession` owns its prepared/active Pipeline, graph snapshot, Node
  instances, model Workers/ASR cores, microphone streams, speakers, target
  connection, callbacks and teardown barriers. `buildGraph` allocates these per
  execution. Tab-capture sharing is confined to sibling Nodes in one execution;
  another graph gets a new capture factory. Browser refusal of an already
  captured tab remains a real capture error; no existing capture is taken over.
- Model module globals live inside separately instantiated Workers. No shared
  mutable model pool, stream, graph Node, global inference queue or global runtime
  limit was added. The synchronous page-local utterance-ID counter only allocates
  distinct output IDs. Pinned asset caches and their existing file verification/
  mutation locks remain separate from runtime ownership.
- The MV3 Web coordinator tracks owners by document, with an independent runtime
  window and capability per owner. Duplicate Start on the same control is inert.
  A late window creation, disconnect, timeout or old runtime reply cannot end a
  replacement or another document's session. Different tabs run concurrently.
- The existing Web UI has one widget and one fixed target per document. This
  Web-only interaction constraint remains; changing focus cannot retarget an
  active session. Opt-in, host/microphone authorization, exact sender/document/
  capability checks, explicit start, final-only output and no auto-submit remain.
  Web OFF/website-permission removal ends Web owners only. Closing Live ends only
  that Live's resources. Assignments and active graph snapshots remain separate.

## Checks

- `npm test`: **876 passed**. New deterministic tests cover simultaneous
  preparation, three independently running sessions, distinct ASR cores/nodes/
  pipelines, output isolation and deduplication, model/Worker failures, late
  readiness after close, Stop/restart, preparation during another owner's pending
  Stop disposal, document-scoped coordinator cleanup, duplicate Start, forged
  runtime connections, OFF/permission removal and late window-creation races.
- `npx playwright test --config playwright.extension.config.js
  tests/extension/web-voice.spec.js
  tests/extension/live-model-preparation.spec.js
  tests/extension/graph-concurrent.spec.js
  tests/extension/graph-model-failures.spec.js`: **29 passed**. This includes the
  full Web voice suite and affected Live/preparation/graph failure boundaries.
  Final focused checks also passed after tightening the overlap assertions.
- Installed MV3 Chrome tests exercise real extension ports/windows, native host
  access, `getUserMedia`, streams/audio normalization, graph Nodes and output
  insertion. Ordinary inference replies are controlled Workers. They cover
  Live Ready + Web Start, Live recording + Web Start, Web recording + Live
  preparation/Start, multiple Live windows, concurrent Web tabs, owner-scoped
  Stop/restart/close, canceled preparation, Worker failure, missing model cache,
  navigation, controlled track-ended events, host permission removal and OFF.
- `WEB_VOICE_REAL=1 npx playwright test --config
  playwright.extension.config.js tests/extension/web-voice.spec.js
  -g 'Live and Web overlap'`: **passed** with actual pinned ReazonSpeech ja-en and
  Silero WASM CPU inference in three concurrent sessions (two Live, one Web).
  The fake microphone device loops `ordinary-english.wav`; Chrome's native
  microphone grant is set through CDP. Web text equals the distinct recognized
  finals exactly once, Live Display matches its recognized final, peer resources
  remain active through Stop/restart/close and Web OFF, and no submit occurs.
  No remote requests or page errors were recorded. See the
  [machine-readable result, asset manifest and source hashes](runtime-concurrency-256-real.json).
- `git diff --check`: passed. Runtime lease/admission identifiers and artificial
  Busy errors are absent from extension code.

## Scope and limits

`npm ci` and `npm run prepare:assets` completed. The ASR-only real smoke staged
production extension/web source, the manifest and checksum-verified
ReazonSpeech/Silero assets into ignored `dist/chrome-extension` and installed
that bundle. Source hashes in the result were checked against the staged files.
A full `npm run build:extension` with all optional model assets was not run;
no complete optional-model distribution build is claimed.

Native optional-host bubble clicks and physical microphone hardware were not
exercised. Host grants use the existing disposable installation/upgrade fixture,
then restore the production optional-only manifest. Device-ended and Worker/GPU
failure cases are controlled events; actual microphone-setting revocation,
GPU-model overlap/device loss, resource exhaustion, sustained performance and
hardware capacity were not established. The change removes application-level
exclusion; it does not guarantee unlimited capacity or faster parallel inference.
No push, PR, merge, Issue comment or deployment was performed.
