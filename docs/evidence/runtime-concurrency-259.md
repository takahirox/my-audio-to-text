# Independent Live/Web microphone sessions (#259)

Validated on 2026-11-10 against the assigned worktree based on `81ced45`.
The selected upstream already includes `077a638` (#256), which removed the
global inference lease and implemented independent Live/Web execution. This
change retains that implementation, adds actionable microphone startup errors,
and closes the mixed-model browser coverage gap for #259.

## Ownership audit and changes

- `runtime-lease.js`, `extension-inference-owner`, `acquireRuntimeLease` and the
  global Runtime busy error are absent. No inference lock, queue, model fallback
  or runtime-count gate is introduced.
- `TabSession` retains its own prepared/active graph snapshot, Pipeline, Nodes,
  model Workers, microphone streams, output target and teardown barriers. Ready
  resources and pending disposal belong to that instance. `buildGraph` allocates
  a fresh execution; tab-source sharing is local to that execution.
- `LocalAsrCore` owns its ASR/VAD Workers and rejects callbacks from obsolete
  Workers or session IDs. Model state in Worker modules belongs to each dedicated
  Worker. Live and Web entry points create separate `TabSession` instances;
  neither entry point stops a peer. Asset verification/file-operation locks
  protect shared pinned files and do not retain inference ownership.
- The Web coordinator stores independent owners by document. Each owner has its
  own runtime window, token, document identity and field capability. Different
  documents can run concurrently. The one-widget/one-fixed-field interaction
  within a document remains necessary for the current target/capability routing;
  duplicate Start cannot replace or retarget that session. This is a Web UI
  constraint, separate from Live or inference concurrency.
- Microphone startup errors now preserve the browser's reason and give recovery
  steps for denied permissions, missing inputs, device stream failures,
  unsupported constraints and other device/resource errors. Recovery refers to
  the affected session and does not require closing a peer.
- README/help now explicitly describe independent execution, same/different
  models, resource limits and session-specific recovery. Graph schema, stored
  assignments, opt-in, permissions, target/security checks, insertion behavior
  and Graph Library layout are unchanged.

## Validation

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed |
| `npm test` | **881 passed**, no failures or skips |
| `node --test tests/live-model-preparation.test.js` | **40 passed**, including five new microphone-error/recording-peer cases |
| Affected extension suites below | **30 passed**, no failures or skips |
| Final focused mixed-model extension test | **1 passed** |
| `npm run prepare:assets` | Passed; pinned checksums verified, 90.8 MB ReazonSpeech/Silero staged |
| Real-model overlap extension test below | **1 passed** |
| Runtime lease/Busy identifier search in current extension/web code | No matches |
| `git diff --check` | Passed |

Affected extension command:

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/web-voice.spec.js \
  tests/extension/live-model-preparation.spec.js \
  tests/extension/graph-concurrent.spec.js \
  tests/extension/graph-model-failures.spec.js
```

The Web suite exercises Live Ready + Web Start, Live recording + Web Start,
Web recording + Live preparation/Start, multiple Live windows and concurrent Web
documents. It covers Stop/restart/close in both directions, preparation Cancel,
Worker failure, missing cache, navigation, device end, OFF and permission removal,
fixed target despite focus changes, duplicate finals, no submit and sender checks.

The new mixed-model test runs Live ReazonSpeech and Web Whisper with native
Chrome `getUserMedia`, separate streams and production graph/ASR Nodes. Controlled
Workers return distinct model-specific finals: Live Display receives
`confirmed fixture`, while each original Web field receives `whisper fixture`
exactly once. Stopping Web preserves Live. Stopping Live, simulating a device
stream failure on its next Start and closing Live preserve Web's model Workers,
active stream and output capability. The final test waits for measured PCM
delivery before Stop rather than assuming a fixed capture delay.

Real-model command:

```sh
WEB_VOICE_REAL=1 npx playwright test --config playwright.extension.config.js \
  tests/extension/web-voice.spec.js -g 'Live and Web overlap'
```

This installed the current production extension/web source and checksum-verified
ASR assets in an ASR-only bundle under ignored `dist/chrome-extension`. Chromium
153.0.8010.12 ran real pinned ReazonSpeech ja-en/Silero WASM CPU inference in
three simultaneous sessions (two Live, one Web). The native fake microphone
looped `ordinary-english.wav`; recognized Web finals were inserted exactly once,
Live Display matched its recognized final, peers survived Stop/restart/close and
Web OFF, and no remote requests, page errors or form submissions occurred.
The [machine-readable result](runtime-concurrency-259-real.json) records asset
pins, source hashes, fixture hash and outcomes. Earlier #256 evidence is retained
unchanged.

## Limits

Different-model overlap and device/resource failures use controlled inference
or injected failures; same-model overlap uses real CPU inference. Physical
microphone hardware, actual OS device exhaustion, GPU-model overlap/device loss,
peak memory, sustained performance and native permission-bubble clicks were not
tested. Host grants use the disposable installation/upgrade fixture and native
microphone grants use CDP. A full optional-model distribution build and the
unrelated browser suites were not run. No push, PR, merge or GitHub comment was
performed.
