# Current-tab Chrome extension — Issue #53

The Manifest V3 extension's explicit toolbar action passes the invoked tab ID
to a persistent transcript window. The window loads the existing local ASR
workers, requests `chrome.tabCapture.getMediaStreamId({targetTabId})`, and
consumes that single-use ID with audio-only `getUserMedia`. There is no arbitrary
tab picker. Its only permissions are `activeTab` and `tabCapture`.

`ExtensionTab` extends the Web `BrowserAudioSource`, sharing stereo downmixing,
16 kHz resampling, worklet/fallback processing, flushing and resource cleanup.
The source connects to playback once because Chrome suppresses original tab
playback; the ASR processor output stays muted. Packaging copies the Web ASR
core, policy, configuration, workers and pinned runtime/model files unchanged.
Only the capture and window lifecycle adapter is new.

The window shows loading/active/finalizing states, audio-signal status,
provisional text, final text, errors, Start again and Stop/finalize. Stop flushes
the source before stopping the core. Tab close/navigation and the captured
track ending finalize once. Window teardown and errors release capture/workers;
generation guards reject late media and recognition callbacks. A new session
clears its transcript and loads fresh workers. Stream-specific end callbacks
avoid relying on global capture-status events that lack a session ID.

## Validation

Local checks on October 7, 2026, using pinned Playwright 1.63.0 and
Chrome-for-Testing 153.0.8010.12 on macOS:

| Check | Result |
| --- | --- |
| `npm ci` | Passed; zero reported vulnerabilities. |
| `npm run prepare:assets` | Passed; checksum-verified ReazonSpeech ja-en + Silero, approximately 90.8 MB. |
| `npm run build:extension` | Passed; produced loadable `dist/chrome-extension/`. |
| `npm test` | Passed: 67 unit tests, no failures/skips. |
| `npm run test:browser` | Passed: 88 Chromium/WebKit checks; six existing opt-in checks skipped. |
| `ASR_TEST_VAD=1 npx playwright test tests/browser/model-smoke.spec.js --workers=2` | Passed: two real-runtime Web smoke checks, including Stop/repeat. |
| `npm run test:extension` | Passed: 14 extension checks, no skips. |
| `git diff --check` | Passed. |

Unit checks cover PCM conversion at 16/44.1/48 kHz, audible-playback routing
without duplicate ASR input, source/API/no-audio failures, provisional/final
output, Stop/repeat, worker errors, model-load cancellation, late capture setup,
stale-session rejection, toolbar window reuse and byte-identical packaging.

The extension browser suite loads the actual manifest with DevTools
`Extensions.loadUnpacked` in an isolated profile. Controlled stream tests use
real stereo Web Audio, AudioWorklet/fallback processing and the production ASR
core; only capture APIs and recognition-worker outputs are fixtures. They cover
provisional output, empty-final fallback, Stop/repeat, missing audio, API/media
failures, silence status, capture-track/tab lifecycle, teardown, late capture
grants and cleanup of streams, contexts and workers.

The native action test uses `Extensions.triggerAction` on a normal HTTPS tab
with generated audible audio. Native `tabCapture` and `getUserMedia` deliver
nonzero audio without the picker. It checks provisional/final output with
deterministic workers, Stop/repeat, continued capture after returning to the tab,
navigation finalization, retargeting/reusing one window, tab-close finalization,
and absence of active capture after closing the transcript window. Another
native check verifies that an uninvoked tab is denied. The final model check
initializes the actual packaged ReazonSpeech ja-en/Silero workers under MV3 CSP
and cross-origin isolation, confirms the one-thread ja-en configuration, and
drains a silent PCM session.

Native checks caught and resolved Chrome's rejection of `blob:` in the MV3
worker policy and of mixing legacy tab-capture constraints with modern audio
constraints. Playwright's default audio-mute launch flag was removed from
capture tests because it also silences native tab-capture input. No autoplay
override, microphone permission bypass or extension permission changes are used.

The six ordinary-suite skips are the existing model smoke, bilingual speech and
thread benchmark checks in each browser. The model smoke was separately run
with real assets. This change does not alter recognition models/policy; fixture
transcripts do not establish speech accuracy. A third-party meeting, subjective
playback listening and real speech through the extension were not manually
tested; these are optional additional validation. No post-merge verification
is required by Issue #53. See the [load/test guide](../chrome-extension.md).
