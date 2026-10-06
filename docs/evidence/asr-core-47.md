# Minimal local ASR core extraction (#47)

Validated locally on 2026-10-06 (Asia/Tokyo), in the assigned Git worktree.
Required post-merge verification: none.

The documented [PCM-to-events contract](../local-asr-core.md) is implemented by
`LocalAsrCore`. The microphone app now owns capture/resampling and presentation;
worker creation, readiness, session isolation, VAD/ASR coordination, backpressure,
utterance policy and draining are behind the core. There is no parallel UI
orchestration path and no additional audio source or model.

The shared configuration retains ja-en, Silero threshold 0.5/512-sample frames,
0.8 s pre-roll, 0.5 s provisional eligibility, 0.35 s trailing silence, 12 s
maximum utterance duration, the 30 s pending-audio cap and existing one-thread
selection. The VAD adapter copies the shared configuration because the pinned
runtime wrapper adds unused detector defaults.

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm test` | 29 passed, including microphone-free core worker fixtures |
| `npm run test:browser -- --workers=2` | 44 passed in Chromium/WebKit; 6 opt-in checks skipped |
| `npm run prepare:assets` | Passed; checksum-pinned ja-en/Silero staged, 90.8 MB |
| `python3 scripts/prepare-reazon-ja-en-fixtures.py` | Passed; all three fixture hashes verified |
| `ASR_TEST_VAD=1 ASR_REAZON_JA_EN=1 ASR_BENCHMARK=1 npm run test:browser -- tests/browser/model-smoke.spec.js tests/browser/reazon-ja-en.spec.js --workers=1` | 4 passed in Chromium/WebKit |
| JavaScript syntax and `git diff --check` | Passed |

Core fixtures verify provisional/final and speech lifecycle events, input array
ownership, pre-roll/endpoints, duration boundaries, serialized/coalesced inference,
Stop with pending VAD audio, empty output, repeat, release during recognition or
Stop, stale workers/sessions, backpressure and errors. Existing browser tests
exercise actual worker framing/cleanup, model configuration, microphone
resampling/worklet flush, permission cancellation and page teardown.

Real inference checks cover Silero silence, Stop/repeat, and Japanese, English
and mixed speech through one ja-en model load in each browser. They verify model
and runtime hashes, provisional/final output, trailing-silence endpoints, empty
pending audio after draining, Cancel/reload and zero runtime errors. Generated
assets, WAVs and Playwright outputs remain ignored. These checks establish retained
pipeline behavior; they do not claim physical-device performance or speech
accuracy beyond the deterministic fixtures.
