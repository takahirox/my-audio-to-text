# Browser-tab audio capture — Issue #49

Implemented a microphone/browser-tab input selector and `BrowserTab` capture
using `navigator.mediaDevices.getDisplayMedia()` directly from the Start gesture.
The native picker owns selection and permissions. Audio is requested alongside
required video; only audio enters the shared Web Audio capture pipeline. Video
is neither displayed nor recorded. Picker hints suggest browser tabs and exclude
system/window audio where supported. The application targets desktop Chromium
tab sharing and gives actionable errors for unavailable capture, denied/canceled
sharing and missing audio tracks.

Both sources mix to mono, resample to 16 kHz Float32Array blocks, and use the
existing `LocalAsrCore.push()` path. The core, ASR/VAD workers, model and policy
configuration remain unchanged. Stop flushes worklet and resampler tails before
stopping the core. Sharing ending on either track finalizes recognition, including
during capture setup. Cancel, switching input, errors and page teardown discard
pending work and release tracks, nodes, contexts and workers. Late permission or
worklet initialization cannot resurrect a canceled source. Tab capture continues
when the playground loses focus; microphone stop-on-hide behavior is retained.

## Validation

Local checks on October 6, 2026:

| Check | Result |
| --- | --- |
| `npm ci` | Passed; pinned dependencies installed, zero reported vulnerabilities. |
| `npm test` | Passed: 38 tests, zero failures/skips. |
| `npm run test:browser -- --workers=2` | Passed: 80 tests in Chromium/WebKit; six existing opt-in checks skipped. |
| `git diff --check` | Passed. |

`tests/browser-audio.test.js` runs the production capture worklet with controlled
browser/worker fixtures. Stereo input at 16, 44.1 and 48 kHz reaches the unchanged
core and produces provisional/final events. Final decode audio includes the
worklet's short block and resampler's tail. It also covers fallback stereo mixing,
unchanged microphone constraints, cancellation during permission/worklet setup,
sharing end during setup, Cancel during a held Stop, and worklet setup errors.

`tests/browser/tab-audio.spec.js` runs the real page, Web Audio, worklet/fallback
and ASR core with generated stereo streams and controlled recognition workers.
It verifies picker options and user activation, normalized Float32 PCM, transcript
events, Stop/repeat, missing audio, permission denial/cancellation, unsupported
APIs, both track-ending paths, pending-picker Cancel/source-switch/teardown,
active-source switch/error/teardown, background capture, sharing end during
worklet setup, late grants after reload, and worklet flush failure. Cleanup
assertions include both tracks, capture/producer contexts and workers. Existing
microphone, worker, model configuration and core tests continue to pass.

The six skipped checks are the existing real-model smoke, bilingual model and
thread benchmark tests in each browser. Recognition/model behavior was not
changed. Fixture transcripts demonstrate the capture/core contract, not speech
accuracy. Native sharing picker interaction, a real playback tab and a
third-party meeting were not manually tested; these are optional validation.
Mocked `getDisplayMedia` in WebKit validates lifecycle portability, not native
WebKit tab-audio support. No post-merge verification is required by Issue #49.
