# Concurrent Extension graph paths — Issue #115

Validated locally on 2026-10-15 with Node 24.12.0 and Playwright 1.63.0,
Chromium 153 on macOS. Graph storage remains version 8. No post-merge-only
verification is required.

## Reproduction

Prepare assets in order: `npm ci`, `npm run prepare:assets`, then
`npm run prepare:translation-assets`, `npm run prepare:whisper-assets`,
`npm run prepare:zipformer-assets`, `npm run prepare:tts-assets`, and
`npm run build:extension`. The base preparation clears `web/vendor`; running
these preparers concurrently does not produce a complete package.

Run:

```sh
npm test
npm run test:extension
npx playwright test --project=chromium tests/browser/playground.spec.js tests/browser/text-contracts.spec.js tests/browser/text-display.spec.js tests/browser/translation.spec.js tests/browser/tts.spec.js
npx playwright test --project=webkit tests/browser/playground.spec.js tests/browser/text-contracts.spec.js tests/browser/text-display.spec.js tests/browser/translation.spec.js tests/browser/tts.spec.js
CONCURRENT_SMOKE=1 npx playwright test --config playwright.extension.config.js tests/extension/graph-concurrent-smoke.spec.js
```

## Behavior covered

`tests/extension-concurrent-graph.test.js` and `tests/extension.test.js` cover
large saved drafts (103 Nodes / 103 edges, positions beyond 4000), incomplete
correlated bundles, malformed wiring, active-path selection, TEXT-only paths,
parked models/sources/processors/outputs, same-type ASRs, independent duration
settings, fan-out, source completion, shared formatters, cancellation and late
microphone grants. Existing model/translation/TTS/default/migration regression
tests continue to exercise their production Node implementations.

`graph-concurrent.spec.js` loads the packaged MV3 Extension in Chromium. It
uses production capture, normalization, graph assembly, session lifecycle and
Worker protocols, with synthesized MediaStreams and fixture ASR responses.
The tab and mic feed distinct ReazonSpeech/Whisper paths and Live displays.
Tab end releases its Workers while mic stays live; Stop/Cancel/repeat release
all streams, AudioContexts and Workers. Parked mic/TTS/ASR Nodes stay saved
without permission requests or allocation. A second test exercises the actual
warning preference, persistence, explicit validation, saving/reloading an
unrunnable draft, and Start without capture or Workers.

The concurrent test in `targets.spec.js` uses native toolbar invocation,
`chrome.tabCapture`, the browser microphone permission setting and Chromium's
fake microphone device, without replacing getUserMedia or the capture Nodes.
Three same-type ReazonSpeech processors feed separate displays: two tab Source
Nodes share one native capture, while a microphone Source stays independent. Tab navigation
finalizes its display and releases its models while the mic track and models
remain live. Stop, Cancel and repeat release all tracks and Workers. Model
inference is a fixture in this test. No physical microphone is required.

WebKit's three existing microphone permission fixtures initially lost their
instance-level getUserMedia overrides when the MediaDevices wrapper was garbage
collected. A pending-permission failure also reproduced using the upstream
Pipeline. These fixtures now retain that wrapper, following the existing
fakeMicrophone helper's approach; application permission behavior is unchanged.

## Real concurrent models and measured limits

[Raw measurements](graph-115-concurrent.json) come from two consecutive sessions
with the real packaged Zipformer English model and Whisper tiny q8 plus Silero.
Both process the pinned 16 kHz `zipformer-en/test_wavs/0.wav` (6.625 seconds),
fed in 100 ms chunks at real-time pace to independent source ports. Capture
hardware and the microphone grant are fixtures in this inference test. Both
independent displays contain the expected “yellow lamps” text. Stop drains
both; repeat and Cancel release all three model Workers. No HTTP requests or
page errors occurred during loading/inference.

| Measurement | Session 1 | Session 2 |
| --- | ---: | ---: |
| Load both models | 2.375 s | 2.490 s |
| First Zipformer text from feed start | 2.398 s | 2.388 s |
| First Whisper text from feed start | 8.759 s | 8.767 s |
| Stop drain | 3.322 s | 4.672 s |
| Feed + drain elapsed | 12.769 s | 13.387 s |
| Chrome process CPU time during feed/drain | 7.705 CPU s | 16.192 CPU s |
| Largest sampled sum of Chrome process RSS | 2,345,696 KiB | 2,955,792 KiB |

CPU time covers the smoke browser's processes, including its UI pages and model
Workers, from after load through Stop/disposal. RSS is sampled after loading,
after feeding and after draining; it is a process sum, may count shared pages
twice, and is neither model-only memory nor a measured peak. The final inference
measurement ran after the other test processes completed; background host load
can still affect timings. The second sampled RSS sum was higher; these two
sessions do not establish a long-run memory plateau. These are local
observations, not cross-device performance guarantees. Whisper emitted
an extra “Thank you.” on the short final tail; output routing does not eliminate
model hallucinations. Its completed-segment output arrives after the audio;
concurrent processing does not promise real-time Whisper latency.

Meeting tab audio can already contain local speech, and microphones can pick up
speaker playback. Separate paths/displays do not establish speaker isolation or
echo suppression. Physical-device acoustics and meeting-site behavior were not
manually tested. Existing concrete ASR queue/duration/model bounds remain;
resource exhaustion still fails visibly instead of silently dropping audio.

## Check results

- `npm test`: **329 passed**.
- Selected Chromium browser regression tests: **50 passed**; the nine playground
  cases also passed again after stabilizing their permission mocks.
- The same selected WebKit browser regression tests: **50 passed** after retaining
  the MediaDevices wrappers. The initial three fixture failures and the upstream
  reproduction are described above.
- `npm run test:extension`: the complete 142-case sweep produced **130 passes,
  seven opt-in skips and five failures of old status-text assertions**. The
  assertions were updated for Node-attributed signals/progress and target labels;
  all five passed on a rebuilt package using `--last-failed`.
- A further rebuilt-package run of `graph-concurrent.spec.js`,
  `graph-number.spec.js`, `graph-whisper.spec.js` and `layout.spec.js`: **16 passed**,
  including the new no-toolbar TEXT-only Start case.
- Native concurrent capture with repeated tab Sources: **passed**, including
  navigation, Stop, Cancel and repeat with independent microphone lifetime.
- `CONCURRENT_SMOKE=1` real packaged Zipformer + Whisper: **passed**, two sessions
  plus Cancel, three Workers released, no HTTP requests/page errors.
- Final branch-start synchronization is covered by the unit test for source end
  during held model preload. The final rebuilt-package concurrent/draft/text-only
  rerun passed **all three cases**, and the native concurrent capture rerun
  **passed**.
- `npm run build:extension` and `git diff --check`: **passed**.

The seven opt-in cases not run in the complete sweep were the two real TTS
engines, standalone Whisper language smoke, standalone Zipformer smoke, real
ASR-to-field smoke and two real translation directions. Concurrent real Whisper
and Zipformer were exercised separately as recorded above. No physical-microphone
or acoustic speaker-isolation check was performed; none is claimed.
