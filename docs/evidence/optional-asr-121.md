# Issue #121 validation: local Parakeet v3 and Moonshine Medium Streaming

Recorded October 17, 2026. Real inference used the **production packaged MV3
extension**, the exact pinned model weights and production graph/Node/Worker/
backend. These results establish operation on speech fixtures, not better
accuracy than Zipformer, comparative WER/CER, real meeting quality or user acceptance.

## Machine and artifacts

Apple M4 Max, 16 CPU cores / 40 GPU cores, 64 GB unified memory, macOS 26.6.2.
Playwright 1.63.0 Chromium 153 headless, isolated extension origin. WebGPU adapter
reports vendor `apple`, architecture `metal-3`, including `shader-f16`. Chrome's
reduced user-agent reports Intel/10_15_7; that is not the actual machine type.
No CPU-only Parakeet fallback was tested or shipped. GPU memory was not directly
measured. Other deterministic browser checks were running during some latency
measurements; these are observations, not controlled benchmarks or device minima.

- Parakeet: `nvidia/parakeet-tdt-0.6b-v3` via the ysdede ONNX conversion at
  `f88260fa0777fe0868dda6df85d1a98f012a4a7a`, FP16 encoder/int8 decoder,
  1,257,264,588 weight/tokenizer bytes. parakeet.js 1.4.4, ORT Web **1.24.3**,
  WebGPU encoder with CPU shape operations, CPU WASM decoder, JS mel.
- Moonshine: **245M English Medium Streaming**, official
  `medium-streaming-en/quantized_26_07_30`, 304,690,919 bytes,
  official `@moonshine-ai/moonshine-wasm@0.1.5`, native architecture **5**,
  CPU WASM with the documented CSP closure adaptation; unchanged WASM binary.
- [Artifact/provenance checks](optional-asr-121-provenance.json): all 8,192 NVIDIA
  v3 tokenizer token/ID entries match the conversion vocabulary, plus one blank;
  encoder/decoder hashes match published conversion provenance/LFS; all seven
  Moonshine files match the pinned runtime catalog's sizes and CRC32C checksums.
  Full SHA-256 and 1 MiB block hashes are retained in the extension manifests. Production MV3
  cache preparation also fetched and verified the Parakeet vocabulary and
  Moonshine tokenizer/config directly from their official HTTPS origins.
- Optional executable/runtime package footprint: **40,966,142 bytes**, including
  the generated provenance manifest, separate from model weights/licenses.
  [Setup, complete pins, origin, terms, policies and limits](../optional-asr-nodes.md).

## Real standalone results

Evidence: [Parakeet events/timings](optional-asr-121-parakeet.json) and
[Moonshine events/timings](optional-asr-121-moonshine.json).

The pinned Zipformer development fixtures `test_wavs/0.wav` (6.625 s) and `1.wav`
(16.715 s) are English LibriSpeech read speech. Their hashes are checked against
`scripts/zipformer-assets.json`. Each model ran `0.wav → 1.wav → 0.wav`, with a
fresh Start and graceful Stop for each, then cancellation of a fourth session.
No production Worker/runtime was replaced. A source fixture fed original PCM into
the production normalized source/graph boundary. A loopback development mirror
populated the **production checksum-verifying cache** with exact pinned bytes;
HTTP(S) was then blocked, with **zero attempted inference-network requests**.

| Observation | Parakeet v3 | Moonshine Medium English Streaming |
| --- | --- | --- |
| Cache-only model load/ready | 3.03–3.37 s | 0.424–0.485 s |
| Feed policy | 100 ms audio blocks every 10 ms (accelerated) | 100 ms blocks paced every 100 ms |
| First useful provisional | No port/event | 1.19–1.53 s after feed began |
| First final after feed began | 1.19–2.17 s, accelerated input | 6.98–11.51 s, real-time input |
| Stop drain | 0.127–0.566 s | 0.003–0.362 s |
| Final items for the three runs | 1 / 2 / 1 | 1 / 2 / 1 |
| Provisional events for the three runs | 0 / 0 / 0 | 11 / 31 / 11 |

These timings are not comparable latency rankings because the feed policies
are different. The 12 s Parakeet cap splits `1.wav` and Stop recognizes the tail.
Moonshine emits multiple changing incomplete native hypotheses before the
corresponding final; `1.wav` also demonstrates final tail recognition on Stop.
All runs check useful English final content, unique committed IDs, no stale
preview after Stop, and termination of every owned Worker. The canceled fourth
session produces no delayed output. Identical transcripts in repeated runs are
not suppressed across sessions.

