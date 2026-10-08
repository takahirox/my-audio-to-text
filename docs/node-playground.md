# Node Playground

The [published Web entry point](https://takahirox.github.io/my-audio-to-text/)
lists available processor nodes. Each link opens a small, independent test page
that supplies valid inputs to the actual node and displays its outputs and
practical status/errors. The list currently has one entry:

- [Speech-to-Text (ReazonSpeech ja-en)](https://takahirox.github.io/my-audio-to-text/nodes/speech-to-text/):
  microphone or browser-tab audio → `SpeechToTextNode` → provisional/final
  transcript sink, connected through the shared Node/Port pipeline.

The speech page preserves model loading, diagnostics, Stop/drain, Cancel/release,
retry and repeat. ReazonSpeech ja-en + Silero/hayamimi is fixed to this node;
there is no model selector. See [speech setup and testing](asr-manual-testing.md)
for permissions, assets and browser limitations, and the
[runtime guide](pipeline-runtime.md) for the actual node contracts.

The Node Playground is a browser testing surface for processors. The pipeline
runtime is the reusable execution/connection layer. The
[Chrome extension](chrome-extension.md) uses that runtime and speech node with
its own tab-capture adapter, toolbar/transcript UI and package.

## Add an independent node page

1. Implement the real processor node using the existing
   [Node/Port contract](pipeline-runtime.md). A different model implementation
   belongs to a distinct node with its own test page.
2. Add `web/nodes/<node-name>/index.html` and a local `app.js` if needed. Use
   node-specific controls to provide valid inputs, connect the actual node to
   suitable sources/sinks, run it and show its outputs. Handle its lifecycle,
   resource cleanup and useful errors. Text input/output may be enough for a
   text processor; the speech page's audio controls and metrics are not required.
3. Add a normal relative link in `web/index.html`. Add a return link to `../../`
   on the test page. Shared modules/styles stay under `web/`; from the node page,
   import them with `../../` paths. Resolve worker/worklet URLs from the module
   that owns the asset, rather than the document URL.
4. Add deterministic browser coverage for navigation and the real node's input,
   output and lifecycle. Keep heavyweight model inference checks separate from
   controlled worker/permission fixtures.

No registry, generic configuration form, shared metrics layout or plugin SDK is
needed. Each page can differ according to its node's input/output needs.

## Static serving and deployment

`npm run serve` serves `web/`; `/` is the list and `/nodes/speech-to-text/` is
the speech page. The [Pages workflow](../.github/workflows/pages.yml) prepares
the pinned runtime/models and uploads the entire `web/` directory recursively.
There is no bundler or separate page build. Keep `web/vendor/`, shared modules,
workers, licenses and notices at the Web root. Extension packaging continues
to copy the shared files and prepared assets without the Playground pages.

All navigation and asset URLs retain the GitHub Pages repository prefix
`/my-audio-to-text/`. The speech page registers the root `isolation-worker.js`
using a URL relative to its controller module; the worker's default scope is
the Web root, covering the speech page and shared assets. It adds COOP/COEP
headers, caches nothing and may reload the page once. The static list needs no
recognition runtime or isolation setup. Existing root worker registrations still
use the same script/scope after upgrading from the dedicated demo.

Run `npm test`, `npm run test:browser -- --workers=2`, `npm run prepare:assets`,
`npm run build:extension` and `npm run test:extension`. The browser suite tests
the plain static server and a repository-prefix alias without server isolation
headers. Opt-in real-model checks use the migrated speech page too.

## Required post-merge verification

**Completed for Issue #63 on 2026-10-08.** The published pages and assets were
verified against merge commit `3de5984b424ef17cbadfc65ef9a160d24b5dc6a3`. See
[deployment, browser and model-loading evidence](evidence/node-playground-pages.md),
including the separate deterministic-suite results. Future changes should repeat
these checks after deployment:

1. Confirm the successful Pages push/deployment run belongs to the merged commit
   SHA; record the run URL, SHA and verification time.
2. Load the canonical published entry point in a fresh browser context. Confirm
   the Node Playground list, click Speech-to-Text, and confirm its heading,
   enabled Load button and cross-origin isolation. Confirm the return link and
   direct speech-page URL work.
3. Load the fixed model and check the browser's network/runtime errors. Verify
   the nested HTML/controller, root styles/modules, isolation worker, ASR/VAD
   workers, capture worklet, notices, and `vendor/sherpa-ja-en/` JS/WASM/data
   resolve under the repository prefix. Record successful asset requests and
   model readiness from the deployed revision.

Use `ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ npm run test:browser -- --workers=2`
for published deterministic checks (the local alias test is skipped), and
`ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ ASR_TEST_VAD=1 npm run test:browser -- tests/browser/model-smoke.spec.js --project=chromium --workers=1`
for pinned model loading and silence Stop/repeat. These results supplement the
deployment SHA and published navigation/asset evidence.
