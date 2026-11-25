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

That revision refused Firefox `input` and `textarea` elements because AT-SPI
did not expose their length limits.
Firefox ESR 153 fails to apply AT-SPI editing operations. This is an upstream
Firefox defect and the desktop detects the unchanged field and stops.
[Mozilla bug 2087495](https://bugzilla.mozilla.org/show_bug.cgi?id=2087495).

## Firefox deferral and Chromium X11 validation

Firefox support is deferred for the first desktop release. The desktop
helper now accepts only supported GTK editor views.

The browser probe used Chromium 156.0.8078.108 on Debian 12 arm64
with a fresh profile, extensions disabled, and renderer accessibility enabled.
AT-SPI showed `Text` for the ordinary HTML text input and reported
`maxlength=4` on the constrained input. Neither control exposed
`EditableText`. Falkon 22.12.1 and GNOME Web 43.1 also exposed `Text` without
`EditableText` on focused HTML inputs. NetSurf GTK 3.10 did not expose a
separate accessible object for the web input in the probe.

Separate paste probes in the same Chromium build showed that a page can shift
focus to a password input from a `paste` handler and receive the edit there.
A `beforeinput` handler that added a length limit to an ordinary input
committed only `a` from `abcd`. Checking the original focus and maxlength
before sending a paste command would permit both outcomes. The packaged helper
keeps browser writes disabled. The mandatory successful extension-free browser
insertion remains open.

Two runs of `npm run build:desktop` produced the Debian 12 arm64 archive with
SHA-256 `aa10decb0db3fc483dc665d201265b88ea1889c503aeb64a9737af824eaa03fd`.
`npm test` passed all 940 checks. The focused MV3 suite
(`graph-interactions`, `graph-autosave`, `graph-optional-asr`) passed all
33 checks. The standalone Chromium suite (`graph-selection`,
`graph-routing`, `model-playground`) passed all 75 checks.

The Chromium shortcut test launched the extracted package and invoked the
registered global shortcut on a plain input, a length-limited input, a
length-limited textarea, a plain-text contenteditable, a read-only input,
and a password input. The package reported a refusal for each field.
The X11 and DOM focus, caret, and field values stayed intact. Chromium
reported zero `beforeinput` or `input` events and zero form submissions.

`DESKTOP_TEST_BINARY=dist/verify/my-audio-to-text/my-audio-to-text DESKTOP_REAL_ASR=1 npm run test:desktop`
passed all five X11 checks on a fresh rerun. The GTK held-shortcut check
ended early on one earlier run. The offline smoke inserted
`こんにちは、こんにちは、こんにちは` from the same licensed fixture and pinned
Moonshine revision as the original validation. `git diff --check` passed.

## Whole-text GTK insertion

The shortcut now accepts writable document views in stock Debian Mousepad
0.5.10. AT-SPI can't tell whether an arbitrary GTK text buffer runs a custom
insertion handler. The packaged regression focuses a GTK 3 text view that
would accept only two characters of `abcdef`. A direct AT-SPI insertion into
the fixture acknowledged success and left `left|abright`. Through the desktop
shortcut, the buffer stayed `left|right`, the caret stayed at offset 5, and
the fixture recorded zero buffer changes. The password field, length-limited
entry, and tagged read-only region also kept their original values.

Two builds produced the same Debian 12 arm64 archive with SHA-256
`b1a9f966db7ae822fbc26d7b9bce2f6d7d562f3c52485b95e3e76cbcd6838e90`.
`npm test` passed all 940 tests. The standalone Chromium checks
(`graph-selection`, `graph-routing`, `model-playground`) passed all 75 tests.
The focused MV3 checks (`graph-interactions`, `graph-autosave`,
`graph-optional-asr`) passed all 33 tests.
`DESKTOP_TEST_BINARY=dist/verify/my-audio-to-text/my-audio-to-text DESKTOP_REAL_ASR=1 npm run test:desktop`
passed all six checks against the extracted archive. The registered global
shortcut inserted ` 東京🙂\n` exactly once per session in Mousepad, preserved
window focus, and rejected output when the active document changed. The
offline Moonshine smoke inserted `こんにちは、こんにちは、こんにちは` into
Mousepad from the same fixture and pinned model revision as above after
HTTP(S) was blocked.

The Chromium 156 shortcut check still observed zero input events, edits, or
submissions in the six unsupported browser controls. Pale Moon 35.0.3
also left the web input inaccessible to the AT-SPI client in the Debian 12
probe. Successful extension-free browser insertion remains open.
Firefox remains deferred.

## Packaged refusal and held-Stop regression

Target refusal now releases the pending authorization without calling Cancel
in a renderer that never started the graph. The X11 helper tracks the physical
shortcut hold, drains focus events buffered by synchronous X11 calls, and
waits for focus to settle before sending a pending edit.

The Debian 12 arm64 archive SHA-256 was
`4b499203375e73d1ccc3aa99d9fc792c20847fbc402b2e4670915ca4415f3f20`.
All six checks passed with the extracted executable and
`DESKTOP_REAL_ASR=1 npm run test:desktop`. The Chromium refusal and held-Stop
checks both passed again against the same archive in a fresh Xvfb and D-Bus
session using `npm run test:desktop -- --test-name-pattern='refuses unsupported Chromium|committed text waits'`.
Both runs used the packaged Electron 45.4.1 app, Chromium 156.0.8078.108 without
extensions, and Mousepad 0.5.10. Set `DESKTOP_TEST_BINARY` to the extracted
executable for both commands.

- The real shortcut returned to Idle for each of six Chromium controls.
  Ordinary and length-limited inputs, the constrained textarea, plain-text
  contenteditable, read-only input, and password kept their original values,
  carets, and focus. The fixture observed zero edit events or form submissions.
- In Mousepad, the pending IPC insertion remained unsettled through a 7.5-second
  shortcut hold and committed `東京🙂` once at the original caret on release.
  Switching documents as the shortcut was released rejected the next
  pending insertion and left both documents unchanged.
- The virtual microphone and pinned Moonshine revision above produced
  `こんにちは、こんにちは、こんにちは` in Mousepad with HTTP(S) blocked.
  All 940 Node tests, 75 standalone Chromium checks, 33 MV3 checks, and
  `git diff --check` passed. The standalone and MV3 runs used Playwright's
  pinned Chromium 153.0.8010.12 on macOS.

Chromium's Linux AT-SPI implementation still lacks a target-bound editing
operation for these fields. Its IME path can run page event handlers before
the edit. Successful browser insertion is an open acceptance item, and
Firefox remains deferred.
[Chromium ATK implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/accessibility/platform/ax_platform_node_auralinux.cc).
[Chromium IME implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/editing/ime/input_method_controller.cc).

## Limits

Physical devices, other application toolkit controls, Wayland, macOS and
Windows were outside this validation. Required post-merge verification is none.

## macOS-primary reassessment (2026-11-25)

Issue #401 requires real macOS editor and browser insertion from the extracted
standalone app. The Linux X11 supported editor and regressions remain in scope.
Linux browser insertion is optional. The macOS build, editor insertion,
browser insertion, and ASR output are separate acceptance checks.

### Environment and test scope

The primary runner was macOS 27.2.1 (26B131) on Apple Silicon arm64, with an
Aqua session, Apple clang 21.0.0, Electron 45.4.1, and BlackHole 2ch. The macOS
harness loads the extracted app with Playwright and its native shortcut helper
in a disposable Electron profile. The external editor test uses stock TextEdit
and a native test driver for keyboard events and Accessibility reads.

### Insertion decision

The inspected products show how input transports vary by platform. Each
ordered TEXT delivery in this app also needs field-specific authorization
and whole-edit validation.

| Project and inspected revision | Mechanism and limitation |
| --- | --- |
| OpenWhispr, MIT, `62546b70a552d9dcb915b71f7c08c135ccbe3a2b` | Electron clipboard plus native paste helpers and environment-specific fallback. On Wayland the clipboard transport and paste transport can differ. Chromium paste failure with a different layout was reported even when the transcript reached history. [Clipboard implementation](https://github.com/OpenWhispr/openwhispr/blob/62546b70a552d9dcb915b71f7c08c135ccbe3a2b/src/helpers/clipboard.js), [troubleshooting](https://github.com/OpenWhispr/openwhispr/blob/62546b70a552d9dcb915b71f7c08c135ccbe3a2b/TROUBLESHOOTING.md#wayland-clipboard-issues-linux), [issue #2055](https://github.com/OpenWhispr/openwhispr/issues/2055). |
| Handy, MIT, `ca2334c9099c53a2c4fd9bad63073f11baaa8dbd` | Serializes paste and uses Enigo 0.6.1 for input. Its macOS transaction can restore after a pasteboard data request and guard against overwriting a newer copy using `changeCount`. A read can come from a clipboard manager, and the previous clipboard has been observed in the target when restoration happens early. [Clipboard code and tests](https://github.com/cjpais/Handy/blob/ca2334c9099c53a2c4fd9bad63073f11baaa8dbd/src-tauri/src/clipboard.rs), [macOS transaction](https://github.com/cjpais/Handy/blob/ca2334c9099c53a2c4fd9bad63073f11baaa8dbd/src-tauri/src/paste_tx/macos.rs), [issue #502](https://github.com/cjpais/Handy/issues/502). |
| Vocalinux, AGPL-3.0, `7ad089e1fbc49fe8170565aed61ec660a03464e7` | Uses IBus or xdotool on X11 and environment-dependent IBus, portal, wtype, ydotool and clipboard tools under Wayland. The guide describes non-US layouts and clipboard history. Its restoration tests cover text and binary formats. An IBus path reported success without text reaching KDE Wayland clients. [Injection code](https://github.com/VocaHQ/vocalinux/blob/7ad089e1fbc49fe8170565aed61ec660a03464e7/src/vocalinux/text_injection/text_injector.py), [clipboard tests](https://github.com/VocaHQ/vocalinux/blob/7ad089e1fbc49fe8170565aed61ec660a03464e7/tests/test_clipboard_restore.py), [guide](https://github.com/VocaHQ/vocalinux/blob/7ad089e1fbc49fe8170565aed61ec660a03464e7/docs/USER_GUIDE.md), [issue #574](https://github.com/VocaHQ/vocalinux/issues/574). |

- **Clipboard and native Paste.** Cmd+V and Ctrl+V offer broad application
  coverage. A pasteboard generation guards restoration from a newer copy.
  Even a read receipt cannot identify the field that consumed the text or
  confirm a complete edit. The X11 Chromium probes above saw focus redirected
  during paste and an edit truncated by a constraint installed during
  `beforeinput`. Those results are from Linux Chromium. [Apple NSPasteboard](https://developer.apple.com/documentation/appkit/nspasteboard),
  [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard).
- **Native Unicode typing.** Core Graphics can attach Unicode to keyboard
  events. Delivery still uses the event consumer's focus, and keyboard or
  input-method handlers can interpret or split the edit. The test harness
  uses Core Graphics only for the registered shortcut. Production uses
  Carbon pressed and released notifications. [Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent),
  [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut).
- **Element-bound accessibility writes.** The macOS adapter is scoped to an
  editable TextEdit document view. AX selected-text writes address the
  captured element and can be checked against the expected text and caret.
  It sends each accepted chunk once, leaves the clipboard untouched, and
  stops on an error or ambiguous result. Linux retains its direct AT-SPI
  editor path. Chromium's experimental Mac text-range operation is disabled
  by default in source and invokes Blink's editing events. Its AX value
  setter assigns the whole HTML input value. WebKit's text-operation path
  goes through the editor. These source findings do not establish safe
  browser writes. [Chromium Mac text operations](https://chromium.googlesource.com/chromium/src/+/d9cb4b533984666bb34c9a1c0a305a92eeb78693/ui/accessibility/platform/browser_accessibility_cocoa.mm),
  [Chromium accessibility feature defaults](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/accessibility/accessibility_features.cc),
  [Chromium value setter](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/accessibility/ax_node_object.cc),
  [WebKit text operations](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/accessibility/AccessibilityObject.cpp).

The Electron host, isolated renderer, target transport, graph runtime and
serialized TEXT queue are shared. The native adapter owns target identity,
editability and shortcut state. A future browser path needs an operation that
binds the mutation to a specific accessible field and whose preconditions
reject protected, read-only and constrained controls. Verify it in a normal,
extension-free browser with rapid commits, a focus change, and a late
constraint. Successful macOS browser insertion is still required. The same
experiment on X11 is optional.

### Validation results

Two macOS builds produced the same SHA-256,
`95c8384a302f9c7a857a7707ed24797acdf6d51cb1059060b656d48a3be49d8a`.
The extracted bundle passed `codesign --verify --deep --strict`.

| Check | Observed result |
| --- | --- |
| `npm run build:desktop` and `DESKTOP_REAL_ASR=1 npm run test:desktop` with `DESKTOP_TEST_BINARY` pointing to the extracted macOS app | Packaged launch, management and Live renderer IPC, native shortcut conflict and preservation of the original binding, management close with continued shortcut ownership, and reclamation after Quit passed. Menu-bar clicking and global shortcut delivery from an external field are outside this successful test. |
| macOS real model smoke in the same run | BlackHole 2ch fed the [licensed konnichiwa fixture](../../tests/desktop/fixtures/konnichiwa.md) into the packaged app's real microphone. The local Pipeline and the production Moonshine worker sent `こんにちは、こんにちは、こんにちは` to Live Display with HTTP(S) blocked after preparation. Model `moonshine/small-streaming-ja`, revision `330a8fedc2c613a96902275ecf6f622bda1271d820221427c19ac2cea230ffee`. The smoke used Display as its output. |
| `DESKTOP_MACOS_EDITOR=1 npm run test:desktop -- --test-name-pattern='native shortcut inserts'` | Blocked before creating the editor window. The Aqua runner returned `false` for both `AXIsProcessTrusted` and `CGPreflightPostEventAccess`. System Events also returned error `-1719` for an assistive-access query. The repository lists zero self-hosted GitHub Actions runners. |
| macOS extension-free browser insertion | Open. The adapter allows only TextEdit document views, and successful browser insertion has no macOS evidence. |
| `DESKTOP_REAL_ASR=1 npm run test:desktop` with the extracted Debian 12 arm64 package | All six checks passed under Docker, Xvfb/Openbox and PulseAudio. Mousepad remained the verified standalone editor. The Chromium refusal, protected and constrained GTK fields, held-Stop focus-change checks, and model retry tests passed. The offline graph inserted `こんにちは、こんにちは、こんにちは` into Mousepad from the same fixture and revision. |
| `npm test` | 940 passed. |
| `npm run test:browser -- --project=chromium --workers=2 tests/browser/graph-selection.spec.js tests/browser/graph-routing.spec.js tests/browser/model-playground.spec.js` | 75 passed with the Pages-style server on a free loopback port. |
| `npm run test:extension -- tests/extension/graph-interactions.spec.js tests/extension/graph-autosave.spec.js tests/extension/graph-optional-asr.spec.js` | 33 passed on the pinned Playwright Chromium, without a running desktop instance. |
| `git diff --check` | Passed. |

The missing macOS insertion evidence includes TextEdit focus, protected and
read-only control behavior, held-key and focus-change handling during a
native commit, and successful extension-free browser entry. These remain
pre-merge checks for an agent-executable macOS fixture with standard
Accessibility and keyboard event authorization. Required post-merge
verification is none.

## Follow-up to the review of `1b6e5cd052e5a537b86a883e528ae0e187754769`

The native helper now checks held modifiers again after the Accessibility
reads that precede a write. A Stop key-down belongs to the session that
received it. Cancel or focus invalidation can end that session while the key
is held, so its eventual release is discarded. The helper still addresses the
captured TextEdit element and verifies text and caret after one write.

### macOS browser insertion decision

The original project comparison above informs the input transport. Native
Paste and Unicode events still route through focus and browser editing code.
An AX check before sending the event cannot reserve the field or prevent a
length limit from changing before the browser applies the edit. Reading the
result can detect a partial edit only after it has occurred. The browser
refusal stays in place while a field-bound whole-edit operation is unresolved.

- Chromium's macOS platform node can dispatch a selected-text action, but
  the Blink AX node has no corresponding native selected-text handler in
  its action switch. Blink's separate value setter assigns the entire
  control value and dispatches input and change events. It has no compare
  against the previously observed value or caret. [Chromium Mac platform node](https://github.com/chromium/chromium/blob/a4037b9d04ff3754918f686344a8873ce05b22d0/ui/accessibility/platform/ax_platform_node_cocoa.mm),
  [Blink AX node](https://github.com/chromium/chromium/blob/a4037b9d04ff3754918f686344a8873ce05b22d0/third_party/blink/renderer/modules/accessibility/ax_node_object.cc).
- Firefox's macOS selected-text setter deletes the selection before
  attempting insertion. That creates a partial-edit risk if the replacement
  is constrained or rejected. [Firefox macOS text accessibility](https://github.com/mozilla-firefox/firefox/blob/4a7b56cdc419768220e195d758c9e3e4852bc6b2/accessible/mac/mozTextAccessible.mm).
- WebKit's text-range replacement can use the focused frame's editor and
  the same insertion path as ordinary typing. A browser implementation
  needs evidence that the operation honors the expected field identity and
  whole-edit guarantees when editing constraints apply. [WebKit accessibility text operations](https://github.com/WebKit/WebKit/blob/2ff591da8e6cff284eae89f299143f16fccd0d0a/Source/WebCore/accessibility/AccessibilityObject.cpp).

These are source findings. A positive macOS browser case still needs an
independent extension-free browser, actual shortcut delivery, complete rapid
commits and observable caret and focus with zero form submissions. The
authorized Aqua runner should exercise that case alongside rejection of
protected and constrained fields. For optional Linux browser follow-up,
verify that the browser exposes field identity and constraints and provides
a whole-edit operation before enabling any X11 browser target.

### Recheck results

Two `npm run build:desktop` runs on macOS 27.2.1 (26B131) arm64 with Apple
clang 21.0.0 produced SHA-256
`31587b3deb32fb482dd8c96752164469855a634d58c872ae3921d23a11db6388`.
The extracted Electron 45.4.1 application passed
`codesign --verify --deep --strict`.

| Check | Observed result |
| --- | --- |
| Extracted macOS package with `DESKTOP_REAL_ASR=1 DESKTOP_MACOS_EDITOR=1 npm run test:desktop` | Packaged launch, management and Live IPC, conflict handling, residency, and shortcut release on app Quit passed. |
| Real-model macOS test in the same run | BlackHole 2ch routed the fixture into the packaged microphone path. With HTTP(S) blocked after preparation, Live Display received `こんにちは、こんにちは、こんにちは` from the pinned Moonshine revision recorded above. |
| Three native macOS tests in the same run | All three stopped before driving either target. The Swift driver returned `{"accessibility":false,"keyboard":false}` from `AXIsProcessTrusted` and `CGPreflightPostEventAccess`. The installed Chrome was 158.0.8127.36. No TextEdit edit, native menu selection, or Chrome refusal was observed in this run. The repository exposed zero self-hosted Actions runners. |
| Extracted Linux package with `DESKTOP_REAL_ASR=1 npm run test:desktop` | Six passed on Debian 12 arm64, Xvfb/Openbox and PulseAudio using the repository Dockerfile. Mousepad 0.5.10 received the same offline model transcript. Chromium 156.0.8078.108 refusal, protected and constrained fields, held-Stop focus changes, and model retry passed. |
| `npm test`, focused standalone Chromium and focused MV3 suites listed above | 940 Node, 75 standalone Chromium, and 33 MV3 tests passed. The two browser hosts ran with no desktop process. |
| `git diff --check` | Passed. |

PR #402 remains partial. The remaining acceptance is successful OS-path
insertion in TextEdit and in an independent macOS browser, with native menu
and safety evidence from a provisioned Aqua runner. Required post-merge
verification is none.

## Display-only Live shortcut fix and macOS recheck (2026-11-25)

The Electron host publishes a new shortcut context at each session start and
end. The native helper captures that context on key-down and returns it when
the shortcut is released. This covers Display-only Live, which has no native
text binding. A release from a completed Live session can no longer trigger
dictation in the external editor. The packaged regression injected a release
message at the helper boundary after Stop and observed Idle with no error. It
also delivered a release for the current Live session and observed a normal
Stop.

In a disposable profile of Google Chrome 158.0.8127.36 on macOS, with
extensions disabled, `Accessibility.getPartialAXTree` reported the same role,
value, editable, settable, focused, and read-only properties for a plain
input and an otherwise identical input with `maxlength="4"`. The diagnostic
read Chrome's internal accessibility tree through DevTools. In a separate
browser-side `Input.insertText` probe from a caret after `xy`, the ordinary
field received `xy東京🙂`. The length-limited field received `xy東京`, including
when the limit was added in `beforeinput`, after focus and caret setup. That
probe used the browser's editing path. Native macOS event delivery was gated at
preflight. The macOS adapter still refuses browser fields. A browser path
needs a field-bound edit with observable preconditions and whole-edit behavior
before it can be enabled. Linux X11 browser insertion remains optional.

| Check | Observed result |
| --- | --- |
| `npm run build:desktop` on macOS 27.2.1 (26B131) arm64 with Apple clang 21.0.0 and Electron 45.4.1 | Two builds produced SHA-256 `237f6d7e28ef080809bcab4a26f0bfe6cea15b57e3be0fc4e27053568640057a`. The extracted bundle passed `codesign --verify --deep --strict`. |
| `DESKTOP_MACOS_EDITOR=1 DESKTOP_REAL_ASR=1 npm run test:desktop` with `DESKTOP_TEST_BINARY` pointing to that extracted package | Three passed. Packaged launch, residency, shortcut conflict and Quit, the helper-boundary Live regression, and the real model smoke passed. BlackHole 2ch fed `tests/desktop/fixtures/konnichiwa.wav` into the production Pipeline, which emitted `こんにちは、こんにちは、こんにちは` to Live Display with HTTP(S) blocked after model preparation. The model revision is the pinned revision listed above. |
| Native tests in the same run | Three blocked at preflight. Both the shell and the Aqua Terminal launch of the Swift driver reported `{"accessibility":false,"keyboard":false}`. GitHub reported zero registered self-hosted runners for the repository. Native TextEdit insertion, indicator focus, menu actions, focus-change and cancellation, the held Live release, and browser control safety remain unverified on this runner. Successful macOS browser insertion remains open. |
| Extracted Debian 12 arm64 package with `DESKTOP_REAL_ASR=1 npm run test:desktop` | Six passed using the documented Docker invocation with the existing X11 image. The Mousepad target received `こんにちは、こんにちは、こんにちは` from the same fixture and pinned revision via PulseAudio with HTTP(S) blocked. The Chromium refusal, GTK protected and constrained fields, held-Stop focus and target checks, and model retry passed. |
| `npm test` and the focused standalone Chromium and MV3 suites listed above | 940 Node, 75 standalone Chromium, and 33 MV3 tests passed. The browser hosts ran independently of the desktop app. |

## Independent Chrome acceptance harness

The macOS browser tests launch installed Google Chrome 158.0.8127.36 with a
disposable profile, extensions disabled, and no debugging connection. The
loopback page prepares the requested caret and reports the resulting browser
state. The successful-insertion case uses the extracted app's global shortcut
and sends three rapid committed chunks through its Pipeline and native helper.
It checks exact text, the UTF-16 caret, indicator focus, normal Stop, a focus
change during the held shortcut, and zero form submissions. The refusal case
also checks the browser state after the desktop reports failure.

A separate browser diagnostic used Playwright's `keyboard.insertText` with
the same Chrome version. It prepared a caret after `xy` in an ordinary
textarea and delivered `東京🙂\n ` as one commit. The resulting value was
`xy東京🙂\n ` with caret 8. When the page set `maxlength=4` in
`beforeinput`, the value became `xy東京` with caret 4. The password field
remained untouched and neither case submitted. This diagnostic exercised
Chromium's editor through its browser test interface. Chromium's
element-addressed range replacement also invokes
replacement input events. The full-value setter overwrites the field from a
previous observation and cannot guard the current value and caret in one
operation. [Chromium range replacement](https://github.com/chromium/chromium/blob/a4037b9d04ff3754918f686344a8873ce05b22d0/third_party/blink/renderer/modules/accessibility/ax_object.cc#L8441),
[Chromium value setter](https://github.com/chromium/chromium/blob/a4037b9d04ff3754918f686344a8873ce05b22d0/third_party/blink/renderer/modules/accessibility/ax_node_object.cc#L5297).

The extracted macOS package built and passed strict signature verification
on macOS 27.2.1 (26B131), arm64. The SHA-256 was
`237f6d7e28ef080809bcab4a26f0bfe6cea15b57e3be0fc4e27053568640057a`.
In the Aqua run with `DESKTOP_MACOS_EDITOR=1 DESKTOP_REAL_ASR=1`, packaged
lifecycle, the held Live release regression, and the offline BlackHole
Moonshine smoke passed. The smoke produced
`こんにちは、こんにちは、こんにちは` in Live Display. The independent
Chrome window reached the foreground and reported the caret in its textarea.
The Swift driver reported `{"accessibility":false,"keyboard":false}` in all
four native cases, before any shortcut or insertion attempt. The repository
reported zero self-hosted Actions runners. TextEdit and browser OS insertion
remain mandatory acceptance checks, and the browser backend still needs a
field-bound whole edit that respects editability and length constraints.

The extracted Debian 12 arm64 package passed all six X11 tests under
Xvfb/Openbox and PulseAudio. The shared browser fixture confirmed refusal
before editing in Chromium. The offline Moonshine smoke inserted
`こんにちは、こんにちは、こんにちは` into Mousepad. `npm test` passed all
940 checks. With no macOS desktop process running, the focused standalone
Chromium and MV3 suites passed all 75 and 33 checks, respectively.
`git diff --check` passed.

## Late browser constraint regression (2026-11-25)

The independent Chrome fixture can now add `maxlength` from
`beforeinput` after a session has bound to its ordinary textarea. The native
acceptance case requires the app to report an error and verifies the
original text, focused element and caret, with zero input events or form
submissions. The ordinary textarea success case remains required.

In a separate browser diagnostic, Playwright's `keyboard.insertText` sent
`A東京🙂\n` at UTF-16 offset 5 in `left|right` in Google Chrome
158.0.8127.36. The unrestricted control became `left|A東京🙂\nright` with
caret 11. When the same fixture added a limit of 11 during `beforeinput`,
Chrome wrote `left|Aright`, emitted an input event and put the caret at 11.
The password field stayed unchanged and neither edit submitted the form.
This exercised Chromium's editor via Playwright. Native shortcut delivery
and production insertion were outside the diagnostic.

The established insertion options still leave a browser safety gap. Paste
and Unicode input can encounter the new constraint inside the editor.
Chromium's element-addressed range replacement also invokes replacement
events, and its full-value setter can overwrite intervening text because it
lacks an expected-value or expected-selection argument. The production
adapter continues to refuse Chrome fields. [Chromium range replacement](https://github.com/chromium/chromium/blob/a4037b9d04ff3754918f686344a8873ce05b22d0/third_party/blink/renderer/modules/accessibility/ax_object.cc#L8441),
[Chromium value setter](https://github.com/chromium/chromium/blob/a4037b9d04ff3754918f686344a8873ce05b22d0/third_party/blink/renderer/modules/accessibility/ax_node_object.cc#L5297).

The follow-up ran on macOS 27.2.1 (26B131) arm64 in Aqua with Apple clang
21.0.0 and Electron 45.4.1. `npm run build:desktop` produced the same
archive SHA-256, `237f6d7e28ef080809bcab4a26f0bfe6cea15b57e3be0fc4e27053568640057a`.
The extracted app passed `codesign --verify --deep --strict`. With
`DESKTOP_TEST_BINARY` set to the extracted executable, the test command was
`DESKTOP_MACOS_EDITOR=1 DESKTOP_REAL_ASR=1 npm run test:desktop`, using the
compiled Swift fixture via `DESKTOP_MACOS_TEST_DRIVER`.

- Three packaged checks passed. They covered launch, residency, shortcut
  conflict and release on Quit, a stale Live shortcut release at the
  helper boundary, and the offline BlackHole microphone smoke to Live
  Display. The smoke again produced `こんにちは、こんにちは、こんにちは`
  with the pinned model and fixture above.
- Five native checks stopped at the Swift driver's
  `{"accessibility":false,"keyboard":false}` preflight. The positive Chrome
  case opened the independent browser and verified the fixture caret before
  stopping. None of the five reached native shortcut delivery or insertion.
  The repository listed zero registered self-hosted Actions runners.
- The focused standalone Chromium and MV3 commands above passed all 75 and
  33 tests without the desktop app running. `npm test` passed all 940
  tests after the build staged the pinned runtime.
- The rebuilt and extracted Debian 12 arm64 package passed all six tests
  with `DESKTOP_REAL_ASR=1 npm run test:desktop` under Docker, Xvfb/Openbox and
  PulseAudio. This covered the Mousepad OS path, protected and constrained
  GTK fields, Chromium refusal, held-Stop safety and model retry. The
  offline fixture inserted `こんにちは、こんにちは、こんにちは` into Mousepad.

Packaged editor and browser insertion remain mandatory on macOS. A safe
browser backend and an Aqua runner with normal OS authorization for the
package and test driver are still required. Linux browser support remains
optional.
