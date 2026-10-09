# Issue #78: post-merge Pages verification

PR [#80](https://github.com/takahirox/my-audio-to-text/pull/80) merged as
`58000ca292f33b27251a9dc4b954e429ad0e18ae`.
The [Deploy Node Playground run](https://github.com/takahirox/my-audio-to-text/actions/runs/37911894375)
completed successfully for that exact SHA; both build and deploy jobs succeeded.
Verification completed **2026-10-09T09:35:57Z**.

Fresh Chrome **154.0.8037.99** browser contexts visited the published origin,
without existing origin storage or mocked inference for the real-model check.
The [index](https://takahirox.github.io/my-audio-to-text/)'s
`./nodes/qwen3-correction/` link opens the
[correction Playground](https://takahirox.github.io/my-audio-to-text/nodes/qwen3-correction/).
Twelve published tracked files, including the index, nested HTML/app, Pipeline,
Node, shared contracts, policy/cache, dedicated Worker and notices/license,
matched Git blob hashes from the merge commit. The four staged correction
runtime/license assets returned HTTP 200 and totaled **27,771,302 bytes**.
See [deployment hashes and UI checks](correction-78-deployment.json).

Navigation and direct bypass downloaded no inference runtime or model assets.
Bypass preserved the original and candidate separately. Empty and overlong
inputs exposed clear errors, Cancel retained the original and cleared the
candidate, and Generate became usable again. The existing production-Worker
browser regression suite also ran against Pages with only heavy inference and
GPU capability mocked: **15 passed**. It covered repeated runs, load/inference
errors and recovery, cancellation during loading/generation, FIFO/drain, output
bounds, unsupported GPU, cache persistence and quota warnings.

## Real deployed inference and limitations

The opt-in production Worker/Pipeline smoke ran from Pages even though published
asset access ultimately behaved like localhost. **1 runtime/privacy smoke
passed** using the pinned Qwen3 0.6B q4f16 checkpoint and runtime. Apple
`metal-3` WebGPU with `shader-f16` was available; HTTPS was secure and
cross-origin isolation was false. Runtime JS/MJS/WASM loaded from
`/my-audio-to-text/correction-assets/`; model/tokenizer GETs used immutable
revision `1e0a4a196ecabdf9a879664110574563d3f372d3` and permitted Hugging Face
asset redirects. All **33 requests were GETs**, with no bodies or fixture text
in URLs, no remote inference and no page errors. Signed query parameters were
removed from the [real-model evidence](correction-78-deployed-model.json).

- Cold load/initialization: **68,066 ms**. Fifteen ordered generations took
  **88–679 ms** each, followed by drain/dispose.
- Batch `language: auto`: all **10 distinct correct fixtures** and the repeated
  Japanese fixture were exact copies, including dates, figures, names and
  negations. All **4 intended corrections were missed**. No successful
  correction or batch regression was observed.
- Separate real Playground `language: ja`: **63,746 ms** initialization and
  **213 ms** generation/drain. Correct `今日は良い天気です。` became
  `良い天気です。`, again dropping “today.” Original and candidate remained
  separately visible. This is a semantic regression despite a completed run.
- Config/tokenizer metadata and tokenizer persisted and were reused by the
  fresh Playground Worker. Weight caching failed with a visible `Cache.put`
  internal error, so the new Worker fetched weights again. Cached/offline
  weight availability remains unverified and device dependent.

Required post-merge deployment verification is now performed and recorded.
Runtime/privacy success does **not** establish correction quality improvement.
The existing optional/bypass design remains necessary; no default graph or
Chrome extension behavior was changed in this verification node.

## Issue outcome

The [verification record](https://github.com/takahirox/my-audio-to-text/issues/78#issuecomment-6078346371)
was posted before closure. Issue #78 was closed as completed at
**2026-10-09T09:37:55Z**, referencing merged PR #80; an outcome comment was then
posted and the closed state read back from GitHub. No quality improvement is
claimed by this closure.
