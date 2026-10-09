## Summary

Add independent browser-local Supertonic 3 and Kokoro 82M production Nodes, each with its own inference Worker and Playground page linked from the index. Both synthesize Japanese and English through the existing Pipeline, using named text/audio ports and a shared mono Float32 PCM contract with explicit native sample rates: 44,100 Hz for Supertonic and 24,000 Hz for Kokoro.

Pin immutable model revisions, runtime archives, tokenizers/frontends and voice assets; preserve licenses and usage restrictions. Supertonic uses its official Unicode frontend; Kokoro uses a checksum-pinned eSpeak NG English frontend rebuilt from immutable source and a browser/WASM Open JTalk Japanese frontend. The Kokoro page links the complete corresponding eSpeak source/data/build bundle staged beside its engine; reproducible-build instructions and GPL notices are preserved. [Artifact documentation](docs/tts-nodes.md) records download sizes, exact revisions, cache behavior and limitations. Pages staging adds checksum-verified runtime/frontend assets without bundling model weights.

## Outcome

Each dedicated page provides short text input, supported language/voice controls, Generate, Cancel, loading/errors, load/generation timings, playback and WAV download. Generate runs the actual production Node through a Pipeline connection to an independent audio consumer. Downloads start explicitly; synthesis runs locally with single-thread WASM and no remote inference or input-text transmission.

Owned Workers support cancellation during initialization, generation and drain, repeated runs, stale-reply protection and clear capability/network/model errors. The shared waveform contract preserves each model's output rate. Existing Pipeline runtime, ASR/translation processors, extension inference/packaging and native integration remain unchanged.

## Validation

Initial implementation results are recorded in [Issue #73 evidence](docs/evidence/tts-73.md); [final source-build and Kokoro evidence](docs/evidence/tts-73-espeak-source.md) records the subsequent English frontend replacement and validation:

- Final unit suite after the source-build fix: **182 passed** (initial implementation: 180).
- Initial full Chromium/WebKit browser regression suite: **184 passed, 16 expected opt-in skips**, including 38 TTS fixture checks for production graphs/Workers, repository-prefix paths, ports, playback/WAV, lifecycle/cancellation/repeat and failure recovery.
- Initial extension suite: **40 passed, 2 expected opt-in skips**; runtime preparation and extension packaging passed.
- Initial opt-in real-model Chromium smoke suite: **2 passed**, each generating Japanese, English and repeat English through its actual production page/Node/Worker/Pipeline. Every waveform was finite, nonempty, nonzero RMS and at the expected native rate; native WAV decoding/playback succeeded. Asset-only network assertions passed, with pinned checkpoint paths and no text-bearing requests.
- Real inference ran on macOS arm64 / Apple M4 Max / Chromium 153.0.8010.12, without cross-origin isolation. Sanitized [Supertonic measurements](docs/evidence/tts-73-supertonic3.json) and [Kokoro measurements](docs/evidence/tts-73-kokoro.json) record device/browser/timings and waveform checks. Listening quality and real inference on other browser/device profiles were not evaluated.
- Final source-build fix: runtime staging passed (77,218,463 bytes including corresponding source); two independent builds produced identical engine modules. Focused Chromium/WebKit TTS regression suite: **40 passed**, including source download/checksum/engine-manifest checks under the repository prefix. Shell/Python syntax checks passed.
- Real-model Kokoro smoke after the source-built engine replacement: **1 passed, 1 skipped** (unchanged Supertonic). Japanese, English and repeat English generated through the final production graph at 24,000 Hz mono, with finite/nonempty/nonzero-RMS waveforms, WAV playback and asset-only network assertions. [Final Kokoro measurements](docs/evidence/tts-73-kokoro-source-built.json) record timings/device/browser. Unchanged Supertonic real inference remains established by the initial run; its smoke was not repeated for this fix.
- Publication checks: current `main` and the prior PR head are ancestors of this checkpoint. The complete diff whitespace check reports one trailing-space line in the checksum-pinned generated `phonemizer-engine.mjs`; its verified bytes are preserved. The whitespace check excluding that generated asset passed. Implementation suites were not repeated during this metadata-only publication.

**Required post-merge Pages verification: pending.** Keep #73 open until the successful Pages deployment run URL, merged SHA and verification time are recorded. Verify both index links and nested pages/scripts/Workers/runtime/notices under the repository prefix in a fresh deployed-origin browser. If model-fetch/CORS/COEP behavior differs from local checks, record deployed-origin real inference too. Local inference results do not establish deployment of the merged revision.

## Related issues

Refs #73. Context: #7, #63 and #65.

After required post-merge Pages verification is performed and recorded, the closure reference will be:

```text
Closes #73
```

This is a future closure example; Issue #73 must remain open while verification is pending.

## Scope check

- [ ] This PR fully addresses each Issue it claims to resolve. Required post-merge Pages verification remains pending.
- [x] This PR does not include unrelated work.
- [x] This PR does not add speculative abstractions, extensibility, frameworks, or subsystems that are not needed by the Issue.
- [x] Any intentionally partial implementation is clearly stated, and the parent Issue is not presented as fully resolved unless the remaining scope has been explicitly split out.
- [x] Validation maps to the Issue's expected outcome / acceptance criteria.
