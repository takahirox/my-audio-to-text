# Issue #172 — CosyVoice3 MV3 streaming validation

Pre-merge implementation and automated validation completed on 2026-10-31.
**Required post-merge verification: pending. Keep Issue #172 open.** This report
qualifies the pinned CosyVoice3 path on the hardware below; it does not borrow
Qwen3-TTS timings or establish production deployment.

The [implementation and reproduction guide](../cosyvoice3-streaming.md) describes
the flow mask, lookahead, retained mel and HiFT right-context changes. A real
long-prefix check also found and repaired stock WebGPU ORT's nearest-Resize
uint32 overflow. The original model cache bytes remain intact; deterministic,
digest-checked ONNX transformations run locally and mark derived graphs as
modified in model metadata. [Sources, licenses and exact graph hashes](../cosyvoice3-artifacts.json)
and [cache hashes](../../extension/cosyvoice3-assets.json) cover all eight files
(916,881,956 bytes). No unreviewed native checkpoint is offered as a runnable Node.

## Actual package, hardware and timing

The normal `npm run setup:extension` and `npm run build:extension` produced
`dist/chrome-extension`. Tests copied that package with unchanged inference,
graph, cache, manifest and CSP code. Only asset transport URLs and observation
hooks were added to the test copy. Save/Models verified real pinned bytes from
loopback; subsequent Start ran offline. The production hashes and sizes were
unchanged. CSP was `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.

Hardware: Apple M4 Max, 64 GiB unified memory, macOS 27.2, Chrome 156.0.8078.74,
Apple Metal 3 WebGPU. Runtime: stock ORT 1.31.1 and Transformers.js 3.8.1.
Worker GPU inference, tokenizer, 24 kHz PCM, AudioContext scheduling and nonzero
analyser rendering were real. Output AudioContext resampling used 48 kHz.

Times below are milliseconds from each Worker stream start, after initialization.
[Absolute timestamps, generation-state diagnostics, complete event ordering,
texts and memory samples](cosyvoice3-172.json) are recorded separately.

| Language | Utterance | First PCM | First nonzero render | Synthesis complete | Chunks |
| --- | --- | --- | --- | --- | --- |
| english | 1 | 3277.25 | 3323.57 | 8120.16 | 5 |
| english | 2 | 1204.36 | 1248.58 | 4398.02 | 4 |
| japanese | 1 | 1229.09 | 1268.14 | 7481.67 | 6 |
| japanese | 2 | 1209.74 | 1256.21 | 3453.77 | 3 |

For every utterance, first render preceded completion. First PCM was marked
`synthesisComplete: false` with 44 speech tokens; later token generation remained
inside the same Worker request. The final chunk was marked complete only after
real token EOS and vocoder tail flush. The second utterance was queued while
the first was active; Stop drained both in order, ending with zero queued bytes,
zero chunks and closed audio contexts. Offline Start made zero model requests.

- English: sampled aggregate RSS peak **4,812,947,456 bytes (4.48 GiB)**, 17 samples, 0 sampling errors; 2 playback underruns. Cancel UI completion took 12 ms; no new scheduling during the following 150 ms.
- Japanese: sampled aggregate RSS peak **5,486,903,296 bytes (5.11 GiB)**, 16 samples, 0 sampling errors; 2 playback underruns. Cancel UI completion took 15 ms; no new scheduling during the following 150 ms.

RSS was sampled every second from this test Chrome process tree. Shared pages
may be counted more than once; GPU driver allocations are not isolated. These
are observations, not a certified memory minimum. Cold shader compilation and
prefix recomputation affect latency. Underruns were observed, so this evidence
does not promise uninterrupted real-time playback. Available adjacent chunks
scheduled contiguously; starvation used Speaker's normal 40 ms restart lead.

Generated PCM artifacts: [English WAV](cosyvoice3-172-english.wav),
[Japanese WAV](cosyvoice3-172-japanese.wav). Their SHA-256 hashes are in the JSON.
No physical loudspeaker acoustics or subjective human listening was required.

## Export and regression checks

The [real differential report](cosyvoice3-172-prefix.json) exercises nonfinal
prefixes at 44, 169 and 494 generated speech tokens against a 500-token reference.
Flow prefix rounding differed by at most 0.00435114, which is why previously
accepted mel is retained. With identical retained mel/noise, emitted PCM differed
by **zero** at all three boundaries through the cap. Untrimmed right-context
samples differed, confirming the withheld tail is necessary. Both transformed
graph digests matched the reviewed manifest. Before the Resize repair, the long
prefix differed by about 0.5085 before that withheld tail.

| Check | Result |
| --- | --- |
| Full extension preparation/build | Passed |
| Node unit suite | 782 passed, zero skipped/failed |
| Browser TTS regressions (controlled inference) | 20 passed |
| Selected MV3 graph, persistence, model preparation/cache and completed-clip Speaker regressions | 36 passed across the selected suite and affected layout recheck |
| Built Qwen3-TTS controlled streaming transport | Passed |
| Built CosyVoice3 controlled streaming transport | Passed |
| Real built CosyVoice3 prefix and bilingual streaming | 2 passed; one Qwen-only decoder test skipped as inapplicable |
| Diff whitespace, JS syntax and Python compilation | Passed |

The broader MV3 run initially found a stale count of ten Models cards; it now
asserts twelve (including Qwen3-TTS and CosyVoice3) and explicitly checks the new
card. All other 35 selected cases passed before that layout-only recheck. The
Playwright browser initially needed installation; the completed checks used the
installed browser and did not skip regression cases.

Shared stream-owner tests cover repeated text, accepted queue bounds,
provisional/oversize rejection, sequence errors, Stop drain, Cancel during load
and generation, bare teardown, retired errors and late replies for both models.
Cache tests cover verified cache-only Start, corruption, eviction, storage
failure and allowlisted reads. Real bilingual tests also cover Stop, Cancel,
consecutive utterances, offline Start and playback ordering. Speaker remains
producer independent. Existing Supertonic3/Kokoro, completed clips and manual WAV
regressions passed; their real-model quality runs and the Qwen real-model decoder
run were not repeated in this node.

## Review and remaining verification

Source/diff review followed [review guidelines](../review-guidelines.md): model
work stays in the owned Worker; shared ownership is factored from the existing
Qwen Node without changing its contract; no graph version, completed-clip port,
CSP or background service behavior changed. No cloud fallback, remote code,
remote inference or unrelated UI workflow was added. Asset/license attribution,
limits and unsupported configurations are explicit. This is ready for the normal
independent PR review; this report is not PR approval. No PR, push, merge or
GitHub comment was created by this node.

Required post-merge verification is **pending**. Against the merged revision,
repeat the documented real built-package command with the same asset/runtime
pins on recorded hardware. Capture first PCM, first nonzero render, EOS, memory
and underruns separately for English/Japanese; repeat ordered utterances,
Stop/Cancel and offline Start. Expect first render before synthesis completion,
bounded queues, no stale playback and no model download during Start. Keep the
Issue open until those merged-revision results are recorded. Other GPUs,
low-memory/mobile configurations, arbitrary voices/languages, native text
normalization and sustained multi-Node operation remain unqualified.
