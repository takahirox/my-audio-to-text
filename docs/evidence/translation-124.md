# TranslateGemma 4B in the extension — Issue #124

Validated locally on 2026-10-18. No push, PR, merge or Issue comment was made.

## Implementation

Graph version remains **9**. Graph Editor exposes **TranslateGemma 4B English →
Japanese** (`TranslateGemmaEnJa`) and **Japanese → English** (`TranslateGemmaJaEn`).
Both use the existing committed `TranslationSchedulerNode`, `text: TEXT` input
and grouped `source/text/error: TEXT` outputs. Direct plain-text fan-out and
TextFormatter need no model-specific sink. No preset, new schema migration,
global model selector or framework layer was added. Defaults and prior graph
migrations are preserved; disconnected Nodes remain saved and prepared but do
not run until they belong to a complete source-to-sink path.

The production Worker retains Transformers.js 4.0.0-next.3 and its pinned ONNX
Runtime Web asyncify loader. Each concrete Node sends its fixed direction, and
the Worker uses the checkpoint's translation chat template with explicit
`source_lang_code: en`, `target_lang_code: ja` (or the reverse). Neither the
conversion nor template required replacement or patching. Worker WebGPU and
adapter checks precede model loading; hardware/memory errors have guidance and
there is no automatic fallback.

Both directions share `onnx-community/translategemma-text-4b-it-ONNX` at
`f7874a1ac60758872a4f78aac0df95b17b776994`, **q4**, eight files totaling
**3,111,911,678 bytes**. The manifest includes config/generation config,
tokenizer config/JSON, chat template, ONNX graph and both external-data shards.
Its 2,973 bounded 1 MiB SHA-256 chunks were computed from downloaded bytes and
checked against the immutable upstream file sizes, LFS whole-file hashes or Git
blob identities. `review-translategemma-assets.py` reverified the committed
manifest without modifying it. Runtime JS/MJS/WASM is packaged, while weights
remain outside setup/build. Extension loading permits only verified cached
manifest URLs; missing optional files use local lookups with remote loading
disabled. Graph Save persists before preparation, and failed downloads leave
the saved graph intact. Models supports recovery, integrity checking, deletion,
progress, Cancel/retry and shared storage reuse.

Graph Editor, Models, guides and the packaged Gemma notice describe the 3.112 GB
download, roughly 7 GB free storage, several GB RAM/GPU memory per active Node,
Google Gemma Terms and Prohibited Use Policy, and ONNX conversion provenance.
Public conversion access does not remove Google's terms or grant independent
redistribution rights. No tokens or user text are submitted.

## Checks

| Check | Result |
| --- | --- |
| `npm run setup:extension` / `npm run build:extension` | Passed; real pinned packaged runtimes and baseline speech assets |
| `python3 scripts/review-translategemma-assets.py` | Passed; all eight files, 3.112 GB, complete hashes |
| `npm test` | 388 passed, 0 skipped |
| Chromium `tests/browser/translation.spec.js` | 18 passed; production Worker protocol with fixture inference |
| MV3 `translategemma.spec.js`, `graph-models.spec.js`, `translation.spec.js`, `model-cache.spec.js` | 50 passed |
| MV3 `graph.spec.js`, `graph-concurrent.spec.js`, `graph-interactions.spec.js`, `graph-number.spec.js`, `graph-optional-asr.spec.js`, `graph-whisper.spec.js`, `graph-zipformer.spec.js` | 54 passed across main run and targeted rerun |
| Real MV3 Gemma with verified loopback asset mirror | Passed, no model/runtime/inference mocks; [captured evidence](translation-124-gemma-mirror.json) |
| Real MV3 Gemma with full public asset preparation | Passed, unmodified packaged manifest/runtime/Worker; [captured evidence](translation-124-gemma-public.json) |

The first layout run found a stale expectation of six Models cards; it now
expects seven and its targeted rerun passed. The first semantic run rejected
the idiomatic equivalent `会議は10時からです。` for uppercase “THE MEETING STARTS
AT TEN.” The fixture now accepts that explicit start-time construction, while
still requiring meeting and ten o'clock meanings. This was a matcher correction,
not a model/prompt change.

The deterministic suites cover Save/reload, preparation only for referenced
Nodes, parked Nodes, shared cache reuse, corrupt/incomplete/evicted assets,
quota/network failures, Cancel/retry, stale replies, missing Worker GPU/adapter,
load/inference/Worker failures, FIFO grouping and Stop/drain, repeat runs,
independent branches, and TEXT routing to formatter/Live/fields/TTS. They execute
production graph/cache/Worker code but substitute hardware or inference where
fault control is needed. They are not translation-quality evidence.

