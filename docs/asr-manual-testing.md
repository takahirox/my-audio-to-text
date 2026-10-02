# Browser Speech-to-Text manual comparison

This disposable playground supplies the implementation portion of [Issue #18](https://github.com/takahirox/my-audio-to-text/issues/18).
It does not select a production backend. Record human observations before a separate selection issue.

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

### Publish for acceptance before merge

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
| Whisper | Transformers.js 3.8.1, `Xenova/whisper-tiny` multilingual q8, revision `5332fcc35e32a33b86612b9a57a89be7906102b1`, WASM CPU, one thread | Segment finals; no native partials |

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
Keep other settings at upstream defaults, including the 0.5-second VAD averaging window.
See [native options](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/docs/api/options.md).

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

## Human test procedure

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

For #25, run the five conditions above on the published revision once deployed. Record the deployed commit, device/browser, microphone signal, VAD segments, partial/final text, obvious errors, first/repeat load time, and responsiveness. This node does not publish; local synthetic validation is recorded in [Moonshine #25 evidence](#moonshine-25-validation). Human whisper/microphone and physical-mobile observations remain additional validation; an agent cannot reproduce the tester's phonation or physical microphone.

## Developer checks

```sh
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
```

Browser tests check isolation on a plain static server, language/sensitivity reloads and recording locks, explicit model-load failures without fallback, quiet capture with VAD rejection/acceptance and empty/nonempty ASR text, switching, microphone denial, real Web Audio
capture with a generated test source, Stop/repeat/release, cancellation during pending permission,
and Stop → Cancel → reload during delayed worklet flushing. Chromium checks that old audio and
Stop callbacks cannot affect a new recording and that both captures are eventually released.
WebKit checks that the old Stop cannot affect the replacement worker at Ready; the rapid capture
replacement case intermittently encounters native `NotAllowedError` in headless WebKit and still
requires real Safari validation under #21.
They substitute tiny model workers to keep routine checks free of model downloads. Unit tests cover
resampling continuity and audio retention at segmentation boundaries. The incompatible binding mock runs in Chromium only: Playwright WebKit cannot reliably intercept nested module-worker imports. Real Moonshine model loading and event checks run in both browsers. No physical microphone/device
is exercised by these automated checks.

Opt in to real Japanese inference with your own **16 kHz mono, signed 16-bit PCM WAV**:

```sh
python3 scripts/prepare-assets.py
ASR_TEST_WAV=/absolute/path/to/japanese.wav npm run test:browser -- --project=chromium
```

The Moonshine evaluation matrix additionally accepts `ASR_MIXED_WAV`, `ASR_ENGLISH_WAV`,
and optionally `ASR_WHISPER_WAV` (same PCM format). For example:

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

The smoke test feeds that WAV through each real backend worker and checks Japanese final output and
Moonshine partial events. It downloads models and takes longer. It checks integration, not accuracy or
realtime pacing. No test WAV is committed or uploaded. The implementation was smoke-tested in
Chromium 153 and Playwright WebKit 26.6 with locally synthesized Japanese speech. All three
emitted Japanese finals and Moonshine emitted partials. The earlier #18 smoke check, using
Japanese Tiny, produced spaced/truncated Moonshine text and a missing first clause in ReazonSpeech
output. Current Moonshine results are recorded below; passing smoke checks establishes integration,
not transcription quality. Actual human/device results still need to be recorded.

## Moonshine #25 validation

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
first-text latency. Physical mobile compatibility is unverified. The published-revision five-condition
comparison remains useful follow-up validation after deployment, using the human procedure above;
no human recognition result or production backend selection is inferred from these synthetic checks.

## Upstream references

- [Moonshine Voice WASM binding](https://github.com/moonshine-ai/moonshine/tree/main/language-bindings/wasm) and [code/model license](https://github.com/moonshine-ai/moonshine/blob/main/LICENSE).
- [sherpa-onnx WASM release 1.13.2](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.2), [ReazonSpeech model documentation](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html), and [ReazonSpeech model card](https://huggingface.co/reazon-research/reazonspeech-k2-v2).
- [Transformers.js browser documentation](https://huggingface.co/docs/transformers.js), [Whisper ONNX model card](https://huggingface.co/Xenova/whisper-tiny), and [runtime license](https://github.com/huggingface/transformers.js/blob/3.8.1/LICENSE).

Preparation preserves upstream runtime files. Runtime/model requests go to the site, jsDelivr,
Hugging Face, and Moonshine's download host. Hosts see normal asset requests, but the playground
does not transmit microphone audio or transcripts. Browser-managed HTTP/model caches may persist
downloads; audio/transcripts remain in memory only. Network access is required on first load.
