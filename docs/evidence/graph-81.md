# Issue #81 verification

Verified in the assigned worktree on 2026-10-09 using Node tests and packaged
MV3 Chromium 153.0.8010.12, with the existing extension CSP and no host permissions.

- `npm test`: 227 passed.
- `npm run test:browser -- --workers=2`: 216 passed; 18 opt-in cases skipped.
- `EXTENSION_TARGET_SMOKE=1 npm run test:extension`: 59 passed; 4 optional real
  TTS/OPUS inference smokes skipped. Includes the real ASR/tabCapture/selected-field
  smoke and all existing default, bilingual, TTS, cache, navigation and lifecycle
  regression tests. Subsequent field-handle isolation fix was verified by the
  complete target suite below; shared ASR/translation/TTS/runtime code is unchanged.
- Final `npm run test:extension -- tests/extension/targets.spec.js`: 8 passed,
  including independent clearing of two picked handles for the same DOM element,
  controlled-input event tracking, rejected beforeinput, actual media isolation,
  native microphone permission state, final-only multi-output, page/frame/tab
  boundaries, duplicate/stale protection, navigation, Stop/drain and cancellation.
- `npm run build:extension` and `git diff --check`: passed.

The deterministic extension suite replaces ASR/translation worker inference,
not browser capture, DOM insertion, permissions, schema, builder or Pipeline.
The 440/880 Hz media fixture measures selected-element capture separately from
whole-tab capture. An audio-less canvas/video stream verifies fallback, and a
mock mediaKeys marker verifies the protected-media guard without claiming actual
DRM service compatibility. Microphone uses a browser test device with native
permission denial/grant; no physical microphone hardware compatibility claim.

[Real inference evidence](graph-81-real-asr-field.json) records the independent
pinned ReazonSpeech/Silero smoke with native tabCapture and real selected-field
insertion. Three finalized utterances reached Live and the field in identical
order, without remote traffic. It records no transcript or page field contents.
No universal support is claimed for external media, DRM, meeting applications,
restricted frames or complex editors. No post-merge deployment check is required.
