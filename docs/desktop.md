# Desktop voice typing

My Audio to Text Desktop runs saved graphs locally from a resident menu-bar
or tray application. macOS on Apple Silicon is the primary v1 target. The
macOS app pastes into the active editor, browser field, or other editable text
control using the system clipboard and Command+V. The X11 app uses AT-SPI
editing. Compatibility depends on the focused field and the input it accepts.

## Build and launch

Both builds use Node.js 22.12 or newer, npm, Python 3, and curl. The build pins
Electron and verifies the shared Workers, JS/WASM runtime files, and other
packaged assets against the repository checksums. The package includes
manifests and license notices. **Models → Prepare** downloads weights into
the desktop profile.

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
its GTK/XEmbed fallback. [Electron Linux tray behavior](https://www.electronjs.org/docs/latest/api/tray#linux).

## Voice typing

1. Open **Models**, prepare Moonshine Small Streaming Japanese, and wait for
   **Ready**. Allow at least 300 MB of free disk space and 2 GB of available RAM.
2. Place the caret in the field you want to dictate into. On macOS, you can
   also select text to replace.
3. Press **Control+Option+Command+D** on macOS or **Ctrl+Alt+Shift+D** on X11.
   The indicator shows **Preparing** while the graph loads and **Recording**
   once microphone capture starts.
4. Speak Japanese. With the default graph, the recording indicator shows the
   latest hypothesis and clears it when the recognizer completes the utterance.
   Each final result goes to the field focused when it is delivered. Switch
   fields, windows, or apps while recording. Press the shortcut again or click
   **Stop** on the indicator to finish
   and drain accepted output. **Cancel voice typing** in the tray discards work
   still pending.

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

Each nonempty TEXT chunk delivered to the focused output follows the current
focus. A chunk can go to the new field even if you began speaking before
switching focus. Recording continues through focus changes. Stop drains
accepted chunks using the same rule. Cancel or Quit discards pending chunks
and finishes any clipboard cleanup for a Paste already sent.

On macOS, the helper waits for the shortcut and modifiers to be released,
stages the text on the system clipboard, and checks the current focus just
before sending Command+V. The helper stages Unicode, whitespace, line breaks,
and tabs as plain text. The current app handles Paste normally, including
selection replacement, formatting, truncation, or rejection. Fields with
incomplete Accessibility editing metadata can receive Paste. Secure Keyboard
Entry, a missing foreground app, an identified menu, or a field identified as
protected, disabled, or read-only causes the helper to skip the chunk. Skipped
chunks are discarded and delivery resumes with the next chunk in a usable field.

The helper gives each Paste 250 ms to read the clipboard before attempting
to restore the previous clipboard and starting the next chunk. It preserves
clipboard items and formats it can read, including non-text data. Some
source-provided formats, such as unavailable promised data, may be lost.
If the helper cannot read the existing clipboard at all, it stops before
staging text.
Restoration checks the clipboard generation to preserve a newer copy. macOS
provides neither an atomic clipboard swap nor confirmation that a field
completed Paste. An app that reads very late or during a concurrent copy
can receive different clipboard contents. Dictation stages text and restores
clipboard items for the current Mac only. It marks the temporary text as
transient. Clipboard history or clipboard managers can still record the
temporary text or restored items.

Switching focus as a Paste is sent can affect which field receives it.
Allow a chunk to appear before switching if it needs to land in a particular
field.

On X11, the helper resolves the current focused field for each chunk. The
control must expose AT-SPI `Text` and `EditableText` interfaces. Place a
caret in an editable span and clear any selection. AT-SPI inserts at the
caret offset and can apply the field's native constraints. It skips chunks
while the focus is unavailable, protected, or unsupported. A browser or
custom editor may expose text for reading without an editing interface. In
the Debian X11 fixture, Chromium 156 exposes its tested web fields that way.
The shortcut starts or stops on key release. Wayland, Windows, mobile and
system audio capture are outside v1.

## Manual test on macOS

This procedure is optional. Build and launch the revision you want to try
using the [Apple Silicon build commands](#apple-silicon-macos).

### Packaged app permissions

- On intentional Start, accept the microphone prompt for **My Audio to
  Text**, or enable it under **System Settings → Privacy & Security →
  Microphone**.
- Under **Privacy & Security → Device Control and Data Access** on macOS
  27.2, enable **My Audio to Text** for focused-field access and posting
  Command+V. The setting is called **Accessibility** on older
  releases and again on macOS 27.3. Use **+** to select the actual built
  bundle if it is missing. If macOS identifies the native helper separately,
  add that executable using **Command+Shift+G** in the file picker. Its
  path inside the bundle is `Contents/MacOS/focused-text`. The app
  executable is `Contents/MacOS/my-audio-to-text`. [Apple's privacy settings update](https://developer.apple.com/news/?id=oqng0zjk).
- If macOS asks for clipboard access, allow it so the helper can save and
  restore the existing clipboard. [Apple's pasteboard access documentation](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-swift.enum/default).
- Quit from the app's menu and relaunch the same bundle after changing
  authorization. Repeat Start after any permission prompt. If the same
  denial persists after moving or rebuilding the ad-hoc-signed bundle,
  remove the stale entry and add the current bundle or helper again.

### Try an editor or browser field

1. Prepare **Moonshine Small Streaming Japanese** in **Models** and wait
   for **Ready**. Select the default voice typing graph as the shortcut
   graph.
2. Copy a short sample in the editor or browser so you can check clipboard
   restoration. Focus an ordinary text field and place the caret or select
   text to replace.
3. Press **Control+Option+Command+D** and wait for **Recording**. Dictate
   a few short phrases with pauses, such as `こんにちは` and `ありがとう`.
   Check that successive chunks appear while you are still recording.
4. While still recording, move to a second field in the same app and dictate
   another phrase. Switch to a second app, focus a text field, and dictate
   again. Check that the chunks appear in the fields focused at delivery
   and that the indicator stays on **Recording** throughout.
5. Press the shortcut again to Stop. When the session finishes, use Paste in
   a scratch field to confirm the original sample is still on the clipboard.
   In a separate run, choose **Cancel voice typing** to discard pending chunks.

## Graphs and models

**Focused application text output** uses the same node type and port schema
as the browser's focused output. It accepts TEXT from any supported producer,
including **Text** and **Text formatter**.
Each nonempty delivery is a separate insertion, including repeated values.
Empty strings leave the field as it is.

### Floating Display

New default dictation graphs connect the recognizer's `provisional` output to
**Floating Display** and its `final` output to **Focused application text output**.
To add the preview to an existing graph, add **Floating Display** in Graph Editor
and connect `provisional` to its `text` input. Keep the `final` connection to
the focused output. The indicator shows the latest supplied TEXT beside Stop
until an empty string clears it or the session ends. Existing saved graphs
keep their original connections.

### Supported Nodes

| Category | Desktop Nodes |
| --- | --- |
| Sources and controls | Microphone audio, Text, Number, Button |
| Speech recognition | Moonshine Small Streaming Japanese, Moonshine Medium Streaming English |
| Translation | TranslateGemma 4B, experimental PLaMo 3 Translate 2B |
| AI text and conditions | LFM2.5 1.2B JP, Qwen3.5 2B, IfCondition (XtremeDistil) |
| Speech synthesis | Supertonic 3, Kokoro 82M, Qwen3-TTS Streaming, CosyVoice3 Streaming |
| Text processors | Text formatter, Text accumulator, Text sliding window, Text window, Hold, Keyed text pair, Keyed text coalesce, Keyed paired text accumulator |
| Outputs | Display, Floating Display, Focused application text output, Speaker, Audio player / WAV |

Use **Graph Library** to create, duplicate, edit, and import or export graphs.
Desktop uses the shared graph JSON, typed ports, settings, and validation.
Import compatible extension graphs directly. For a parent with dependencies,
use **Export JSON** and import the resulting Subgraph bundle from Graph Library.
Select connected processing Nodes and choose **Create Subgraph** to make a
reusable definition. Input and output destinations stay in the parent graph.
Nested Subgraphs are outside the shared format. **Chrome tab audio** depends
on the toolbar-invoked browser tab and Chrome's tab-capture APIs. Desktop
identifies that Node when rejecting an incompatible import and preserves the
source file. Focused text output uses the current native caret on desktop.

**Live** runs graphs with a connected Display, Floating Display, Speaker, or
Audio player / WAV. Button Nodes with executable paths appear under **Graph
Actions**. A Button wired to `Hold.trigger` emits the held `TEXT` at every
accepted click. Display renders text, keyed pairs, and keyed history snapshots
in their configured tabs. Speaker plays clips and streaming audio. Audio player
/ WAV retains generated clips for replay and saving. Start graphs with a
focused output from the global shortcut or tray. Their Display panes are
available in Live. Edits and shared definition changes apply at the next Start.

### Models and hardware

Choose a model and, where applicable, a voice in **Models**. Each entry lists
download size, requirements, and license or source notices. The editor and
Live link directly to graph requirements. Start verifies files for the
executable graph, downloads missing ones with progress and cancellation,
and initializes its Workers before requesting microphone access or running
sources. Prepared files are reverified and reused offline. Stop the session
before deleting cached files. Voice variants can share files.

- **CPU/WASM** runs both Moonshine recognizers, IfCondition, Supertonic 3, and
  Kokoro. Kokoro's Japanese `jf_alpha` voice also requires the OpenJTalk
  frontend voice listed in Models. PLaMo uses CPU/WASM and requires
  WebAssembly JSPI in Electron. Allow about 5 GB of free storage and 6 GB of
  available RAM for PLaMo.
- **Worker WebGPU** runs TranslateGemma, LFM2.5, Qwen3.5, Qwen3-TTS, and
  CosyVoice3. LFM2.5 and Qwen3.5 also require `shader-f16`. Models can need
  several GB of free RAM/GPU memory per Node. Live reports the specific
  capability or initialization error if the machine cannot load a model.
  WebGPU availability depends on the GPU, driver, and OS. Linux X11 can run
  the same graphs where its Chromium Worker exposes the required features.

See the [verified asset lifecycle](model-assets.md) for integrity and cache
details and [Moonshine pins and notices](optional-asr-nodes.md) for ASR.

### Example graphs

Add the listed Nodes in Graph Editor, wire their named ports, and choose the
saved graph in Live.

- **Translation**. For Japanese to English, connect a Japanese `Text.value`
  to `TranslateGemma4B.text`, then connect the translation's `text` output
  to `Display.input1`. For PLaMo use the equivalent ports. Wire a second Text
  Node holding `en` to `target_lang` to always request English.
- **Text processing**. Connect `Text.value → TextProcessingLfm2.input1` and
  `TextProcessingLfm2.result → Display.input1`. Set the system prompt to
  “Summarize Input 1 in one English sentence.” Qwen3.5 uses the same ports.
- **Speech synthesis**. Set Kokoro's voice to `af_heart` for English. Connect
  `Text.value → Kokoro.text` and `Kokoro.audio → AudioOutput.audio` for
  replay or WAV export. For automatic playback connect `audio` to
  `SpeakerOutput.audio`. For Qwen3-TTS or CosyVoice3 connect the `stream`
  output to `SpeakerOutput.audio`.

## Host boundaries

Electron provides the Web Audio, Worker and WASM APIs used by the existing
processing code, with a sandbox for each renderer. The macOS helper uses
Apple's Carbon, Accessibility and AppKit frameworks. The Linux helper uses
the distribution's AT-SPI and X11 bindings.

The main process owns the tray, global shortcut, permission policy, saved
graph snapshots, and session authorization for focused output. At delivery
the X11 helper matches the active window to its process and focused AT-SPI
object, checks the caret, and uses the object's
[EditableText insertion method](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.EditableText.insert_text.html).
Both platform helpers use private process pipes. They send text and leave
submission to the user.

A sandboxed hidden renderer owns microphone capture, the shared Pipeline,
inference Workers, and Speaker playback. The management and indicator use
their own narrowly scoped bridges. Only the runtime can request microphone
access during an intentional Start. Packaged resources load through a local
Electron protocol. The main process transports only the pinned files for
the current preparation. Speech and text are processed locally.

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
draft recovery. A controlled AppKit editor uses its native pasteboard
reader with a private pasteboard and simulated delayed consumption. The tests
exercise ordered provisional and final chunks during recording, multi-item
clipboard preservation, intervening copies, held modifiers, protection, focus
changes, Stop, and cancellation without external keyboard-event authorization.
The real-model smoke routes the licensed fixture through BlackHole 2ch and
the app's microphone input. It temporarily selects BlackHole as the default
input and restores the prior device.

The packaged graph suite also exercises Subgraph extraction, Graph Actions,
keyed display history, construction and startup boundaries for every AI
Worker, and download cancellation, retry, and integrity checks. On a WebGPU
machine the opt-in graph smoke uses real IfCondition, LFM2.5, and Kokoro
weights, blocks the network during inference, and verifies WAV export.

```sh
DESKTOP_REAL_GRAPH_MODELS=1 npm run test:desktop
```

Use `DESKTOP_GRAPH_TEST_PROFILE` with a disposable test profile to reuse
verified model files across graph smoke runs. If another desktop instance
owns the default shortcut, run the macOS suite with a free
`DESKTOP_TEST_SHORTCUT`, such as `Control+Alt+Super+F10`.

### Issue #417 validation

| Environment | Checks and results |
| --- | --- |
| Apple Silicon macOS 27.2.1, Electron 45.4.1 | Built, verified the ad-hoc signature, extracted, and launched the weight-free package. The desktop suite and opt-in real graph smoke passed. IfCondition ran on CPU/WASM and LFM2.5 ran on WebGPU with `shader-f16` in the same offline graph. Kokoro produced real offline audio, loaded it in the player, recovered Speaker playback after a test device failure, and saved a 24 kHz WAV. |
| Debian 12 arm64, X11 in Docker | Built and tested the extracted Linux archive. With `DESKTOP_REAL_ASR=1`, the suite passed and Japanese Moonshine recognized the PulseAudio fixture offline and inserted TEXT at the Mousepad caret. |
| Shared code and Chrome MV3 | `npm test` passed 947 tests. `npm run build:extension` verified 223 weight-free files. The focused MV3 graph, Subgraph, model/cache, and audio suites passed 47 tests. Chromium Playground TTS and PLaMo fixtures passed 25 tests. |

The packaged boundary checks covered construction, pinned requirements, and
Worker startup for all 11 AI Nodes on both desktop targets. Real desktop
inference was exercised for IfCondition, LFM2.5, Kokoro (English), and Moonshine
Small Japanese. The other seven AI Nodes had packaged boundary checks and
shared regression coverage. The macOS native cross-application and virtual
microphone options, Linux GPU inference, and the heavyweight MV3 streaming
decoder smokes were skipped.

### Optional native Swift driver

The optional native suite uses the packaged app permissions described above
and a separate Swift driver. The driver sends the shortcut and uses
Accessibility to observe TextEdit and exercise the menu. The tests open
a separate instance of Safari from `/Applications`. Use a test account with
Safari extensions disabled. A local page checks Unicode insertion in order at
the current caret, normal length limits, password-field refusal, unchanged
read-only values, and zero form submissions.

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
and final delivery to a newly focused tab when the Stop shortcut is
released. The separate GTK fixture checks delivery across fields, native
limits in single-line and multiline controls, and safe skips for password
fields and locked text. The Chromium 156 fixture checks skips when AT-SPI
editing is unavailable, confirms that field values, caret, focus, and form
submission state are preserved, and verifies the next chunk reaches an
eligible editor in another app. Put
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
