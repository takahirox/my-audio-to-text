# Focused TEXT output validation (#87)

Validated locally on 2026-10-10 with Playwright 1.63.0 / Chromium 153.0.8010.12.

## Implementation

The supported focused sink has exactly `text: TEXT`. FinalText and
TranslatedFinalText convert confirmed results and suppress repeated/stale IDs
before emitting whole strings. TTS snippet sizing stays in the TTS branch.
Version 1/2 graphs migrate through explicit typed adapters or fail with a
Reset-and-Save recovery message. The selected-field sink and picker are removed;
selected media and microphone remain supported.

Toolbar invocation prepares only its top-level document with existing activeTab
access. New Live popups prepare before taking window focus. Focus tracking retains
only a valid prior user-focused target, invalidates superseded/removed targets,
and skips unavailable/secret/unsupported fields or canceled edits. Navigation or
transport loss detaches only focused output; no cross-tab output or host grants
are added.

## Fixture and unit checks

- `npm test`: 242 passed.
- `npm run build:extension`: passed with the pinned ASR, translation and TTS
  runtime assets staged by the existing preparation scripts.
- `npm run test:extension -- --reporter=line`: 72 passed, 5 opt-in checks skipped.
  The final added IBAN guard also passed its targeted MV3 check; final migration
  layout adjustment passed the MV3 version 1/2 migration/recovery recheck.
- MV3 page-focus tests run headed with Playwright focus emulation disabled and
  Live in a separate popup. They assert actual page window-focus loss, including
  first-toolbar creation and an editor that blurs on window deactivation.
- Controlled dynamic comment activation creates/focuses a contenteditable with
  nested spans/br, then receives literal plain text. This is a YouTube-style
  fixture, not a live YouTube claim.
- Native tab/media capture and fake-device microphone checks are retained.
  ASR/translation inference is deterministic fixture code in the general target
  suite; typed TEXT fan-out and final-delivery policy also have unit coverage.

## Shared browser suite limitation

The Chromium/WebKit suite was run with both two workers and one worker. The
first run had 215 passed / 18 skipped / 1 WebKit cleanup timeout. The serial run
had 213 passed / 18 skipped / 3 WebKit cleanup timeouts. These assertions poll
AudioContext state for `closed`, in unchanged `web/` and `tests/browser/` code.

All affected cases subsequently passed: the picker-cancellation case in the
serial suite and isolated upstream copies (also with the same prepared assets),
and isolated rechecks of Stop/Cancel, sharing ending during worklet setup, and
a late canceled grant during a replacement session. The complete browser suite
was therefore not consistently green on this host; no assertion was weakened
and no shared audio implementation was changed to hide the timing failures.

## Real inference

`EXTENSION_TARGET_SMOKE=1 npm run test:extension -- tests/extension/targets-real-smoke.spec.js`
passed using the committed checksum-pinned speech WAV, real native tabCapture,
real bundled ReazonSpeech/Silero workers, FinalText and the focused TEXT sink,
with concurrent Live output. Three confirmed utterances were inserted once in
order, including Stop drain. There were no remote requests or page errors.
[Sanitized metrics](graph-87-real-asr-field.json) contain no transcripts.

Real OPUS-MT/TTS inference checks remained opt-in/skipped; fixture results do not
establish their model accuracy. Live YouTube search/comments, native microphone
hardware, external rich editors and restricted frames were not manually tested.
No post-merge verification or publication is required for the unpacked build.
