# ReazonSpeech ja-en retained baseline (#45)

Validated locally on 2026-10-06 (Asia/Tokyo), using Chromium 153.0.8010.12 and
WebKit 26.6 on macOS. Required post-merge verification: none.

## Retained path and model identity

The single application path now loads ReazonSpeech ja-en, using #41's epoch-35
int8 encoder/joiner, fp32 decoder, and tokens at mirror revision
`12b44671ff48b9aed622551d64e02fea9a2cf870`. Source URLs and SHA-256 pins are in
[`scripts/reazon-ja-en-assets.json`](../../scripts/reazon-ja-en-assets.json).
There is no backend, language, or thread selector. UI descriptions and the
worker's model/thread diagnostic identify ja-en. Dynamic transcript elements use
unknown language metadata (`lang=""`), allowing Japanese, English, or mixed text
without asserting Japanese-only output or inheriting the English UI language.

`ReazonSimulation`, the page controller, capture, and thread policy are unchanged:
0.8-second pre-roll, approximately 0.5-second provisional eligibility, 0.35-second
trailing silence, 12-second maximum speech duration, separate VAD/ASR workers,
one decode in flight, coalesced provisional work, a 30-second backlog cap, and the
one-thread default selected from #38's evidence.

Both workers load only `web/vendor/sherpa-ja-en/`. Asset preparation verifies all
sources before replacing generated assets and removes obsolete bundles. It never
downloads the Japanese-only ReazonSpeech archive. The sherpa-onnx 1.13.2 runtime
and Silero are obtained from the checksum-pinned upstream English Moonshine
archive (`c388d09c952557f0aeaf7a3c796d20143a2bbed7cb0fe2eca656c26dc8beb444`);
its ASR weights and tokens are discarded, and only ja-en/Silero are packaged.
This is a runtime source, not an additional recognizer or application path.

A local comparison with #41's original archive established byte-identical WASM,
ASR/VAD wrappers, Silero weights, and loader code after stripping only the preload
table. The executable ja-en test verifies these identities by hashes without
preparing the Japanese-only bundle. Generated model data has SHA-256
`900bca64640c969acdae920b4e797094a9169c5dffa780a3941e1c2659eabea7`, identical to
#41. The sole staged bundle is 90,822,540 bytes, including the scoped VAD wrapper.

## Automated validation

| Check | Result |
| --- | --- |
| `npm run prepare:assets` | Passed; runtime/model checksums verified, only ja-en/Silero staged |
| `npm test` | 15 passed, including repackaging, corrupt inputs, obsolete-bundle removal, audio, utterance policy, and thread selection |
| `npm run test:browser -- --workers=2` | 44 passed across Chromium/WebKit; 6 opt-in real-model/benchmark tests skipped without their flags |
| Updated playground/thread tests | 22 passed across Chromium/WebKit after strengthening ja-en diagnostic and language-metadata assertions |
| `npm run test:reazon-ja-en` | 2 passed; Japanese, English, and mixed fixtures through the real page in each browser |
| `ASR_TEST_VAD=1 ASR_BENCHMARK=1 npm run test:browser -- tests/browser/model-smoke.spec.js --workers=1` | 2 passed; real Silero silence, empty final text, Stop, and repeat |
| `npm run benchmark:reazon` | 2 passed; supported 1/2/4-thread ja-en inference produced equivalent transcripts in both browsers, and both recommended the retained one-thread default |
| `git diff --check` | Passed |

Ordinary browser tests exercise Load readiness for both workers, Start, provisional
output, trailing-silence and maximum-duration finalization, Stop, Cancel during
recording/Stop, reload/repeat, worker isolation during blocked inference, bounded
buffering, stale-result rejection, errors, capture resampling, and worklet flushing.

The real ja-en tests replace only the microphone source with #41's checksum-pinned
WAV samples. Actual model loading, VAD, controller, scheduler, and WASM inference
remain active. Each fixture produces provisional and nonempty final text, appended
silence finalizes before Stop, and Stop drains without duplicating the final text.
All three recordings reuse one ja-en model load without language switching. The
test then releases, reloads the same model, and cancels active English recognition.
It checks packaged model/runtime identities, the sole generated bundle, ja-en-only
asset requests, diagnostics, absence of selectors, and runtime errors.

Raw real-inference outputs are saved in
[`reazon-45-chromium.json`](reazon-45-chromium.json) and
[`reazon-45-webkit.json`](reazon-45-webkit.json). Both browsers produced identical
transcripts: Japanese script for Japanese input, Latin script for English input,
and both for the mixed fixture. These checks establish executable bilingual
pipeline behavior, without making a recognition-quality superiority claim.

## Reproduction and limits

Follow the [current setup and test commands](../asr-manual-testing.md).
Generated model assets and evaluation WAVs remain ignored; fixtures stay in
`.cache/` and are not included in Pages. Real-model tests use the existing loopback
server with COOP/COEP headers for WebKit's nested pthread workers. Ordinary browser
tests exercise the service-worker isolation path. Both workers have their own
WASM instances, so memory cost remains substantial.

No publication, Pages real-inference verification, physical-device test, or human
quality comparison was performed or required. Historical experiment evidence is
unchanged.
