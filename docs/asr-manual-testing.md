# Browser Speech-to-Text baseline: setup and testing

## Current baseline

The playground exposes only **ReazonSpeech ja-en simulated streaming**, using sherpa-onnx 1.13.2 (epoch-35 bilingual Zipformer, int8 encoder/joiner and fp32 decoder) and Silero VAD. Its utterance policy is inspired by hayamimi. This is the current development baseline, not an irreversible production-backend decision. Removed Moonshine, two-pass, Japanese-only ReazonSpeech, and Whisper experiments remain recoverable from Git history.

The model itself is an offline recognizer. The [local ASR core](local-asr-core.md) repeatedly decodes bounded utterance snapshots to produce unstable provisional text; this is not native streaming. Provisional text may change and is cleared when an utterance finalizes. Only final text is appended to the final transcript.

| Policy | Retained behavior |
| --- | --- |
| Capture | Microphone or browser-tab audio mixed to mono and resampled to 16 kHz; no loudness gate |
| Speech detection | Silero VAD, threshold 0.5, 512-sample frames |
| Pre-roll | Up to 0.8 seconds of idle audio before speech |
| Provisional scheduling | About every 0.5 seconds of active utterance audio, excluding pre-roll |
| Endpoint | About 0.35 seconds of trailing silence |
| Maximum duration | 12 seconds excluding pre-roll; continuous speech continues in a new utterance |
| Stop | Flush capture and VAD tails, then drain finals once |
| Inference | One decode at a time; finals before coalesced latest previews |
| Backlog | Visible error and release if pending audio exceeds 30 seconds |
| Cancel | Release the audio source and both workers; discard canceled results |
| Threads | One ASR thread, based on the recorded #38 benchmark; one VAD thread |

Silero and ASR have separate workers so speech classification can continue while ASR is busy. Both reuse the pinned runtime distribution. Thread selection respects browser cores, cross-origin isolation, shared runtime memory, and the runtime's four-thread pool cap. There is no backend, language, or thread selector in the UI.

## Local setup

Requirements: Python 3, Node.js with npm, and Playwright's Chromium/WebKit browsers.

```sh
npm ci
npx playwright install chromium webkit
npm run prepare:assets
npm run serve
```

Open `http://127.0.0.1:8000`. Audio capture requires HTTPS or localhost. The page's service worker enables cross-origin isolation on the static Pages host and local server; allow the initial reload. If isolation fails, close other playground tabs and reload, or serve with COOP/COEP headers. Keep the playground in the foreground for microphone capture. Browser-tab audio continues when you switch to the shared tab.

Asset preparation checksum-verifies the epoch-35 ja-en weights and tokens at mirror revision `12b44671ff48b9aed622551d64e02fea9a2cf870`, pinned in [`scripts/reazon-ja-en-assets.json`](../scripts/reazon-ja-en-assets.json). It obtains sherpa-onnx 1.13.2 runtime files and Silero from the checksum-pinned upstream English Moonshine archive, discards its ASR weights, and replaces only the loader's preload table and data with ja-en/Silero. The runtime, wrappers, and Silero are byte-identical to those evaluated in #41. No Japanese-only ReazonSpeech archive is downloaded or staged. Only `web/vendor/sherpa-ja-en/` and its manifest are generated. Generated `web/vendor/` and `.cache/` are ignored by Git. The prepared distribution is about 91 MB. VAD uses a second worker with that same distribution, so browser memory use can be substantial. The preparation step rebuilds the generated vendor directory, removing obsolete staged assets from earlier experiments.

The existing [Pages workflow](../.github/workflows/pages.yml) prepares these assets and deploys `web/`. No server-side recognition is required, and captured audio stays in the browser. See [runtime/model notices](../web/third-party-notices.txt).

## Browser-tab audio