For example, both recognize the first fixture's yellow lamps / squalid quarter
passage. The full unedited texts are retained in JSON; Moonshine's longer-fixture
output also shows a misrecognition around “connect her pair / Her parent”. That
illustrates why passing a fixture check does not establish accuracy or superiority.

## Real concurrent native capture

[Native capture/concurrent evidence](optional-asr-121-native.json) uses **real
Chrome toolbar invocation and tabCapture**, restoring audible playback through
the existing capture/resampler. The graph fans normalized audio to two independent
production ASRs; both emit Live output, Moonshine final passes through TextFormatter,
and Parakeet final appends once in order to the same-tab focused textarea.

Two runs of the first pinned English WAV both passed. Each loaded exactly two
owned ASR Workers, received native audio signal, recognized meaningful final text,
completed Stop and released both Workers and all active tab captures. The field
contained the manual prefix plus Parakeet finals exactly once. Moonshine retained
real pre-final provisional recognition. No physical microphone or selected-media
hardware was used in this check.

| Concurrent native run | Load/start | Stop drain | Chrome CPU time including model startup | Largest sampled sum of Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
| 1 | 10.044 s | 1.045 s | 42.520 CPU seconds | 6,703,616 KiB (~6.39 GiB) |
| 2 | 9.340 s | 5.866 s | 53.074 CPU seconds | 9,306,720 KiB (~8.88 GiB) |

CPU is the sum of CDP Chrome-process CPU deltas. RSS samples sum the test browser's
processes before/after load, feed and drain; shared pages can be counted twice,
transient peaks can be missed, and this is not model-only or GPU memory. Browser
caches/allocators may retain memory after worker termination. The measurements do
not prove absence of all native/driver leaks in an indefinite meeting. They support
the substantial memory guidance and bounded-worker/history design; no global
model-count restriction was added. Only GETs to the loopback speech fixture site
were allowed during native capture. Audio/text never went to a remote origin.
The test also verified browser CORS access to the official Moonshine config host
**before** inference, separate from the offline recognition check.

## Deterministic validation and packaging

- `npm test`: **357 passed**, no skips. New model tests cover exact public ports,
  copy/ack/backlog ownership, FIFO/deduplication, repeated equal finals, session
  isolation, Cancel during load/audio/drain, Stop tails, quiet/hard endpoints,
  Moonshine native-line semantics and 30 s renewal, GPU preflight, runtime CSP
  patch hashes, per-path failure isolation, manifests and preparation retry.
  Existing Graph v9/default/migration, capture, cache and other-model tests pass.
- Focused packaged Graph Editor/browser checks: **33 passed** (interactions,
  model preparation and optional ASR integration). Before-Save size guidance,
  searchable independent types, parked preparation, failed-download recovery,
  unchanged persistence, reload, repeated finals, peer errors and release pass.
- `npm run test:optional-asr-real`: **3 passed**, no skips: two standalone models
  and the native concurrent check above. The standalone Moonshine check passed
  again against the final package after the cleanup-only error-handling change;
  its linked JSON records that last run. Generated evidence is linked above.
- `npm run prepare:optional-asr-assets`, `npm run build:extension` and
  `npm run prepare:optional-asr-test-models` passed checksum validation. Model
  weights remain outside the default bundle. The unchanged MV3 CSP, permissions,
  packaged executable loading and cache-only startup were exercised.

The first broad extension run had two failures: an old test expected four Models
cards instead of the new six, and a fixture copy overlapped a package rebuild
(`ENOENT`). The card expectation was updated and builds were stopped before the
final regression run. The final `npm run test:extension` run passed **150 tests**, with **11 opt-in
real-model checks skipped** by their default gates and **no failures**. This
Issue's three opt-in real-model checks passed separately above. The independent
focused field/capture suite also passed all **24 tests**.

Not run: physical microphone capture, Windows/Linux/mobile/low-memory hardware,
GPU-driver diversity, arbitrary-length meeting endurance, comparative WER/CER,
real-room/subjective quality or user acceptance. Other models' opt-in real smokes
remain opt-in in the broad suite; this Issue's three real checks ran separately.
These are device/scope limits, not pending required post-merge checks.

Required post-merge verification: **none**.
