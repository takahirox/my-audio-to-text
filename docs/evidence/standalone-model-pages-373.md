# Standalone model pages — Issue #373

Implementation based on upstream checkpoint `e55108675e6d851df6cf87f5e51bfd109286a115`.
Local validation performed on 2026-11-13/14, using Playwright 1.63.0 Chromium and
WebKit. These results do not establish deployment of this revision or comparable
performance across machines.

## Delivered behavior

- The static web index links every primary model in the current extension
  catalog, grouped by task. Silero and the Japanese frontend remain dependencies;
  experimental Qwen3 correction remains separate and reachable.
- Existing pages are preserved. Added independent file-ASR pages for Whisper,
  Zipformer, Parakeet and Moonshine; text pages for both summary models and
  IfCondition; streaming TTS pages for Qwen3-TTS and CosyVoice3. TranslateGemma
  supports both directions and preserves independently entered source text.
- Production nodes/workers own inference. Browser-origin loading reuses pinned
  manifests, verified asset preparation and cache readers. Extension workers
  continue to select their original cache-only loaders.
- Explicit Run/Generate, loading progress, separate loading/inference timings,
  cancellation/retry and resource cleanup are covered. File replay exposes real
  streaming ASR updates; streaming TTS uses the actual chunk speaker with a
  separate completed-WAV collector. GPU compatibility is checked before loading;
  worker/runtime compatibility failures include actionable browser guidance.
- Pages preparation and a dedicated deterministic CI workflow include all
  runtimes and pages without downloading model weights. The extension Models UI,
  Graph Editor, graph runtime, model checkpoints and cache policy are unchanged.

## Historical passing validation

