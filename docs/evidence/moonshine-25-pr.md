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

This addresses the updated #25 scope through agent-verifiable implementation and tests.
Human speech, actual whisper phonation, physical-device testing, and published-site checks
are optional follow-up validation. The existing Pages workflow must remain able to build
and deploy the playground; deployment of this revision before merge is not required.
No production backend is selected.

## Validation

- Four audio unit tests and 19 routine Chromium/WebKit checks pass. One WebKit binding
  mock and 28 opt-in real-model checks are skipped without their recordings.
- Previously recorded: all five WebKit repeat cases passed five runs each (25 checks), including repeat
  startup, nonzero audio, diagnostics reset, track release, and stale flush isolation.
- Previously recorded: four selected real-model checks passed: Japanese and English Small Streaming in
  Chromium and WebKit, using newly synthesized speech on localhost. Both languages
  emitted nonempty partials/finals and completed native speech events.
- Historical real-model/synthetic observations are retained in
  `docs/evidence/moonshine-25.json` and `docs/asr-manual-testing.md`; they establish local
  integration and expose language/quiet-signal limitations, rather than human accuracy.
- The matrix accepts a whisper recording independently at both VAD thresholds and can
  target the published repository subpath with `ASR_BASE_URL`, without a localhost server.
  A separate localhost subpath check passed real Japanese inference in Chromium; the
  actual public HTTPS revision remains unverified.
- Asset preparation and archive checksum verification pass. The existing Pages workflow
  runs that preparation and uploads `web/`, including the pinned runtime assets, then
  deploys on pushes to main. No workflow or deployment-policy change is needed for #25.

Human microphone, actual quiet/whisper speech, physical-device behavior, and this revision
on the public HTTPS site have not been verified. Synthetic input validates integration and
diagnostics without establishing human accuracy. These optional observations do not block
merge or Issue completion under the updated #25 criteria.

## Related issues

Closes #25

## Scope check

- [x] This PR fully addresses the updated Issue #25 agent-verifiable criteria.
- [x] This PR does not include unrelated work.
- [x] This PR adds no speculative frameworks or subsystems.
- [x] Optional human and published-site validation is explicitly identified without claiming unperformed checks.
- [x] Validation maps to the updated Issue's expected outcome and acceptance criteria.
