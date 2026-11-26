# Desktop voice typing

My Audio to Text Desktop runs saved graphs locally from a resident menu-bar
or tray application. macOS on Apple Silicon is the primary v1 target. The
macOS app writes to the active editor, browser field, or other editable text
control through Accessibility editing or native keyboard input. The X11 app
uses AT-SPI editing. Compatibility depends on the focused field and the
editing methods it exposes.

## Build and launch

Both builds use Node.js 22.12 or newer, npm, Python 3, and curl. The build pins
Electron and verifies the shared Moonshine runtime against the repository
checksums. The package contains the runtime and license notices. Download the
model weights separately through **Models → Prepare**.

### Apple Silicon macOS

Install the Xcode Command Line Tools. In an Aqua session run:

```sh
npm ci --prefix desktop
npm exec --prefix desktop -- install-electron
npm run build:desktop
open 'dist/desktop/My Audio to Text.app'
```

The archive is `dist/my-audio-to-text-macos-arm64.tar.gz`. Extract it, keep
the `.app` bundle intact, and open it. The build ad-hoc signs its bundle for
local execution. It is a development package. Signing for distribution,
notarization and public installation are outside this issue.

### Debian X11

Use an X11 session with AT-SPI, an XEmbed tray and PulseAudio. Install the
build and runtime dependencies and start the app:

```sh
sudo apt-get install at-spi2-core dbus-x11 gir1.2-atspi-2.0 libgtk-3-0 \
  libgbm1 libnss3 libasound2 pulseaudio python3-gi python3-xlib
npm ci --prefix desktop
npm exec --prefix desktop -- install-electron
npm run build:desktop
./dist/desktop/my-audio-to-text
```

On another Debian 12 machine with the runtime dependencies, extract
`dist/my-audio-to-text-linux-arm64.tar.gz` and keep the companion runtime files
alongside the executable.

