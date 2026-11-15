# Function-first AI node labels (#380)

All 16 AI-backed graph types now carry display-only function, model, language and
runtime facts in their node definitions. Canvas and Add Node use the same small
sparkles icon (accessible name `AI`) and smaller, persistent model subtitle.
Settings exposes semantic read-only Model/Languages/Runtime facts above existing
editable controls. Search matches both title and model; category sorting uses
functional title then model name, including Japanese kana and natural numbers.

The pre-change graph/contract fixture was captured from commit `5c87735`.
`tests/graph-ai-presentation.test.js` checks byte-identical graph round trips and
hashes every non-presentation definition field (ports, defaults, grouping, help).
No graph version, inference configuration, asset requirement or model selection
changes. The stale palette classification for the nonexistent
`StreamingSpeakerOutput` was removed; the existing Speaker remains unchanged.

Automated coverage includes all 16 canvas cards, palette model search, duplicate
function titles, accessible names, selection/focus and inspector facts at 1440px
and 320px. Both Chromium and WebKit pass these checks. Existing palette,
port-order, movement, pointer/touch and layout checks also pass. The existing
Models terms test was updated to use the current per-model Details link.
Updated palette screenshots: `graph-231-1440.png`, `graph-231-390.png`.

Parakeet's language list follows the [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
Its runtime description includes the WebGPU encoder and CPU/WASM decoder;
Whisper accurately lists only English (default) and Japanese accepted here.

Validation results and environment limitations:

- Unit suite: 1,082 passing tests.
- Browser suites: 116 passing checks across Chromium and WebKit (112 passed in
  the main run, and four Models-link checks passed after their fixture update).
- MV3 extension suites: 39 passing checks covering Auto Save, model preparation,
  shared caches, summaries, Whisper, Zipformer, typed connections and movement.
- Four broader `graph.spec.js` checks also fail in the original checkout:
  two stale TTS status expectations, one stale missing-assets error expectation,
  and one Models cache-state expectation. They are unrelated to label rendering.
- Packaging cannot complete without the checkout's missing vendored weight-free
  `vendor/sherpa-ja-en/sherpa-onnx-asr.js` runtime. No real model weights were
  downloaded or inference configurations changed for this presentation task.
