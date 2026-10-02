## Summary

The browser PoC used non-streaming Japanese Tiny and did not distinguish microphone,
speech detection, and recognition failures. Use Japanese/English Small Streaming with
explicit language and native VAD threshold controls, plus signal/VAD/transcript diagnostics.

## Outcome

Japanese is the default; English is selectable. Both use `ModelArch.SmallStreaming` (4)
and dated model URLs. The official Moonshine v0.1.5 release runtime is pinned and its
archive verified; the npm 0.1.5 binary cannot load these streaming models. Loading
failures are explicit, without an older-model fallback. This runtime has no automatic
language detection, so no Auto option is shown.

The UI shows captured frames, RMS/session peak, accepted/completed native VAD segments,
and nonempty partial/final counts. VAD thresholds 0.5 and 0.2 help diagnose quiet input.
The browser fixture retains WebKit's MediaDevices/track wrappers, awaits successful
repeat capture, and verifies both tracks are released. Both browsers exercise delayed
Stop → Cancel → reload while a replacement capture is recording.

**This is intentional partial work for #25.** Completed scope is the streaming/runtime
update, language controls, diagnostics, documentation, and local synthetic checks.
Remaining scope stays in #25: publish and verify the reviewed revision over HTTPS,
then record normal Japanese, Japanese with English terms, English-only, actual quiet
Japanese, and actual whisper-like Japanese with signal/VAD/transcript observations and
load/responsiveness results. Real whisper phonation needs a recording or microphone
utterance; attenuation does not reproduce it. Physical mobile testing is optional.
No production backend is selected.

## Validation

- Four audio unit tests and 19 routine Chromium/WebKit checks pass. One WebKit binding
  mock and 28 opt-in real-model checks are skipped without their recordings.
- All five WebKit repeat cases passed five runs each (25 checks), including repeat
  startup, nonzero audio, diagnostics reset, track release, and stale flush isolation.
- Four selected real-model checks passed: Japanese and English Small Streaming in
  Chromium and WebKit, using newly synthesized speech on localhost. Both languages
  emitted nonempty partials/finals and completed native speech events.
- Historical real-model/synthetic observations are retained in
  `docs/evidence/moonshine-25.json` and `docs/asr-manual-testing.md`; they establish local
  integration and expose language/quiet-signal limitations, rather than human accuracy.
- The matrix accepts a whisper recording independently at both VAD thresholds and can
  target the published repository subpath with `ASR_BASE_URL`, without a localhost server.
  A separate localhost subpath check passed real Japanese inference in Chromium; the
  actual public HTTPS revision remains unverified.

**Required evidence still missing:** the reviewed revision on Pages and the real-speech
five-condition comparison. At the read-only check on 2026-10-02, Pages served main commit
`8c4e44b36ad3999042e2d192b8708bd1913ec010`; `moonshine-config.js` returned 404. The
github-pages environment permits only main. No whisper recording is available to this
node. Keep this PR draft and #25 open while the remaining scope is unfinished.

## Related issues

Related to #25 (intentional partial work).

Keep Issue #25 open and this PR draft until the required published-revision and
real-speech evidence is recorded. Preserve this non-closing reference when updating
the PR body; publication does not complete the remaining validation scope.

## Scope check

- [ ] Issue #25 is fully addressed; required published and real-speech validation remains open.
- [x] This PR does not include unrelated work.
- [x] This PR adds no speculative frameworks or subsystems.
- [x] Intentional partial work and remaining scope are explicit; the parent Issue remains open.
- [x] Validation maps to the Issue's expected outcome, with missing evidence stated above.
