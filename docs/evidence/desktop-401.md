# Issue #401 desktop validation

## Target and build

### Original implementation (`ae1259245dbaade1cc725f5f3f5e36a8d1487c90`)

The initial environment is Debian GNU/Linux 12 arm64 in a Linux VM, with Openbox
on Xvfb, a trayer XEmbed tray, an AT-SPI D-Bus session and PulseAudio 16.1.
The application uses Electron 45.4.1 with sandboxed renderers. The browser
target is the unmodified Mozilla Firefox 162.0b1 arm64 build and a fresh profile
without extensions. The editor target is an independent GTK 3 process with
two plain-text buffers and a password field.

The release artifact is `dist/my-audio-to-text-linux-arm64.tar.gz`.
The build pins Electron and packages repository-verified Moonshine JS/WASM
and notices. Models downloads the pinned weights separately. Two builds in
the validation environment produced the same SHA-256
`d5b1543503cb3005c0ff0340ef3848a66c71b98ec545224532abc834f10239c7`.

### Original validation commands

| Check | Result |
| --- | --- |
| `npm test` | 938 passed, including six desktop tests for saved graph snapshots, endpoint validation, committed TEXT, cancellation, drain ordering and failure recovery. |
| `npm run build:desktop` | Built the arm64 application and archive. The real-model test launched the extracted executable. |
| `DESKTOP_TEST_BINARY=dist/verify/my-audio-to-text/my-audio-to-text DESKTOP_REAL_ASR=1 npm run test:desktop` | Both tests passed in a fresh Debian container with the checksum-verified Firefox build, using the release archive extracted into `dist/verify`. |
| `npm run test:extension -- tests/extension/graph-interactions.spec.js tests/extension/graph-autosave.spec.js tests/extension/graph-optional-asr.spec.js` | All 33 passed. These tests launch the MV3 extension with deterministic assets and no desktop process. |
| The preceding MV3 command plus `tests/extension/graph-library.spec.js` | 59 passed on the first run. The legacy migration test passed when rerun individually, and also passed on the upstream checkout. |
| `npm run test:browser -- --project=chromium --workers=2 tests/browser/graph-canvas-first.spec.js tests/browser/graph-selection.spec.js tests/browser/graph-routing.spec.js tests/browser/model-playground.spec.js` | 93 passed with the pinned Playwright Chromium and the standalone test server on a free loopback port. The save-conflict case and three validation pointer/touch cases also failed on the untouched upstream checkout. The 93 other cases passed again on the final tree. |
| `npm run setup:extension` and `npm run build:extension` | The existing full extension package setup could not complete. The pinned ONNX Runtime license and ThirdPartyNotices URLs returned HTTP 404 during TTS asset preparation. The MV3 fixture tests above independently exercised the affected extension behavior. |

The normal extension and standalone browser checks ran on macOS without the
Linux desktop package installed or running. The Docker X11 session launched
its standalone desktop archive independently of the extension.

The desktop integration test reserved a conflicting shortcut in another X11
client, verified the actionable error and old binding, and then saved a new
binding after releasing the grab. It created, duplicated, imported, edited,
exported and selected saved graphs through the management renderer. It covered
Undo/Redo, reload, an unsupported node, explicit Text formatter wiring, and a
saved edit taking effect on the next Live session. It also verified microphone
denial from the management renderer.

With the management window closed, the native shortcut inserted
`left| 東京🙂\nright` in the independent GTK editor. The tray also started
a fresh session in the editor. The Firefox control
received `left| [東京🙂] right`, with a preserved caret and zero form submits.
That earlier result preceded the refusal of inputs with unobservable length
limits and shows only the original revision's behavior.
The suite checked native keyboard focus, same-window focus changes, loss of the
browser window, rejection of a password field, and a native tray Quit from a
running graph followed by reclamation of the shortcut from another process.

### Original Japanese inference

