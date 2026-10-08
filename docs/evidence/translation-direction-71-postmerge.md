# Issue #71 post-merge Pages verification

**Passed.** This completes the required deployment gate for merged
[PR #72](https://github.com/takahirox/my-audio-to-text/pull/72).
Earlier reports' pending statements describe the state before this verification.

| Required record | Verified result |
| --- | --- |
| Pages workflow | [Deploy Node Playground, run 37765869426](https://github.com/takahirox/my-audio-to-text/actions/runs/37765869426), push event, completed successfully |
| Merged and deployed SHA | `63de63a4803fd793669620da3b990fd8e0848908` |
| Deployment | `6933512365`, `github-pages`, successful at **2026-10-08T10:48:57Z**; [deployment job](https://github.com/takahirox/my-audio-to-text/actions/runs/37765869426/job/113273469123) |
| URL/source/index verification UTC time | **2026-10-08T10:50:32.415Z** |
| Real browser inference completion UTC time | **2026-10-08T10:52:23.440Z** |
| Canonical page | [English → Japanese Node Playground](https://takahirox.github.io/my-audio-to-text/nodes/opus-mt-en-ja/), HTTP 200, loaded by clicking its Playground index link |

## Deployed source and URLs

[Structured Pages evidence](translation-direction-71-postmerge-pages.json)
records the workflow, deployment, each URL/status, sizes, content types and Git
blob hashes. Eleven published static files were fetched and matched byte-for-byte
against the merged commit's Git tree and this worktree's verification sources:
the index, new page/app, shared page module, production translation Nodes,
Pipeline, independent en-ja Worker, Worker plumbing, model configuration,
stylesheet and notices. Their URLs retain `/my-audio-to-text/`.

All three deployed runtime URLs returned HTTP 200: `transformers.js`,
`ort-wasm-simd-threaded.asyncify.mjs` and
`ort-wasm-simd-threaded.asyncify.wasm` under
`https://takahirox.github.io/my-audio-to-text/vendor/translation/`.
The WASM response has `application/wasm` content type; JavaScript responses have
JavaScript content types. Actual browser inference also loaded the runtime.

All seven immutable model asset URLs returned HTTP 200 and their lengths match
the independent manifest, totaling **252,634,769 bytes**. They use
`Kadonox/opus-tatoeba-en-ja-onnx` at
`225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e`, with the q8 encoder/merged decoder.
This post-merge URL check validates availability and sizes; prior whole-file and
chunk-hash preparation evidence remains in the review-fix report.

Chrome-for-Testing **153.0.8010.12** followed the live index link to the exact
canonical page. Run was enabled, status was Ready to run, and input/output
languages were `en`/`ja`. There were no page errors and **zero model downloads
before Run**. The DevTools connector could not attach to the user's Chrome;
the independent Playwright browser completed these checks and the real smoke.

## Real deployed production-page inference

```sh
ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ TRANSLATION_SMOKE=opus-en-ja npm run test:browser -- tests/browser/translation-smoke.spec.js --project=chromium --workers=1
```

**1 passed, 2 unselected-model smokes skipped**, in **2.9 minutes**. Twenty real
Run invocations used the deployed production Node/Worker/runtime: five ordinary
English sentences, each in normal and uppercase ASR forms, repeated twice. Each
Run owns a fresh Worker. All meaning-based assertions passed:

| Normal/uppercase source meaning | Output in both repeats |
| --- | --- |
| Greeting | こんにちは |
| Meeting starts at ten | 集会は10時から開始する. |
| Send the report | 報告書を寄越して |
| Where is the station? | 駅はどこだ? |
| Finish the project by Friday | 金曜までにこのプロジェクトを完了しなければならない. |

[Real inference evidence](translation-direction-71-postmerge-inference.json)
contains UTC time, browser capabilities, all inputs/results/timings and sanitized
request paths. There were no runtime/model mocks and no page errors. All 138
observed requests were GETs without bodies or input in URLs. Remote requests
were immutable Hugging Face asset delivery and its CDN redirects; inference
ran locally. The page was secure and not cross-origin isolated, using the pinned
single-thread WASM configuration successfully.

Japanese → English and TranslateGemma real smokes were explicitly skipped because
this command selects only en-ja. MV3 extension tests were not rerun in this node;
their pre-merge evidence is unchanged. These sentence checks establish tested
behavior, not universal translation quality.

## Issue outcome

Verification was [recorded on Issue #71](https://github.com/takahirox/my-audio-to-text/issues/71#issuecomment-6058291113)
before closure. Issue #71 was then closed as **completed** at
**2026-10-08T10:54:03Z**, referencing merged PR #72. The same comment was updated
to report the closed outcome. GitHub readback confirmed `closed`/`completed`
and the expected comment body. Comment timestamps and final state are retained
in the structured Pages evidence. No reopen was performed.
