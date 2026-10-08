# Current-tab transcription Chrome extension

This desktop Chromium Manifest V3 PoC starts local transcription for the tab
on which you invoke its toolbar action. It uses the same ReazonSpeech ja-en,
Silero VAD and hayamimi utterance policy as the [Node Playground speech test page](node-playground.md). There is no
recognition server, page injection, microphone capture or tab-selection picker.

The extension uses the shared Node/Port runtime:

```text
ExtensionTab (chrome.tabCapture) → ExtensionTabAudioNode.audio
  → SpeechToTextNode.audio
    ├─ provisional → TranscriptOutputNode.provisional
    └─ final       → TranscriptOutputNode.final
```

The small extension audio adapter reuses the Web capture lifecycle and mono
16 kHz PCM contract. `TabSession` targets the invoked tab and renders the UI;
the shared speech node owns the existing ASR core and workers.

The extension keeps its own toolbar/transcript UI and packaging; it is not a Node Playground page.

Its separate **Model asset cache** options page provides an explicitly initiated,
small cache demo without starting capture or inference. See
[extension model-asset caching](extension-model-cache.md) for the lifecycle,
manifest API, storage limits and validation.

## Build and load unpacked

Requirements: Chrome 116 or later, Python 3 and Node.js/npm.

```sh
npm ci
npm run prepare:assets
npm run build:extension
```

Asset preparation downloads and verifies the existing pinned approximately
91 MB runtime/model distribution. Building copies the maintained Web pipeline,
nodes, core, workers, configuration, capture helpers, models and license notices
into `dist/chrome-extension/`. These generated files are ignored by Git. Rebuild
after source changes; reload the extension in Chrome after rebuilding.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select **`dist/chrome-extension`** (the directory
   containing the generated root `manifest.json`).
3. Pin **Local current-tab transcription** in Chrome's Extensions menu.
4. Open a normal meeting/video/audio tab and click **Transcribe this tab** in
   the toolbar. A transcript window opens, loads the models, and starts capturing
   the tab you invoked. Loading time is excluded from capture; audio played
   before the active indication is not transcribed.
5. Return to the meeting tab; keep the transcript window open. It shows the
   active state, audio-signal status, provisional text and committed final text.
6. Click **Stop / finalize** to flush capture/VAD tails and drain final decoding
   and transcript output ports before the UI reports completion.
   Copy the final text before closing the window.

**Start again** retries the selected tab and clears the previous transcript.
Each session loads fresh workers. To capture another tab, stop first, then
invoke the toolbar action on the new tab; it reuses the transcript window.
An invocation during a live session focuses its window and leaves the session
on its originally selected tab.

Tab navigation, closing the captured tab, or Chrome ending its stream finalizes
the session. Stop during model loading cancels before capture. Closing/reloading
the transcript window or unloading the extension releases media and workers,
discarding pending inference. Transcripts are held only in that window's memory.
Errors release capture and workers and leave retry available. If Chrome's
temporary tab grant has expired (for example after navigating to another origin),
invoke the toolbar action again on that tab. Chrome-internal pages and other
restricted tabs cannot be captured. A silent or muted tab may still expose a
valid audio track; the UI shows **No audio signal yet** until nonzero PCM arrives.

Chrome normally suppresses a captured tab's local playback. The extension
connects the captured source to the audio destination once to restore audible
playback; the separate ASR processor output remains muted. Only the captured
input is mixed to mono and resampled to 16 kHz using the Web helpers. Restored
playback is never an additional ASR input. See Chrome's
[tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
and [capture in a new extension window](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture#record_audio_and_video_in_a_new_tab).

## Permissions and local execution

| Manifest entry | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the specific tab where the user invokes the action; needed for `getMediaStreamId({targetTabId})`. |
| `tabCapture` | Obtain that tab's audio stream, without the Web sharing picker. |
| `script-src 'self' 'wasm-unsafe-eval'` | Execute packaged scripts and the existing local WASM runtime. |
| COOP/COEP | Isolate the extension page/workers for the pinned runtime's shared WASM memory. |

No host, `tabs`, storage, microphone or offscreen permission is requested. Basic
tab IDs and lifecycle events are available without the `tabs` permission. All
scripts and ASR weights are packaged locally; no remote code is loaded. The
cache demo reads only tiny packaged data files. Its extension options page uses
Cache Storage without adding permissions or changing the existing CSP. The toolbar
invocation grants capture authority; opening a window by itself does not grant
access to an arbitrary tab. The persistent window avoids a toolbar popup's
automatic teardown when the user returns to the meeting.

## Automated checks

```sh
npx playwright install chromium webkit
npm test
npm run test:browser
npm run prepare:assets
npm run build:extension
npm run test:extension
```

The extension tests launch isolated Chrome-for-Testing profiles, load the actual
unpacked manifest via the browser DevTools `Extensions.loadUnpacked` API, and
exercise the extension page under its real CSP. This test-only debugger flag
and profile do not change installed Chrome or the extension's permissions.
The suite includes controlled API streams with real stereo Web Audio and
AudioWorklet/fallback processing, the production ASR core with deterministic
recognition workers, the actual shared pipeline graph, lifecycle/error/resource
checks, delayed transcript delivery and disposal, and real pinned
ReazonSpeech/Silero initialization and pipeline silence finalization under MV3 CSP.
The real-toolbar test uses `Extensions.triggerAction` on a generated audio tab
with native tab capture; deterministic decoding isolates capture behavior from
speech accuracy. A native permission check verifies that opening the extension
page without invoking its action cannot capture an arbitrary tab. Unit tests
also verify normalized PCM at 16/44.1/48 kHz,
playback routing, Stop/repeat, and stale-session rejection.
See the [Issue #61 validation evidence](evidence/extension-pipeline-61.md).

An optional manual speech check can use Google Meet, YouTube or another tab:
confirm audible playback, evolving provisional text, final text after Stop,
and cleanup after closing the tab/window. This PoC does not include participant
labels, overlays, simultaneous microphone input, Web Store publication or
cross-browser extension support. No post-merge verification is required by #61.
