# Issue #38: ReazonSpeech inference threading

**Selected default: `numThreads: 1`.** Neither 2 nor 4 threads delivered the
predefined meaningful improvement (10% lower median decode time on both inputs)
in either available browser. The largest measured reduction was 1.4%, insufficient
evidence to increase the default. The explicit configuration applies to offline,
simulated-streaming and two-pass final recognition. Model, VAD, transcript handling
and update intervals are unchanged.

## Environment and method

- Recorded 2026-10-05 UTC; Apple M4 Max, 16 host logical cores, 64 GiB RAM,
  macOS 26.6.2 (Darwin 25.6.0 arm64), Node 24.12.0, Python 3.14.7, Playwright 1.63.0.
- Headless Chromium 153.0.8010.12 exposes 16 cores; automated WebKit 26.6 exposes 8.
  Both worker environments are cross-origin isolated with shared WASM memory.
- Runtime/model: existing sherpa-onnx 1.13.2 SIMD ReazonSpeech quantized archive;
  SHA-256 `49c26de5550b2e1fec3e322b1fa909331ff027a4c0c76954f6d793102a4f4204`.
  The staged loader has `pthreadPoolSize=4`; the unchanged ASR wrapper writes
  `config.numThreads` to the native model configuration. The
  [pinned upstream build](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.2/wasm/vad-asr/CMakeLists.txt)
  specifies `-pthread -sPTHREAD_POOL_SIZE=4`, and the
  [session implementation](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.2/sherpa-onnx/csrc/session.cc)
  passes `num_threads` to ONNX Runtime intra-op configuration. We measure requested
  counts, not actual CPU utilization; accepting a configuration does not guarantee
  every operator executes in parallel.
- Deterministic audio: upstream
  [Japanese ja.wav](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ja.wav),
  mono PCM16 at 44.1 kHz, source SHA-256
  `780f95a86ba6cc33a4431fcafeacd213417dfa0a6613f93e4400c18f4dd467b0`.
  The existing `Resampler` produces 130,589 Float32 samples at 16 kHz (8.1618125 s),
  SHA-256 `6bdf88a2b99879a3f28684a78dbd3ad3854a361c511dca6ba77b497569c92c03`.
  Inputs are its first 32,000 samples (2 s provisional snapshot) and full utterance.
- One fresh real worker per count per sweep; ascending 1/2/4 followed by descending
  4/2/1. One warm-up per input/worker, three measured decodes per input/sweep:
  six measured runs plus two warm-ups per input/count/browser. Only `recognizer.decode`
  is timed; loading, audio transfer, stream creation and result extraction are excluded.
  Browsers run serially. Background host load is uncontrolled; these small differences
  should not be interpreted as a portable performance advantage.

## Recorded medians

Positive improvement means faster than one thread. Selection requires at least 10%
on **both** inputs in both tested browsers; choose the smallest eligible count,
otherwise one. This rule was set before measurement.

| Browser | Threads | 2 s decode (ms) | Improvement | Full decode (ms) | Improvement |
| --- | ---: | ---: | ---: | ---: | ---: |
| chromium | 1 | 177.66 | 0.00% | 685.88 | 0.00% |
| chromium | 2 | 175.86 | 1.01% | 679.86 | 0.88% |
| chromium | 4 | 175.18 | 1.40% | 680.79 | 0.74% |
| webkit | 1 | 166.91 | 0.00% | 660.85 | 0.00% |
| webkit | 2 | 166.78 | 0.08% | 659.62 | 0.19% |
| webkit | 4 | 166.62 | 0.17% | 658.90 | 0.30% |

All 1/2/4-thread counts loaded and decoded successfully in both header-enabled
browsers. Every measured transcript and warm-up matches exactly for each input,
across counts and browsers. No nondeterminism allowance was needed. The provisional
snapshot yields `国があなたのために何`; the full utterance yields:

`国があなたのために何ができるかを問うのではなくあなたが国のために何ができるかを問うてください`

Raw samples, warm-ups, transcripts, checksums, environment and recommendations:
[Chromium JSON](reazon-38-chromium.json), [WebKit JSON](reazon-38-webkit.json).
`npm test` independently recomputes the choice from those raw samples and verifies
the committed default. Fresh measurements report their recommendation without
altering the default automatically.

## Browser isolation and unsupported counts

The first Chromium run using the existing plain HTTP server plus isolation service
worker completed and also recommended one thread. The first real WebKit run stalled
at initialization before producing timings and was interrupted after approximately
2.7 minutes. Serving COOP/COEP headers directly resolved that setup limitation; the
final recorded runs above use those headers. The benchmark command now starts an
explicit header-enabled loopback server for repeatability. This server changes no
published assets or Pages workflow. Successful automated WebKit measurements do not
establish Pages Safari compatibility; service-worker-only initialization remains
an existing compatibility limitation observed here, even at one ONNX thread.
The default remains one, so this Issue introduces no additional threading requirement.

The selection caps requested ONNX threads by the reported browser cores and the
pinned four-thread runtime pool. Unknown core capacity, absent worker isolation or
unshared runtime memory restricts selection to one. Explicit unsupported experiment
requests produce an error before recognizer construction. The page already terminates
workers on errors. Selecting one cannot make this pthread runtime load without
its existing isolation/shared-memory requirements. The upstream fixed worker pool
itself is unchanged. There is no thread-count UI; Silero VAD still uses one thread.

## Reproduction and validation

See the [executable benchmark commands](../asr-manual-testing.md#reazonspeech-inference-threading-38).
The recorded run used a worktree-local header-enabled server on a free loopback port:

```sh
ASR_BASE_URL=http://127.0.0.1:49262 npm run benchmark:reazon
```

- Asset preparation: both existing archives passed SHA-256 verification and staging.
- `npm test`: 17 passed, including capability bounds, unsupported requests and the
  independently recomputed evidence-based default.
- Ordinary browser suite on the existing service-worker setup: 74 passed, 38 skipped
  (32 optional model tests without supplied audio, 2 opt-in timing tests and 4
  existing WebKit import-interception checks). Sixteen new configuration checks
  verify the actual worker load path in both browsers for offline, simulated and
  two-pass recognition, all requested counts, core limits and unshared memory.
- Final real timing benchmark: 2 passed (one per browser), 57.3 seconds.
- Real Japanese model smoke checks: 4 passed, 17.6 seconds. Both browsers decoded
  the full utterance through offline segmentation and completed two simulated
  recording/Stop cycles with the actual Silero VAD and ReazonSpeech runtime.
  The fixture was the same checksum-pinned `ja.wav`, converted with `Resampler`
  to 16 kHz and rounded back to PCM16 for the existing WAV test reader. It remains
  in ignored `.cache/`; original source and Float32 content are pinned above.

  ```sh
  ASR_TEST_WAV=.cache/reazon-ja-16k.wav ASR_BASE_URL=http://127.0.0.1:49262 \
    npx playwright test tests/browser/model-smoke.spec.js \
    --grep 'sherpa:|ReazonSpeech simulated' --workers=1
  ```

- JavaScript syntax checks and `git diff --check`: passed.

The benchmark JSON files are intentional, bounded validation artifacts. Large model
weights, runtime binaries and audio stay outside the committed tree. Human microphone,
physical mobile and published-site verification were not performed; these are optional
for #38. Required post-merge verification: none. No GitHub writes or publication were
performed.
