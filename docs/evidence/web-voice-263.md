# In-page dictation without a recording window (#263)

Validated on 2026-11-10 with headless Chromium 153.0.8010.12 on macOS.
This supersedes the visible Web recording-window architecture described in
historical #247/#256 evidence. Live's visible UI is unchanged.

## Feasibility before implementation

Before changing the architecture, a disposable minimal unpacked MV3 extension
created an offscreen `USER_MEDIA` document and called native `getUserMedia` with
Chrome's fake microphone. The initial probe returned:

| Native microphone state | Offscreen result | User activation |
| --- | --- | --- |
| `prompt` | `NotAllowedError: Permission dismissed` | false |
| `granted` | Successful capture; tracks stopped after probe | false |
| `denied` | `NotAllowedError: Permission denied` | false |

AudioWorklet loading/creation, a dedicated Worker, WASM and a WebGPU adapter were
available. `chrome.storage` and `chrome.tabs` were absent. These results guided
the choice of a shared nonvisible runtime and a permission-only visible setup.
The implementation never attempts offscreen first-use prompting or opens the
old recording window as a fallback.

The committed `tests/extension/offscreen-feasibility.spec.js` reproduces the probe
with production-equivalent COOP/COEP/CSP and a fresh offscreen document per native
permission state. It also verifies Worker isolation and shared WASM memory.
[Recorded probe output](web-voice-263-feasibility.json).

Chrome's [offscreen API reference](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
documents its single-document limit per profile, runtime-only extension APIs and
`USER_MEDIA`, `WORKERS` and `LOCAL_STORAGE` reasons. This permission reason enables
media access; it does not supply a visible first-use permission UI. Only Chromium
153 was exercised here; the manifest retains the existing Chrome 116 minimum
needed for `runtime.getContexts`.

## Implementation and ownership

- One offscreen document multiplexes independent existing `TabSession` instances.
  Each owns its graph snapshot, Pipeline/Nodes, model Workers, microphone streams,
  output adapter and cancellation. Document creation/closing is serialized, not
  inference. No global Busy gate, model pool or worker/track sharing was added.
- For an existing microphone grant, the original page mic starts/stops dictation
  without creating any visible extension page/window or changing field focus.
  Its existing Preparing/Recording/Stopping/Error UI remains the primary control,
  including keyboard Stop when focus changes or the field scrolls offscreen.
- Only `prompt` opens the permission setup tab from the explicit field click.
  The setup button calls native gUM and immediately stops its test tracks. That
  page imports no model/graph runtime. On consent the coordinator returns to the
  original tab, closes setup and resumes offscreen processing. Later granted use
  skips setup. Denied/revoked permission and device/cache errors give recovery
  instructions; closing/canceling setup or its target cancels the request.
- Offscreen cannot call tabs/storage extension APIs. The coordinator checks
  current opt-in/website access and relays output to its stored original
  tab/document. Generation nonce, session token, exact sender URL, field
  capability and monotonic edit sequence protect ownership. It never accepts a
  caller-selected output tab or any page-world messages. Existing native setter,
  saved Range/caret, final-only insertion and no-submit behavior are reused.
- Stop drains once; Cancel, removal/navigation, lost ports, OFF and permission
  removal cancel the right owners. Cancellation can interrupt an already-running
  Stop while peers retain their capture. Last-session cleanup closes the DOM
  document. Worker restart discards its previous generation; host disconnect and
  immediate retry cannot reuse a disconnected runtime. Heartbeat acknowledgments
  back up port-disconnect cleanup. Sessions never silently resume after restart.
- The only new required permission is `offscreen`; website permissions remain
  optional and gated by the existing explicit opt-in. No graph schema, Graph
  Library layout, rich-editor support or Live UI change was introduced.

## Checks run

```sh
npm test
npx playwright test --config playwright.extension.config.js \
  tests/extension/web-voice.spec.js \
  tests/extension/offscreen-feasibility.spec.js \
  tests/extension/live-model-preparation.spec.js \
  tests/extension/graph-concurrent.spec.js \
  tests/extension/graph-model-failures.spec.js
npm run prepare:assets
WEB_VOICE_REAL=1 npx playwright test --config playwright.extension.config.js \
  tests/extension/web-voice.spec.js -g 'already granted|Live and Web overlap'
```

- **886 unit tests passed**, including the packaging check and 15 coordinator
  tests for authenticated multiplexing, duplicate Start, forged/stale owners,
  scoped teardown, setup failure and late creation/retry/restart races.
- **43 MV3 browser tests passed**: 32 Web/offscreen tests plus 11 existing
  Live preparation/concurrency/model-failure regression checks. The tests inspect
  the actual offscreen CDP target without opening a visible recording host.
  They cover first setup, native grant/denial, subsequent invisible use, focus and
  caret, final drain/deduplication, no submit, basic editable/manual edits,
  snapshots, sensitive fields, permission removal, multiple Web owners, Live/Web
  overlap, cancellation while preparing/stopping, navigation/removal, back-forward
  cache, device failure/end, Worker/cache errors, native service-worker
  stop/restart, offscreen loss, immediate retry and extension reload.
- **Two real-model smoke tests passed** using the pinned 90.8 MB
  ReazonSpeech ja-en/Silero bundle, actual CPU/WASM Workers, native gUM and
  worklets. Input and textarea insertion equals unique final events exactly.
  The overlap test reaches three concurrent Live/Web executions, checks Live
  output against its final event and preserves peers through Stop/restart,
  OFF and close. No unexpected remote request or page error was observed.
  [Input/textarea evidence and source hashes](web-voice-263-real.json);
  [concurrent Live/Web evidence and source hashes](web-voice-263-overlap-real.json).

## Limits of the evidence

Native permission decisions use `Browser.setPermission`; native permission-bubble
buttons and physical microphone hardware were not automated or manually tested.
The setup page's own button still performs real gUM. Website grants use the
existing disposable installation/upgrade fixture, with the production optional-only
manifest restored before feature checks. Fake microphone audio comes from the
pinned `ordinary-english.wav` speech fixture. The regular suite controls only
inference Worker replies and selected failure/timing conditions.

WebGPU adapter availability was measured; real GPU-dependent model inference was
not run. Genuine adapter/memory/model/cache errors remain per-session failures
through the existing preparation/runtime path. Resource availability and inference
speed under arbitrary parallel load are not guaranteed.

`npm run build:extension` stopped with `Missing translation runtime` because this
worktree does not stage the unrelated optional translation/summary/TTS bundles.
The packaging unit test passes. Browser tests install the current extension
sources and production manifest directly; real-model mode adds the verified
Reazon/Silero assets prepared by the repository script. No complete optional-model
distribution build is claimed.