The following results are preserved from the implementation before the official
default-branch reconciliation. They were not rerun for the documentation changes
described below.

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run prepare:playground-assets` | Passed; pinned runtimes/manifests, no weights |
| Model/asset unit subset used by the new CI workflow | 196 passed |
| `npm run test:playground -- --workers=2` | 288 passed across Chromium/WebKit |
| Follow-up direction/source-preservation and pending-GPU cancellation checks | 8 passed across Chromium/WebKit |
| `npm run build:extension` | Passed; weight-free packaged artifact |
| New CI's packaged optional-ASR, Whisper, Zipformer, summary, IfCondition and streaming-TTS subset | 25 passed, 2 opt-in checks skipped |
| `git diff --check` | Passed |

The focused browser suite covers index/direct/return navigation under the Pages
prefix, no work on page opening, each new model's independent lifecycle, both
summary types, both condition outcomes, settings forwarding, partial/final ASR,
native GPU failures without weight downloads, cancellation during setup/load/run,
pagehide release, repeated runs, incremental playback before completion and WAV
contents. Browser cache fixtures verify pinned reads, corrupt downloads,
unreviewed lookups and eviction. Existing TTS fixtures were aligned with the
current frontend initialization and cached-voice/blob interface. The local test
server's listen backlog was increased after tracing reset module requests during
parallel browser startup.

Opt-in real browser runs passed for IfCondition, Whisper, Zipformer and Moonshine.
IfCondition exercised the real classifier. ASR used a short generated waveform:
these checks establish real model loading and audio processing/drain, not speech
accuracy; Whisper's VAD may reject the waveform. Use `PLAYGROUND_AUDIO_FILE` with
known speech for transcript validation. No inference API or extension was used.
Real heavyweight WebGPU generation and published deployment were not run; their
explicit opt-in commands and requirements are in [the Playground guide](../node-playground.md).

## Required post-merge verification — pending

Perform the
[#373 deployment checklist](../node-playground.md#issue-373--all-standalone-model-pages)
after merge and record its evidence here, in the merged PR or in the closed
Issue. The post-merge results are recorded below. Runtime verification remains partial;
the historical pre-merge evidence does not establish these results.

PR [#374](https://github.com/takahirox/my-audio-to-text/pull/374) includes the
normal closing reference `Closes #373`. Once implementation and mandatory
pre-merge acceptance are complete, merge and close the implemented Issue, then
perform the checks below following the
[official lifecycle](../development-flow.md#pre-merge-acceptance-and-post-merge-verification).
Record the affected revision, results and evidence in the merged PR, closed
Issue or this report. Approval and Issue closure do not establish that pending
checks passed. Publication does not authorize merge.

| Check | Expected result | Status |
| --- | --- | --- |
| Merged revision deployment | Both Pages jobs succeed for the merged SHA; the canonical published site serves that deployment. Record SHA, run/deployment URL and UTC verification time. | See 2026-11-14 results below |
| All 15 primary model links | Each index link, direct page URL and return link works beneath `/my-audio-to-text/`, shows the correct model controls and triggers no eager inference/download/capture. Record each URL/result. | See 2026-11-14 results below |
| Per-model runtime and asset resolution | Explicit loading/running resolves modules, workers/worklets, isolation worker, notices and vendor runtimes/manifests under the repository prefix; pinned remote weights load from their distribution hosts. Record successful requests, required isolation, readiness/output and any console/network failures per model. | See 2026-11-14 results below |

Post-merge deployment and navigation checks completed on 2026-11-14. Real
runtime checks are partial, as detailed below. Fixture-driven published tests
alone do not establish real runtime/weight loading; hardware-blocked checks
remain pending.

If verification discovers an actual defect, check for an equivalent Issue and
use it or register a new linked Issue with reproduction steps, affected revision,
expected/actual behavior and links to #373 and PR #374. Do not keep or reopen
#373 solely for post-merge follow-up. An unavailable environment alone does not
establish a product defect; record the blocker and leave the check pending.

## Historical upstream suite failures

At the original implementation checkpoint, the full repository suites were not
green. The final full unit run had 1,076
passing checks and one failure: the palette still classifies the removed
`StreamingSpeakerOutput` type. That failure also occurs at the untouched input
checkpoint.

The broad browser run reported extension legal-link, palette, graph-canvas/zoom,
Live and related layout failures. Its Playground failures were addressed and the
focused browser suite above subsequently passed. The broad packaged-extension
run reported 356 passed, 30 failed and 26 skipped, including graph actions,
concurrent capture, canvas and focused-field target fixtures.

Representative failures were reproduced in a temporary, untouched copy of the
input checkpoint: both `extension-layout` Models/legal-link cases, `shared-ui`
Models links, `graph-quick-add`, `text-sliding-window`, and packaged
`graph-actions` / `graph-concurrent`. These extension UI/target issues were left
outside #373. Full-suite success must not be inferred from the focused results.

## PR #374 reconciliation context

On 2026-11-14, at the owner's explicit request to resume #373 after the
35-repository policy rollout, the saved implementation checkpoint
`1447506b11d50cce7b5d624b3773611677950438` was reconciled with the officially
updated default branch at `c72e0264661ef9b941ac5541994d3514be67b9cc` (policy
Issue #378 / PR #379). This merge preserves #373's standalone model pages and
main's other fixes, including the rich-editor changes from PR #376. It does not
restore the discarded ad hoc local policy commit `8aa5f6d`.

The current guide and this report now follow the officially merged development
and review guidance: close the implemented Issue at merge, verify afterward and
track actual discovered defects in new or equivalent linked Issues. This is the
owner-requested reconciliation within PR #374, not a separate policy redesign.
Historical validation above remains evidence for the recorded checkpoints;
unperformed heavyweight inference and published-revision checks remain pending.

### Reconciliation validation — 2026-11-14

The merge completed without conflicts. Its only shared paths were this feature's
Playground guide and `package.json`; package scripts, dependencies and overrides
retain both branches' entries, and dependency declarations match the merged
lockfile. No code conflict resolution or additional runtime changes were needed.

| Check | Result |
| --- | --- |
| Merge target, unresolved entries and discarded-commit ancestry | Passed: target is `c72e0264661ef9b941ac5541994d3514be67b9cc`, no unresolved entries, `8aa5f6d` is absent from the saved implementation's ancestry |
| Branch preservation | Passed: all 22 upstream-only paths and all 52 feature-only paths other than this deliberately updated report retain their source bytes |
| Package merge / lockfile consistency | Passed: both branches' package entries retained, dependency declarations match lockfile |
| Current guide and report structure / links / consistency | Passed: heading hierarchy, fences, table columns, 33 local links/anchors, four external HTTPS URL forms and #373 lifecycle wording checked; external destinations were not fetched |
| `git diff --check` and `git diff --cached --check` | Passed |

Runtime regression suites, asset preparation and real-model checks were not
rerun for this documentation reconciliation. The imported upstream code is
unchanged; historical suite failures above remain historical and no new
full-suite success is claimed. Published-revision checks remain **pending**.
This reconciliation did not push, merge PR #374, close Issues or alter Tasks.


## Post-merge published verification — 2026-11-14

**Result: partial.** GitHub was checked again after testing: PR #374 is merged,
Issue #373 remains closed/completed, and the actual merge SHA is
`d58849c766b7903a2d5f8a1f2201853f78a69e68` (PR head
`3a40a582b2831edc39301a47c41ccdb57c286cfd`). No product/deployment defect was
established; no follow-up Issue or fix was started.

### Deployment and navigation

[Pages run 43578274950](https://github.com/takahirox/my-audio-to-text/actions/runs/43578274950)
ran for the exact merge SHA. Both build and deploy succeeded, finishing at
08:58:46 and 08:59:05 UTC. Deployment `7785295954` reported success at
08:59:06 UTC for [the canonical site](https://takahirox.github.io/my-audio-to-text/).
It was already complete when inspected; no polling or deployment retry was needed.
The run/deployment and final UTC observation are saved in
[GitHub and runtime evidence](standalone-model-pages-373-postmerge.json).

All **15** primary links in the four task groups passed in fresh Chromium
contexts without an extension. Each link, direct URL and Node Playground return
link retained `/my-audio-to-text/`; matching headings and enabled Run/Load controls
were present. No model worker, capture call, external request or eager weight
load occurred. All five ASR pages became cross-origin isolated through the
published isolation worker. [Per-page evidence](standalone-model-pages-373-published.json)
records every canonical URL, heading, controls, request statuses and capabilities.

The published `test:playground` command exited 0 across Chromium/WebKit:
294 declared cases, including two skipped local-server-only alias cases. This
suite uses worker/asset fixtures and verifies lifecycle, cancellation, settings,
streaming UI/playback plumbing and both TranslateGemma directions; it does not
establish real inference. Its initial JSON stdout was removed by Playwright's
output-directory initialization; the observed process exit and separate suite
listing are recorded, rather than presenting a missing report as saved evidence.

The [asset audit](standalone-model-pages-373-assets.json) records 192 successful
availability/MIME checks: 117 published source responses match the merged bytes,
45 prepared JS/runtime files match their recorded SHA-256 pins, and 30 other
checks establish availability only (including WASM served as `application/wasm`).
Controllers, shared modules/styles, workers/worklets, isolation worker, notices,
model-cache manifests and vendor runtimes resolve beneath the repository prefix.
HEAD availability does not establish successful runtime execution or WASM integrity.
Four additional guessed manifest paths were excluded after checking
`prepare-model-cache.py` and production loaders: those models do not use those
URLs. Their observed responses, including an unused Kokoro probe's 503, remain
in `excludedProbes`; no production failure is inferred from them.

### Real model execution

Chromium **153.0.8010.12**, macOS arm64, Apple M4 Max. Locked dependencies were
installed with `npm ci --prefer-offline`; existing browser binaries, published
staged runtimes and browser asset caches were used. No local asset rebuild or
model substitution was required. Model inputs stayed local; observed HTTP
requests downloaded static assets. Request evidence omits signed query strings.

The repository's existing opt-in browser tests ran against `ASR_BASE_URL` set to
the canonical published URL. A temporary wrapper only recorded network/console
and final UI state; it did not replace workers, runtimes or weights. It imported
`playground-model-smoke.spec.js`, `model-smoke.spec.js`,
`translation-smoke.spec.js` and `tts-smoke.spec.js`. The wrapper was removed after
recording evidence. Runs had explicit 240–360 second overall bounds; no unbounded
wait/retry loop was used. Preliminary real runs passed; the five-model CPU subset
was repeated specifically to collect the missing per-model network evidence.

| Model | Published real result |
| --- | --- |
| ReazonSpeech ja-en | Real ReazonSpeech/Silero readiness; silence processing, Stop and repeat passed. Microphone input was replaced by silence injection, not inference. No speech-accuracy claim. |
| Whisper tiny q8 | Real pinned loading and one-second generated-waveform processing/drain passed; empty transcript. No speech-accuracy claim. |
| Zipformer English | Real pinned loading and generated-waveform processing/drain passed; empty transcript. No validated speech partial/final accuracy. |
| Moonshine Medium | Real pinned loading and generated-waveform processing/drain passed; empty transcript. No validated speech partial/final accuracy. |
| IfCondition | Real classifier completed with `Yes`; distinct load/inference timing and no page/runtime errors. |
| OPUS-MT ja → en | Initialization, inference and repeat passed; example: `It's a nice day today.` |
| OPUS-MT en → ja | Initialization, fixture meanings, inference and repeat passed; final example: `金曜までにこのプロジェクトを完了しなければならない.` |
| Supertonic 3 | Japanese, English and repeated English generation, finite non-silent waveform, native WAV playback and local-only request checks passed. |
| Kokoro 82M | Japanese and twice-English generation, non-silent finite WAV and playback succeeded; **the existing smoke test failed** its external-host assertion at `tts-smoke.spec.js:51`. It rejects the successful pinned `cdn.jsdelivr.net/npm/kokoro-js-jp@0.2.0/dist/openjtalk-voice.htsvoice` dependency download. This is a test allowlist mismatch, not evidence of failed generation, remote inference or an unavailable deployed asset. The test is not reported as passing. |

Runtime records include real worker/vendor/model-manifest and licensed weight
responses, final status/output, separate timings, console warnings and test
assertions. There were no recorded HTTP failures or uncaught page errors in these
nine executions. OPUS tokenizer/content-length warnings were retained. Replaced
completed-audio blob requests can be aborted during normal player cleanup; the
recorder excludes those from HTTP asset failures.

**Still pending:** Parakeet, TranslateGemma (both real directions), LFM2 summary,
Qwen3.5 summary, Qwen3-TTS and CosyVoice3 real generation. The headless browser
exposes `navigator.gpu`, but `requestAdapter()` returned null in the fresh-context
capability checks. Their WebGPU inference, shader-f16 behavior and real streaming
speech playback were not performed; no heavyweight GPU weight download was
attempted. Fixture-based streaming tests and runtime-file availability are not
substitutes. Retry these opt-in checks on a compatible GPU/browser, and reconcile
the Kokoro smoke allowlist separately. An unavailable adapter alone is a
verification limitation, so #373 was left closed and no product defect Issue was
created.
