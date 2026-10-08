# Node Playground post-merge verification — Issue #63

[PR #64](https://github.com/takahirox/my-audio-to-text/pull/64) merged as
`3de5984b424ef17cbadfc65ef9a160d24b5dc6a3`.
The automatic main-branch push [Pages run 37723647968](https://github.com/takahirox/my-audio-to-text/actions/runs/37723647968)
completed successfully at `2026-10-08T03:38:45Z`; both build and deploy jobs
succeeded. The [saved workflow metadata](node-playground-pages-deployment.json)
identifies the same merge SHA.

Published verification ran from `2026-10-08T03:39:57.681Z` to
`2026-10-08T03:40:25.482Z` with Playwright and Chromium `153.0.8010.12`, using
a fresh isolated browser context and normal HTTPS certificate verification.
The [machine-readable record](node-playground-pages.json) contains URLs,
HTTP statuses, source checksums, runtime responses and session results.

- The [canonical entry point](https://takahirox.github.io/my-audio-to-text/)
  rendered the Node Playground heading and clickable Speech-to-Text entry.
  Clicking opened the [speech page](https://takahirox.github.io/my-audio-to-text/nodes/speech-to-text/).
  Its Load button became enabled. The return link and direct speech URL worked.
- All 18 tracked files under `web/` returned HTTP 200, and their SHA-256 hashes
  matched the files read directly from the merge commit. These include both HTML
  pages, the nested controller, root styles, production pipeline/node modules,
  isolation worker, ASR/VAD workers, capture worklet, licenses and notices.
- `crossOriginIsolated` was true. The service worker scope was
  `https://takahirox.github.io/my-audio-to-text/`.
- Both real worker runtimes loaded the fixed ReazonSpeech ja-en/Silero model.
  The page reached `Ready. Choose an audio source and tap Start.` after 23.50 s,
  and displayed `ReazonSpeech ja-en (ja-en); 1 thread(s)`.
  The runtime ASR/VAD helpers and JS/WASM/data assets all returned HTTP 200.
  The vendor manifest reports 90,822,540 bytes and the pinned bilingual model
  revision `12b44671ff48b9aed622551d64e02fea9a2cf870`.
- Two sessions each fed 16,037 silent samples through the actual production
  speech node/pipeline, then stopped and drained to `1.0 s / 0.0 s`, with zero
  accepted utterances and empty final text. Cancel released the session and
  restored the enabled Load button. There were no JavaScript exceptions,
  failed browser requests or HTTP errors during this verification.

The silence source replaced only the microphone acquisition methods. It did
not replace either model worker or the production speech node. This check does
not claim physical microphone/tab permission testing or speech accuracy.
See the [index screenshot](node-playground-pages-index.png) and
[speech page after Stop](node-playground-pages-speech.png).

## Additional published deterministic suite

Command: `ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ npm run test:browser -- --workers=2`.

The initial Chromium/WebKit suite took 1.9 minutes: **103 passed, 5 failed,
8 skipped**. Both browsers passed list navigation and isolation. The controlled
tests exercise production pipeline and capture code with worker/permission
fixtures; they are separate from the real-model check above.

Rerunning just the five failures with `--last-failed --workers=1` produced
**3 passed, 2 failed**. The Chromium held-flush test and WebKit microphone denial
and pending-permission tests passed on that rerun. Two WebKit tab-cancellation
checks still failed at `tests/browser/tab-audio.spec.js:152`, because the immediate
assertion found at least one capture context whose state was not `closed`:

- `cancel during the tab picker discards a late-granted stream`
- `a canceled picker grant cannot feed or end a replacement tab session`

Track-release polling passed before those assertions. The remaining failures
need follow-up to determine whether they reflect asynchronous closure timing
or a cleanup defect. No all-green suite or new unit/extension test result is
claimed. The [saved suite summary](node-playground-pages-suite.json) retains
the rerun results and bounded error excerpts.

The required post-deployment revision, navigation, isolation, model readiness
and asset-resolution checks are complete. [Issue #63](https://github.com/takahirox/my-audio-to-text/issues/63)
was closed as completed at `2026-10-08T03:42:31Z`, after posting the
[outcome comment](https://github.com/takahirox/my-audio-to-text/issues/63#issuecomment-6051711176)
referencing PR #64 and disclosing the two additional WebKit failures.
