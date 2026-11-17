# Moonshine streaming speech recognition

The supported speech recognition Nodes are language-specific:

| Node | Model | Language | Runtime | Download |
| --- | --- | --- | --- | --- |
| `SpeechToTextMoonshineMediumEn` | Moonshine Medium Streaming (245M) | English | CPU WASM | 305 MB |
| `SpeechToTextMoonshineSmallJa` | Moonshine Small Streaming (123M) | Japanese | CPU WASM | 122 MB |

Both expose `audio: MONO_16KHZ_PCM`, `provisional: TEXT`, `provisionalId: NUMBER`,
`final: TEXT` and `finalId: NUMBER`. The public labels are **Speech Recognition ·
EN / Streaming** and **Speech Recognition · JA / Streaming**. Model, Languages
and Runtime in Settings describe fixed model facts; there is no language input.
Japanese Small is newly integrated and has not been established as meeting the
user's dictation quality bar.

The native engine emits revisable incomplete lines and completed lines. Japanese
Unicode is preserved. Each graph instance owns a Worker and globally unique
public utterance IDs. Stop drains accepted PCM and native finalization; Cancel
terminates the Worker and rejects late output. Native history renews after 30
seconds, draining first; transport permits at most 30 seconds of queued audio,
with one block in flight. Overflow visibly fails the path instead of dropping
PCM. Hard history boundaries can split words.

The default/reset graph explicitly recognizes **Japanese** with Small Streaming.
The English → Japanese example explicitly uses English Medium; no mixed-speech
language detection is implied. Connect committed `final` to formatting,
translation, history, display, TTS or focused input. Previews may change; route
them only to preview-aware consumers. Microphone and shared tab capture feed the
same mono 16 kHz contract.

## Assets and runtime

`extension/moonshine-medium-en-assets.json` retains the existing English
`medium-streaming-en/quantized_26_07_30` files, cache ID, revision and hashes.
`extension/moonshine-small-ja-assets.json` pins the official Japanese
`small-streaming-ja/quantized_26_08_23` checkpoint: adapter, cross KV, decoder KV,
encoder, split frontend model and weights, streaming config and Japanese
tokenizer. Both manifests record exact byte sizes, SHA-256 and 1 MiB chunk hashes.
`ModelAssetCache` provides download, retry, abort, verification and offline reuse.
No weights ship in extension or Pages artifacts. Live/Auto Save/Models prepare
selected requirements; extension inference reads verified cache only. Standalone
pages prepare on Run on their own origin.

The shared official **v0.1.6 GitHub release** WASM runtime, source
`d8d8fa29d05ca67441a7719e70099f9f48917a93`, supports `SmallStreaming` (4),
`MediumStreaming` (5), in-memory split frontend loading, Japanese tokenization
and string transcriber options. The npm 0.1.5 **and** 0.1.6 packages contain
an older binary that rejects split frontend filenames; preparation uses only
`moonshine-voice-wasm.tar.gz` from GitHub release v0.1.6 (6,607,636 bytes,
SHA-256 `47a8b94f0b10f9b0687491d86e4606a3cd2b332e566766774f8eb0f984d0ed42`).
Its WASM is 13,345,086 bytes, SHA-256
`aeb17e8b7f614796998bfb8ecaffbabf66366cb9faab9ca4de5ef39b95155830`.
No npm Moonshine or separate browser ORT dependency is needed. Japanese passes `max_tokens_per_second: '13'`;
English options are unchanged. Selection uses pinned file maps, never a mutable
catalog or fallback model. `scripts/optional-asr-runtime.json` checks original
and packaged hashes; the WASM is unchanged and `scripts/moonshine-csp.py` adapts
generated JS closures for extension CSP. Both streaming checkpoints and the
runtime are MIT. Retain [notices](../web/third-party-notices.txt), the
[MIT license](../web/licenses/moonshine.txt) and dependency notices.

Reviewed upstream references at `d8d8fa29d05ca67441a7719e70099f9f48917a93`:
[model inventory](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/available-models.md),
[accuracy and token guard](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/accuracy.md),
[official catalog](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-model-catalog.cpp).

## Validation

```
npm ci
npm run prepare:playground-assets
npm test
npm run test:playground -- --project=chromium --workers=2
npm run build:extension
npx playwright test --config playwright.extension.config.js tests/extension/graph-optional-asr.spec.js
```

Opt-in real inference (downloads about 427 MB total):

```
npm run prepare:optional-asr-test-models
npm run test:optional-asr-real
PLAYGROUND_MODELS=moonshine-medium,moonshine-small-ja npm run test:playground-real -- --project=chromium
```

The short committed English and Japanese speech fixtures have known text and
provenance in `tests/fixtures/`. Tests exercise real production Workers, record
partials/finals and latency, require representative recognized content, and
check offline repeat and cancellation. Synthetic speech is a reproducible smoke
test, not proof of accuracy on a human user's voice. Large downloads and manual
quality approval are not default CI gates. See [implementation evidence](evidence/asr-383.md).

Unsupported graph types fail normal validation with guidance to recreate/reset.
There are no aliases, migration loaders or automatic substitutions. Current
supported graphs still import/export and Auto Save normally. Historical evidence
in `docs/evidence/` describes its original commit, not current available models.
