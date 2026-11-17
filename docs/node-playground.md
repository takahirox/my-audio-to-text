# Node Playground

The [index](../web/index.html) links to independent browser-local model tests.
Speech recognition has exactly two pages: [Moonshine Medium Streaming English](../web/nodes/moonshine-medium/)
and [Moonshine Small Streaming Japanese](../web/nodes/moonshine-small-ja/).
Select an audio file, then Run. Stop finalizes the accepted prefix; Cancel
releases resources. Pages show genuine provisional and final output, loading time
and replay/inference time. Neither model detects or switches languages.

Translation pages test OPUS-MT in each direction and TranslateGemma. Text pages
test both summary models and IfCondition. Speech synthesis pages test Kokoro,
Supertonic 3, Qwen3-TTS and CosyVoice3. Experimental transcript correction has its
own page. All inference stays on the device; only explicit actions start downloads.
GPU models require supported desktop WebGPU hardware and sufficient memory.
Kokoro's Japanese OpenJTalk frontend remains a separate TTS dependency.

## Local development and Pages

```
npm ci
npm run prepare:playground-assets
npm run serve
```

Open http://localhost:8000/ . Use HTTPS or localhost for Worker, cache and audio
APIs. Each page's shared bootstrap installs the isolation service worker and
reloads to provide cross-origin isolation. Nested paths and the deployed
repository prefix resolve relative to the shared web root. GitHub Pages stages
weight-free assets with the same preparation command and publishes `web/`.
No weights are committed or packaged.

```
npm run test:playground
PLAYGROUND_MODELS=moonshine-medium,moonshine-small-ja npm run test:playground-real -- --project=chromium
```

Default browser tests use deterministic inference fixtures while exercising real
nodes, PCM decode/replay, lifecycle, navigation and deployment paths. Explicit
real-model tests use short known speech and attach transcripts/timings; they
are not CI download gates. `ASR_BASE_URL` selects a published deployment. See
[ASR pins, licensing and real-model validation](optional-asr-nodes.md).
