# Browser Speech-to-Text manual comparison

This disposable playground supplies the implementation portion of [Issue #18](https://github.com/takahirox/my-audio-to-text/issues/18).
It does not select a production backend. Record human observations before a separate selection issue.

## ReazonSpeech inference threading (#38)

The ReazonSpeech thread count is explicit in `web/reazon-config.js` and shared by
offline, simulated-streaming and two-pass final recognition. The selected count
and measurements are recorded in [the threading evidence](evidence/reazon-38.md).
The worker emits a `configuration` diagnostic containing the actual `numThreads`.
There is no page control for threading; Silero VAD retains its existing one thread.
Selection respects `navigator.hardwareConcurrency`, worker isolation, shared WASM
memory and the pinned runtime's four-thread pool. Unknown core capacity selects one.
An explicit unsupported benchmark request fails before constructing a recognizer.
The existing runtime itself still requires browser isolation/shared memory to load;
selecting one ONNX thread does not make that runtime compatible with an unisolated page.

Reproduce the comparison on an otherwise idle machine:

```sh
npm ci
npx playwright install chromium webkit
npm run prepare:assets
npm run benchmark:reazon
```

The benchmark starts a loopback server with COOP/COEP response headers. This is
needed for WebKit's nested pthread workers in the available automated environment;
service-worker-only isolation stalled its real runtime before inference. This
measurement server does not alter Pages deployment. See the evidence for the
compatibility limitation; a passing header-enabled run does not verify Pages Safari.

The command verifies and caches the upstream Japanese `ja.wav` by SHA-256, converts
44.1 kHz mono PCM16 to 16 kHz using the playground's existing deterministic resampler,
and tests both the first two seconds (provisional snapshot) and the full utterance.
It uses fresh instances of the actual pinned browser worker/model for 1, 2 and 4
threads where supported, in ascending then descending order. Each instance has one
warm-up per input followed by three measured runs per input, giving six measured
runs per input/count. Decode timing excludes initialization, transfer, stream creation
and result extraction. Tests require exact transcript equality across all measured
runs and warm-ups and nonempty Japanese output for the full utterance.

Playwright writes a `reazon-threads.json` attachment under `test-results/` for each
browser, including the environment, source/model checksums, timings, transcripts,
unsupported/failed counts and recommendation. The selection rule is fixed before
measurement: the smallest supported count with at least 10% lower median decode time
on **both** inputs, otherwise one. The committed default must meet that rule in both
tested browsers; a fresh benchmark reports a recommendation and does not rewrite it.
Record new results before revising the default. This experiment changes no VAD policy,
model, segmentation, transcript handling or provisional interval.

Use `npm test` and `npm run test:browser` for configuration and behavior checks.
The real timing experiment is opt-in to keep ordinary tests independent of model
downloads and machine performance. If port 8000 is occupied, run
`python3 scripts/serve-reazon-benchmark.py --port 8001` and set
`ASR_BASE_URL=http://127.0.0.1:8001` for the benchmark. For ordinary behavior tests,
`npm run serve` retains the existing service-worker isolation setup. A desktop/mobile
microphone comparison is optional; required
post-merge verification: none.

## Open the playground

The Pages URL is **https://takahirox.github.io/my-audio-to-text/**. The reviewed PR #20 commit
`6888cca542e3d9131d727f9b40f0f2c96e65d6a1` is published by successful
[run 36933623325](https://github.com/takahirox/my-audio-to-text/actions/runs/36933623325).
The live page, runtime scripts, and manifest matched the reviewed files, and all three real models reached Ready in automated Chromium on 2026-10-02 JST. This does not verify human microphone or recognition acceptance; see
[publication evidence and pending human acceptance](asr-acceptance.md).
In repository Settings → Pages, select **GitHub Actions** as the source. The workflow stages
the pinned runtime assets and deploys `web/` on pushes to `main` or an explicit manual dispatch.
PR #20 was published from its reviewed branch before merge. The maintainer subsequently waived the human-test merge gate; see the acceptance decision below. Publication and real-device acceptance are tracked in
[#21](https://github.com/takahirox/my-audio-to-text/issues/21). The maintainer accepts the implemented comparison environment for #18, with later defects handled in separate Issues. Physical-device ASR compatibility remains unverified. The older
[#17](https://github.com/takahirox/my-audio-to-text/issues/17) covers the static placeholder from #15,
not the three-backend ASR environment.
Do not interpret the documented URL as evidence that deployment succeeded.

### Historical #18/#21 publication procedure

This procedure records the earlier PR #20 acceptance deployment. Issue #25 requires
compatibility with the existing Pages build/deploy workflow, not publication before merge.

1. The PR branch must contain this revised workflow and the reviewed code. A local checkpoint
   is not available to GitHub Actions until the publication step updates the branch. Confirm
   the PR head SHA before deployment. This fix node does not push or merge.
2. In **Settings → Environments → github-pages → Deployment branches and tags**, retain `main`
   and allow the exact branch `codex/issue-18-browser-asr-pocs` for this acceptance deployment.
   Keep the environment's other protections. This exact branch permission was added on
   2026-10-02 JST, retaining `main`; changing the workflow alone does not authorize a branch.
3. Run the existing Pages workflow with the PR branch selected in Actions, or use:

   ```sh
   gh workflow run pages.yml --repo takahirox/my-audio-to-text --ref codex/issue-18-browser-asr-pocs
   ```

   The workflow already exists on the default branch with `workflow_dispatch`; the selected
   branch supplies the workflow revision for this run. See GitHub's
   [manual dispatch instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
   and [Pages deployment requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
   This deploys to the canonical Pages URL, replacing the placeholder, rather than creating a
   separate preview URL. No pull-request event automatically deploys code.
4. Wait for both build and deploy to succeed. Record the run URL, its head SHA, the HTTPS URL,
   and check time in #21. Confirm that the page title is **Japanese Speech-to-Text playground**,
   the selector contains all three candidates, and `vendor/manifest.json` plus the staged
   Moonshine and sherpa files load successfully. A successful placeholder deployment is insufficient.
5. Run the human test procedure below on desktop Chromium and physical iPhone Safari against
   this deployment. Record each candidate's load, microphone capture, Japanese output, Stop,
   repeat, and switching results; test Android when available, otherwise mark it not tested.
   Record missing results as not tested; the maintainer waived these as merge prerequisites.
6. After acceptance and review, merge may proceed in the normal repository workflow. The push
   to `main` redeploys the same environment. Remove the temporary PR-branch permission once
   it is no longer needed.

The reviewed branch was published before merge. The maintainer has now chosen to proceed assuming it works and to track later defects in separate Issues. Human tests below remain useful for comparison and backend selection, but are no longer a prerequisite to merging PR #20 or completing #18/#21. No human microphone or physical-device ASR test has been claimed as passing.

Publication evidence and the explicit acceptance decision are recorded in [ASR acceptance status](asr-acceptance.md). Selecting a production backend still requires a separate decision; this change selects none.

For local desktop development (Python 3.12+):

```sh
python3 scripts/prepare-assets.py
python3 -m http.server 8000 --directory web --bind 127.0.0.1
```

Open http://localhost:8000/. No application build or npm install is needed to serve it.
The preparation script downloads about 150 MB of compressed distributions, verifies SHA-256
checksums, and stages about 197 MB in ignored `web/vendor/`. These files must be included in
the served directory and Pages artifact; copying only tracked files will not load the models.
The script uses `.cache/` on subsequent runs. A corrupt cached archive fails visibly; remove
that archive before retrying. Whisper's runtime and model are downloaded by the browser.

For a phone, use the published **HTTPS** Pages site, or serve the same prepared directory through
a trusted HTTPS development server reachable by the phone. Plain HTTP at a LAN IP is not a
secure microphone origin; the desktop's `localhost` does not refer to the desktop from a phone.

The page enables cross-origin isolation using a small service worker because Pages cannot set
COOP/COEP headers. The first visit reloads once to activate it. The worker adds headers only:
it does not cache audio, implement offline installation, or create a PWA. On a custom server,
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
on HTML and worker scripts avoid the bootstrap reload. If isolation fails, the page reports
the error. Close other playground tabs and reload; private browsing or a managed browser may
restrict service workers or model caches.

## Candidates and observable differences

| Candidate | Pinned configuration | What the page shows |
| --- | --- | --- |
| Moonshine Voice | `@moonshine-ai/moonshine-wasm` 0.1.5, Japanese/English Small Streaming, native `Stream` API; official v0.1.5 release WASM runtime | Incremental partials and completed lines emitted by the runtime; native speech detection |
| sherpa-onnx | 1.13.2 SIMD WASM, quantized Japanese ReazonSpeech Zipformer 2024-08-01 | Segment finals; no native partials |
| sherpa-onnx (simulated streaming) | Same offline ReazonSpeech model/runtime and 16 kHz mono capture | Unstable utterance previews; Silero VAD pause/12-second finals and active speech flushed on Stop |
| Whisper | Transformers.js 3.8.1, `Xenova/whisper-tiny` multilingual q8, revision `5332fcc35e32a33b86612b9a57a89be7906102b1`, WASM CPU, one thread | Segment finals; no native partials |
| Moonshine + ReazonSpeech | Existing Japanese Small Streaming and Japanese ReazonSpeech configurations | Moonshine streaming text; ReazonSpeech final only after Stop |

### ReazonSpeech simulated-streaming comparison (#33)

Select **sherpa-onnx — Japanese ReazonSpeech (simulated streaming)** and load the model.
[Issue #35](https://github.com/takahirox/my-audio-to-text/issues/35) replaces #33's fixed
10-second windows with the focused utterance policy inspired by
[hayamimi](https://github.com/oboroge0/hayamimi). The ReazonSpeech model, recognizer
configuration and WASM runtime are unchanged. The original offline option retains its
pause/20-second/Stop policy and does not initialize VAD.

Silero VAD and its ONNX model are already included in the checksum-pinned sherpa 1.13.2
WASM distribution. Asset preparation now stages its small JavaScript wrapper and scopes
its helpers to avoid overwriting ASR's `freeConfig`. No additional runtime or model
download is needed. The VAD model's MIT notice is included with the existing notices.

At 16 kHz mono, Silero classifies 512-sample (32 ms) frames at threshold 0.5. The worker
retains fewer than 512 samples between microphone callbacks. Stop pads the last short
frame only for classification; ASR receives its original samples, without padding.
Silero uses minimal onset/offset hold times (one sample), with its built-in hysteresis:
onset and offset decisions can lag by a frame. The page implements the utterance policy:

- Keep at most 12,800 samples (0.8 seconds) of idle pre-roll. On speech onset, prepend
  the available pre-roll to the utterance. Silence alone never creates an utterance.
- While speaking, make a cumulative preview eligible after each additional 8,000
  samples (0.5 seconds) from onset, excluding pre-roll. At 32 ms frame resolution the
  first opportunity is normally 0.512 seconds after detection. Provisional text is
  explicitly labeled unstable, replaces earlier text, and may change with more context.
- Finalize after 5,600 samples (0.35 seconds) classified as trailing silence, including
  that audio in the final. Detection has 32 ms resolution plus Silero's offset latency;
  this is approximately 0.4 seconds after a clear pause, before ASR inference time.
- Force-finalize 192,000 samples (12 seconds) after onset, excluding pre-roll. Split an
  input frame exactly when necessary. A continuing utterance starts at the next sample,
  with no repeated pre-roll, so forced boundaries lose or duplicate no audio.

Only one ReazonSpeech decode is in flight. There is no queue of previews: inference
completion uses the latest eligible active snapshot, and completed utterances take
priority. A result from a preview of an ended utterance cannot repopulate the provisional
transcript. Finals use the complete utterance, including its pre-roll and trailing audio;
a final is at most 12.8 seconds. Pre-roll after a committed endpoint contains only new
idle audio, avoiding overlap with the preceding final.

VAD and synchronous offline ASR run sequentially in the same worker. This keeps the
existing WASM/model allocation and keeps inference off the UI thread. Slow inference
also delays VAD processing; the interval is an audio eligibility policy, not a guarantee
of visible wall-clock updates. Pending VAD audio, active utterances, pending finals, and
the final in flight share a 30-second cap. The bounded idle pre-roll and one provisional
snapshot (at most 12.8 seconds) are additional. Exceeding the cap reports an error, stops
capture, and terminates the worker. Native VAD segment storage is flushed/cleared after
each frame, without resetting Silero's recurrent/threshold state; the page owns ASR audio.

**Stop** flushes the microphone and VAD tails, waits for in-flight decoding, and commits
all completed and active utterances. Idle pre-roll is discarded. Start remains disabled
until this drains. **Cancel** terminates the worker, discards pending audio, and clears
the experiment's transcripts. Repeat resets VAD/buffers/session state. Backend switching
releases the worker. Session checks reject stale VAD, transcript, and completion messages.

Run deterministic unit and Chromium/WebKit coverage without model downloads:

```sh
npm ci
npm test
npm run test:browser -- --workers=2
```

Policy tests compare every final sample across arbitrary 2,048-sample boundaries and
verify silence, available pre-roll, preview eligibility/coalescing, pause reset/endpoints,
12-second finals, exact boundary continuity, Stop, and the backlog limit. Browser tests
exercise the actual worker with controlled Silero/recognizer fixtures, including VAD frame
and Stop tails, stale ended previews, Cancel/reload/repeat/switching, empty recognition,
stream cleanup/errors, and unchanged offline segmentation. The existing suite checks
Moonshine, two-pass, Whisper, and actual Web Audio capture/resampling.

Opt-in checks use the pinned real runtime, with generated silence or a supplied Japanese
16 kHz mono PCM WAV. Run asset staging first:

```sh
npm run prepare:assets
ASR_TEST_VAD=1 npm run test:browser -- tests/browser/model-smoke.spec.js --grep 'ReazonSpeech simulated'
ASR_TEST_WAV=/absolute/path/japanese.wav npm run test:browser -- tests/browser/model-smoke.spec.js --grep 'ReazonSpeech simulated'
```

The silence check verifies actual Silero initialization, frame processing, Stop/repeat,
no committed silence, and no runtime errors. The WAV check also expects Japanese final
text. Neither is a subjective accuracy comparison. Optional manual comparison can record
first-preview latency, update frequency, clipped beginnings, pause latency, offline versus
simulated recognition, long speech behavior, responsiveness, and thermal behavior.
No post-merge verification is required for #35.

### Japanese two-pass experiment (#31)

Select **Moonshine + ReazonSpeech — two-pass Japanese**, then **Load model**. Start becomes
available after both existing models finish loading. Language is fixed to Japanese; Moonshine
keeps its Japanese Small Streaming release, `max_tokens_per_second=13`, and existing speech
detection threshold choices.

During recording, **Moonshine streaming transcript (first pass)** shows the active partial and
preserves completed Moonshine lines. Every resampled 16 kHz mono microphone block is copied
before transfer to Moonshine, including quiet samples and the capture worklet's Stop flush.
ReazonSpeech receives no recording audio and runs no inference before Stop.

**Stop and finalize** releases microphone capture and closes the Moonshine stream, then sends
the whole retained recording once to the existing sherpa-onnx/ReazonSpeech recognizer. This
path bypasses its live pause/20-second segmentation. **ReazonSpeech final transcript (second
pass)** is the final experiment result, separate from Moonshine's completed lines. The existing
**Stop to all final results** metric includes microphone flushing and both passes' finalization.
An empty recording or a decode producing no text leaves the final transcript empty.

Start resets both transcripts and retained audio for a repeat. Loaded models remain available
for repeated recordings; per-recording recognition streams are closed/freed after Stop. Cancel
clears the two-pass results and audio, stops capture, and terminates both model workers.
Switching backends or Moonshine threshold releases both workers; during recording/finalization,
use Cancel before switching. Recording session IDs and worker identity checks discard stale
events after repeat, Cancel, or switching. Backgrounding uses the existing Stop behavior.

Both models coexist in memory, and the complete utterance is retained until Stop, so use short
utterances for this experiment, especially on phones. Audio remains local. No model, VAD,
token-rate, or transcript-selection tuning is introduced.

Automated acceptance uses controlled workers with the real microphone/resampling/transfer
paths in Chromium and WebKit; [the validation record](evidence/two-pass-31.md) lists coverage
and limits. For optional real inference, stage assets and supply a Japanese 16 kHz mono PCM16
WAV:

```sh
npm ci
npm run prepare:assets
ASR_TEST_WAV=/absolute/path/japanese.wav npm run test:browser -- --grep 'two-pass: real Japanese'
```

This opt-in check loads both real backends, feeds the same WAV to Moonshine in blocks and
ReazonSpeech as one utterance after Moonshine Stop, and requires Japanese text from both plus
Moonshine partial/speech events. It does not assert subjective accuracy improvement. Optional
manual comparison can record both texts and Stop latency for the same spoken Japanese utterance.
Issue #31 requires no post-merge verification or human accuracy judgment.

**Moonshine configuration for #25:** the latest npm package is still
`@moonshine-ai/moonshine-wasm` 0.1.5, but its WASM binary predates Japanese streaming
and fails to load the current split-frontend models. The playground stages the official
[v0.1.5 release](https://github.com/moonshine-ai/moonshine/releases/tag/v0.1.5)
`moonshine-voice-wasm.tar.gz` instead, from source commit
`234f60faa0eb388b01cdf7e60aca232af37aefda`. This release includes the same 0.1.5 JS API
and a newer, compatible WASM binary. Do not substitute the npm archive based on version
number alone. The preparation script verifies archive SHA-256
`c515bf7691e12048f70a92cc82b3b0894c16c3773ffcacb7d48944fb150e4837`;
release `moonshine.wasm` SHA-256 is
`22fca4a5b2dc50fe36dc68e4d25fab73b0250b71f744d9fea511c3a308b2420a`.
Runtime: CPU WebAssembly with SIMD and threads, requiring cross-origin isolation.

Both language choices use `ModelArch.SmallStreaming` (numeric value `4`):

- Japanese (default): `https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/`
- English: `https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/`

`web/moonshine-config.js` pins the eight canonical filenames and dated release URLs
from the [upstream model catalog](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/core/moonshine-model-catalog.cpp).
`Transcriber.loadFromUrls` loads them through the supported in-memory file-map API,
with native partial/final events. The dated model URLs identify the tested releases;
model bytes are fetched and cached by the upstream downloader, without local checksum
verification. Load failures name the intended configuration and stop; there is no fallback.
Japanese and English streaming models are MIT under the [upstream license](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/LICENSE).

**Language evaluation:** Japanese and English are separate monolingual models. This API
does not provide automatic language detection, so no Auto option is shown. The control
applies only to Moonshine; the other candidates retain their Japanese configuration.
Changing language or VAD threshold releases the loaded model and requires Load again;
both controls are locked during capture/finalization. Test mixed Japanese/English speech
in both models, rather than assuming either routes languages automatically.

**Quiet/whisper diagnosis:** the meter remains live; numeric RMS dBFS and session peak
RMS reveal signals too small to see on the meter. A nonzero signal can be room noise,
not necessarily usable speech. Native `onLineStarted` and `onLineCompleted` report
accepted VAD segments independently of nonempty ASR text. Segment counts and nonempty
partial/final counts remain visible after Stop and reset at the next Start. These are
segment events reported on transcription passes, not instantaneous VAD probabilities.
Use a several-second utterance, Stop, and wait for Stopped and a drained queue:

1. No captured frames or zero signal: inspect microphone permission/device/capture.
2. Nonzero signal, zero native VAD segments: speech detection did not accept a segment.
3. Accepted segments, zero nonempty transcript events: the recognizer emitted no useful text.
4. Text events: inspect the actual partial/final text for recognition errors.

Runtime errors take precedence over these interpretations. The UI reports them separately;
a failed transcription pass may prevent segment events from reaching the page.
The minimum sensitivity control forwards native `vad_threshold`: default `0.5` or
more sensitive `0.2`. Lowering it may accept noise and does not guarantee whisper recognition.
Japanese recognition passes `max_tokens_per_second=13` (as the string `'13'` in the
runtime options map), following the upstream recommendation for non-Latin languages
in [Issue #29](https://github.com/takahirox/my-audio-to-text/issues/29). English leaves
this option unset and uses the upstream default. The model description displays the
selected token-rate setting. The Small Streaming models and pinned v0.1.5 runtime are
unchanged. Keep other settings at upstream defaults, including the 0.5-second VAD
averaging window.
See [native options](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/docs/api/options.md).

Issue #29 now specifies required post-merge verification as **None**. The previously
listed Pages deployment and published-revision/Japanese-model checks were not performed
and are no longer acceptance requirements for #29. Local build and test results do not
establish those published-site results.

**ReazonSpeech is non-streaming.** Both ReazonSpeech and Whisper receive the same 16 kHz mono
capture and simple segmentation: decode after 0.8 seconds of low audio energy following speech,
at 20 seconds of audio, or when Stop flushes the remaining audio. This gives useful live segment
results without pretending either model supports native streaming partials. Quiet audio is retained
even below the energy threshold; it still decodes at the duration limit or Stop. Segmentation can
split a word or mistake room noise for speech and should be considered when comparing results.
The 20-second limit also stays below ReazonSpeech's documented roughly 30-second input limit.

All inference runs in workers, away from the page's UI. All candidates use the same mono microphone
capture with echo cancellation, noise suppression, and automatic gain requested off (a device may
ignore constraints), a worklet with a ScriptProcessor fallback, and continuous resampling from the
device's actual sample rate. The microphone meter shows capture even while recognition is busy.
If the backend accumulates over 30 seconds of unprocessed audio, capture stops with an explicit
error to prevent an unbounded queue. Switching or Cancel terminates the model worker and releases
capture. Leaving the foreground stops and finalizes a recording where the browser permits it.

## Optional human test procedure

For #25, human speech and physical-device testing are optional follow-up validation.
Use this procedure to record observations when a tester and deployment are available.

1. Use one foreground tab and one backend at a time. Plug in the phone if necessary and start on Wi-Fi.
2. Select a backend and tap **Load model**. Wait for **Ready**. Note first-load progress and initialization
   time; it includes runtime download, model download, and construction. Model/browser caching can
   make later loads faster, so label runs as first load or repeat. The UI shows progress reported by
   the upstream runtime, not a complete network byte benchmark.
3. Tap **Start microphone**, grant permission, and check that the meter responds. Speak the utterance
   displayed in the text box. Keep distance, volume, room, and utterance consistent between candidates.
4. For Moonshine, record language/model and VAD threshold, the numeric microphone level, accepted/completed VAD segment counts, and nonempty partial/final counts. Pause for about one second. Observe incremental partials (Moonshine), segment finals, and responsiveness.
   Tap **Stop and finalize** and wait for **Stopped**. The microphone is released immediately while pending
   inference finishes. **Cancel / release model** abandons pending inference if necessary.
5. Copy results and timings into the template below before changing backend. The utterance text is kept
   when switching; recognition results are cleared. Nothing is persisted by this page. Tap Start again
   to repeat with the same loaded model, or switch and load the next one.
6. Repeat with ordinary dictation, names/technical terms, quiet speech, and a 30–60 second utterance.
   Observe delays, missing text, heat, responsiveness, and instability. Use Cancel if finalization stalls.
7. Repeat on a real iPhone Safari, desktop Chrome/Chromium, and Android Chrome if available. Record actual
   OS/browser versions and failures. Automated WebKit checks do not establish real iPhone compatibility.

Timing labels are deliberately precise: first partial/text are measured from the first captured
audio block, not the acoustic start of speech. Stop latency measures from tapping Stop until all
queued results are finalized; it includes any recognition backlog. It is not an automatic
silence-to-final latency measurement. Unsupported partials show explicitly as unsupported.

## Results to carry into a separate backend-selection issue

Copy one row per utterance and candidate. Use `not tested` instead of inferring device support.

For each test session, record the tester, test time, HTTPS URL, deployment run URL, and
deployed commit SHA. Use the deployment's SHA, rather than a later documentation-only PR
head. Record whether an Android device was available; if it was not tested, say so explicitly.
Include partial transcript observations for Moonshine and mark partials unsupported for the
other candidates. For Stop, note whether the microphone was released and finalization reached
**Stopped**, alongside its latency. For repeat and switching, record the observed outcome,
including the next backend, rather than leaving success implicit in a transcript. For Moonshine, also record the selected language/model release and VAD threshold, numeric signal/peak RMS, accepted/completed speech segment counts, and nonempty partial/final counts. These distinguish capture, detection, and ASR failures.

| Date / device / OS / browser | Backend / first or repeat load | Utterance / volume | Permission and meter | Init (s) | First partial / text (s) | Stop outcome / latency (s) | Partial / final transcript | Repeat outcome | Switch to / outcome | Accuracy, responsiveness, heat, stability, errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

Suggested samples (edit the on-page utterance as needed):

- Ordinary Japanese: `今日は東京で音声認識を試しています。明日の午後三時に会議を予約してください。`
- Japanese with English terms: `GitHub の API を JavaScript で呼び出します。WebAssembly と OpenAI を試します。` Record each term as preserved in Latin spelling, transliterated, wrong, or missing under both language choices.
- English only: `Use the GitHub API with JavaScript, WebAssembly, and OpenAI.` Test English and Japanese models explicitly.
- Quiet speech: repeat the ordinary sample softly at the same microphone distance, first at threshold 0.5, then 0.2.
- Whisper-like speech: repeat the ordinary sample with whisper-like phonation at the same distance, with both thresholds. Reducing a recording's amplitude is a quiet-signal proxy and does not reproduce whisper phonation.
- Longer speech: dictate a paragraph for 30–60 seconds, with and without pauses.

For #25, these five conditions are **optional follow-up validation**, under the updated Issue acceptance criteria. When testing, record the deployed commit, device/browser, microphone signal, VAD segments, partial/final text, obvious errors, first/repeat load time, and responsiveness. [Moonshine #25 evidence](#moonshine-25-validation) records agent-verifiable integration and diagnostics checks. Actual whisper phonation needs a real recording or microphone utterance; synthetic attenuation does not establish whisper recognition. Human speech, physical-device testing, and publication of the reviewed revision before merge are not completion gates.

## Developer checks

```sh
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
```

Browser tests check isolation on a plain static server, language/sensitivity reloads and recording locks, explicit model-load failures without fallback, quiet capture with VAD rejection/acceptance and empty/nonempty ASR text, switching, microphone denial, real Web Audio
capture with a generated test source, Stop/repeat/release, cancellation during pending permission,
and Stop → Cancel → reload during delayed worklet flushing. Both browsers check that old audio and
Stop callbacks cannot affect a new recording and that both captures are eventually released.
The synthetic microphone retains its `MediaDevices` and instrumented track wrappers so WebKit
does not lose the mock between captures and invoke native permission handling. Repeat checks wait
for Listening and nonzero captured audio before asserting reset behavior or canceling. AudioContext
creation/closure, audio graphs, worklets, and resampling remain real; no context-lifetime mock is used.
They substitute tiny model workers to keep routine checks free of model downloads. Unit tests cover
resampling continuity and audio retention at segmentation boundaries. The incompatible binding mock runs in Chromium only: Playwright WebKit cannot reliably intercept nested module-worker imports. Real Moonshine model loading and event checks run in both browsers. No physical microphone/device
is exercised by these automated checks.

Opt in to real Japanese inference with your own **16 kHz mono, signed 16-bit PCM WAV**:

```sh
python3 scripts/prepare-assets.py
ASR_TEST_WAV=/absolute/path/to/japanese.wav npm run test:browser -- --project=chromium
```

The Moonshine evaluation matrix additionally accepts `ASR_MIXED_WAV`, `ASR_ENGLISH_WAV`,
and `ASR_WHISPER_WAV` (same PCM format). Inputs are opt-in for routine automated checks;
a skipped whisper case leaves optional whisper accuracy untested, without blocking #25. For example:

```sh
ASR_TEST_WAV=/path/japanese.wav ASR_MIXED_WAV=/path/mixed.wav ASR_ENGLISH_WAV=/path/english.wav \
  npm run test:browser -- --grep 'Moonshine evaluation' --workers=1
```

It logs selected language, threshold, RMS, accepted/completed VAD events, partials/finals,
load time, and unpaced inference/finalization time, and attaches JSON to Playwright results.
Quiet cases attenuate the Japanese recording by 0.01 and 0.001; a zero-gain case checks
that silence produces no segments/text. Whisper is skipped unless a real recording is supplied.
Mixed-term results are observations, not hardcoded accuracy requirements. The normal Japanese
and English cases must emit nonempty partials/finals and completed speech events.

Run an actual whisper recording at **both** VAD thresholds independently of the other WAVs:

```sh
ASR_WHISPER_WAV=/path/actual-whisper.wav \
  npm run test:browser -- --grep 'Moonshine evaluation: Japanese whisper recording' --workers=1
```

After the reviewed revision is deployed, the same real-worker checks can target Pages instead
of localhost. `ASR_BASE_URL` disables the local web server; include the trailing slash to preserve
the repository subpath. The evaluation checks require the Small Streaming description before
loading the worker, so the older deployed page cannot pass as the revised implementation:

```sh
ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ \
  ASR_TEST_WAV=/path/japanese.wav ASR_MIXED_WAV=/path/mixed.wav \
  ASR_ENGLISH_WAV=/path/english.wav ASR_WHISPER_WAV=/path/actual-whisper.wav \
  npm run test:browser -- --grep 'Moonshine evaluation' --workers=1
```

Record the deployment run/SHA and compare published page scripts, `moonshine-config.js`, and
the staged runtime manifest/checksums to the reviewed files first. Direct-worker checks verify
loading/events and recording input. Optional published microphone/meter and human comparison
checks use the procedure above. Do not treat a skipped condition as passing.

The smoke test feeds that WAV through each real backend worker and checks Japanese final output and
Moonshine partial events. It downloads models and takes longer. It checks integration, not accuracy or
realtime pacing. No test WAV is committed or uploaded. The implementation was smoke-tested in
Chromium 153 and Playwright WebKit 26.6 with locally synthesized Japanese speech. All three
emitted Japanese finals and Moonshine emitted partials. The earlier #18 smoke check, using
Japanese Tiny, produced spaced/truncated Moonshine text and a missing first clause in ReazonSpeech
output. Current Moonshine results are recorded below; passing smoke checks establishes integration,
not transcription quality. Actual human/device results remain untested unless separately recorded.

## Moonshine #25 validation

**Acceptance follows the updated Issue #25.** Completion is based on agent-verifiable
model/runtime selection and browser loading, deterministic partial/final events, language
controls, low-amplitude capture, observable microphone/VAD/ASR states, VAD threshold
configuration, existing functionality, and Pages build/deploy compatibility. The checks
below cover these criteria. The [PR description](evidence/moonshine-25-pr.md) reflects this
scope. Human speech, whisper accuracy, physical-device testing, and a pre-merge deployment
are optional follow-up validation and do not require keeping PR #26 draft or #25 open.
No production backend is selected.

The results below and [evidence JSON](evidence/moonshine-25.json) retain historical
observations. Earlier partial-work statuses, deployment blockers, and handoff instructions
in that record reflect the previous acceptance criteria and are superseded by this guidance.

On 2026-10-02 JST, the official release runtime loaded Japanese and English Small Streaming
in Chromium 153.0.8010.12 and Playwright WebKit 26.6. Tests used the plain local static
server and the same isolation service worker used on Pages. The archive and staged runtime
were checksum-verified. These files remain deployable by the existing Pages preparation workflow;
this node did **not** publish a revision or verify it at the public URL.

All four audio unit tests passed, and routine browser checks passed (19 checks; the WebKit
incompatible-binding mock is skipped for the harness limitation above). Real Japanese
inference/finalization also passed for all three backends in both browsers (6 checks). The
Moonshine real-model check and evaluation matrix passed in both browsers (20 checks, 2 whisper
cases skipped without a recording). macOS `say` voices Kyoko/Samantha synthesized the
samples above, converted with ffmpeg to 16 kHz mono signed 16-bit PCM. Input was sent
directly to the real worker in unpaced 2048-sample blocks, without a physical microphone.
The separate UI tests use a quiet Web Audio oscillator and controlled worker outcomes to
verify the actual capture/meter path and the three diagnostic states. They do not establish
speech accuracy. Raw observations, partials/finals, configuration, RMS, and timings are in
[the evaluation record](evidence/moonshine-25.json).

Both browsers produced the same finals and event counts for these samples:

| Input / model language / VAD threshold | Worker input RMS (dBFS) | Accepted / completed segments | Nonempty partial / final events | Final transcript / observation |
| --- | --- | --- | --- | --- |
| Normal Japanese / ja / 0.5 | −25.0 | 1 / 1 | 14 / 1 | `今日は東京で音声認識を試しています明日の午後3時に会議を予約してください` — punctuation differs. |
| Quiet proxy (gain 0.01) / ja / 0.5 | −65.0 | 1 / 1 | 12 / 1 | `東京で音声認識を試しています明日の午後3時に会議を予約してください` — opening words missing. |
| Very quiet proxy (gain 0.001) / ja / 0.5 | −85.0 | 0 / 0 | 0 / 0 | Nonzero audio delivered/acknowledged; speech detection accepted no segment. |
| Same very quiet proxy / ja / 0.2 | −85.0 | 2 / 2 | 2 / 2 | `ありがとうございました` twice — VAD accepts, but ASR text is wrong. More sensitivity does not ensure usable recognition. |
| Japanese with English terms / ja / 0.5 | −24.4 | 1 / 1 | 13 / 1 | `GitHubのAPIをJavaScriptが呼び出します。WavaSembridをPeneiをお試します。` — GitHub/API/JavaScript preserved; WebAssembly/OpenAI wrong; Japanese particle error. |
| Same mixed sample / en / 0.5 | −24.4 | 1 / 1 | 11 / 1 | Repeated English date text, beginning `The first is the 10th of July, 2021.` — incorrect; switching to English did not preserve the Japanese content or terms. |
| English only / en / 0.5 | −16.1 | 1 / 1 | 8 / 1 | `Use the github api with javascript, web assembly, and open ai.` — terms recognizable; casing and word boundaries differ. |
| Same English sample / ja / 0.5 | −16.1 | 1 / 1 | 8 / 1 | `Use the GitHub API with Job Ascript, Web Assem` — incorrect/truncated. |
| Digital silence / ja / 0.5 | −∞ | 0 / 0 | 0 / 0 | No segments or transcripts. |
| Human whisper-like Japanese / ja / 0.5 and 0.2 | Not tested | Not tested | Not tested | Requires a real recording or microphone observation; attenuation does not reproduce whisper phonation. |

Initialization including model downloads ranged from 8.41–12.71 seconds. Unpaced inference
and Stop for voiced samples took 0.48–3.05 seconds, with every sample acknowledged and Stop
completed. This does not measure real-time responsiveness, repeat-load caching, or human
first-text latency. Physical mobile compatibility and the published-revision five-condition
human comparison remain unverified and optional. No human recognition result or production
backend selection is inferred from these synthetic checks.

### Optional follow-up validation for #25

- After deployment, verify HTTPS deployment identity, staged runtime/model
  loading, partial/final events, Stop/repeat, and responsiveness on the canonical Pages URL.
- Record the five-condition comparison: normal Japanese, Japanese with English terms, English-only,
  actual quiet Japanese, and actual whisper-like Japanese. Use both whisper VAD thresholds and
  record input signal, accepted/completed VAD segments, partial/final events/text, and errors.
- These observations do not block merge or completion. Synthetic voices and attenuation do not
  establish human phonation or whisper recognition; human and physical-device results may remain not tested.

### Historical publication observation (2026-10-02 08:23 UTC)

At 2026-10-02 08:23 UTC, read-only checks confirmed Pages still served the successful main
deployment `8c4e44b36ad3999042e2d192b8708bd1913ec010`
([run 36959071356](https://github.com/takahirox/my-audio-to-text/actions/runs/36959071356)).
`app.js`, `model-worker.js`, and `vendor/manifest.json` returned 200 but differed from this
revision; `moonshine-config.js` returned 404. At that time, the `github-pages` environment permitted
only `main`, so a PR-branch deployment would have required a separately approved branch permission.
No approval or deployment was recorded. This historical observation does not block #25 under the
updated criteria; the existing main deployment path remains available after merge. No real whisper
recording was available in the worktree; no whisper result is inferred from the amplitude proxies.

### Historical review-fix checks (2026-10-02)

The three diagnostic WebKit repeat failures were reproduced before the fix. Retaining the
synthetic microphone's MediaDevices/track wrappers prevents garbage collection from discarding
the getUserMedia mock. Afterward all four audio tests and 19 routine browser checks passed;
29 cases were skipped (28 opt-in real-model cases without their WAVs and one WebKit binding mock).
All five WebKit repeat cases passed five runs each (25 checks). Both browsers now test a new
recording during the old delayed worklet flush, with successful capture and eventual track release.

Separately, four selected real-model checks passed for synthesized normal Japanese and English
in Chromium and WebKit. Both current Small Streaming models loaded and emitted nonempty
partials/finals and completed native speech events. Asset preparation and archive verification
also passed. These local checks do not establish published-site or actual whisper observations.
The external-base harness also passed real Japanese inference in Chromium through a separate
localhost server at `/my-audio-to-text/`, with no Playwright-managed server. This checks repository
subpath handling, not the public HTTPS deployment.
The refreshed structured check record is in [the evidence JSON](evidence/moonshine-25.json).

### Historical review findings follow-up (2026-10-02)

This review used the previous acceptance criteria. The updated Issue makes its outstanding
published-revision and human-speech checks optional; the observations below remain historical.

The non-closing reference was restored in [the checked-in PR description](evidence/moonshine-25-pr.md)
and applied to [PR #26](https://github.com/takahirox/my-audio-to-text/pull/26). The live body was
read back and matched the file; PR #26 remained draft with head
`68bd23570bf205602a0181f283120941882b912d`, and Issue #25 remained open. The instruction to preserve
the non-closing reference is superseded by the updated scope and current PR description.

At 08:49 UTC, fresh HTTPS checks found `app.js` and `model-worker.js` returned 200 but differed
from this worktree. `vendor/manifest.json` returned 200; `moonshine-config.js` still returned 404.
The latest successful Pages run remained
[36959071356](https://github.com/takahirox/my-audio-to-text/actions/runs/36959071356), at main commit
`8c4e44b36ad3999042e2d192b8708bd1913ec010`. A fresh read of the deployment branch policies found
only `main`. Therefore the reviewed HTTPS revision's model loading, partial/final events,
and responsiveness were **not tested**, rather than passing based on the older deployment.

No speech recordings were present in the assigned worktree, and no human microphone utterances
were supplied. The five real-speech conditions below were not tested and are now optional.
For each, record the deployed SHA, language/model and threshold, microphone signal and peak,
accepted/completed VAD segments, partial/final text, obvious errors, first/repeat load time, and
responsiveness. Actual quiet speech and whisper phonation cannot be inferred from attenuation.

| Optional real-speech condition | Recorded status |
| --- | --- |
| Normal Japanese | Not tested |
| Japanese containing GitHub, WebAssembly, API, JavaScript, and OpenAI | Not tested |
| English-only | Not tested |
| Actual quiet Japanese at the same microphone distance | Not tested |
| Actual whisper-like Japanese at VAD thresholds 0.5 and 0.2 | Not tested |

The closing-reference finding was resolved under the earlier scope. Published-revision and
real-speech evidence was missing; the updated Issue removes those checks as completion gates.
Four unit tests and 19 Chromium/WebKit checks passed again; 29 browser cases were skipped
(28 opt-in model checks without recordings and one WebKit binding mock). Skips are not validation
evidence. Historical responses, checksums, PR state, and blockers are recorded under
`review_findings_followup` in [the evidence JSON](evidence/moonshine-25.json).

The earlier instruction to keep PR #26 draft and #25 open pending human or published-site
evidence is superseded. During that historical follow-up, only the PR description was changed
on GitHub; no push, merge, deployment, environment-policy change, usage reset, allowance
purchase, or model/provider switch was performed.

### Acceptance-guidance fix checks (2026-10-02)

After aligning this guidance with the updated Issue snapshot, asset preparation and archive
checksum verification passed, as did four audio unit tests and 19 Chromium/WebKit browser
checks. The 29 skipped cases were 28 opt-in real-model checks without WAV inputs and one
WebKit binding mock. Real-model checks were not rerun for this documentation change; their
earlier results remain recorded above. The existing Pages workflow runs the same preparation
and uploads `web/` before deployment. No human speech, physical-device, or public-site result
is claimed by these checks.

## Upstream references

- [Moonshine Voice WASM binding](https://github.com/moonshine-ai/moonshine/tree/main/language-bindings/wasm) and [code/model license](https://github.com/moonshine-ai/moonshine/blob/main/LICENSE).
- [sherpa-onnx WASM release 1.13.2](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.2), [ReazonSpeech model documentation](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html), and [ReazonSpeech model card](https://huggingface.co/reazon-research/reazonspeech-k2-v2).
- [Transformers.js browser documentation](https://huggingface.co/docs/transformers.js), [Whisper ONNX model card](https://huggingface.co/Xenova/whisper-tiny), and [runtime license](https://github.com/huggingface/transformers.js/blob/3.8.1/LICENSE).

Preparation preserves upstream runtime files. Runtime/model requests go to the site, jsDelivr,
Hugging Face, and Moonshine's download host. Hosts see normal asset requests, but the playground
does not transmit microphone audio or transcripts. Browser-managed HTTP/model caches may persist
downloads; audio/transcripts remain in memory only. Network access is required on first load.
