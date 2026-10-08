# Issue #69 extension OPUS-MT validation

Validated on 2026-10-08 on macOS with Chrome-for-Testing **153.0.8010.12**.
This is the unpacked extension; no Web Store release or deployment was performed.

## Implementation and deterministic evidence

The existing `SpeechToTextNode` feeds a session-owned adapter via named
provisional/final ports. Its inner Pipeline wires a text producer to the production
`OpusMtTranslationNode` and text sink. One in-flight translation, one replaceable
pending provisional and a final FIFO keep interim backlog bounded. Version
checks suppress obsolete output; final rows retain arrival indices. All finals
are drained before Stop completes. Cancel/disposal interrupts owned workers.
Failures are isolated to translation, preserving ASR and original transcripts.

Preparation uses the existing extension-origin streaming/hash cache with the
real seven-file immutable OPUS manifest (**238,978,729 bytes**). Downloads require
an explicit recorder action, expose progress/failure/retry/cancel, and reuse
verified complete files. The module Worker verifies/read-loads those assets from
the same extension-origin cache with remote model access disabled. Runtime
JS/MJS/WASM are packaged from the existing checksum-pinned preparation script;
weights are not bundled. No new permission or remote executable-code allowance.

- `npm test`: **143 passed**; includes 14 new translation integration/scheduling
  checks plus all existing ASR/cache/translation tests.
- `npm run test:browser -- --workers=2`: **136 passed, 10 opt-in tests skipped**,
  Chromium and WebKit. An initial 8-worker run passed 135 and failed the existing
  WebKit “switch during the tab picker” AudioContext cleanup poll. That case
  passed alone, and the full 2-worker rerun passed; no unrelated audio code changed.
- `npm run test:extension`: **33 passed, 1 opt-in real smoke skipped**. The real
  smoke was executed separately and passed. A final focused translation UI/lifecycle
  rerun: **6 passed**, verifying the rebuilt bundle after preserving final-list DOM
  during interim updates.
- `git diff --check`: passed.

New MV3 tests exercise the production recorder/scheduler/OPUS Worker protocol
with small hashed assets and a deterministic model runtime. They cover no download
on opening/enabling, missing/evicted cache, explicit progress/retry, network/quota/
cancel failures, extension Worker cache reads, final pairing/order, stale interim
labels, offline reuse across a Chrome profile restart, load/inference teardown,
missing translation-worker WebAssembly and Cancel during final drain. They do
**not** establish real model execution.

## Real OPUS-MT smoke — passed

```sh
python3 scripts/prepare-reazon-ja-en-fixtures.py
EXTENSION_OPUS_SMOKE=1 npm run test:extension -- tests/extension/translation-smoke.spec.js
```

The strengthened smoke passed in **1.2 minutes**. It triggers the actual toolbar
action and native tab capture on a loopback tab playing the checksum-pinned
upstream Japanese WAV, with real ReazonSpeech, Silero and OPUS-MT inference under
MV3 CSP/COEP. No model, capture, ASR, cache or inference mocks are installed.
The model is downloaded through the product's explicit preparation control from
the real immutable remote asset URLs. WASM, Worker, Cache Storage and cross-origin
isolation were available. The second run recreated the recorder window and ran
with Chrome offline using the existing cache, without another asset download.

Online completed provisional example:

- Original: `日本語ちゃんと聞き取ってます`
- English: `I'm listening to you in Japanese.`

Online final example:

- Original: `日本語ちゃんと聞き取れてますか`
- English: `Do you understand Japanese well?`

Both runs produced five ordered final Japanese/English pairs. The smoke records
only provisional output marked complete for its matching original, rather than
accepting pending status text as English. No page errors were observed. All
observed requests were GETs without bodies; remote requests occurred only during
explicit preparation to Hugging Face asset-delivery hosts, and no remote requests
occurred during inference/offline reuse. Signed asset query parameters are omitted
from evidence. See [sanitized real evidence](extension-translation-69-opus.json).

An earlier real execution completed inference but failed its test-only network
assertion because WHATWG `URL.origin` is `null` for extension URLs. The recorder
made no unexpected remote inference requests. The smoke now preserves the
extension scheme/host while stripping asset query strings; the rerun passed.

This establishes local execution and UI/lifecycle behavior in this test profile,
not translation quality, long-term cache retention, other-device capability or
Web Store release behavior. Physical meeting/device testing remains optional.
No post-merge verification is required for the unpacked extension in this Issue.
