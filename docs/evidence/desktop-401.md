# Issue #401 desktop validation

## Target and build

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

## Validation commands

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
The suite checked native keyboard focus, same-window focus changes, loss of the
browser window, rejection of a password field, and a native tray Quit from a
running graph followed by reclamation of the shortcut from another process.

## Actual Japanese inference

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

## Limits

Firefox ESR 153 fails to apply AT-SPI editing operations. This is an upstream
Firefox defect and the desktop detects the unchanged field and stops.
[Mozilla bug 2087495](https://bugzilla.mozilla.org/show_bug.cgi?id=2087495).

Physical devices, other application toolkit controls, Wayland, macOS and
Windows were outside this validation. Required post-merge verification is none.