Select **Browser-tab audio**, load the model, and tap **Start capture**. In the
browser's native sharing picker, choose a browser tab and enable **Share tab
audio**. Desktop Chromium browsers are the initial target; mobile and browsers
without tab audio support can use **Microphone**. Selection is always performed
by the user; permission must be granted for each capture. Display capture also
requires a video track, but this application only processes audio and does not
display or record video. The picker options suggest a browser tab and exclude
system/window audio where supported. See the [Chrome sharing API documentation](https://developer.chrome.com/docs/web-platform/screen-sharing-controls).

A missing audio track or denied/canceled picker produces an actionable runtime
error and releases capture and recognition; load again to retry. Changing the
input cancels the active session and releases the model, so load again before
starting the new source. **Stop and finalize**, or stopping sharing through the
browser, flushes final audio and drains transcript results. **Cancel** discards
pending results. Tab capture continues while the playground is in the background;
closing or leaving the page releases capture and recognition.

Optional manual validation: share a tab playing speech, confirm provisional and
final text, stop sharing and confirm finalization, then repeat with a microphone.
A real meeting is not required; deterministic source/core fixtures are the
pre-merge acceptance check for Issue #49. No post-merge verification is required.

## Automated validation

```sh
npm test
npm run test:browser -- --workers=2
npm run prepare:assets
npm run test:reazon-ja-en
```

Unit tests drive the PCM-to-events core with deterministic worker fixtures (no microphone required), including readiness, lifecycle, Stop, release, stale results, and errors. They also cover resampling continuity, pre-roll, provisional scheduling/coalescing, trailing silence, maximum duration, Stop draining, buffer caps, and evidence-based thread selection. Browser tests in Chromium and WebKit exercise the real page and actual worker message/cleanup paths with controlled native initialization. They verify Load readiness for both workers, Start, provisional output, utterance finalization, Stop, Cancel, repeat, stale results, worker isolation, bounded inference, and errors. Capture tests use generated stereo Web Audio streams and the real microphone/tab pipelines, including worklet and fallback capture, flushing, permission denial, missing audio, pending permission cancellation, source end, source switching, background capture, and teardown. The tab picker API is replaced with a controlled stream fixture; these tests do not automate the native sharing picker. These deterministic tests do not establish human speech accuracy or physical-device performance.

`npm run test:reazon-ja-en` downloads the three checksum-pinned #41 fixtures to `.cache/`, serves with COOP/COEP headers, and runs real inference in Chromium and WebKit. It verifies the packaged model hashes, manifest, unchanged runtime/Silero identity, absence of obsolete bundles and selectors, provisional text, trailing-silence finalization, Stop, Cancel, reload, and repeat. Japanese, English, and mixed input must produce nonempty final text with the expected scripts through one model load, without any language switching. JSON transcripts and model identity are attached to Playwright results. Fixtures are never included in the Pages artifact. Without the command's `ASR_REAZON_JA_EN` flag, this test is explicitly skipped in the ordinary lifecycle suite.

Additional opt-in integration uses the actual pinned runtime/models and the page's utterance policy:

```sh
npm run prepare:assets
ASR_TEST_VAD=1 ASR_BENCHMARK=1 npm run test:browser -- tests/browser/model-smoke.spec.js --workers=1
# Japanese or English 16 kHz mono, 16-bit PCM WAV, kept local:
ASR_TEST_WAV=/absolute/path/speech.wav ASR_BENCHMARK=1 npm run test:browser -- tests/browser/model-smoke.spec.js --workers=1
```

The silence check verifies real Silero initialization, Stop, and repeat. `ASR_BENCHMARK=1` uses the header-enabled loopback server required by the pinned runtime in automated WebKit; the ordinary browser suite exercises service-worker isolation. The WAV check additionally requires nonempty final text. Supply speech longer than 0.5 seconds to observe provisional output; recognition accuracy depends on the fixture. Without these environment variables the real-runtime smoke test is explicitly skipped, rather than reported as passed.

The retained threading benchmark is optional:

```sh
npm run prepare:assets
npm run benchmark:reazon
```

It downloads a checksum-pinned Japanese fixture, serves COOP/COEP headers, and compares supported 1/2/4-thread configurations on provisional and whole-utterance inputs. It attaches timings and transcripts to Playwright results. The production default is unchanged: recorded [#38 evidence](evidence/reazon-38.md) did not justify a global multi-thread increase.

## Manual check and results template

1. Load the model and wait for Ready. Note initialization time and the ja-en model/thread diagnostic.
2. Start microphone capture, allow permission, and speak Japanese, English, or mixed speech. Watch microphone RMS, accepted VAD utterances, and provisional text.
3. Pause for about one second. Verify the utterance appears once as final text and provisional text clears.
4. Speak again, then Stop during speech. Verify final results drain and the microphone stops.
5. Start again and verify the old transcript resets. Cancel during capture, reload, and repeat; canceled text must not return.
6. Optionally repeat with quiet speech, Japanese with English terms, long speech, and an actual whisper recording. Track heat, responsiveness, and stability.

When signal is zero, investigate capture. Nonzero signal can be room noise. Signal with no accepted utterances suggests VAD rejection; accepted utterances without text suggest recognition failure. Errors and zero transcript counts are separate diagnostics. Quiet and whisper-like speech can be rejected by Silero even when captured correctly; no whisper-accuracy claim is made.

Record results without inferring unperformed checks:

| Field | Result |
| --- | --- |
| Commit / URL / date | |
| Device / OS / browser version | |
| Utterance / volume / recording conditions | |
| Load / first provisional / first text / Stop latency | |
| VAD utterances / transcript event counts | |
| Provisional observations / final transcript | |
| Stop / Cancel / repeat / runtime errors | |
| Accuracy / responsiveness / heat / stability | |

Human and physical-device checks are optional follow-up for Issue #45, not merge gates. No post-merge verification is required by this issue.

## Historical evidence

The [#18 publication/acceptance record](asr-acceptance.md) is historical. Earlier experimental behavior and testing instructions can be recovered from Git history. Retained evidence includes [#35 utterance handling](evidence/reazon-35.md), [#37 worker isolation](evidence/reazon-37.md), [#38 threading](evidence/reazon-38.md), and [#41 bilingual comparison](evidence/reazon-41.md). Those records describe experiments at their recorded revisions, not active backend choices.
