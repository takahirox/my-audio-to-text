# On-demand model assets (#323)

Validated November 12, 2026 on macOS with Chromium 153.0.8010.12,
Node 26.12.1 and Python 3.13.13.

The extension build audits 258 payload files against a 74-entry runtime
allowlist plus maintained source/manifests/notices. `asset-inventory.json`
records their sizes and SHA-256 hashes and `modelWeights: 0`. It excludes its
own self-referential hash. The build succeeds without any model files: the
packaging unit fixture has no model cache and deliberately puts stale weights
in every former generated directory, verifying that none are copied.

The 6,935,355-byte weight-free sherpa runtime package contains seven JS/WASM
members, no model preload image, and reproduces SHA-256
`36f841a3934d9859d66af11d262d5424d7db4804a5633319805a1e9677901931`.
`npm run setup:extension` passes using only runtime preparation. The OpenJTalk
statistical voice is excluded from TTS preparation; runtime/dictionary files
are fetched independently with pinned hashes. Original model revisions,
virtual filenames and recognizer/VAD configurations are preserved.

Validation:

- `npm test`: **964 passed**, zero failures/skips, including packaging inventory,
  checksum/cancellation/quota/eviction recovery and all-or-nothing deletion
  while a shared file is in use.
- `LOCAL_ASR_SMOKE=1 ... local-asr-assets.spec.js`: **4 passed**. Actual
  ReazonSpeech/Silero, Whisper/Silero, online Zipformer and Japanese Kokoro
  frontend voice, with verified downloads, offline startup/inference, missing
  and same-length corrupt cache recovery, exact dependency downloads, repeat,
  Stop and cross-tab deletion protection/release. ReazonSpeech also exercises
  real Graph Auto Save preparation without Workers and the production
  TabSession prepared/warm Start path. Loopback replaces only download sources;
  pinned speech replaces capture hardware. Inference code remains production.
- `... local-asr-preparation.spec.js`: passes for a clean profile, model-free
  offline editing/execution, no eager downloads, and exact deduplicated
  ReazonSpeech/Whisper/shared Silero preparation without inference Workers.
- Existing Chromium web ASR/thread/plumbing tests: **30 passed**.
- Actual web ReazonSpeech Japanese/English/mixed speech: **1 passed**, zero
  page errors, same pinned model/runtime and one production thread.
- Unmodified extension fetches from the actual pinned Silero mirror and
  Japanese frontend voice CDN both reach verified Ready, with unchanged
  permissions/CSP. The original GitHub release URL fails browser CORS, so
  Silero uses a commit-pinned CORS mirror of the exact original binary.
- Python compilation and `git diff --check`: pass.

The broad default Chrome extension sweep exercised 383 cases: 331 passed,
26 opt-in cases skipped, and 26 failures. Four failures were obsolete fixture
expectations or preparation timing and pass on focused reruns (Zipformer
selection, layout preparation, Live navigation labels and cache deletion after
session release). The remaining **22 failures** are in the existing
`targets.spec.js` (21) and `toolbar-launch.spec.js` (1). Representative cases
were reproduced from the selected upstream commit **562e1eeb7f755265c76e03174a7a43203ed92791**:

```sh
npx playwright test --config playwright.extension.config.js \
  tests/extension/targets.spec.js tests/extension/toolbar-launch.spec.js \
  --grep 'plain TEXT appends verbatim to #focused|Edit graph targets its own' \
  --workers=1
```

Both also fail upstream. The target fixture expects the toolbar to retarget
its pre-existing manually opened Live page; that page is Ready with no error
but has no invoking tab, leaving Start disabled. The navigation fixture waits
for a page event during its Models keyboard navigation. These failures are
recorded explicitly; this evidence does not claim a completely green default
extension suite or qualification of every optional multi-GB model backend.

No audio/text is uploaded, no model choice/graph format is changed, and no
extension host permission or remote executable-code exception is added.

## Publication integration

Integrated `main` at `6b8bb1c805a1ab382e201331ff572be6dbfbc740` before
publication. Conflict resolution preserves the extension name and removed Chrome
Options entry, simplified Models page, automatic persistence before missing
asset downloads, and automatic cache inspection from #307/#318/#324/#326/#329.
The five newly downloadable model cards inherit these behaviors. No manual
Check cache button or persistence controls are reintroduced.

Validation after integration:

- `npm test`: **978 passed**, zero failures/skips, including packaging inventory,
  shared-file deletion leases and automatic persistence tests.
- Chromium `local-asr-preparation.spec.js`, `model-inspection.spec.js`,
  `model-persistence.spec.js` and `simple-layout.spec.js`: **14 distinct tests
  passed** (13 on the initial sweep; all three persistence tests passed after
  updating the readiness assertion for the additional ReazonSpeech/Silero cards).
  Covers offline model-free execution, exact graph dependency preparation without
  Workers, corruption/eviction recovery, cross-page inspection, concurrent
  downloads/persistence, legal links, and narrow/wide layouts.
- Real inference and the complete production setup/build were not repeated at
  publication; the implementation results and broader-suite limitations above
  remain the evidence for those checks. The real-ASR smoke's corruption step now
  triggers the existing automatic focus inspection instead of the removed button.
