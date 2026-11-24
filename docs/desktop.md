# Desktop voice typing on Linux X11

My Audio to Text Desktop is a resident application for local Japanese voice
typing and saved processing graphs. The initial target is Debian 12 arm64 with
an X11 window manager, an XEmbed tray, the AT-SPI accessibility service, and
PulseAudio. X11 supplies the global shortcut and active-window identity.
AT-SPI can write directly to a specific editable control, and Xvfb and a
PulseAudio monitor make that path testable without a physical microphone.

## Build and launch

Use Node.js 22.12 or newer, npm, Python 3, and curl to build. Install the
X11 session and audio dependencies through your distribution. For Debian, use the following commands.

```sh
sudo apt-get install at-spi2-core dbus-x11 gir1.2-atspi-2.0 libgtk-3-0 \
  libgbm1 libnss3 libasound2 pulseaudio python3-gi python3-xlib
npm ci --prefix desktop
npm exec --prefix desktop -- install-electron
npm run build:desktop
./dist/desktop/my-audio-to-text
```

On another machine with the runtime dependencies, extract
`dist/my-audio-to-text-linux-arm64.tar.gz` and run its `my-audio-to-text`
executable from the extracted directory. Keep the companion runtime files
alongside the executable. The build pins Electron and checks the shared
Moonshine runtime against the repository's checksums. The archive contains the
application, runtime, and license notices. Model weights arrive through
**Models → Prepare**.

Use an EWMH-compatible X11 window manager such as Openbox. Install `trayer`
and run `trayer --edge top --align right` before launching the app. Disable
any StatusNotifierItem tray hosts or plugins in that session so Electron uses
its GTK/XEmbed fallback. Tray Start needs that backend to remember the focused
field when its menu opens. [Electron Linux tray behavior](https://www.electronjs.org/docs/latest/api/tray#linux).

## Voice typing

1. Open **Models**, prepare Moonshine Small Streaming Japanese, and wait for
   **Ready**. Allow at least 300 MB of free disk space and 2 GB of available RAM.
2. Place a caret in an editable plain-text control in another application.
3. Press **Ctrl+Alt+Shift+D**. The status indicator shows **Preparing** while the
   graph loads, then **Recording** once microphone capture starts.
4. Speak Japanese. Committed text goes to the authorized caret. Press the same
   shortcut or **Stop** on the indicator to finish and drain accepted audio.
   **Cancel voice typing** in the tray discards work still pending.

The tray provides Start and Stop, the current shortcut graph, Graph Library,
Models, Settings, and Quit. Closing the management window leaves the tray and
shortcut available. Quit stops capture and releases the shortcut and runtime.
A shortcut conflict leaves the current valid binding in place. Choose a
different combination in Settings and save it.

Use your default system audio input. If the app reports a microphone error,
check that this device is enabled and available to your desktop session.
Accessibility must be enabled in both the session and the target application.
Reopen the target after changing accessibility settings.

### Focused fields

Desktop insertion uses the AT-SPI `Text` and `EditableText` interfaces. It
supports GTK 3 plain-text editor views with an editable run at the caret.
Those views preserve Unicode, spaces, and line breaks.

Place a caret with no selection. The app stops if the field closes, becomes
unavailable, loses focus, or rejects the output. The shortcut uses the field
focused at the key press, even while the toolkit restores focus after the X11
keyboard grab. Tray Start uses the field focused before the XEmbed menu opened
and requires that same field when the menu closes.

The app refuses GTK single-line entries because AT-SPI cannot establish their
length limits. Password fields, rich-text editors, read-only controls, and fields
that rewrite inserted text are outside the support scope.

Extension-free browser insertion remains an open acceptance requirement.
Chromium 156 on Debian X11 exposes focused web text inputs through AT-SPI but
lacks `EditableText` on those controls. The app refuses Chromium web fields
before recording. Firefox support is deferred for the first desktop release.

Wayland, macOS, Windows, mobile, newer field families, system audio capture,
and a public installer are follow-up scope.

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
processing code, with a sandbox for each renderer. The Linux helper uses the
distribution's AT-SPI and X11 bindings for focused output.

The main process owns the tray, global shortcut, permission policy, saved
graph snapshots, and authorized target. Its X11 helper takes the active window,
matches its process and focused AT-SPI object, and holds that identity for the
session. It revalidates it before every insertion and uses the object's
[EditableText insertion method](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.EditableText.insert_text.html).
The helper uses private process pipes. It sends no keystrokes, submits no forms,
and leaves clipboard data untouched.

A sandboxed hidden renderer owns microphone capture, the shared Pipeline, and
its Moonshine CPU/WASM Worker. The management and indicator renderers use
their own narrowly scoped bridges. Only the runtime can request microphone
access during an intentional Start. The packaged resources load through a
local Electron protocol. HTTP(S) is limited to the pinned model file requests.
Speech and text are processed locally.

The Electron profile under `${XDG_CONFIG_HOME:-~/.config}/My Audio to Text/`
holds `desktop-library.json`, the graph editor draft recovery state, and the
verified model cache. The Chrome extension and Web Playground have their own
storage, model caches, runtimes, and lifecycle. Each application can launch and
run independently. Concurrent sessions use their own memory.

## Automated checks

```sh
npm ci
npm test
sudo apt-get install chromium xvfb xauth openbox trayer xdotool pulseaudio-utils \
  gir1.2-gtk-3.0
npm run test:desktop
DESKTOP_REAL_ASR=1 npm run test:desktop
```

The X11 suite starts the packaged application, an independent GTK editor, and
Chromium with a fresh profile and extensions disabled. The GTK tests check
shortcut Start and Stop, exactly-once Unicode insertion at the caret, and safe
cancellation when the target changes. The Chromium test checks that the shortcut
reports a refusal while leaving the values, caret, and focus intact in each
tested field, with zero edit events and zero form submissions. Put `chromium`
on `PATH` or set `DESKTOP_TEST_CHROMIUM` to its executable path.
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
