# Issue #73: corresponding-source fix

Validation: 2026-10-09 UTC/JST. Baseline: `5af5d5c`.

The untraceable phonemizer 1.2.1 npm engine has been replaced by our own build
of eSpeak NG `0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582`, using Emscripten
3.1.30 (compiler image digest and build-tool versions are pinned in the
[Dockerfile](../../scripts/tts-phonemizer/Dockerfile)). The
[build script](../../scripts/tts-phonemizer/build.sh) compiles English data
with the native engine, builds the same engine for WASM, and links the upstream
WebIDL glue as a single ES module. The standalone Worker handler is removed;
Kokoro keeps ownership of its Worker. Per-phoneme separators in the upstream
demo glue are disabled so Kokoro receives compact IPA with word spaces.
A regression test checks the actual rebuilt frontend's phonemes.

Two separate source trees were used for native/data and WASM library builds
and final glue links. Their final modules were byte-for-byte identical:
`33c6fbc7c26e4860908909c4375ed836f97d0dad682ba2f5eeba17ef365eb28e`
(SHA-256, 1,742,316 bytes). The complete upstream source archive checksum is
`e6b84b52a87b3ad72885331bd942b2adecd70c384fa4ecfbe10aae7d9afd5e21`.
The distributed GPL text matches the rebuilt source's `COPYING` exactly.

Staging publishes the modules together with `tts-assets/phonemizer-source.tar.gz`
(16,315,334 bytes). The Kokoro page directly links this same-origin download.
The bundle contains the complete upstream source/data archive (2,791 entries,
including native engine, dictionary/phoneme sources, build scripts and licenses),
our adapter/build script, Dockerfile, installation instructions and engine
checksum. Source or engine checksum failures abort staging before publication.
The old wrapper's Apache notice is removed from the staged assets.

Final checks:

- `npm run prepare:tts-assets`: passed; 77,218,463 bytes, including source.
- `npm test`: **182 passed**, including compact IPA and checksum rejection.
- `npx playwright test tests/browser/tts.spec.js --workers=2`: **40 passed**,
  Chromium and WebKit. Both browsers downloaded the full source bundle under
  `/my-audio-to-text/`, verified its source hash and compared its engine manifest
  with the served executable. Production graph/lifecycle fixtures also passed.
- `TTS_SMOKE=kokoro npx playwright test tests/browser/tts-smoke.spec.js --project=chromium --workers=1`:
  **1 passed, 1 skipped** (unchanged Supertonic). The final source-built engine
  generated Japanese, English and repeat English through the production graph;
  native WAV decoding/playback and asset-only, no-body/no-text GET assertions passed.
- Shell/Python syntax checks and `git diff --check`: passed.

Real inference: Chromium **153.0.8010.12**, macOS arm64, Apple **M4 Max**,
16 logical browser cores, single-thread WASM, no cross-origin isolation.

| Language / voice | Load | Generation / drain | Waveform |
| --- | --- | --- | --- |
| Japanese / jf_alpha | 11,655 ms | 4,531 ms | 67,800 samples, 24,000 Hz mono, 2.825 s |
| English / af_heart | 1,604 ms | 4,414 ms | 66,600 samples, 24,000 Hz mono, 2.775 s |
| Repeat English / af_heart | 656 ms | 4,500 ms | 66,600 samples, 24,000 Hz mono, 2.775 s |

All samples were finite and nonempty; duration bounds and nonzero RMS passed.
No page errors occurred. [Sanitized measured evidence](tts-73-kokoro-source-built.json)
records timing, device, waveforms and request summaries without signed URLs.
These timings include concurrent rebuild work and are not a performance claim.
Listening was not performed; it remains optional. The unchanged Supertonic
real-model results remain in the [initial validation](tts-73.md).

Post-merge Pages verification remains **pending**. No push or merge was
performed. Keep Issue #73 open until the required deployed-SHA evidence and
fresh-browser prefix/asset checks are recorded, including deployed-origin real
inference if model-fetch/CORS/COEP behavior differs.