Use an EWMH-compatible X11 window manager such as Openbox. Install `trayer`
and run `trayer --edge top --align right` before launching the app. Disable
any StatusNotifierItem tray hosts or plugins in that session so Electron uses
its GTK/XEmbed fallback. Tray Start needs that backend to remember the focused
field when its menu opens. [Electron Linux tray behavior](https://www.electronjs.org/docs/latest/api/tray#linux).

## Voice typing

1. Open **Models**, prepare Moonshine Small Streaming Japanese, and wait for
   **Ready**. Allow at least 300 MB of free disk space and 2 GB of available RAM.
2. Place the caret in the field you want to dictate into. On macOS, you can
   also select text to replace.
3. Press **Control+Option+Command+D** on macOS or **Ctrl+Alt+Shift+D** on X11.
   The indicator shows **Preparing** while the graph loads and **Recording**
   once microphone capture starts.
4. Speak Japanese. Committed text goes to the authorized caret. Press the same
   shortcut or **Stop** on the indicator to finish and drain accepted audio.
   **Cancel voice typing** in the tray discards work still pending.

The tray provides Start and Stop, the current shortcut graph, Graph Library,
Models, Settings, and Quit. Closing the management window leaves the tray and
shortcut available. Quit stops capture and releases the shortcut and runtime.
A shortcut conflict leaves the current valid binding in place. Choose a
different combination in Settings and save it.

The app uses the default system audio input. Grant microphone access through
the normal OS dialog after an intentional Start. See the
[macOS permissions](#packaged-app-permissions) for recovery on macOS. On X11,
enable assistive technology in the session and reopen the target application.

### Focused fields

The macOS helper binds the active application, window and exact field at
key-down or before opening the tray menu. Before each dispatch it rechecks
focus, identity and editability, and waits for shortcut and modifier release.
A release from an ended voice typing or Display-only Live session is
discarded.

The macOS helper uses Accessibility selected-text editing or range replacement
when the field exposes one of those operations. For an Accessibility-confirmed
editable field without a direct operation, it sends Unicode text in keyboard
events to the active application. This fallback requires macOS authorization
to post keyboard events and leaves the clipboard untouched. It converts line
breaks and tabs to spaces to avoid submitting forms or moving focus. Some
applications ignore Unicode text supplied through keyboard events.

Single-line fields, multiline fields, and selections use the target's editing
rules. A field can normalize, truncate, or ignore a chunk. Protected, disabled,
and read-only controls are refused when identified by Accessibility. An
application that exposes no usable editable field or returns an edit error
will stop voice typing. Voice typing sends text without a submit command.

A detected focus change stops the session and discards pending output. An
edit already in flight can reach a different field if focus changes after
the final check. Stop dictation and wait for the session to finish before
switching fields or apps.

On X11, the focused control must expose AT-SPI `Text` and `EditableText`
interfaces. Place a caret in an editable span. AT-SPI inserts at the caret
and can apply the field's native constraints. Its insertion operation works
at an offset, so clear any selection before starting. A browser or custom
editor may expose text for reading without an editing interface. In the
Debian X11 fixture, Chromium 156 exposes its tested web fields that way.
The shortcut binds at key-down and starts or stops on key release. The tray
checks the field captured before opening the XEmbed menu. Wayland, Windows,
mobile and system audio capture are outside v1.

## Manual test on macOS

This procedure is optional. Build and launch the revision you want to try
using the [Apple Silicon build commands](#apple-silicon-macos).

### Packaged app permissions

- On intentional Start, accept the microphone prompt for **My Audio to
  Text**, or enable it under **System Settings → Privacy & Security →
  Microphone**.
- Under **Privacy & Security → Device Control and Data Access** on macOS
  27.2, enable **My Audio to Text** for focused-field access.
  The setting is called **Accessibility** on older
  releases and again on macOS 27.3. Use **+** to select the actual built
  bundle if it is missing. If macOS identifies the native helper separately,
  add that executable using **Command+Shift+G** in the file picker. Its
  path inside the bundle is `Contents/MacOS/focused-text`. The app
  executable is `Contents/MacOS/my-audio-to-text`. [Apple's privacy settings update](https://developer.apple.com/news/?id=oqng0zjk).
- Quit from the app's menu and relaunch the same bundle after changing
  authorization. Repeat Start after any permission prompt. If the same
  denial persists after moving or rebuilding the ad-hoc-signed bundle,
  remove the stale entry and add the current bundle or helper again.

### Try an editor or browser field

1. Prepare **Moonshine Small Streaming Japanese** in **Models** and wait
   for **Ready**. Select the default voice typing graph as the shortcut
   graph.
2. Open a blank document in an editor you use, or open a browser page with
   a text field. For a local browser example, open
   `data:text/html,<form><textarea>left%7Cright</textarea><input maxlength=6><input type=password><button>Submit</button></form>`
   and place the caret after `|`.
3. Press **Control+Option+Command+D**, wait for **Recording**, say
   `こんにちは`, then press the same shortcut to Stop. Check that text
   appears at the caret and the field stays focused. Try with selected text
   or in the single-line field to see how the application handles replacement
   or limits.
4. During a separate run, move focus or choose **Cancel voice typing** from
   the menu to check that pending text is discarded.

## Graphs and models

The default graph is
`MicrophoneAudio → SpeechToTextMoonshineSmallJa.final → FocusedInputTextOutputNode`.
The editor labels this sink **Focused application text output**. The saved
graph retains the same node type and port schema used by the browser host.
The sink accepts committed TEXT from any supported producer, including
**Text** and **Text formatter**. Other supported nodes are **Microphone audio**,
**Speech Recognition · JA / Streaming**, and **Display**.

Use **Graph Library** to create, duplicate, edit, select, and import or export
individual graphs. The editor uses the same typed ports, settings, wiring
validation, Auto Save, and Undo/Redo as the extension. If a recovered draft
cannot be saved, repair the draft or use **Undo** to return to the saved
graph. Desktop rejects graph nodes outside its supported subset and shows
the original import error.
A running graph uses the last saved snapshot taken at Start. Edits apply to the
next session. Use **Live** to run Display graphs inside the management window.
Graphs with both Display and a focused output start from a valid external
caret and retain the latest Display panes for inspection in Live.

Models uses the shared [verified asset lifecycle](model-assets.md) and
[Moonshine model pin and notices](optional-asr-nodes.md).
The model card supports progress, cancellation, retry, and deletion.
A session loads verified assets before requesting audio.
Existing files are reverified and reused offline, and deletion is blocked
while a session owns the model.

## Host boundaries

Electron provides the Web Audio, Worker and WASM APIs used by the existing
processing code, with a sandbox for each renderer. The macOS helper uses
Apple's Carbon, Accessibility and AppKit frameworks. The Linux helper uses
the distribution's AT-SPI and X11 bindings.

The main process owns the tray, global shortcut, permission policy, saved
graph snapshots, and authorized target. Its X11 helper takes the active window,
matches its process and focused AT-SPI object, and holds that identity for the
session. It revalidates it before every insertion and uses the object's
[EditableText insertion method](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.EditableText.insert_text.html).
Both platform helpers use private process pipes. They send text and leave
submission to the user.

A sandboxed hidden renderer owns microphone capture, the shared Pipeline, and
its Moonshine CPU/WASM Worker. The management and indicator renderers use
their own narrowly scoped bridges. Only the runtime can request microphone
access during an intentional Start. The packaged resources load through a
local Electron protocol. HTTP(S) is limited to the pinned model file requests.
Speech and text are processed locally.

The Electron profile holds `desktop-library.json`, graph editor draft
recovery state, and the verified model cache. The profile lives in
`~/Library/Application Support/My Audio to Text/` on macOS and
`${XDG_CONFIG_HOME:-~/.config}/My Audio to Text/` on X11. The Chrome extension
and Web Playground have their own storage, model caches, runtimes, and
lifecycle. Each application can launch and run independently.

## Automated checks

Install the repository test dependencies with `npm ci` and run `npm test`.
Build the target package before running its desktop tests.

On macOS, use a graphical test session and the extracted executable:

```sh
mkdir -p dist/verify-macos
tar -xzf dist/my-audio-to-text-macos-arm64.tar.gz -C dist/verify-macos
export DESKTOP_TEST_BINARY="$PWD/dist/verify-macos/My Audio to Text.app/Contents/MacOS/my-audio-to-text"
npm run test:desktop
DESKTOP_REAL_ASR=1 npm run test:desktop
```

The basic macOS check exercises the packaged management and Live renderers,
native shortcut conflicts, residency after closing the window, and shortcut
release at Quit. The suite also relaunches the package to verify Auto Save
draft recovery. Dispatch fixtures use simulated Accessibility responses to
exercise distinct application identities, selected-text and range editing,
delayed keyboard input and clipboard preservation, native constraints,
protected fields, order, focus changes, and cancellation. A fixture-owned WebKit
window checks the installed browser engine's edit behavior, including Unicode,
length limits and a line break in a single-line form field.
The real-model smoke routes the licensed fixture through BlackHole 2ch and
the app's microphone input. It temporarily selects BlackHole as the default
input and restores the prior device.

### Optional native Swift driver

The optional native suite uses the packaged app permissions described above
and a separate Swift driver. The driver sends the shortcut and uses
Accessibility to observe TextEdit and exercise the menu. The tests open
a separate instance of Safari from `/Applications`. Use a test account with
Safari extensions disabled. A local page checks Unicode insertion in order at
the authorized caret, normal length limits, protected and read-only field
refusal, and zero form submissions.

Build the driver at a stable path, then run its permission preflight.

```sh
mkdir -p dist
export DESKTOP_MACOS_TEST_DRIVER="$PWD/dist/desktop-macos-test-driver"
xcrun swiftc -O tests/desktop/macos-fixture.swift -o "$DESKTOP_MACOS_TEST_DRIVER"
"$DESKTOP_MACOS_TEST_DRIVER" permissions
DESKTOP_MACOS_EDITOR=1 npm run test:desktop
```

In an authorized Aqua session, use **+** and **Command+Shift+G** to select
`dist/desktop-macos-test-driver` under **Device Control and Data Access**
(**Accessibility** on releases that use that label). Authorize the driver
for keyboard event posting through the normal OS mechanism as well. Rerun
the driver after any settings change. Its `permissions` command checks
`AXIsProcessTrusted` and `CGPreflightPostEventAccess`. The optional cases
skip before interacting with external fields if either result is `false`.
The driver is only needed for automation.

On X11:

```sh
sudo apt-get install chromium xvfb xauth openbox trayer xdotool pulseaudio-utils \
  gir1.2-gtk-3.0 mousepad
npm run test:desktop
DESKTOP_REAL_ASR=1 npm run test:desktop
```

The X11 suite starts the packaged application, Mousepad, a GTK safety fixture,
and Chromium with a fresh profile and extensions disabled. The Mousepad tests
check shortcut Start and Stop, exactly-once Unicode insertion at the caret,
and safe cancellation when the target changes, including when the Stop
shortcut is released. The separate GTK fixture checks successful input to a
length-limited single-line entry and multiline buffer, plus refusal of a
password field and locked text. The Chromium 156 fixture checks refusal
when AT-SPI editing is unavailable and confirms that field values, caret,
focus, and form submission state are preserved. Put
`chromium` on `PATH` or set `DESKTOP_TEST_CHROMIUM` to its executable path.
The model smoke additionally downloads the pinned
weights, plays a licensed speech fixture into a virtual microphone, and tests
the prepared cache with HTTP blocked. Run the Desktop suite in an isolated
session. Its test profile and virtual audio server are disposable.

On a machine with Docker running Linux containers, the same environment can
be prepared from the repository root:

```sh
docker build --platform linux/arm64 -t local-voice-x11-test -f tests/desktop/Dockerfile tests/desktop
docker run --rm --init --platform linux/arm64 --cap-add SYS_ADMIN --security-opt seccomp=unconfined --shm-size=1g \
  -v "$PWD:/source:ro" local-voice-x11-test bash -lc '
    set -euo pipefail
    tar -C /source --exclude=.git --exclude=node_modules --exclude=dist \
        --exclude=.cache --exclude=web/vendor --exclude=web/tts-assets \
        --exclude=test-results --exclude=playwright-report -cf - . | tar -xf -
    npm ci && npm ci --prefix desktop && npm exec --prefix desktop -- install-electron &&
    npm run build:desktop &&
    mkdir -p dist/verify &&
    tar -xzf dist/my-audio-to-text-linux-arm64.tar.gz -C dist/verify &&
    DESKTOP_TEST_BINARY=dist/verify/my-audio-to-text/my-audio-to-text \
      DESKTOP_REAL_ASR=1 npm run test:desktop'
```

The container settings allow the Electron and Chromium sandboxes to run inside the VM.
See the [issue #401 validation record](evidence/desktop-401.md) for historical
environment details and fixture output.
