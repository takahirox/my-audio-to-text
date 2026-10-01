# Browser Speech-to-Text manual comparison

This disposable playground supplies the implementation portion of [Issue #18](https://github.com/takahirox/my-audio-to-text/issues/18).
It does not select a production backend. Record human observations before a separate selection issue.

## Open the playground

The Pages URL is **https://takahirox.github.io/my-audio-to-text/**. The reviewed PR #20 commit
`66fb43f82b5a29df7c3e96efc9e0dfe3bb33a444` is published by successful
[run 36894283644](https://github.com/takahirox/my-audio-to-text/actions/runs/36894283644).
The page and all staged assets were verified on 2026-10-02 JST; see
[publication evidence and pending human acceptance](asr-acceptance.md).
In repository Settings → Pages, select **GitHub Actions** as the source. The workflow stages
the pinned runtime assets and deploys `web/` on pushes to `main` or an explicit manual dispatch.
For PR #20, **publish its reviewed branch and complete acceptance before merging** using the
procedure below. Publication and real-device acceptance are tracked in
[#21](https://github.com/takahirox/my-audio-to-text/issues/21). This is partial work against #18;
#18 remains open until its remaining acceptance evidence is recorded. The older
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
   Keep PR #20 in draft and #18 open while these required results are missing.
6. After acceptance and review, merge may proceed in the normal repository workflow. The push
   to `main` redeploys the same environment. Remove the temporary PR-branch permission once
   it is no longer needed.

The sequence for this work is **reviewed branch → manual publication → recorded human acceptance
→ final review → merge**, with #21 tracking the pre-merge work. #21 already documents this
sequence. Publication is complete for the commit above; desktop and physical-device human
results are still required. Retain the acceptance gate and do not describe #18 as complete
while evidence is missing.

Current evidence and remaining blockers are recorded in [ASR acceptance status](asr-acceptance.md).

Before completing #21, record a successful deployment run and commit SHA, verify that the HTTPS
URL serves all three candidates and their required assets, and exercise load/capture/Japanese
recognition/Stop/repeat/switch on desktop Chromium and a physical iPhone Safari. Test Android Chrome
when a device is available, or record it as not tested. Use the results template below and record
errors or demonstrated limitations; then reassess #18's complete Definition of done. Do not close
#18 based only on the implementation PR or #17's placeholder checks.

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
| Moonshine Voice | `@moonshine-ai/moonshine-wasm` 0.1.5, Japanese Tiny, live `Stream` API | Incremental partials and completed lines emitted by the runtime; native speech detection |
| sherpa-onnx | 1.13.2 SIMD WASM, quantized Japanese ReazonSpeech Zipformer 2024-08-01 | Segment finals; no native partials |
| Whisper | Transformers.js 3.8.1, `Xenova/whisper-tiny` multilingual q8, revision `5332fcc35e32a33b86612b9a57a89be7906102b1`, WASM CPU, one thread | Segment finals; no native partials |

**Moonshine Japanese streaming availability:** the published 0.1.5 WASM catalog rejects Japanese
`TinyStreaming` and `SmallStreaming` even though current upstream source documentation describes
Japanese streaming releases. This PoC uses the published Japanese `Tiny` architecture and exercises
its live `Stream` API, which does emit partial/final events. It is a non-streaming model with
incremental decoding; it is not evidence that the new Japanese streaming architecture works in
this published binary. The model manifest selects runtime downloads, and upstream models may
change independently of the pinned npm package. The Japanese Tiny model has the upstream
Moonshine Community License; it is an evaluation candidate, not a production licensing decision.

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
4. Pause for about one second. Observe incremental partials (Moonshine), segment finals, and responsiveness.
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
including the next backend, rather than leaving success implicit in a transcript.

| Date / device / OS / browser | Backend / first or repeat load | Utterance / volume | Permission and meter | Init (s) | First partial / text (s) | Stop outcome / latency (s) | Partial / final transcript | Repeat outcome | Switch to / outcome | Accuracy, responsiveness, heat, stability, errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

Suggested samples (edit the on-page utterance as needed):

- Ordinary Japanese: `今日は東京で音声認識を試しています。明日の午後三時に会議を予約してください。`
- Names/terms: `高橋さんに、GitHub ActionsとWebAssemblyの設定を確認してもらいます。`
- Quiet speech: repeat the ordinary sample softly at the same microphone distance.
- Longer speech: dictate a paragraph for 30–60 seconds, with and without pauses.

No human accuracy results or production recommendation are claimed by this change.

## Developer checks

```sh
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
```

Browser tests check isolation on a plain static server, switching, microphone denial, real Web Audio
capture with a generated test source, Stop/repeat/release, cancellation during pending permission,
and Stop → Cancel → reload during delayed worklet flushing. Chromium checks that old audio and
Stop callbacks cannot affect a new recording and that both captures are eventually released.
WebKit checks that the old Stop cannot affect the replacement worker at Ready; the rapid capture
replacement case intermittently encounters native `NotAllowedError` in headless WebKit and still
requires real Safari validation under #21.
They substitute tiny model workers to keep routine checks free of model downloads. Unit tests cover
resampling continuity and audio retention at segmentation boundaries. No physical microphone/device
is exercised by these automated checks.

Opt in to real Japanese inference with your own **16 kHz mono, signed 16-bit PCM WAV**:

```sh
python3 scripts/prepare-assets.py
ASR_TEST_WAV=/absolute/path/to/japanese.wav npm run test:browser -- --project=chromium
```

The smoke test feeds that WAV through each real backend worker and checks Japanese final output and
Moonshine partial events. It downloads models and takes longer. It checks integration, not accuracy or
realtime pacing. No test WAV is committed or uploaded. The implementation was smoke-tested in
Chromium 153 and Playwright WebKit 26.6 with locally synthesized Japanese speech. All three
emitted Japanese finals and Moonshine emitted partials. This sample also produced spaced/truncated
Moonshine text and a missing first clause in ReazonSpeech output; passing smoke checks establishes
integration, not transcription quality. Actual human/device results still need to be recorded.

## Upstream references

- [Moonshine Voice WASM binding](https://github.com/moonshine-ai/moonshine/tree/main/language-bindings/wasm) and [code/model license](https://github.com/moonshine-ai/moonshine/blob/main/LICENSE).
- [sherpa-onnx WASM release 1.13.2](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.2), [ReazonSpeech model documentation](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html), and [ReazonSpeech model card](https://huggingface.co/reazon-research/reazonspeech-k2-v2).
- [Transformers.js browser documentation](https://huggingface.co/docs/transformers.js), [Whisper ONNX model card](https://huggingface.co/Xenova/whisper-tiny), and [runtime license](https://github.com/huggingface/transformers.js/blob/3.8.1/LICENSE).

Preparation preserves upstream runtime files. Runtime/model requests go to the site, jsDelivr,
Hugging Face, and Moonshine's download host. Hosts see normal asset requests, but the playground
does not transmit microphone audio or transcripts. Browser-managed HTTP/model caches may persist
downloads; audio/transcripts remain in memory only. Network access is required on first load.
