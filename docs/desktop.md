# Desktop voice typing

My Audio to Text Desktop runs saved graphs locally from a resident menu-bar
or tray application. macOS on Apple Silicon is the primary v1 target. The
arm64 macOS package builds and launches, and its TextEdit adapter is pending
automated insertion validation. The verified dictation target is stock
Mousepad 0.5.10 on Debian 12 arm64/X11. See the
[validation record](evidence/desktop-401.md) for current acceptance status.

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
2. Place a caret in a writable document in TextEdit on macOS or Mousepad on X11.
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
the normal OS dialog after an intentional Start. On macOS, check **System
Settings → Privacy & Security → Microphone** and **Accessibility** if access
is refused. On X11, enable assistive technology in the session and reopen
the target application.

### Focused fields

The macOS helper registers the global shortcut with Carbon and uses
Accessibility to bind the TextEdit document at key-down or before opening
the menu. It checks the active application, window, exact element and
writable selection before using the target's selected-text setter. It reads
back the full text and caret and ends the session if the edit cannot be
confirmed. It holds pending text until the shortcut and its modifiers are
released. The press belongs to the session or idle period in which it began.
If a voice typing or Display-only Live session ends while the shortcut is
held, the release is discarded. The adapter leaves the clipboard alone. Its
intended scope is the document view in the system TextEdit app. Other editors,
secure fields, native dialog fields and browser fields are refused.

The X11 helper uses AT-SPI `Text` and `EditableText` in stock Mousepad 0.5.10
(`sudo apt-get install mousepad`). Place a caret with no selection. AT-SPI
does not expose custom GTK insertion handlers or their constraints. Other
GTK text views, single-line entries, and locked text ranges are refused.
If the target closes, changes, loses focus, or rejects output, the app stops.
The shortcut binds at key-down and starts or stops on key release. The tray
checks the field captured before opening the XEmbed menu.

Extension-free browser insertion on **macOS** remains a pre-merge acceptance
requirement. The current macOS adapter refuses browser fields. Linux browser
insertion is an optional follow-up. Chromium 156 on X11 exposes focused web
fields through AT-SPI without `EditableText`, and the package refuses these
fields before recording. Firefox remains deferred. The
[insertion decision](evidence/desktop-401.md#insertion-decision) explains the
remaining field-level requirements. Wayland, Windows, mobile and system audio
capture are outside v1.

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
validation, Auto Save, and Undo/Redo as the extension. Desktop rejects graph
nodes outside its supported subset and shows the original import error.
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
Apple's Carbon and Accessibility frameworks. The Linux helper uses the
distribution's AT-SPI and X11 bindings.

The main process owns the tray, global shortcut, permission policy, saved
graph snapshots, and authorized target. Its X11 helper takes the active window,
matches its process and focused AT-SPI object, and holds that identity for the
session. It revalidates it before every insertion and uses the object's
[EditableText insertion method](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.EditableText.insert_text.html).
Both platform helpers use private process pipes and edit an authorized
element directly. Neither helper changes clipboard data or submits forms.

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
DESKTOP_MACOS_EDITOR=1 npm run test:desktop
```

The basic macOS check exercises the packaged management and Live renderers,
native shortcut conflicts, residency after closing the window, and shortcut
release at Quit. The real-model smoke routes the licensed fixture through
BlackHole 2ch and the app's microphone input. It temporarily selects BlackHole
as the default input and restores the previous device.

The native tests require an automated Aqua session with normal Accessibility
and keyboard event permission for the Swift driver and Accessibility for the
packaged app. They exercise TextEdit with rapid committed chunks, focus while
the indicator is visible, native menu Start, Stop, and Quit, and cancellation
or focus change while the shortcut is held. They also cover ending a
Display-only Live session before releasing the shortcut in TextEdit. The basic
packaged run separately checks stale release handling at the helper message
boundary. With Google Chrome installed,
the same suite checks refusal of a password field, read-only input, and
length-limited input and textarea in a fresh extension-disabled profile. The
Chrome tests cover safety refusals. Successful browser insertion remains
required before merge.

The harness compiles the Swift driver by default. A provisioned runner can
compile it at a stable location using
`xcrun swiftc -O tests/desktop/macos-fixture.swift -o /path/to/driver`, then set
`DESKTOP_MACOS_TEST_DRIVER=/path/to/driver`. The driver's `permissions` command
must report both permissions as granted before the native tests can run.

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
shortcut is released. The GTK fixture verifies that
length-limited buffers and protected fields retain their values and focus
with zero edits to the constrained fields. The Chromium test checks that the
shortcut reports a refusal while leaving the values, caret, and focus intact
in each tested field, with zero edit events and zero form submissions. Put
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
See [desktop validation evidence](evidence/desktop-401.md) for the tested
environment, results, and fixture output.
