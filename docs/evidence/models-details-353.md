# Models Details consolidation — Issue #353

Each of the 17 cards now has one native, initially closed Details disclosure.
Verified byte counts, file inventories, planning/dependency metadata and compact
legal/source links live inside it. Model name, state, brief size metadata, voice
selection and existing actions remain available when collapsed. TranslateGemma
keeps a short restriction notice and direct Google terms/policy links before
Download; its attribution/conversion notice is inside Details. No cache,
download, verification or inference implementation changed.

## Legal destination review

Existing documents are reused; no new legal documents or license grants were
introduced. License text is retained unchanged. The browser regression opens
every card's primary destination and checks model-specific attribution,
license references and conversion provenance in the actual returned document.

| Cards | Destination and retained information |
| --- | --- |
| ReazonSpeech, Silero, Whisper, Zipformer | `web/third-party-notices.txt`: authors, model/runtime pins, conversion/export information and full local license references. |
| Parakeet | Same existing notices: NVIDIA, ysdede/istupakov conversion revisions, CC BY 4.0, retained converter attribution and modification requirements; replaces the upstream card alone. |
| Moonshine | Same existing notices: Useful Sensors/Moonshine AI, dated checkpoint, MIT license, bundled dependency notices and MPL source availability; retains the previous model-documentation URL in the notice. |
| OPUS-MT in both directions | Same existing notices: Helsinki-NLP and ONNX Community/Kadonox conversion pins and license references; replaces the bare CC BY URL and upstream-only card. Explicit attribution/conversion retention reminder added for Japanese → English. |
| Kokoro Japanese frontend | Existing complete `web/licenses/kokoro-japanese.txt`: adapted frontend authors, MIT/BSD/Apache texts, dictionary notices and Mei voice CC BY 3.0 attribution. |
| Qwen3-TTS, CosyVoice3 | Existing model notices: original/converter attribution, separate decoder, modified graph provenance, packaged model/runtime licenses; CosyVoice3 retains Koizumi et al., LibriTTS-R speaker/utterance and CC BY 4.0 derived-feature notice. |
| Text Summary LFM2.5 | Existing full LFM license, with a short attribution/pin header and revenue-condition/redistribution references added. |
| Text Summary Qwen3.5 | Existing full Apache license, with Qwen Team/source and pinned ONNX Community conversion attribution added, including unavailable exporter details and redistribution/modification requirements. |
| IfCondition | Existing Moritz Laurer/Microsoft attribution, pin, MIT license and notice. |
| TranslateGemma | Existing `gemma-notices.txt`: Google and ONNX Community, exact conversion pin, required Gemma Notice, upstream terms/policy, redistribution and modification obligations. |
| Supertonic 3, Kokoro | Existing `tts-notices.txt`: Supertone/hexgrad, model/voice pins, OpenRAIL-M/Apache license references, Japanese frontend notices and eSpeak GPL source obligations. Kokoro's selected `jf_alpha`/`af_heart` voice mapping is now explicit. The separate eSpeak source/build link remains inside Details. |

Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms) and
[Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) were
reachable during review. The existing notice covers the terms' required Notice,
use restrictions and downstream distribution obligations. The pinned
[OPUS-MT conversion card](https://huggingface.co/onnx-community/opus-mt-ja-en/raw/05470cd69b62aa32e3ee64ccfd41279789ee4b1e/README.md)
was also checked directly: it declares `cc-by-4.0`; this change preserves the
existing checkpoint-specific license assessment.

## Validation

- `npm test`: 989 passed.
- Targeted extension run: 33 passed across `model-details`, `model-card-actions`,
  `model-inspection`, `model-persistence`, `shared-ui`, `translategemma` and
  `simple-layout`, excluding the three unrelated Live queue cases below.
- Packaged cache/voice integration run: 12 passed across `model-cache` and
  `model-asset-voices`. Covers real MV3 streaming verification, corruption,
  cancellation, cache reuse/deletion, profile restart and shared voice files.
- The final `model-details` run passes both tests, including all 17 destinations,
  collapsed/reset state, no nested disclosures, Enter/Space/Tab navigation,
  visible focus, 44px target height, touch activation, and no horizontal overflow
  at 1440px and 390px. Chrome screenshots were visually inspected at narrow size.
- `npm run build:extension`: 264 verified files; no model weights. Packaged UI
  and legal documents were compared with source. The packaged eSpeak archive
  includes the source tarball, adapter, Dockerfile, build instructions/scripts
  and engine checksum; Qwen model/runtime licenses/notices are present.
- `git diff --check`: passed.

The initial inspection test's old Window CacheStorage hook did not intercept
SharedWorker inspection. It now holds inspection requests at the page's message
port, retaining the production worker and deterministic Checking-state coverage.

Three pre-existing `simple-layout.spec.js` cases named “Live shows queue failures,
replaces prior errors and clears them on restart” fail for Qwen3TtsStreaming,
CosyVoice3Streaming and OpusMtJaEn. All three were reproduced in a separate,
unchanged worktree at `cea9585`: the first two wait for enabled Start, and the
third waits for a visible Retry models button. No production Live behavior or
unrelated fixture was changed to address them.

Real model inference and physical-device testing were not run for this
presentation/legal-link change. No push, publication or post-merge checks were
performed.