The model was `moonshine/small-streaming-ja` at revision
`330a8fedc2c613a96902275ecf6f622bda1271d820221427c19ac2cea230ffee`.
The [fixture](../../tests/desktop/fixtures/konnichiwa.md) contains the spoken
Japanese word `こんにちは`. The harness sends the PCM Wave file through
`paplay` to a PulseAudio null sink and remaps its monitor as the default
microphone. The desktop calls the normal `getUserMedia` capture path and uses
the production Moonshine WASM Worker and default saved graph. HTTP(S) requests
were blocked after the cache reached **Ready**. The extracted package inserted
`こんにちは、こんにちは、こんにちは` in the GTK editor on the final run.
Another run yielded `こんにちはこんにちは`. The check asserts a nonempty
committed result and target correctness. It does not measure recognition
quality.

The test also covers missing assets before capture, an interrupted preparation,
retry, the active session deletion guard, removal, and a visible download
failure when offline.

## PR #402 reviewed head (`29cb23b5deacc6d4c5604d88bab6ddea36de08f7`)

Extension-free browser insertion was unmet on this head. The helper refused
Firefox text controls before any mutation because AT-SPI could not identify
their length limits. The review passed four deterministic packaged checks
on rerun after an Electron launch timeout. The offline model smoke inserted
`こんにちは、こんにちは、こんにちは` into the GTK editor. The Node suite,
33 MV3 checks, 31 standalone browser checks, and `git diff --check` passed.
The standalone model job reported HTTP 404 for the existing TTS asset URLs.

## Revised package with Firefox textbox support

The fix is based on `29cb23b5deacc6d4c5604d88bab6ddea36de08f7`. The revised
Debian 12 arm64 archive has SHA-256
`7f9508866e96a8b678cb5ac1f2bd2386a1c7f2a4b138c24125e6ba000236ebf0`.

| Check | Result |
| --- | --- |
| `npm test` after desktop asset preparation | 940 passed on Debian. |
| `npm run build:desktop` | Two builds produced the same archive hash. The X11 suite launched its extracted executable with sandboxed renderers. |
| `DESKTOP_TEST_BINARY=dist/verify/my-audio-to-text/my-audio-to-text DESKTOP_REAL_ASR=1 npm run test:desktop` | All five tests passed under Xvfb and Openbox. |
| `npm run test:extension -- tests/extension/graph-interactions.spec.js tests/extension/graph-autosave.spec.js tests/extension/graph-optional-asr.spec.js` | All 33 MV3 checks passed on macOS. |
| `npm run test:browser -- --project=chromium --workers=2 tests/browser/graph-selection.spec.js tests/browser/graph-routing.spec.js tests/browser/model-playground.spec.js` | 75 passed on macOS with the Playwright-pinned Chromium and the standalone server on a free loopback port. |
| `git diff --check` | Passed. |

With a fresh, extension-free Firefox 162.0b1 profile, the registered global
shortcut inserted ` [東京🙂]\n ` in a plain-text web textbox between `left|`
and `right`. The X11 window and browser focus stayed on the authorized
field. The browser recorded the advanced caret, one input event and zero
form submissions. The shortcut stopped the session from the same field.
A same-window focus change stopped another session. The length-limited
input and textarea retained their original values and carets, the password
stayed unchanged, and none of these rejected targets received input events.

The packaged GTK test passed, including refusal of a protected text run and
a length-limited entry. The test using the pinned Moonshine revision and the
virtual microphone again inserted `こんにちは、こんにちは、こんにちは`
into GTK with HTTP(S) blocked after model preparation.

## Limits

Firefox `input` and `textarea` elements remain outside the desktop support
scope because their length limits are unavailable through AT-SPI.
Firefox ESR 153 fails to apply AT-SPI editing operations. This is an upstream
Firefox defect and the desktop detects the unchanged field and stops.
[Mozilla bug 2087495](https://bugzilla.mozilla.org/show_bug.cgi?id=2087495).

Physical devices, other application toolkit controls, Wayland, macOS and
Windows were outside this validation. Required post-merge verification is none.