## Real packaged inference

The real test loads the actual extension package under its unchanged Manifest
V3 CSP, creates production `Text → TranslateGemma → TextFormatter → Live.append`
and direct translated-TEXT fan-out with the real graph builder, and runs an
independent Text/Live branch. A saved parked reverse-direction Node prepares
the same weights without creating another Worker. The first input comes from
the production Text Node; further controlled fixtures traverse that source's
TEXT routes and the committed FIFO. No model or inference implementation is
mocked. Stop drains every fixture and disposal releases the one owned Worker.

Host: Chromium **153.0.8010.12**, macOS, **Apple Metal 3** WebGPU adapter,
cross-origin isolated. Adapter maxBufferSize and maxStorageBufferBindingSize
were both 4,294,967,292 bytes. No GPU-enabling or CSP-relaxing browser flag was
used; extension debugging enabled Playwright's unpacked-extension loading only.

Verified mirror run at **2026-10-18T07:48:17.978Z**:

- Save prepared all eight real files through the production streaming cache
  and unchanged hashes. The second Save made no asset requests.
- First English → Japanese run: **12 fixtures**, about **10.33 s** including
  verified cache loading, GPU initialization, all inference and drain.
- New page/Worker offline English → Japanese run: the same **12 fixtures**,
  about **8.55 s**. All outputs were identical to the online run.
- New offline Japanese → English Worker: one meeting fixture, about **5.46 s**.
- Sources stayed paired in order, no model errors occurred, and the independent
  display remained usable. Runtime made **zero external requests**, including
  on the online run. All captured requests were GET with no request body or
  fixture text in URLs. No executable network downloads occurred.
- The mirror changed only the manifest's asset transport `sourceURL`; the
  production package's runtime, Worker, model bytes and expected hashes were
  unchanged. The public pinned config separately passed browser CORS/COEP.

Public-URL run at **2026-10-18T07:54:21.614Z** also passed, using the unmodified
packaged extension and pinned HTTPS URLs (no mirror). It downloaded and verified
all eight model files through real Chrome CORS/COEP, CSP and Cache API handling,
then reused them on a second Save without external requests. The whole check,
including the 3.112 GB public download, took approximately **5.5 minutes**.
The 12 online and 12 fresh offline English → Japanese outputs and the offline
Japanese → English output matched the mirror run. Full load/inference/drain
latencies were approximately **8.52 s**, **8.06 s** and **5.10 s**.
All runtime inference requests stayed on the extension origin; external traffic
was model-data-only GET requests to Hugging Face and its asset-delivery hosts.
Signed download query strings are omitted from evidence, while method, body and
fixture-text-in-URL checks remain recorded. No executable network download or
remote inference occurred. There were no hardware-dependent skips.

Representative observed meanings (full outputs are in the JSON evidence):

| English input | Observed Japanese |
| --- | --- |
| The meeting starts at ten. | 会議は10時から始まります。 |
| Please send me the report. | レポートをお送りください。 |
| We need to finish this project by Friday. | このプロジェクトを金曜日までに完了させる必要があります。 |
| Could you repeat the last point more slowly? | 最後の点について、もう少しゆっくりと繰り返していただけますか？ |
| Please do not send the report until Friday. | 金曜日まで、レポートをお送りしないでください。 |

The reverse fixture `会議は金曜日の午前十時に始まります。` produced
“The meeting will begin at 10:00 AM on Friday.” The assertions check meeting,
weekday and time semantics, as well as source retention and direction; they do
not rely on nonempty output or Japanese-script checks alone.

## Scope and limitations

These are representative controlled text fixtures, including ASR-style
uppercase, conversational requests, a meeting time, a deadline and negation.
They do not establish general translation accuracy or quality superiority to
OPUS-MT. A comparative quality assessment remains a separate user evaluation.
The real smoke uses Text input, not a new audio-recognition quality benchmark;
ASR-final composition and field/TTS fan-out are covered by integration tests.
Real inference ran on the supported Apple adapter only. Other GPUs, driver
failures and low-memory devices are not certified by this result; unsupported
conditions use the tested explicit error paths. Inputs remain limited to 1,000
UTF-16 code units and generation to 256 tokens, as in the existing Worker.

Existing real OPUS-MT/TTS/ASR model smokes were not rerun for #124; their unit,
protocol, graph, migration and recovery regressions above passed. No
hardware-dependent skip is counted as real inference success.

No check introduced by #124 requires waiting until after merge. No new required
post-merge verification is pending.
